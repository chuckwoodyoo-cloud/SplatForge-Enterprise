import {
    BLENDMODE_ONE,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BLENDMODE_SRC_ALPHA,
    BLENDEQUATION_ADD,
    CULLFACE_NONE,
    FUNC_LESSEQUAL,
    SEMANTIC_POSITION,
    BlendState,
    DepthState,
    Layer,
    QuadRender,
    ScopeSpace,
    Shader,
    ShaderUtils,
    Vec3,
    Mat4
} from 'playcanvas';

import { Element, ElementType } from './element';
import { Serializer } from './serializer';
import { vertexShader, fragmentShader } from './shaders/infinite-grid-shader';
import { Splat } from './splat';
import { State } from './splat-state';

const MAX_GROUND_SAMPLES = 60000;
const GROUND_PERCENTILE = 0.03;

const resolve = (scope: ScopeSpace, values: any) => {
    for (const key in values) {
        scope.resolve(key).setValue(values[key]);
    }
};

class InfiniteGrid extends Element {
    shader: Shader;
    quadRender: QuadRender;
    blendState = new BlendState(false);
    depthState = new DepthState(FUNC_LESSEQUAL, true);

    visible = true;
    private readonly viewPosition = [0, 0, 0];
    private readonly planeOffsets = [0, 0, 0];
    private readonly viewProjectionMatrix = new Mat4();
    private readonly samplePosition = new Vec3();
    private blendStateRender: BlendState;
    private groundDirty = true;

    constructor() {
        super(ElementType.debug);
    }

    add() {
        const device = this.scene.app.graphicsDevice;

        this.shader = ShaderUtils.createShader(device, {
            uniqueName: 'infinite-grid',
            attributes: {
                vertex_position: SEMANTIC_POSITION
            },
            vertexGLSL: vertexShader,
            fragmentGLSL: fragmentShader
        });

        this.quadRender = new QuadRender(this.shader);

        const blendState = new BlendState(
            true,
            BLENDEQUATION_ADD, BLENDMODE_SRC_ALPHA, BLENDMODE_ONE_MINUS_SRC_ALPHA,
            BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE_MINUS_SRC_ALPHA
        );
        this.blendStateRender = blendState;

        this.scene.camera.camera.on('preRenderLayer', this.onPreRenderLayer, this);

        const { events } = this.scene;
        events.on('splat.stateChanged', this.requestGroundUpdate, this);
        events.on('splat.positionsChanged', this.requestGroundUpdate, this);
        events.on('splat.moved', this.requestGroundUpdate, this);
        events.on('splat.visibility', this.requestGroundUpdate, this);
    }

    remove() {
        this.scene.camera.camera.off('preRenderLayer', this.onPreRenderLayer, this);

        const { events } = this.scene;
        events.off('splat.stateChanged', this.requestGroundUpdate, this);
        events.off('splat.positionsChanged', this.requestGroundUpdate, this);
        events.off('splat.moved', this.requestGroundUpdate, this);
        events.off('splat.visibility', this.requestGroundUpdate, this);

        this.shader.destroy();
        this.quadRender.destroy();
    }

    serialize(serializer: Serializer): void {
        serializer.pack(this.visible);
    }

    onAdded(element: Element) {
        if (element.type === ElementType.splat) {
            this.requestGroundUpdate();
        }
    }

    onRemoved(element: Element) {
        if (element.type === ElementType.splat) {
            this.requestGroundUpdate();
        }
    }

    private requestGroundUpdate() {
        this.groundDirty = true;
        if (this.scene) {
            this.scene.forceRender = true;
        }
    }

    private updatePlaneOffsets() {
        this.groundDirty = false;

        const splats = this.scene.getElementsByType(ElementType.splat) as Splat[];
        const ySamples: number[] = [];
        let totalSplats = 0;
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        let hasBound = false;

        splats.forEach((splat) => {
            if (!splat.visible) {
                return;
            }

            totalSplats += splat.splatData.numSplats;

            const { center, halfExtents } = splat.worldBound;
            minX = Math.min(minX, center.x - halfExtents.x);
            maxX = Math.max(maxX, center.x + halfExtents.x);
            minY = Math.min(minY, center.y - halfExtents.y);
            minZ = Math.min(minZ, center.z - halfExtents.z);
            maxZ = Math.max(maxZ, center.z + halfExtents.z);
            hasBound = true;
        });

        if (totalSplats > 0) {
            const step = Math.max(1, Math.ceil(totalSplats / MAX_GROUND_SAMPLES));
            let sampleIndex = 0;

            splats.forEach((splat) => {
                if (!splat.visible) {
                    return;
                }

                const state = splat.splatData.getProp('state') as Uint8Array;
                const { numSplats } = splat.splatData;

                for (let i = 0; i < numSplats; i++) {
                    if (sampleIndex++ % step !== 0) {
                        continue;
                    }

                    if (state[i] & State.deleted) {
                        continue;
                    }

                    if (splat.calcSplatWorldPosition(i, this.samplePosition)) {
                        ySamples.push(this.samplePosition.y);
                    }
                }
            });
        }

        this.planeOffsets[0] = hasBound ? (minX + maxX) * 0.5 : 0;
        this.planeOffsets[1] = hasBound ? minY : 0;
        this.planeOffsets[2] = hasBound ? (minZ + maxZ) * 0.5 : 0;

        if (ySamples.length > 0) {
            ySamples.sort((a, b) => a - b);
            const index = Math.min(ySamples.length - 1, Math.floor((ySamples.length - 1) * GROUND_PERCENTILE));
            this.planeOffsets[1] = ySamples[index];
        }
    }

    private onPreRenderLayer(layer: Layer, transparent: boolean) {
        const { scene } = this;
        if (this.visible && layer === scene.worldLayer && !transparent && scene.camera.renderOverlays) {
            if (this.groundDirty) {
                this.updatePlaneOffsets();
            }

            const { camera } = scene;
            const device = scene.app.graphicsDevice;

            device.setBlendState(this.blendStateRender);
            device.setCullMode(CULLFACE_NONE);
            device.setDepthState(DepthState.WRITEDEPTH);
            device.setStencilState(null, null);

            let plane;

            // select the correctly plane in orthographic mode
            if (camera.ortho) {
                const cmp = (a:Vec3, b: Vec3) => 1.0 - Math.abs(a.dot(b)) < 1e-03;
                const z = camera.worldTransform.getZ();
                plane = cmp(z, Vec3.RIGHT) ? 0 : (cmp(z, Vec3.BACK) ? 2 : 1);
            } else {
                // default is xz plane
                plane = 1;
            }

            const p = camera.position;
            this.viewPosition[0] = p.x;
            this.viewPosition[1] = p.y;
            this.viewPosition[2] = p.z;

            this.viewProjectionMatrix.mul2(camera.camera.projectionMatrix, camera.camera.viewMatrix);

            resolve(device.scope, {
                plane,
                plane_offsets: this.planeOffsets,
                view_position: this.viewPosition,
                matrix_viewProjection: this.viewProjectionMatrix.data
            });

            this.quadRender.render();
        }
    }
}

export { InfiniteGrid };
