import { BLEND_NONE, BLEND_NORMAL, Color, Entity, StandardMaterial, Vec3 } from 'playcanvas';

import { Events } from './events';
import { Scene } from './scene';
import type { WeatherMode } from './weather-system';

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

type ProxyCollisionOptions = {
    radius?: number,
    navigation?: boolean,
    silent?: boolean
};

type ProxyCollisionHit = {
    id: string,
    kind: ProxyMeshKind,
    normal: Vec3,
    penetration: number
};

type ProxyCollisionResult = {
    position: Vec3,
    grounded: boolean,
    moved: boolean,
    hits: ProxyCollisionHit[]
};

type PatrolRouteDescriptor = {
    id?: string,
    points?: Vec3Like[],
    speed?: number,
    loop?: boolean,
    weather?: WeatherMode[]
};

type PatrolRouteRecord = {
    id: string,
    points: Vec3[],
    speed: number,
    loop: boolean,
    weather: WeatherMode[] | null,
    index: number,
    position: Vec3,
    active: boolean,
    weatherPaused: boolean
};

const defaultBoxSize = new Vec3(4, 1, 4);
const defaultPlaneSize = new Vec3(60, 0.02, 60);
const up = new Vec3(0, 1, 0);
const down = new Vec3(0, -1, 0);
const patrolRouteColor = new Color(0.18, 0.88, 1, 0.7);
const patrolAgentColor = new Color(1, 0.84, 0.26, 0.95);

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
    private patrolRoutes = new Map<string, PatrolRouteRecord>();
    private patrolEnabled = false;
    private currentWeatherMode: WeatherMode = 'clear';

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

        this.events.function('proxyMesh.resolveCollision', (
            position: Vec3Like,
            radiusOrOptions: number | ProxyCollisionOptions = 0.35,
            options: ProxyCollisionOptions = {}
        ) => {
            const collisionOptions = typeof radiusOrOptions === 'number' ?
                { ...options, radius: radiusOrOptions } :
                radiusOrOptions;
            return this.serializeCollision(this.resolveCollision(position, collisionOptions));
        });

        this.events.function('proxyMesh.createPatrolRoute', (descriptor: PatrolRouteDescriptor = {}) => {
            return this.createPatrolRoute(descriptor);
        });

        this.events.function('proxyMesh.listPatrolRoutes', () => this.serializePatrolRoutes());
        this.events.function('proxyMesh.patrolState', () => this.serializePatrolRoutes());
        this.events.function('proxyMesh.setPatrolEnabled', (enabled: boolean) => this.setPatrolEnabled(enabled));

        this.events.on('proxyMesh.import', (descriptors: ProxyMeshDescriptor[] = []) => {
            this.import(descriptors);
        });

        this.events.on('proxyMesh.remove', (id: string) => {
            this.remove(id);
        });

        this.events.on('proxyMesh.clear', () => {
            this.clear();
        });

        this.events.on('proxyMesh.removePatrolRoute', (id: string) => {
            this.removePatrolRoute(id);
        });

        this.events.on('proxyMesh.clearPatrolRoutes', () => {
            this.clearPatrolRoutes();
        });

        this.events.on('proxyMesh.setPatrolEnabled', (enabled: boolean) => {
            this.setPatrolEnabled(enabled);
        });

        this.events.on('weather.changed', (state: { resolvedMode?: WeatherMode }) => {
            if (state.resolvedMode) {
                this.currentWeatherMode = state.resolvedMode;
            }
        });

        this.events.on('weather.trigger', (event: { type?: string, mode?: WeatherMode }) => {
            if (event.type === 'weather-enter' && event.mode) {
                this.currentWeatherMode = event.mode;
                this.events.fire('proxyMesh.weatherTrigger', {
                    mode: event.mode,
                    patrol: this.serializePatrolRoutes()
                });
            }
        });

        this.events.on('update', (deltaTime: number) => {
            this.updatePatrol(deltaTime);
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

    private resolveCollision(positionLike: Vec3Like, options: ProxyCollisionOptions = {}): ProxyCollisionResult {
        const radius = Math.max(0.01, options.radius ?? 0.35);
        const position = toVec3(positionLike, new Vec3());
        const original = position.clone();
        const hits: ProxyCollisionHit[] = [];
        let grounded = false;

        this.records.forEach((record) => {
            if (!record.raycast) {
                return;
            }

            if (record.kind === 'plane') {
                if (options.navigation === false || !record.navigation) {
                    return;
                }

                const halfX = record.size.x * 0.5;
                const halfZ = record.size.z * 0.5;
                const insideX = position.x >= record.position.x - halfX && position.x <= record.position.x + halfX;
                const insideZ = position.z >= record.position.z - halfZ && position.z <= record.position.z + halfZ;
                const bottom = position.y - radius;

                if (insideX && insideZ && bottom <= record.position.y && position.y >= record.position.y - 3) {
                    const penetration = record.position.y - bottom;
                    position.y += penetration;
                    grounded = true;
                    hits.push({
                        id: record.id,
                        kind: record.kind,
                        normal: up.clone(),
                        penetration
                    });
                }
                return;
            }

            const half = record.size.clone().mulScalar(0.5);
            const min = record.position.clone().sub(half).sub(new Vec3(radius, radius, radius));
            const max = record.position.clone().add(half).add(new Vec3(radius, radius, radius));
            const inside = position.x >= min.x && position.x <= max.x &&
                position.y >= min.y && position.y <= max.y &&
                position.z >= min.z && position.z <= max.z;

            if (!inside) {
                return;
            }

            const pushes = [
                { axis: 'x', sign: -1, amount: position.x - min.x },
                { axis: 'x', sign: 1, amount: max.x - position.x },
                { axis: 'y', sign: -1, amount: position.y - min.y },
                { axis: 'y', sign: 1, amount: max.y - position.y },
                { axis: 'z', sign: -1, amount: position.z - min.z },
                { axis: 'z', sign: 1, amount: max.z - position.z }
            ].sort((a, b) => a.amount - b.amount);

            const push = pushes[0];
            const normal = new Vec3();
            if (push.axis === 'x') {
                position.x += push.amount * push.sign;
                normal.x = push.sign;
            } else if (push.axis === 'y') {
                position.y += push.amount * push.sign;
                normal.y = push.sign;
                grounded = push.sign > 0;
            } else {
                position.z += push.amount * push.sign;
                normal.z = push.sign;
            }

            hits.push({
                id: record.id,
                kind: record.kind,
                normal,
                penetration: push.amount
            });
        });

        const result = {
            position,
            grounded,
            moved: position.distance(original) > 0.0001,
            hits
        };

        if (result.moved && !options.silent) {
            this.events.fire('proxyMesh.collision', this.serializeCollision(result));
        }

        return result;
    }

    private serializeCollision(result: ProxyCollisionResult) {
        return {
            position: toTuple(result.position),
            grounded: result.grounded,
            moved: result.moved,
            hits: result.hits.map(hit => ({
                id: hit.id,
                kind: hit.kind,
                normal: toTuple(hit.normal),
                penetration: hit.penetration
            }))
        };
    }

    private createPatrolRoute(descriptor: PatrolRouteDescriptor) {
        const points = (descriptor.points ?? []).map(point => toVec3(point, new Vec3()));
        if (points.length < 2) {
            return null;
        }

        const id = descriptor.id ?? `patrol-${Math.random().toString(36).slice(2, 9)}`;
        const route: PatrolRouteRecord = {
            id,
            points,
            speed: Math.max(0.05, descriptor.speed ?? 1.5),
            loop: descriptor.loop ?? true,
            weather: descriptor.weather?.length ? [...descriptor.weather] : null,
            index: 1,
            position: points[0].clone(),
            active: true,
            weatherPaused: false
        };

        this.patrolRoutes.set(id, route);
        this.scene.forceRender = true;
        this.events.fire('proxyMesh.patrolChanged', this.serializePatrolRoutes());
        return this.serializePatrolRoute(route);
    }

    private removePatrolRoute(id: string) {
        if (!this.patrolRoutes.delete(id)) {
            return;
        }

        this.scene.forceRender = true;
        this.events.fire('proxyMesh.patrolChanged', this.serializePatrolRoutes());
    }

    private clearPatrolRoutes() {
        if (this.patrolRoutes.size === 0) {
            return;
        }

        this.patrolRoutes.clear();
        this.scene.forceRender = true;
        this.events.fire('proxyMesh.patrolChanged', this.serializePatrolRoutes());
    }

    private setPatrolEnabled(enabled: boolean) {
        this.patrolEnabled = enabled;
        this.scene.forceRender = true;
        this.events.fire('proxyMesh.patrolEnabled', enabled);
        return enabled;
    }

    private serializePatrolRoute(route: PatrolRouteRecord) {
        return {
            id: route.id,
            points: route.points.map(point => toTuple(point)),
            speed: route.speed,
            loop: route.loop,
            weather: route.weather ? [...route.weather] : null,
            index: route.index,
            position: toTuple(route.position),
            active: route.active,
            weatherPaused: route.weatherPaused
        };
    }

    private serializePatrolRoutes() {
        return {
            enabled: this.patrolEnabled,
            weatherMode: this.currentWeatherMode,
            routes: Array.from(this.patrolRoutes.values()).map(route => this.serializePatrolRoute(route))
        };
    }

    private updatePatrol(deltaTime: number) {
        if (!this.patrolEnabled || this.patrolRoutes.size === 0) {
            return;
        }

        this.patrolRoutes.forEach((route) => {
            route.weatherPaused = !!route.weather && !route.weather.includes(this.currentWeatherMode);

            if (route.active && !route.weatherPaused) {
                this.advancePatrolRoute(route, deltaTime);
            }

            this.drawPatrolRoute(route);
        });

        this.scene.forceRender = true;
    }

    private advancePatrolRoute(route: PatrolRouteRecord, deltaTime: number) {
        let remaining = route.speed * deltaTime;

        while (remaining > 0 && route.active) {
            const target = route.points[route.index];
            const distance = route.position.distance(target);

            if (distance <= 0.001) {
                this.advancePatrolIndex(route);
                continue;
            }

            const step = Math.min(remaining, distance);
            const direction = target.clone().sub(route.position).normalize();
            route.position.add(direction.mulScalar(step));
            remaining -= step;

            if (step >= distance - 0.001) {
                this.advancePatrolIndex(route);
            }
        }

        const collision = this.resolveCollision(route.position, {
            radius: 0.35,
            silent: true
        });
        route.position.copy(collision.position);
    }

    private advancePatrolIndex(route: PatrolRouteRecord) {
        const previousIndex = route.index;
        route.index += 1;

        if (route.index >= route.points.length) {
            if (route.loop) {
                route.index = 0;
            } else {
                route.index = route.points.length - 1;
                route.active = false;
            }
        }

        if (previousIndex !== route.index) {
            this.events.fire('proxyMesh.patrolWaypoint', this.serializePatrolRoute(route));
        }
    }

    private drawPatrolRoute(route: PatrolRouteRecord) {
        if (route.points.length < 2) {
            return;
        }

        const positions: number[] = [];
        for (let i = 0; i < route.points.length - 1; i++) {
            this.pushLine(positions, route.points[i], route.points[i + 1]);
        }
        if (route.loop) {
            this.pushLine(positions, route.points[route.points.length - 1], route.points[0]);
        }

        this.scene.app.drawLineArrays(positions, patrolRouteColor, false, this.scene.gizmoLayer);

        const markerSize = route.weatherPaused ? 0.26 : 0.42;
        const marker: number[] = [];
        this.pushLine(marker,
            route.position.clone().add(new Vec3(-markerSize, 0, 0)),
            route.position.clone().add(new Vec3(markerSize, 0, 0))
        );
        this.pushLine(marker,
            route.position.clone().add(new Vec3(0, -markerSize, 0)),
            route.position.clone().add(new Vec3(0, markerSize, 0))
        );
        this.pushLine(marker,
            route.position.clone().add(new Vec3(0, 0, -markerSize)),
            route.position.clone().add(new Vec3(0, 0, markerSize))
        );
        this.scene.app.drawLineArrays(marker, patrolAgentColor, false, this.scene.gizmoLayer);
    }

    private pushLine(positions: number[], start: Vec3, end: Vec3) {
        positions.push(start.x, start.y, start.z, end.x, end.y, end.z);
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
export type {
    PatrolRouteDescriptor,
    ProxyCollisionOptions,
    ProxyMeshDescriptor,
    ProxyRaycastHit,
    ProxyRaycastOptions
};
