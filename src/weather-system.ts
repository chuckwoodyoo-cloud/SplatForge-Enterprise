import { Color, Entity, Vec3 } from 'playcanvas';

import { Events } from './events';
import { Scene } from './scene';

type WeatherMode = 'clear' | 'rain' | 'snow' | 'fog' | 'cloudy' | 'storm' | 'timeline';
type WeatherResolvedMode = Exclude<WeatherMode, 'timeline'>;

type WeatherSettings = {
    mode: WeatherMode,
    intensity: number,
    timelineTime: number,
    timelinePlaying: boolean
};

type WeatherTimelineState = {
    time: number,
    playing: boolean,
    resolvedMode: WeatherResolvedMode
};

type FogSnapshot = {
    type: string,
    color: [number, number, number],
    density: number,
    start: number,
    end: number
};

type WeatherParticle = {
    x: number,
    y: number,
    z: number,
    speed: number,
    length: number,
    drift: number,
    size: number,
    phase: number
};

type SurfacePatch = {
    x: number,
    y: number,
    width: number,
    height: number,
    phase: number,
    alpha: number
};

type LensDrop = {
    x: number,
    y: number,
    radius: number,
    speed: number,
    length: number,
    alpha: number,
    phase: number
};

type WeatherRenderStats = {
    mode: WeatherMode,
    resolvedMode: WeatherResolvedMode,
    intensity: number,
    rainSegments: number,
    snowSegments: number,
    puddles: number,
    snowCover: number,
    lensDrops: number,
    lightning: boolean,
    timelineTime: number,
    timelinePlaying: boolean
};

const cameraPosition = new Vec3();
const rainColor = new Color(0.62, 0.78, 1, 0.72);
const snowColor = new Color(0.96, 0.99, 1, 0.9);
const rainWind = new Vec3(-0.58, -1, 0.14).normalize();

const WEATHER_DEFAULTS: WeatherSettings = {
    mode: 'clear',
    intensity: 0.6,
    timelineTime: 12,
    timelinePlaying: false
};

const cloneSettings = (settings: WeatherSettings): WeatherSettings => ({
    mode: settings.mode,
    intensity: settings.intensity,
    timelineTime: settings.timelineTime,
    timelinePlaying: settings.timelinePlaying
});

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const randomRange = (min: number, max: number) => min + Math.random() * (max - min);

class WeatherSystem {
    private events: Events;
    private scene: Scene;
    private root: Entity;
    private lightning: Entity;
    private overlay: HTMLCanvasElement;
    private overlayContext: CanvasRenderingContext2D | null;
    private overlayScale = 1;
    private baseFog: FogSnapshot;
    private settings = cloneSettings(WEATHER_DEFAULTS);
    private rain = this.createParticles(420, 'rain');
    private snow = this.createParticles(260, 'snow');
    private surfacePatches = this.createSurfacePatches(22);
    private snowCoverPatches = this.createSurfacePatches(18);
    private lensDrops = this.createLensDrops(34);
    private rainLinePositions: number[] = [];
    private snowLinePositions: number[] = [];
    private renderStats: WeatherRenderStats = {
        mode: 'clear',
        resolvedMode: 'clear',
        intensity: 0.6,
        rainSegments: 0,
        snowSegments: 0,
        puddles: 0,
        snowCover: 0,
        lensDrops: 0,
        lightning: false,
        timelineTime: 12,
        timelinePlaying: false
    };
    private lightningDelay = 1.5;
    private lightningPulse = 0;
    private lightningSeed = Math.random();
    private timelineEmitDelay = 0;

