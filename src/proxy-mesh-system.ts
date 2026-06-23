import { BLEND_NONE, BLEND_NORMAL, Color, Entity, StandardMaterial, Vec3 } from 'playcanvas';

import { Events } from './events';
import { Scene } from './scene';

type Vec3Tuple = [number, number, number];
type Vec3Like = Vec3 | Vec3Tuple | { x: number, y: number, z: number };
type ProxyMeshKind = 'box' | 'plane';

type ProxyMeshDescriptor = {
    id?: string,
    kind?: ProxyMeshKind,
    position?: Vec3Like,
    rotation?: Vec3Like,
    size?: Vec3Like,
    raycast?: boolean,
    navigation?: boolean,
    depthOccluder?: boolean,
    debugVisible?: boolean
};

type ProxyMeshRecord = {
    id: string,
    kind: ProxyMeshKind,
    entity: Entity,
    position: Vec3,
    rotation: Vec3,
    size: Vec3,
    raycast: boolean,
    navigation: boolean,
    depthOccluder: boolean,
    debugVisible: boolean
};

type ProxyRaycastOptions = {
    first?: boolean,
    navigation?: boolean,
    depthOccluder?: boolean
};

type ProxyRaycastHit = {
    id: string,
    kind: ProxyMeshKind,
    point: Vec3,
    normal: Vec3,
    distance: number,
    entity: Entity
};

const defaultBoxSize = new Vec3(4, 1, 4);
const defaultPlaneSize = new Vec3(60, 0.02, 60);
const up = new Vec3(0, 1, 0);
const down = new Vec3(0, -1, 0);

const toVec3 = (value: Vec3Like | undefined, fallback: Vec3) => {
    if (!value) {
        return fallback.clone();
    }

    if (value instanceof Vec3) {
        return value.clone();
    }

    if (Array.isArray(value)) {
        return new Vec3(value[0], value[1], value[2]);
    }

    return new Vec3(value.x, value.y, value.z);
};

const toTuple = (value: Vec3): Vec3Tuple => [value.x, value.y, value.z];

const makeId = () => `proxy-${Math.random().toString(36).slice(2, 9)}`;

class ProxyMeshSystem {
    private events: Events;
    private scene: Scene;
    private root: Entity;
    private material: StandardMaterial;
    private debugMaterial: StandardMaterial;
    private records = new Map<string, ProxyMeshRecord>();

    constructor(events: Events, scene: Scene) {
        this.events = events;
        this.scene = scene;
        this.root = new Entity('ProxyMeshSystem');
        this.scene.app.root.addChild(this.root);
        this.material = this.createDepthMaterial();
        this.debugMaterial = this.createDebugMaterial();
        this.registerEvents();
    }

    private createDepthMaterial() {
        const material = new StandardMaterial();
        material.name = 'ProxyDepthOccluder';
        material.diffuse = new Color(0, 0, 0);
        material.blendType = BLEND_NONE;
        material.depthWrite = true;
        material.redWrite = false;
        material.greenWrite = false;
        material.blueWrite = false;
        material.alphaWrite = false;
        material.update();
        return material;
    }

    private createDebugMaterial() {
        const material = new StandardMaterial();
        material.name = 'ProxyDebug';
        material.diffuse = new Color(0.1, 0.9, 0.8);
        material.opacity = 0.18;
        material.blendType = BLEND_NORMAL;
        material.depthWrite = false;
        material.update();
        return material;
    }

    private registerEvents() {
        this.events.function('proxyMesh.createBox', (descriptor: ProxyMeshDescriptor = {}) => {
            return this.create({ ...descriptor, kind: 'box' });
        });

        this.events.function('proxyMesh.createPlane', (descriptor: ProxyMeshDescriptor = {}) => {
            return this.create({ ...descriptor, kind: 'plane' });
        });

        this.events.function('proxyMesh.list', () => this.serialize());
        this.events.function('proxyMesh.serialize', () => this.serialize());

        this.events.function('proxyMesh.raycast', (start: Vec3Like, end: Vec3Like, options: ProxyRaycastOptions = {}) => {
            const hits = this.raycast(start, end, options);
            return options.first ? hits[0] ?? null : hits;
        });

        this.events.function('proxyMesh.projectToGround', (position: Vec3Like, height = 1000) => {
            const p = toVec3(position, new Vec3());
            return this.raycast(
                new Vec3(p.x, p.y + height, p.z),
                new Vec3(p.x, p.y - height, p.z),
                { first: true, navigation: true }
            )[0] ?? null;
        });

        this.events.on('proxyMesh.import', (descriptors: ProxyMeshDescriptor[] = []) => {
            this.import(descriptors);
        });

        this.events.on('proxyMesh.remove', (id: string) => {
            this.remove(id);
        });

        this.events.on('proxyMesh.clear', () => {
            this.clear();
        });
    }

    private create(descriptor: ProxyMeshDescriptor) {
        const kind = descriptor.kind ?? 'box';
        const position = toVec3(descriptor.position, new Vec3());
        const rotation = toVec3(descriptor.rotation, new Vec3());
        const size = toVec3(descriptor.size, kind === 'plane' ? defaultPlaneSize : defaultBoxSize);
        const id = descriptor.id ?? makeId();

        this.remove(id);

        const entity = new Entity(`ProxyMesh:${id}`);
        entity.setLocalPosition(position);
        entity.setLocalEulerAngles(rotation);
        entity.setLocalScale(size);

        const depthOccluder = descriptor.depthOccluder ?? false;
        const debugVisible = descriptor.debugVisible ?? false;
        if (depthOccluder || debugVisible) {
            entity.addComponent('render', {
                type: 'box',
                material: debugVisible ? this.debugMaterial : this.material
            });
        }
        entity.enabled = depthOccluder || debugVisible;
        this.root.addChild(entity);

        const record: ProxyMeshRecord = {
            id,
            kind,
            entity,
            position,
            rotation,
            size,
            raycast: descriptor.raycast ?? true,
            navigation: descriptor.navigation ?? kind === 'plane',
            depthOccluder,
            debugVisible
        };

        this.records.set(id, record);
        this.scene.forceRender = true;
        this.events.fire('proxyMesh.added', this.serializeOne(record));
        return this.serializeOne(record);
    }

