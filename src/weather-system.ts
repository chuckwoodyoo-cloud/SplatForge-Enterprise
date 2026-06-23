import { Color, Entity, Vec3 } from 'playcanvas';

import { Events } from './events';
import { Scene } from './scene';

type WeatherMode = 'clear' | 'rain' | 'snow' | 'fog' | 'cloudy' | 'storm';

type WeatherSettings = {
    mode: WeatherMode,
    intensity: number
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

type WeatherRenderStats = {
    mode: WeatherMode,
    intensity: number,
    rainSegments: number,
    snowSegments: number
};

const cameraPosition = new Vec3();
const rainColor = new Color(0.62, 0.78, 1, 0.72);
const snowColor = new Color(0.96, 0.99, 1, 0.9);
const rainWind = new Vec3(-0.58, -1, 0.14).normalize();

const WEATHER_DEFAULTS: WeatherSettings = {
    mode: 'clear',
    intensity: 0.6
};

const cloneSettings = (settings: WeatherSettings): WeatherSettings => ({
    mode: settings.mode,
    intensity: settings.intensity
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
    private rainLinePositions: number[] = [];
    private snowLinePositions: number[] = [];
    private renderStats: WeatherRenderStats = {
        mode: 'clear',
        intensity: 0.6,
        rainSegments: 0,
        snowSegments: 0
    };
    private lightningDelay = 1.5;
    private lightningPulse = 0;

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
        this.events.function('weather.renderStats', () => ({ ...this.renderStats }));

        this.events.on('weather.setMode', (mode: WeatherMode) => {
            this.setSettings({ mode });
        });

        this.events.on('weather.setIntensity', (intensity: number) => {
            this.setSettings({ intensity });
        });

        this.events.on('weather.setSettings', (settings: Partial<WeatherSettings>) => {
            this.setSettings(settings);
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
        this.settings = {
            mode: next.mode ?? this.settings.mode,
            intensity: clamp(next.intensity ?? this.settings.intensity, 0, 1)
        };
        this.apply();
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

    private usesWeatherFog() {
        return this.settings.mode === 'fog' || this.settings.mode === 'cloudy' || this.settings.mode === 'storm';
    }

    private weatherFog(): FogSnapshot {
        const intensity = this.settings.intensity;

        if (this.settings.mode === 'storm') {
            return {
                type: 'exp2',
                color: [0.08, 0.1, 0.12],
                density: 0.01 + intensity * 0.018,
                start: 12,
                end: 150
            };
        }

        if (this.settings.mode === 'cloudy') {
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
        if (this.usesWeatherFog()) {
            this.writeFog(this.weatherFog());
        } else {
            this.writeFog(this.baseFog);
        }

        this.lightning.light.intensity = 0;
        this.renderStats = {
            mode: this.settings.mode,
            intensity: this.settings.intensity,
            rainSegments: 0,
            snowSegments: 0
        };
        this.scene.forceRender = true;
        this.events.fire('weather.settings', cloneSettings(this.settings));
    }

    private update(deltaTime: number) {
        const mode = this.settings.mode;
        const intensity = this.settings.intensity;
        const showRain = mode === 'rain' || mode === 'storm';
        const showSnow = mode === 'snow';

        this.prepareOverlay(showRain || showSnow);

        if (showRain || showSnow) {
            cameraPosition.copy(this.scene.camera.position);
            this.root.setLocalPosition(cameraPosition);
        }

        let rainSegments = 0;
        let snowSegments = 0;

        if (showRain) {
            rainSegments = this.drawRain(deltaTime, intensity);
        }

        if (showSnow) {
            snowSegments = this.drawSnow(deltaTime, intensity);
        }

        this.renderStats = {
            mode,
            intensity,
            rainSegments,
            snowSegments
        };

        if (showRain || showSnow) {
            this.scene.forceRender = true;
        }

        this.updateLightning(deltaTime);
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

    private updateLightning(deltaTime: number) {
        if (this.settings.mode !== 'storm') {
            return;
        }

        this.lightningDelay -= deltaTime;
        if (this.lightningDelay <= 0) {
            this.lightningPulse = 0.16 + Math.random() * 0.12;
            this.lightningDelay = 2.4 + Math.random() * 4.5;
            this.events.fire('weather.lightning');
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
}

const registerWeatherEvents = (events: Events, scene: Scene) => {
    return new WeatherSystem(events, scene);
};

export { WEATHER_DEFAULTS, registerWeatherEvents };
export type { WeatherMode, WeatherSettings };
