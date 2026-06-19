import { Button, Container, Label, SelectInput } from '@playcanvas/pcui';
import { Vec3 } from 'playcanvas';

import { DeleteMaskOp } from '../edit-ops';
import { Events } from '../events';
import { IndexRanges } from '../index-ranges';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { State } from '../splat-state';
import { localize } from '../ui/localization';

type Strength = 'light' | 'medium' | 'strong';
type DepthScope = 'all' | 'front' | 'back' | 'layer';

type CandidateRecord = {
    index: number;
    opacity: number;
    maxScale: number;
    volume: number;
    depth: number;
};

const strengthConfig: Record<Strength, { opacityQ: number, scaleQ: number, volumeQ: number, minScore: number }> = {
    light: { opacityQ: 0.08, scaleQ: 0.94, volumeQ: 0.94, minScore: 3 },
    medium: { opacityQ: 0.16, scaleQ: 0.88, volumeQ: 0.88, minScore: 2 },
    strong: { opacityQ: 0.28, scaleQ: 0.78, volumeQ: 0.78, minScore: 1 }
};

const tmpPoint = new Vec3();

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

const percentile = (values: number[], q: number) => {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const pos = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * q));
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const t = pos - lo;
    return sorted[lo] * (1 - t) + sorted[hi] * t;
};

const setSelectionPreview = async (splat: Splat, selectedMask: Uint8Array) => {
    const { state } = splat;
    const numSplats = splat.splatData.numSplats;
    const current = state.data;

    const selectedRanges = IndexRanges.fromPredicate(numSplats, (i) => {
        return (current[i] & State.selected) !== 0;
    });

    if (!selectedRanges.empty) {
        state.clearBits(selectedRanges, State.selected);
    }

    const previewRanges = IndexRanges.fromPredicate(numSplats, (i) => {
        return selectedMask[i] === 255 &&
            (current[i] & (State.locked | State.deleted)) === 0;
    });

    if (!previewRanges.empty) {
        state.setBits(previewRanges, State.selected);
    }

    await splat.updateState(State.selected);
};

class EndRefinement {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        let splat: Splat | null = null;
        let originalSelection: Uint8Array | null = null;
        let candidateMask: Uint8Array | null = null;
        let candidateCount = 0;
        let committed = false;
        let refreshToken = 0;

        const selectToolbar = new Container({
            class: ['select-toolbar', 'end-refinement-toolbar'],
            hidden: true
        });

        selectToolbar.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        const title = new Label({
            class: 'select-toolbar-label',
            text: localize('tool.end-refinement.title')
        });

        const strengthSelect = new SelectInput({
            width: 94,
            defaultValue: 'medium',
            options: [
                { v: 'light', t: localize('tool.end-refinement.strength.light') },
                { v: 'medium', t: localize('tool.end-refinement.strength.medium') },
                { v: 'strong', t: localize('tool.end-refinement.strength.strong') }
            ]
        });

        const scopeSelect = new SelectInput({
            width: 122,
            defaultValue: 'all',
            options: [
                { v: 'all', t: localize('tool.end-refinement.scope.all') },
                { v: 'front', t: localize('tool.end-refinement.scope.front') },
                { v: 'back', t: localize('tool.end-refinement.scope.back') },
                { v: 'layer', t: localize('tool.end-refinement.scope.layer') }
            ]
        });

        const countLabel = new Label({
            class: 'select-toolbar-label',
            text: `${localize('tool.end-refinement.candidates')}: 0`
        });

        const previewButton = new Button({
            class: 'select-toolbar-button',
            text: localize('tool.end-refinement.preview')
        });

        const deleteButton = new Button({
            class: 'select-toolbar-button',
            text: localize('tool.end-refinement.delete-preview'),
            enabled: false
        });

        const cancelButton = new Button({
            class: 'select-toolbar-button',
            text: localize('popup.cancel')
        });

        selectToolbar.append(title);
        selectToolbar.append(strengthSelect);
        selectToolbar.append(scopeSelect);
        selectToolbar.append(countLabel);
        selectToolbar.append(previewButton);
        selectToolbar.append(deleteButton);
        selectToolbar.append(cancelButton);
        canvasContainer.append(selectToolbar);

        const captureSelection = () => {
            const selected = events.invoke('selection') as Splat;
            if (!selected?.visible || selected.numSelected <= 0) {
                splat = null;
                originalSelection = null;
                return false;
            }

            splat = selected;
            const state = selected.splatData.getProp('state') as Uint8Array;
            originalSelection = new Uint8Array(selected.splatData.numSplats);
            for (let i = 0; i < state.length; ++i) {
                if ((state[i] & State.selected) !== 0 && (state[i] & (State.locked | State.deleted)) === 0) {
                    originalSelection[i] = 255;
                }
            }

            return true;
        };

        const restoreOriginalSelection = async () => {
            if (splat && originalSelection) {
                await setSelectionPreview(splat, originalSelection);
            }
        };