    private import(descriptors: ProxyMeshDescriptor[]) {
        this.clear();
        descriptors.forEach(descriptor => this.create(descriptor));
        this.events.fire('proxyMesh.changed', this.serialize());
    }

    private remove(id: string) {
        const record = this.records.get(id);
        if (!record) {
            return;
        }

        record.entity.destroy();
        this.records.delete(id);
        this.scene.forceRender = true;
        this.events.fire('proxyMesh.removed', id);
    }

    private clear() {
        Array.from(this.records.keys()).forEach(id => this.remove(id));
    }

    private serializeOne(record: ProxyMeshRecord): Required<ProxyMeshDescriptor> {
        return {
            id: record.id,
            kind: record.kind,
            position: toTuple(record.position),
            rotation: toTuple(record.rotation),
            size: toTuple(record.size),
            raycast: record.raycast,
            navigation: record.navigation,
            depthOccluder: record.depthOccluder,
            debugVisible: record.debugVisible
        };
    }

    private serialize() {
        return Array.from(this.records.values()).map(record => this.serializeOne(record));
    }

    private raycast(startLike: Vec3Like, endLike: Vec3Like, options: ProxyRaycastOptions) {
        const start = toVec3(startLike, new Vec3());
        const end = toVec3(endLike, new Vec3());
        const hits: ProxyRaycastHit[] = [];

        this.records.forEach((record) => {
            if (!record.raycast) {
                return;
            }

            if (options.navigation && !record.navigation) {
                return;
            }

            if (options.depthOccluder && !record.depthOccluder) {
                return;
            }

            const hit = record.kind === 'plane' ?
                this.raycastPlane(record, start, end) :
                this.raycastBox(record, start, end);

            if (hit) {
                hits.push(hit);
            }
        });

        hits.sort((a, b) => a.distance - b.distance);
        return options.first ? hits.slice(0, 1) : hits;
    }

    private raycastPlane(record: ProxyMeshRecord, start: Vec3, end: Vec3): ProxyRaycastHit | null {
        const dy = end.y - start.y;
        if (Math.abs(dy) < 0.00001) {
            return null;
        }

        const t = (record.position.y - start.y) / dy;
        if (t < 0 || t > 1) {
            return null;
        }

        const point = start.clone().lerp(start, end, t);
        const halfX = record.size.x * 0.5;
        const halfZ = record.size.z * 0.5;
        if (
            point.x < record.position.x - halfX ||
            point.x > record.position.x + halfX ||
            point.z < record.position.z - halfZ ||
            point.z > record.position.z + halfZ
        ) {
            return null;
        }

        return {
            id: record.id,
            kind: record.kind,
            point,
            normal: start.y >= record.position.y ? up.clone() : down.clone(),
            distance: point.distance(start),
            entity: record.entity
        };
    }

    private raycastBox(record: ProxyMeshRecord, start: Vec3, end: Vec3): ProxyRaycastHit | null {
        const min = record.position.clone().sub(record.size.clone().mulScalar(0.5));
        const max = record.position.clone().add(record.size.clone().mulScalar(0.5));
        const direction = end.clone().sub(start);
        const length = direction.length();
        if (length <= 0.00001) {
            return null;
        }
        direction.mulScalar(1 / length);

        let near = 0;
        let far = length;
        let axis = -1;
        let axisSign = 1;

        const slab = (origin: number, dir: number, minValue: number, maxValue: number, index: number) => {
            if (Math.abs(dir) < 0.00001) {
                return origin >= minValue && origin <= maxValue;
            }

            let t1 = (minValue - origin) / dir;
            let t2 = (maxValue - origin) / dir;
            let sign = -1;
            if (t1 > t2) {
                const tmp = t1;
                t1 = t2;
                t2 = tmp;
                sign = 1;
            }

            if (t1 > near) {
                near = t1;
                axis = index;
                axisSign = sign;
            }
            far = Math.min(far, t2);
            return near <= far;
        };

        if (!slab(start.x, direction.x, min.x, max.x, 0)) return null;
        if (!slab(start.y, direction.y, min.y, max.y, 1)) return null;
        if (!slab(start.z, direction.z, min.z, max.z, 2)) return null;

        if (far < 0 || near > length) {
            return null;
        }

        const distance = Math.max(0, near);
        const point = start.clone().add(direction.clone().mulScalar(distance));
        const normal = new Vec3();
        if (axis === 0) normal.x = axisSign;
        if (axis === 1) normal.y = axisSign;
        if (axis === 2) normal.z = axisSign;

        return {
            id: record.id,
            kind: record.kind,
            point,
            normal,
            distance,
            entity: record.entity
        };
    }
}

const registerProxyMeshEvents = (events: Events, scene: Scene) => {
    return new ProxyMeshSystem(events, scene);
};

export { registerProxyMeshEvents };
export type { ProxyMeshDescriptor, ProxyRaycastHit, ProxyRaycastOptions };
