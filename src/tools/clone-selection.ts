import { Button, Container, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { Scene } from '../scene';
import { localize } from '../ui/localization';

type Point = { x: number, y: number };

const CLICK_TOLERANCE = 4;

class CloneSelection {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, parent: HTMLElement, canvasContainer: Container) {
        let pointerId: number | undefined;
        let startPoint: Point | undefined;
        let clicked = false;

        const selectToolbar = new Container({
            class: 'select-toolbar',
            hidden: true
        });

        const label = new Label({
            class: 'select-toolbar-label',
            text: localize('tool.clone-selection.target')
        });

        const cancel = new Button({
            class: 'select-toolbar-button',
            text: localize('popup.cancel')
        });

        selectToolbar.append(label);
        selectToolbar.append(cancel);
        canvasContainer.append(selectToolbar);

        const stopEvent = (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
        };

        selectToolbar.dom.addEventListener('pointerdown', stopEvent);
        cancel.dom.addEventListener('click', () => events.fire('tool.deactivate'));

        const isPrimary = (event: PointerEvent) => {
            return event.pointerType === 'mouse' ? event.button === 0 : event.isPrimary;
        };

        const resetPointer = () => {
            if (pointerId !== undefined && parent.hasPointerCapture(pointerId)) {
                parent.releasePointerCapture(pointerId);
            }
            pointerId = undefined;
            startPoint = undefined;
            clicked = false;
        };

        const pointerdown = (event: PointerEvent) => {
            if (pointerId === undefined && isPrimary(event)) {
                stopEvent(event);

                pointerId = event.pointerId;
                startPoint = {
                    x: event.offsetX,
                    y: event.offsetY
                };
                clicked = true;
                parent.setPointerCapture(pointerId);
            }
        };

        const pointermove = (event: PointerEvent) => {
            if (event.pointerId === pointerId) {
                stopEvent(event);

                if (startPoint) {
                    const dx = event.offsetX - startPoint.x;
                    const dy = event.offsetY - startPoint.y;
                    if (dx * dx + dy * dy > CLICK_TOLERANCE * CLICK_TOLERANCE) {
                        clicked = false;
                    }
                }
            }
        };

        const pointerup = async (event: PointerEvent) => {
            if (event.pointerId === pointerId) {
                stopEvent(event);

                const shouldClone = clicked && isPrimary(event) && events.invoke('selection.splats');
                resetPointer();

                if (shouldClone) {
                    const result = await scene.camera.intersect(
                        event.offsetX / parent.clientWidth,
                        event.offsetY / parent.clientHeight
                    );

                    if (result) {
                        await events.invoke('select.cloneToTarget', result);
                        events.fire('tool.deactivate');
                    }
                }
            }
        };

        const pointercancel = (event: PointerEvent) => {
            if (event.pointerId === pointerId) {
                stopEvent(event);
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
        };
    }
}

export { CloneSelection };
