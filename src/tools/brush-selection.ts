import { Events } from '../events';

const DEFAULT_RADIUS = 22;
const MIN_RADIUS = 2;
const MAX_RADIUS = 220;
const RADIUS_STEP = 1.08;

class BrushSelection {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, parent: HTMLElement, mask: { canvas: HTMLCanvasElement, context: CanvasRenderingContext2D }) {
        // create svg
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('tool-svg', 'hidden');
        svg.id = 'brush-select-svg';
        parent.appendChild(svg);

        // create circle element
        const circle = document.createElementNS(svg.namespaceURI, 'circle') as SVGCircleElement;
        svg.appendChild(circle);

        const { canvas, context } = mask;

        let radius = DEFAULT_RADIUS;

        const setRadius = (value: number) => {
            radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, value));
            circle.setAttribute('r', radius.toFixed(2));
        };

        setRadius(radius);

        const prev = { x: 0, y: 0 };
        let dragId: number | undefined;

        const update = (e: PointerEvent) => {
            const x = e.offsetX;
            const y = e.offsetY;

            circle.setAttribute('cx', x.toString());
            circle.setAttribute('cy', y.toString());

            if (dragId !== undefined) {
                const lineWidth = Math.max(1, radius * 2);
                context.beginPath();
                context.strokeStyle = '#33d6c5';
                context.lineCap = 'round';
                context.lineJoin = 'round';
                context.lineWidth = lineWidth;
                context.moveTo(prev.x, prev.y);
                context.lineTo(x, y);
                context.stroke();

                prev.x = x;
                prev.y = y;
            }
        };

        const pointerdown = (e: PointerEvent) => {
            if (dragId === undefined && (e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary)) {
                e.preventDefault();
                e.stopPropagation();

                dragId = e.pointerId;
                parent.setPointerCapture(dragId);

                // initialize canvas
                if (canvas.width !== parent.clientWidth || canvas.height !== parent.clientHeight) {
                    canvas.width = parent.clientWidth;
                    canvas.height = parent.clientHeight;
                }

                // clear canvas
                context.clearRect(0, 0, canvas.width, canvas.height);

                // display it
                canvas.style.display = 'inline';

                prev.x = e.offsetX;
                prev.y = e.offsetY;

                update(e);
            }
        };

        const pointermove = (e: PointerEvent) => {
            if (dragId !== undefined) {
                e.preventDefault();
                e.stopPropagation();
            }

            update(e);
        };

        const dragEnd = () => {
            parent.releasePointerCapture(dragId);
            dragId = undefined;
            canvas.style.display = 'none';
        };

        const pointerup = async (e: PointerEvent) => {
            if (e.pointerId === dragId) {
                e.preventDefault();
                e.stopPropagation();

                dragEnd();

                await events.invoke(
                    'select.byMask',
                    e.shiftKey ? 'add' : (e.ctrlKey ? 'remove' : 'set'),
                    canvas,
                    context
                );
            }
        };

        const wheel = (e: WheelEvent) => {
            if (e.altKey || e.metaKey) {
                const { deltaX, deltaY } = e;
                events.fire((Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY) > 0 ? 'tool.brushSelection.smaller' : 'tool.brushSelection.bigger');
                e.preventDefault();
                e.stopPropagation();
            }
        };

        this.activate = () => {
            svg.classList.remove('hidden');
            parent.style.display = 'block';
            parent.addEventListener('pointerdown', pointerdown);
            parent.addEventListener('pointermove', pointermove);
            parent.addEventListener('pointerup', pointerup);
            parent.addEventListener('wheel', wheel);
        };

        this.deactivate = () => {
            // cancel active operation
            if (dragId !== undefined) {
                dragEnd();
            }
            svg.classList.add('hidden');
            parent.style.display = 'none';
            parent.removeEventListener('pointerdown', pointerdown);
            parent.removeEventListener('pointermove', pointermove);
            parent.removeEventListener('pointerup', pointerup);
            parent.removeEventListener('wheel', wheel);
        };

        events.on('tool.brushSelection.smaller', () => {
            setRadius(radius / RADIUS_STEP);
        });

        events.on('tool.brushSelection.bigger', () => {
            setRadius(radius * RADIUS_STEP);
        });
    }
}

export { BrushSelection };
