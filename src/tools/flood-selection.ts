import { Container, NumericInput } from '@playcanvas/pcui';

import { Events } from '../events';

type Pt = {x : number, y: number };

const RED = 0;
const GREEN = 1;
const BLUE = 2;
const ALPHA = 3;
const PIXEL = 4;
const DEFAULT_THRESHOLD = 0.08;
const CLICK_TOLERANCE = 4;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

class FloodSelection {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, parent: HTMLElement, mask: { canvas: HTMLCanvasElement, context: CanvasRenderingContext2D }, canvasContainer: Container) {

        // create canvas
        const { canvas, context } = mask;

        let threshold = DEFAULT_THRESHOLD;
        let point: Pt | undefined;
        let imageData: ImageData;

        // ui
        const selectToolbar = new Container({
            class: 'select-toolbar',
            hidden: true
        });

        selectToolbar.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        const thresholdInput = new NumericInput({
            value: threshold,
            placeholder: 'Threshold',
            width: 120,
            precision: 3,
            min: 0.005,
            max: 0.5
        });
        selectToolbar.append(thresholdInput);

        canvasContainer.append(selectToolbar);

        const apply = async (op: 'set' | 'add' | 'remove') => {
            await events.invoke(
                'select.byMask',
                op,
                canvas,
                context
            );
        };

        const refreshSelection = async () => {
            if (!point) return false;

            const width = parent.clientWidth;
            const height = parent.clientHeight;
            if (width <= 0 || height <= 0) {
                return false;
            }

            if (!imageData || canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
                imageData = context.createImageData(width, height);
            }

            const data = await (events.invoke('render.offscreen', width, height) as Promise<Uint8Array>);
            const seed = {
                x: clamp(point.x, 0, width - 1),
                y: clamp(point.y, 0, height - 1)
            };

            const seedOffset = (seed.y * width + seed.x) * PIXEL;
            const seedR = data[seedOffset + RED];
            const seedG = data[seedOffset + GREEN];
            const seedB = data[seedOffset + BLUE];
            const seedA = data[seedOffset + ALPHA];

            const colorThreshold = threshold * 255;
            const colorThresholdSq = colorThreshold * colorThreshold * 3;
            const alphaThreshold = Math.max(10, threshold * 128);
            const matchesSeed = (offset: number) => {
                const dr = data[offset + RED] - seedR;
                const dg = data[offset + GREEN] - seedG;
                const db = data[offset + BLUE] - seedB;
                const da = Math.abs(data[offset + ALPHA] - seedA);
                return dr * dr + dg * dg + db * db <= colorThresholdSq && da <= alphaThreshold;
            };

            const stack: number[] = [seed.y * width + seed.x];
            const visited = new Uint8Array(width * height);
            const d = imageData.data;
            let filled = 0;

            d.fill(0);
            visited[stack[0]] = 1;

            while (stack.length > 0) {
                const pixel = stack.pop();
                const x = pixel % width;
                const y = Math.floor(pixel / width);
                const offset = pixel * PIXEL;

                if (!matchesSeed(offset)) {
                    continue;
                }

                d[offset + RED] = 51;
                d[offset + GREEN] = 214;
                d[offset + BLUE] = 197;
                d[offset + ALPHA] = 255;
                filled++;

                const push = (next: number) => {
                    if (!visited[next]) {
                        visited[next] = 1;
                        stack.push(next);
                    }
                };

                if (x > 0) push(pixel - 1);
                if (x < width - 1) push(pixel + 1);
                if (y > 0) push(pixel - width);
                if (y < height - 1) push(pixel + width);
            }

            if (filled === 0) {
                context.clearRect(0, 0, canvas.width, canvas.height);
                return false;
            }
            context.putImageData(imageData, 0, 0);
            return true;
        };

        thresholdInput.on('change', () => {
            const next = Number(thresholdInput.value);
            threshold = Number.isFinite(next) ? clamp(next, 0.005, 0.5) : threshold;
        });

        const isPrimary = (e: PointerEvent) => {
            return e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary;
        };

        const stopEvent = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
        };

        let clicked = false;
        let pointerId: number | undefined;
        let startPoint: Pt | undefined;

        const resetPointer = () => {
            if (pointerId !== undefined && parent.hasPointerCapture(pointerId)) {
                parent.releasePointerCapture(pointerId);
            }
            clicked = false;
            pointerId = undefined;
            startPoint = undefined;
        };

        const pointerdown = (e: PointerEvent) => {
            if (!clicked && isPrimary(e)) {
                stopEvent(e);
                clicked = true;
                pointerId = e.pointerId;
                startPoint = {
                    x: e.offsetX,
                    y: e.offsetY
                };
                parent.setPointerCapture(pointerId);
            }
        };

        const pointermove = (e: PointerEvent) => {
            if (e.pointerId === pointerId) {
                stopEvent(e);

                if (startPoint) {
                    const dx = e.offsetX - startPoint.x;
                    const dy = e.offsetY - startPoint.y;
                    if (dx * dx + dy * dy > CLICK_TOLERANCE * CLICK_TOLERANCE) {
                        clicked = false;
                    }
                }
            }
        };

        const pointerup = async (e: PointerEvent) => {
            if (e.pointerId === pointerId) {
                stopEvent(e);

                if (clicked && isPrimary(e)) {
                    point = {
                        x: Math.floor(e.offsetX),
                        y: Math.floor(e.offsetY)
                    };

                    const hasSelection = await refreshSelection();

                    if (hasSelection) {
                        await apply(e.shiftKey ? 'add' : (e.ctrlKey ? 'remove' : 'set'));
                    }

                    context.clearRect(0, 0, canvas.width, canvas.height);
                }

                resetPointer();
            }
        };

        const pointercancel = (e: PointerEvent) => {
            if (e.pointerId === pointerId) {
                stopEvent(e);
                resetPointer();
            }
        };

        this.activate = () => {
            parent.style.display = 'block';
            selectToolbar.hidden = false;
            parent.addEventListener('pointerdown', pointerdown);
            parent.addEventListener('pointermove', pointermove);
            parent.addEventListener('pointerup', pointerup);
            parent.addEventListener('pointercancel', pointercancel);
        };

        this.deactivate = () => {
            parent.style.display = 'none';
            selectToolbar.hidden = true;
            resetPointer();
            parent.removeEventListener('pointerdown', pointerdown);
            parent.removeEventListener('pointermove', pointermove);
            parent.removeEventListener('pointerup', pointerup);
            parent.removeEventListener('pointercancel', pointercancel);
            point = undefined;
        };
    }
}

export { FloodSelection };