        const inDepthScope = (record: CandidateRecord, scope: DepthScope, depths: number[]) => {
            if (scope === 'all' || depths.length < 3) {
                return true;
            }

            if (scope === 'front') {
                return record.depth <= percentile(depths, 0.33);
            }

            if (scope === 'back') {
                return record.depth >= percentile(depths, 0.67);
            }

            return record.depth >= percentile(depths, 0.35) &&
                record.depth <= percentile(depths, 0.65);
        };

        const buildCandidateMask = () => {
            if (!splat || !originalSelection) {
                return { mask: null as Uint8Array | null, count: 0 };
            }

            const opacity = splat.splatData.getProp('opacity') as Float32Array;
            const scale0 = splat.splatData.getProp('scale_0') as Float32Array;
            const scale1 = splat.splatData.getProp('scale_1') as Float32Array;
            const scale2 = splat.splatData.getProp('scale_2') as Float32Array;

            if (!opacity || !scale0 || !scale1 || !scale2) {
                return { mask: null as Uint8Array | null, count: 0 };
            }

            const cameraPos = scene.camera.position.clone();
            const cameraForward = scene.camera.forward.clone();
            const records: CandidateRecord[] = [];

            for (let i = 0; i < originalSelection.length; ++i) {
                if (originalSelection[i] !== 255) {
                    continue;
                }

                if (!splat.calcSplatWorldPosition(i, tmpPoint)) {
                    continue;
                }

                const sx = Math.exp(scale0[i]);
                const sy = Math.exp(scale1[i]);
                const sz = Math.exp(scale2[i]);
                const depth = tmpPoint.sub(cameraPos).dot(cameraForward);

                records.push({
                    index: i,
                    opacity: sigmoid(opacity[i]) * splat.transparency,
                    maxScale: Math.max(sx, sy, sz),
                    volume: sx * sy * sz,
                    depth
                });
            }

            if (records.length === 0) {
                return { mask: null as Uint8Array | null, count: 0 };
            }

            const cfg = strengthConfig[strengthSelect.value as Strength] ?? strengthConfig.medium;
            const opacityCut = percentile(records.map(r => r.opacity), cfg.opacityQ);
            const scaleCut = percentile(records.map(r => r.maxScale), cfg.scaleQ);
            const volumeCut = percentile(records.map(r => r.volume), cfg.volumeQ);
            const depths = records.map(r => r.depth);
            const scope = scopeSelect.value as DepthScope;
            const mask = new Uint8Array(originalSelection.length);
            let count = 0;

            records.forEach((record) => {
                if (!inDepthScope(record, scope, depths)) {
                    return;
                }

                let score = 0;
                if (record.opacity <= opacityCut) score++;
                if (record.maxScale >= scaleCut) score++;
                if (record.volume >= volumeCut) score++;

                if (score >= cfg.minScore) {
                    mask[record.index] = 255;
                    count++;
                }
            });

            return { mask, count };
        };

        const updateCount = () => {
            countLabel.text = splat ?
                `${localize('tool.end-refinement.candidates')}: ${candidateCount}` :
                localize('tool.end-refinement.no-selection');
            deleteButton.enabled = candidateCount > 0;
        };

        const refreshPreview = async () => {
            const token = ++refreshToken;
            await events.invoke('queue', (): void => undefined);
            if (token !== refreshToken) {
                return;
            }

            if (!splat && !captureSelection()) {
                candidateMask = null;
                candidateCount = 0;
                updateCount();
                return;
            }

            const result = buildCandidateMask();
            candidateMask = result.mask;
            candidateCount = result.count;

            if (candidateMask && candidateCount > 0) {
                await setSelectionPreview(splat, candidateMask);
            } else {
                await restoreOriginalSelection();
            }

            updateCount();
        };

        previewButton.dom.addEventListener('click', () => {
            refreshPreview();
        });

        deleteButton.dom.addEventListener('click', async () => {
            if (!splat || !candidateMask || candidateCount === 0) {
                return;
            }

            await restoreOriginalSelection();
            committed = true;
            events.fire('edit.add', new DeleteMaskOp(splat, candidateMask));
            events.fire('tool.deactivate');
        });

        cancelButton.dom.addEventListener('click', () => {
            events.fire('tool.deactivate');
        });

        strengthSelect.on('change', () => {
            refreshPreview();
        });

        scopeSelect.on('change', () => {
            refreshPreview();
        });

        this.activate = () => {
            committed = false;
            refreshToken++;
            selectToolbar.hidden = false;
            captureSelection();
            updateCount();
            refreshPreview();
        };

        this.deactivate = () => {
            refreshToken++;
            selectToolbar.hidden = true;
            if (!committed) {
                restoreOriginalSelection();
            }
            splat = null;
            originalSelection = null;
            candidateMask = null;
            candidateCount = 0;
            committed = false;
        };
    }
}

export { EndRefinement };
