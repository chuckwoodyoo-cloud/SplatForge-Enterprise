import {
    BLEND_NORMAL,
    Color,
    Curve,
    CurveSet,
    EMITTERSHAPE_BOX,
    Entity,
    PARTICLEMODE_GPU,
    PARTICLEORIENTATION_WORLD,
    Vec3
} from 'playcanvas';

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

const cameraPosition = new Vec3();

const WEATHER_DEFAULTS: WeatherSettings = {
    mode: 'clear',
    intensity: 0.6
};

const cloneSettings = (settings: WeatherSettings): WeatherSettings => ({
    mode: settings.mode,
    intensity: settings.intensity
});

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

class WeatherSystem {
    private events: Events;
    private scene: Scene;
    private root: Entity;
    private rain: Entity | null = null;
    private snow: Entity | null = null;
    private lightning: Entity;
    private baseFog: FogSnapshot;
    private settings = cloneSettings(WEATHER_DEFAULTS);
    private lightningDelay = 1.5;
    private lightningPulse = 0;

    constructor(events: Events, scene: Scene) {
        this.events = events;
        this.scene = scene;
        this.root = new Entity('WeatherSystem');
        this.scene.app.root.addChild(this.root);

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

        if (this.scene.app.systems.particlesystem) {
            this.rain = this.createRain();
            this.snow = this.createSnow();
            this.root.addChild(this.rain);
            this.root.addChild(this.snow);
        }

        this.apply();
        this.registerEvents();
    }

    private registerEvents() {
        this.events.function('weather.settings', () => cloneSettings(this.settings));
        this.events.function('weather.mode', () => this.settings.mode);

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

    private createRain() {
        const entity = new Entity('Rain');
        entity.addComponent('particlesystem', {
            autoPlay: false,
            loop: true,
            preWarm: true,
            numParticles: 700,
            lifetime: 1.7,
            rate: 0.005,
            rate2: 0.018,
            emitterShape: EMITTERSHAPE_BOX,
            emitterExtents: new Vec3(22, 5, 22),
            localSpace: false,
            wrap: true,
            wrapBounds: new Vec3(22, 10, 22),
            mode: PARTICLEMODE_GPU,
            lighting: false,
            stretch: 0.72,
            alignToMotion: true,
            depthWrite: false,
            blendType: BLEND_NORMAL,
            orientation: PARTICLEORIENTATION_WORLD,
            scaleGraph: new Curve([0, 0.09, 1, 0.09]),
            alphaGraph: new Curve([0, 0, 0.12, 0.65, 0.88, 0.55, 1, 0]),
            colorGraph: new CurveSet([
                [0, 0.66, 1, 0.66],
                [0, 0.78, 1, 0.78],
                [0, 0.92, 1, 0.92]
            ]),
            velocityGraph: new CurveSet([
                [0, -1.1, 1, -1.1],
                [0, -14, 1, -14],
                [0, 0.45, 1, 0.45]
            ])
        });
        entity.enabled = false;
        return entity;
    }

    private createSnow() {
        const entity = new Entity('Snow');
        entity.addComponent('particlesystem', {
            autoPlay: false,
            loop: true,
            preWarm: true,
            numParticles: 420,
            lifetime: 4.2,
            rate: 0.018,
            rate2: 0.05,
            emitterShape: EMITTERSHAPE_BOX,
            emitterExtents: new Vec3(24, 5, 24),
            localSpace: false,
            wrap: true,
            wrapBounds: new Vec3(24, 10, 24),
            mode: PARTICLEMODE_GPU,
            lighting: false,
            depthWrite: false,
            blendType: BLEND_NORMAL,
            orientation: PARTICLEORIENTATION_WORLD,
            scaleGraph: new Curve([0, 0.13, 1, 0.08]),
            alphaGraph: new Curve([0, 0, 0.15, 0.75, 0.82, 0.65, 1, 0]),
            colorGraph: new CurveSet([
                [0, 0.94, 1, 0.94],
                [0, 0.97, 1, 0.97],
                [0, 1, 1, 1]
            ]),
            velocityGraph: new CurveSet([
                [0, -0.35, 1, 0.25],
                [0, -2.1, 1, -1.4],
                [0, 0.15, 1, -0.35]
            ])
        });
        entity.enabled = false;
        return entity;
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
        const mode = this.settings.mode;
        const intensity = this.settings.intensity;
        const showRain = mode === 'rain' || mode === 'storm';
        const showSnow = mode === 'snow';

        if (this.rain) {
            this.rain.enabled = showRain;
            this.rain.particlesystem.numParticles = Math.round(320 + intensity * 900);
            this.rain.particlesystem.intensity = 0.55 + intensity * 0.9;
            if (showRain) {
                this.rain.particlesystem.reset();
                this.rain.particlesystem.play();
            } else {
                this.rain.particlesystem.stop();
            }
        }

        if (this.snow) {
            this.snow.enabled = showSnow;
            this.snow.particlesystem.numParticles = Math.round(180 + intensity * 520);
            this.snow.particlesystem.intensity = 0.6 + intensity * 0.6;
            if (showSnow) {
                this.snow.particlesystem.reset();
                this.snow.particlesystem.play();
            } else {
                this.snow.particlesystem.stop();
            }
        }

        if (this.usesWeatherFog()) {
            this.writeFog(this.weatherFog());
        } else {
            this.writeFog(this.baseFog);
        }

        this.lightning.light.intensity = 0;
        this.scene.forceRender = true;
        this.events.fire('weather.settings', cloneSettings(this.settings));
    }

    private update(deltaTime: number) {
        const activeParticles = this.rain?.enabled || this.snow?.enabled;
        if (activeParticles) {
            cameraPosition.copy(this.scene.camera.position);
            this.root.setLocalPosition(cameraPosition.x, cameraPosition.y + 8, cameraPosition.z);
            this.scene.forceRender = true;
        }

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