    constructor(events: Events, scene: Scene) {
        this.events = events;
        this.scene = scene;
        this.root = new Entity('WeatherSystem');
        this.scene.app.root.addChild(this.root);
        this.overlay = document.createElement('canvas');
        this.overlay.id = 'weather-canvas';
        this.overlay.hidden = true;
        this.overlayContext = this.overlay.getContext('2d');
        document.getElementById('canvas-container')?.appendChild(this.overlay);

        this.baseFog = this.readFog();
        this.lightning = new Entity('WeatherLightning');
        this.lightning.addComponent('light', {
            type: 'directional',
            color: new Color(0.72, 0.82, 1),
            intensity: 0,
            castShadows: false
        });
        this.lightning.setLocalEulerAngles(55, -30, 0);
        this.root.addChild(this.lightning);

        this.apply();
        this.registerEvents();
    }

    private registerEvents() {
        this.events.function('weather.settings', () => cloneSettings(this.settings));
        this.events.function('weather.mode', () => this.settings.mode);
        this.events.function('weather.resolvedMode', () => this.resolvedMode());
        this.events.function('weather.timelineState', () => this.timelineState());
        this.events.function('weather.renderStats', () => ({ ...this.renderStats }));
        this.events.function('weather.forceLightning', () => this.triggerLightning(true));

        this.events.on('weather.setMode', (mode: WeatherMode) => {
            this.setSettings({ mode });
        });

        this.events.on('weather.setIntensity', (intensity: number) => {
            this.setSettings({ intensity });
        });

        this.events.on('weather.setSettings', (settings: Partial<WeatherSettings>) => {
            this.setSettings(settings);
        });

        this.events.on('weather.setTimelineTime', (timelineTime: number) => {
            this.setSettings({ timelineTime });
        });

        this.events.on('weather.setTimelinePlaying', (timelinePlaying: boolean) => {
            this.setSettings({ timelinePlaying });
        });

        this.events.on('environment.settings', (settings: { fog?: FogSnapshot }) => {
            if (!this.usesWeatherFog()) {
                this.baseFog = {
                    type: settings.fog?.type ?? this.baseFog.type,
                    color: settings.fog?.color ?? this.baseFog.color,
                    density: settings.fog?.density ?? this.baseFog.density,
                    start: settings.fog?.start ?? this.baseFog.start,
                    end: settings.fog?.end ?? this.baseFog.end
                };
            }
        });

        this.events.on('update', (deltaTime: number) => {
            this.update(deltaTime);
        });
    }

    private setSettings(next: Partial<WeatherSettings>) {
        const previousMode = this.settings.mode;
        const previousResolvedMode = this.resolvedMode();
        const previousTimelineTime = this.settings.timelineTime;
        const previousTimelinePlaying = this.settings.timelinePlaying;

        this.settings = {
            mode: next.mode ?? this.settings.mode,
            intensity: clamp(next.intensity ?? this.settings.intensity, 0, 1),
            timelineTime: this.normalizeTimelineTime(next.timelineTime ?? this.settings.timelineTime),
            timelinePlaying: next.timelinePlaying ?? this.settings.timelinePlaying
        };
        this.apply();

        const resolvedMode = this.resolvedMode();
        if (previousMode !== this.settings.mode || previousResolvedMode !== resolvedMode) {
            this.fireWeatherChange(previousResolvedMode);
        }

        if (
            previousTimelineTime !== this.settings.timelineTime ||
            previousTimelinePlaying !== this.settings.timelinePlaying
        ) {
            this.fireTimeline();
        }
    }

    private createParticles(count: number, kind: 'rain' | 'snow') {
        return Array.from({ length: count }, () => this.resetParticle({
            x: 0,
            y: 0,
            z: 0,
            speed: 0,
            length: 0,
            drift: 0,
            size: 0,
            phase: Math.random() * Math.PI * 2
        }, kind));
    }

    private createSurfacePatches(count: number) {
        return Array.from({ length: count }, (): SurfacePatch => ({
            x: randomRange(0.05, 0.95),
            y: randomRange(0.02, 0.98),
            width: randomRange(0.025, 0.11),
            height: randomRange(0.005, 0.024),
            phase: randomRange(0, Math.PI * 2),
            alpha: randomRange(0.45, 1)
        }));
    }

    private createLensDrops(count: number) {
        return Array.from({ length: count }, (): LensDrop => this.resetLensDrop({
            x: 0,
            y: 0,
            radius: 0,
            speed: 0,
            length: 0,
            alpha: 0,
            phase: 0
        }, true));
    }

    private resetParticle(particle: WeatherParticle, kind: 'rain' | 'snow') {
        const radius = kind === 'rain' ? 17 : 19;
        particle.x = randomRange(-radius, radius);
        particle.y = randomRange(-5, 10);
        particle.z = randomRange(4, 34);
        particle.phase = randomRange(0, Math.PI * 2);

        if (kind === 'rain') {
            particle.speed = randomRange(16, 25);
            particle.length = randomRange(1.4, 2.4);
            particle.drift = randomRange(-0.35, 0.35);
            particle.size = 0;
        } else {
            particle.speed = randomRange(1.4, 3.2);
            particle.length = 0;
            particle.drift = randomRange(-0.85, 0.85);
            particle.size = randomRange(0.08, 0.18);
        }

        return particle;
    }

    private resetLensDrop(drop: LensDrop, anywhere = false) {
        drop.x = randomRange(0.04, 0.96);
        drop.y = anywhere ? randomRange(-0.15, 0.95) : randomRange(-0.28, -0.04);
        drop.radius = randomRange(0.004, 0.013);
        drop.speed = randomRange(0.05, 0.18);
        drop.length = randomRange(0.035, 0.14);
        drop.alpha = randomRange(0.32, 0.88);
        drop.phase = randomRange(0, Math.PI * 2);
        return drop;
    }

    private normalizeTimelineTime(time: number) {
        const wrapped = time % 24;
        return wrapped < 0 ? wrapped + 24 : wrapped;
    }

    private resolvedMode(): WeatherResolvedMode {
        if (this.settings.mode !== 'timeline') {
            return this.settings.mode;
        }

        const time = this.settings.timelineTime;
        if (time < 5) return 'snow';
        if (time < 8) return 'fog';
        if (time < 13) return 'clear';
        if (time < 16) return 'cloudy';
        if (time < 19) return 'rain';
        if (time < 21) return 'storm';
        return 'fog';
    }

    private timelineState(): WeatherTimelineState {
        return {
            time: this.settings.timelineTime,
            playing: this.settings.timelinePlaying,
            resolvedMode: this.resolvedMode()
        };
    }

    private fireTimeline() {
        this.events.fire('weather.timeline', this.timelineState());
    }

    private fireWeatherChange(previousResolvedMode: WeatherResolvedMode) {
        const resolvedMode = this.resolvedMode();
        const payload = {
            mode: this.settings.mode,
            resolvedMode,
            previousMode: previousResolvedMode,
            time: this.settings.timelineTime
        };

        this.events.fire('weather.changed', payload);

        if (previousResolvedMode !== resolvedMode) {
            this.events.fire('weather.trigger', {
                type: 'weather-exit',
                mode: previousResolvedMode,
                nextMode: resolvedMode,
                time: this.settings.timelineTime
            });
            this.events.fire('weather.trigger', {
                type: 'weather-enter',
                mode: resolvedMode,
                previousMode: previousResolvedMode,
                time: this.settings.timelineTime
            });
        }
    }

    private readFog(): FogSnapshot {
        const fog = this.scene.app.scene.fog;
        return {
            type: fog.type,
            color: [fog.color.r, fog.color.g, fog.color.b],
            density: fog.density,
            start: fog.start,
            end: fog.end
        };
    }

    private writeFog(fog: FogSnapshot) {
        const target = this.scene.app.scene.fog;
        target.type = fog.type;
        target.color.set(fog.color[0], fog.color[1], fog.color[2]);
        target.density = fog.density;
        target.start = fog.start;
        target.end = fog.end;
    }

    private usesWeatherFog(mode = this.resolvedMode()) {
        return mode === 'fog' || mode === 'cloudy' || mode === 'storm';
    }

    private weatherFog(mode = this.resolvedMode()): FogSnapshot {
        const intensity = this.settings.intensity;

        if (mode === 'storm') {
            return {
                type: 'exp2',
                color: [0.08, 0.1, 0.12],
                density: 0.01 + intensity * 0.018,
                start: 12,
                end: 150
            };
        }

        if (mode === 'cloudy') {
            return {
                type: 'exp2',
                color: [0.46, 0.49, 0.52],
                density: 0.006 + intensity * 0.014,
                start: 20,
                end: 220
            };
        }

        return {
            type: 'exp2',
            color: [0.62, 0.66, 0.68],
            density: 0.012 + intensity * 0.026,
            start: 8,
            end: 130
        };
    }

    private apply() {
        const resolvedMode = this.resolvedMode();

        if (this.usesWeatherFog(resolvedMode)) {
            this.writeFog(this.weatherFog(resolvedMode));
        } else {
            this.writeFog(this.baseFog);
        }

        this.lightning.light.intensity = 0;
        this.renderStats = {
            mode: this.settings.mode,
            resolvedMode,
            intensity: this.settings.intensity,
            rainSegments: 0,
            snowSegments: 0,
            puddles: 0,
            snowCover: 0,
            lensDrops: 0,
            lightning: false,
            timelineTime: this.settings.timelineTime,
            timelinePlaying: this.settings.timelinePlaying
        };
        this.scene.forceRender = true;
        this.events.fire('weather.settings', cloneSettings(this.settings));
        this.fireTimeline();
    }

    private update(deltaTime: number) {
        this.updateTimeline(deltaTime);

        const mode = this.resolvedMode();
        const intensity = this.settings.intensity;
        const showRain = mode === 'rain' || mode === 'storm';
        const showSnow = mode === 'snow';
        const showOverlay = showRain || showSnow || this.lightningPulse > 0;

        this.prepareOverlay(showOverlay);

        if (showOverlay) {
            cameraPosition.copy(this.scene.camera.position);
            this.root.setLocalPosition(cameraPosition);
        }

        let rainSegments = 0;
        let snowSegments = 0;
        let puddles = 0;
        let snowCover = 0;
        let lensDrops = 0;

        this.updateLightning(deltaTime, mode);

        if (showRain) {
            rainSegments = this.drawRain(deltaTime, intensity);
            puddles = this.drawPuddlesOverlay(deltaTime, intensity);
            lensDrops = this.drawLensDropsOverlay(deltaTime, intensity);
        }

        if (showSnow) {
            snowSegments = this.drawSnow(deltaTime, intensity);
            snowCover = this.drawSnowCoverOverlay(deltaTime, intensity);
        }

        if (this.lightningPulse > 0) {
            this.drawLightningOverlay(intensity);
        }

        this.renderStats = {
            mode: this.settings.mode,
            resolvedMode: mode,
            intensity,
            rainSegments,
            snowSegments,
            puddles,
            snowCover,
            lensDrops,
            lightning: this.lightningPulse > 0,
            timelineTime: this.settings.timelineTime,
            timelinePlaying: this.settings.timelinePlaying
        };

        if (showOverlay) {
            this.scene.forceRender = true;
        }
    }

    private updateTimeline(deltaTime: number) {
        if (this.settings.mode !== 'timeline' || !this.settings.timelinePlaying) {
            return;
        }

        const previousResolvedMode = this.resolvedMode();
        this.settings.timelineTime = this.normalizeTimelineTime(this.settings.timelineTime + deltaTime * 0.35);
        const resolvedMode = this.resolvedMode();

        if (previousResolvedMode !== resolvedMode) {
            this.apply();
            this.fireWeatherChange(previousResolvedMode);
        }

        this.timelineEmitDelay -= deltaTime;
        if (this.timelineEmitDelay <= 0) {
            this.events.fire('weather.settings', cloneSettings(this.settings));
            this.fireTimeline();
            this.timelineEmitDelay = 0.25;
        }
    }

    private prepareOverlay(active: boolean) {
        const ctx = this.overlayContext;
        if (!ctx) {
            return;
        }

        if (!active) {
            if (!this.overlay.hidden) {
                ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
                this.overlay.hidden = true;
            }
            return;
        }

        this.overlay.hidden = false;
        const rect = this.overlay.getBoundingClientRect();
        this.overlayScale = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.ceil(rect.width * this.overlayScale));
        const height = Math.max(1, Math.ceil(rect.height * this.overlayScale));

        if (this.overlay.width !== width || this.overlay.height !== height) {
            this.overlay.width = width;
            this.overlay.height = height;
        }

        ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    }

    private particleToWorld(particle: WeatherParticle, out: number[], index: number) {
        const camera = this.scene.camera.mainCamera;
        const right = camera.right;
        const up = camera.up;
        const forward = camera.forward;
        const origin = this.scene.camera.position;

        out[index] = origin.x + right.x * particle.x + up.x * particle.y + forward.x * particle.z;
        out[index + 1] = origin.y + right.y * particle.x + up.y * particle.y + forward.y * particle.z;
        out[index + 2] = origin.z + right.z * particle.x + up.z * particle.y + forward.z * particle.z;
    }

    private drawRain(deltaTime: number, intensity: number) {
        const count = Math.min(this.rain.length, Math.round(90 + intensity * this.rain.length));
        const positions = this.rainLinePositions;
        positions.length = count * 6;

        for (let i = 0; i < count; i++) {
            const particle = this.rain[i];
            particle.y -= particle.speed * deltaTime;
            particle.x += (particle.drift - 0.65) * deltaTime;

            if (particle.y < -8 || particle.x < -20 || particle.x > 20) {
                this.resetParticle(particle, 'rain');
                particle.y = randomRange(7, 13);
            }

            const index = i * 6;
            this.particleToWorld(particle, positions, index);
            positions[index + 3] = positions[index] + rainWind.x * particle.length;
            positions[index + 4] = positions[index + 1] + rainWind.y * particle.length;
            positions[index + 5] = positions[index + 2] + rainWind.z * particle.length;
        }

        this.scene.app.drawLineArrays(positions, rainColor, false, this.scene.gizmoLayer);
        this.drawRainOverlay(count);
        return count;
    }

    private drawSnow(deltaTime: number, intensity: number) {
        const count = Math.min(this.snow.length, Math.round(60 + intensity * this.snow.length));
        const positions = this.snowLinePositions;
        positions.length = count * 12;

        const camera = this.scene.camera.mainCamera;
        const right = camera.right;
        const up = camera.up;

        for (let i = 0; i < count; i++) {
            const particle = this.snow[i];
            particle.phase += deltaTime * 1.6;
            particle.y -= particle.speed * deltaTime;
            particle.x += (Math.sin(particle.phase) * 0.55 + particle.drift) * deltaTime;

            if (particle.y < -7 || particle.x < -21 || particle.x > 21) {
                this.resetParticle(particle, 'snow');
                particle.y = randomRange(7, 13);
            }

            const index = i * 12;
            this.particleToWorld(particle, positions, index);
            const cx = positions[index];
            const cy = positions[index + 1];
            const cz = positions[index + 2];
            const half = particle.size * (0.75 + intensity * 0.75);

            positions[index] = cx - right.x * half;
            positions[index + 1] = cy - right.y * half;
            positions[index + 2] = cz - right.z * half;
            positions[index + 3] = cx + right.x * half;
            positions[index + 4] = cy + right.y * half;
            positions[index + 5] = cz + right.z * half;
            positions[index + 6] = cx - up.x * half;
            positions[index + 7] = cy - up.y * half;
            positions[index + 8] = cz - up.z * half;
            positions[index + 9] = cx + up.x * half;
            positions[index + 10] = cy + up.y * half;
            positions[index + 11] = cz + up.z * half;
        }

        this.scene.app.drawLineArrays(positions, snowColor, false, this.scene.gizmoLayer);
        this.drawSnowOverlay(count);
        return count * 2;
    }

    private drawRainOverlay(count: number) {
        const ctx = this.overlayContext;
        if (!ctx) {
            return;
        }

        const width = this.overlay.width;
        const height = this.overlay.height;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(1, 1.2 * this.overlayScale);
        ctx.strokeStyle = 'rgba(165, 205, 255, 0.68)';
        ctx.shadowColor = 'rgba(120, 170, 255, 0.28)';
        ctx.shadowBlur = 3 * this.overlayScale;

        for (let i = 0; i < count; i++) {
            const particle = this.rain[i];
            const x = width * ((particle.x + 20) / 40);
            const y = height * ((13 - particle.y) / 21);
            const length = particle.length * 18 * this.overlayScale;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x - length * 0.42, y + length);
            ctx.stroke();
        }

        ctx.restore();
    }

    private drawSnowOverlay(count: number) {
        const ctx = this.overlayContext;
        if (!ctx) {
            return;
        }

        const width = this.overlay.width;
        const height = this.overlay.height;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.fillStyle = 'rgba(248, 252, 255, 0.9)';
        ctx.strokeStyle = 'rgba(248, 252, 255, 0.7)';
        ctx.shadowColor = 'rgba(220, 240, 255, 0.45)';
        ctx.shadowBlur = 4 * this.overlayScale;

        for (let i = 0; i < count; i++) {
            const particle = this.snow[i];
            const x = width * ((particle.x + 21) / 42);
            const y = height * ((13 - particle.y) / 20);
            const radius = Math.max(1.2, particle.size * 18 * this.overlayScale);
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fill();

            if (i % 3 === 0) {
                ctx.lineWidth = Math.max(1, 0.8 * this.overlayScale);
                ctx.beginPath();
                ctx.moveTo(x - radius * 1.7, y);
                ctx.lineTo(x + radius * 1.7, y);
                ctx.moveTo(x, y - radius * 1.7);
                ctx.lineTo(x, y + radius * 1.7);
                ctx.stroke();
            }
        }

        ctx.restore();
    }

    private drawPuddlesOverlay(deltaTime: number, intensity: number) {
        const ctx = this.overlayContext;
        if (!ctx) {
            return 0;
        }

        const width = this.overlay.width;
        const height = this.overlay.height;
        const count = Math.min(this.surfacePatches.length, Math.round(8 + intensity * this.surfacePatches.length));
        const groundTop = height * 0.58;
        const groundHeight = height * 0.38;

        ctx.save();
        ctx.lineCap = 'round';
        for (let i = 0; i < count; i++) {
            const patch = this.surfacePatches[i];
            patch.phase += deltaTime * (0.9 + intensity);
            const x = patch.x * width;
            const y = groundTop + patch.y * groundHeight;
            const patchWidth = patch.width * width * (1.2 + patch.y * 1.8);
            const patchHeight = patch.height * height * (1.4 + patch.y);
            const alpha = (0.08 + intensity * 0.17) * patch.alpha;
            const ripple = 0.5 + Math.sin(patch.phase) * 0.5;

            const gradient = ctx.createRadialGradient(x, y, patchHeight * 0.2, x, y, patchWidth);
            gradient.addColorStop(0, `rgba(186, 218, 255, ${alpha})`);
            gradient.addColorStop(0.62, `rgba(95, 150, 210, ${alpha * 0.55})`);
            gradient.addColorStop(1, 'rgba(58, 97, 140, 0)');

            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.ellipse(x, y, patchWidth, patchHeight, -0.08, 0, Math.PI * 2);
            ctx.fill();

            ctx.strokeStyle = `rgba(208, 230, 255, ${alpha * (0.35 + ripple * 0.35)})`;
            ctx.lineWidth = Math.max(1, 0.8 * this.overlayScale);
            ctx.beginPath();
            ctx.ellipse(x, y, patchWidth * (0.42 + ripple * 0.18), patchHeight * (0.5 + ripple * 0.15), 0, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.restore();

        return count;
    }

    private drawSnowCoverOverlay(deltaTime: number, intensity: number) {
        const ctx = this.overlayContext;
        if (!ctx) {
            return 0;
        }

        const width = this.overlay.width;
        const height = this.overlay.height;
        const count = Math.min(this.snowCoverPatches.length, Math.round(6 + intensity * this.snowCoverPatches.length));
        const baseY = height * (0.72 - intensity * 0.04);

        ctx.save();
        const gradient = ctx.createLinearGradient(0, baseY - height * 0.08, 0, height);
        gradient.addColorStop(0, `rgba(250, 253, 255, ${0.02 + intensity * 0.06})`);
        gradient.addColorStop(0.35, `rgba(238, 247, 255, ${0.12 + intensity * 0.2})`);
        gradient.addColorStop(1, `rgba(215, 232, 244, ${0.26 + intensity * 0.26})`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(0, height);
        ctx.lineTo(0, baseY);
        for (let i = 0; i <= 8; i++) {
            const x = width * (i / 8);
            const y = baseY + Math.sin(i * 1.9 + deltaTime) * height * 0.012;
            ctx.lineTo(x, y);
        }
        ctx.lineTo(width, height);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = `rgba(248, 252, 255, ${0.16 + intensity * 0.28})`;
        ctx.strokeStyle = `rgba(220, 236, 248, ${0.12 + intensity * 0.18})`;
        ctx.lineWidth = Math.max(1, 0.9 * this.overlayScale);
        for (let i = 0; i < count; i++) {
            const patch = this.snowCoverPatches[i];
            patch.phase += deltaTime * 0.35;
            const x = patch.x * width;
            const y = baseY + patch.y * height * 0.24;
            const patchWidth = patch.width * width * (1.4 + patch.y * 1.5);
            const patchHeight = patch.height * height * 2.3;

            ctx.beginPath();
            ctx.ellipse(x, y, patchWidth, patchHeight, 0.02, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
        ctx.restore();

        return count;
    }

    private drawLensDropsOverlay(deltaTime: number, intensity: number) {
        const ctx = this.overlayContext;
        if (!ctx) {
            return 0;
        }

        const width = this.overlay.width;
        const height = this.overlay.height;
        const count = Math.min(this.lensDrops.length, Math.round(5 + intensity * this.lensDrops.length));

        ctx.save();
        ctx.lineCap = 'round';
        for (let i = 0; i < count; i++) {
            const drop = this.lensDrops[i];
            drop.phase += deltaTime * 1.8;
            drop.y += drop.speed * deltaTime * (0.6 + intensity);
            drop.x += Math.sin(drop.phase) * deltaTime * 0.008;

            if (drop.y > 1.08 || drop.x < -0.05 || drop.x > 1.05) {
                this.resetLensDrop(drop);
            }

            const x = drop.x * width;
            const y = drop.y * height;
            const radius = Math.max(2.2, drop.radius * width);
            const alpha = drop.alpha * (0.25 + intensity * 0.45);

            const gradient = ctx.createRadialGradient(x - radius * 0.25, y - radius * 0.35, 1, x, y, radius * 1.35);
            gradient.addColorStop(0, `rgba(255, 255, 255, ${alpha * 0.75})`);
            gradient.addColorStop(0.46, `rgba(166, 205, 255, ${alpha * 0.28})`);
            gradient.addColorStop(1, `rgba(72, 118, 170, ${alpha * 0.08})`);

            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.ellipse(x, y, radius * 0.72, radius, 0.08, 0, Math.PI * 2);
            ctx.fill();

            ctx.strokeStyle = `rgba(210, 232, 255, ${alpha * 0.38})`;
            ctx.lineWidth = Math.max(1, radius * 0.16);
            ctx.beginPath();
            ctx.moveTo(x + radius * 0.12, y + radius * 0.9);
            ctx.lineTo(x - radius * 0.34, y + height * drop.length);
            ctx.stroke();
        }
        ctx.restore();

        return count;
    }

    private drawLightningOverlay(intensity: number) {
        const ctx = this.overlayContext;
        if (!ctx) {
            return;
        }

        const width = this.overlay.width;
        const height = this.overlay.height;
        const flash = clamp(this.lightningPulse / 0.22, 0, 1) * intensity;
        const startX = width * (0.22 + (this.lightningSeed % 0.56));
        const segments = 7;

        ctx.save();
        ctx.fillStyle = `rgba(210, 224, 255, ${flash * 0.18})`;
        ctx.fillRect(0, 0, width, height);

        ctx.shadowColor = `rgba(190, 215, 255, ${flash})`;
        ctx.shadowBlur = 22 * this.overlayScale;
        ctx.strokeStyle = `rgba(245, 250, 255, ${0.58 + flash * 0.42})`;
        ctx.lineWidth = Math.max(2, (2.2 + flash * 3.2) * this.overlayScale);
        ctx.beginPath();
        ctx.moveTo(startX, 0);
        for (let i = 1; i <= segments; i++) {
            const bend = Math.sin(i * 8.13 + this.lightningSeed * 100) * width * 0.035;
            const jag = ((i % 2 === 0 ? 1 : -1) * width * 0.028) + bend;
            ctx.lineTo(startX + jag, height * (0.08 + i * 0.072));
        }
        ctx.stroke();

        ctx.shadowBlur = 12 * this.overlayScale;
        ctx.strokeStyle = `rgba(170, 205, 255, ${0.28 + flash * 0.32})`;
        ctx.lineWidth = Math.max(1, 1.2 * this.overlayScale);
        ctx.beginPath();
        ctx.moveTo(startX + width * 0.025, height * 0.18);
        ctx.lineTo(startX + width * 0.11, height * 0.31);
        ctx.lineTo(startX + width * 0.04, height * 0.42);
        ctx.stroke();
        ctx.restore();
    }

    private updateLightning(deltaTime: number, mode = this.resolvedMode()) {
        if (mode === 'storm') {
            this.lightningDelay -= deltaTime;
            if (this.lightningDelay <= 0) {
                this.triggerLightning();
            }
        }

        if (this.lightningPulse > 0) {
            this.lightningPulse = Math.max(0, this.lightningPulse - deltaTime);
            this.lightning.light.intensity = (this.lightningPulse > 0.06 ? 3.2 : 1.4) * this.settings.intensity;
            this.scene.forceRender = true;
        } else if (this.lightning.light.intensity !== 0) {
            this.lightning.light.intensity = 0;
            this.scene.forceRender = true;
        }
    }

    private triggerLightning(force = false) {
        const mode = this.resolvedMode();
        if (!force && mode !== 'storm') {
            return false;
        }

        this.lightningPulse = 0.18 + Math.random() * 0.13;
        this.lightningDelay = 2.4 + Math.random() * 4.5;
        this.lightningSeed = Math.random();
        this.events.fire('weather.lightning');
        this.events.fire('weather.trigger', {
            type: 'lightning',
            mode,
            time: this.settings.timelineTime
        });
        this.scene.forceRender = true;
        return true;
    }
}

const registerWeatherEvents = (events: Events, scene: Scene) => {
    return new WeatherSystem(events, scene);
};

export { WEATHER_DEFAULTS, registerWeatherEvents };
export type { WeatherMode, WeatherSettings };
