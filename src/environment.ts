import { Color } from 'playcanvas';

import { Events } from './events';
import { Scene } from './scene';

type ColorTuple = [number, number, number];
type EnvironmentPresetId = 'day' | 'dusk' | 'night' | 'overcast' | 'custom';

type EnvironmentSettings = {
    preset: EnvironmentPresetId,
    background: ColorTuple,
    ambient: ColorTuple,
    exposure: number,
    toneMapping: string,
    fog: {
        type: string,
        color: ColorTuple,
        density: number,
        start: number,
        end: number
    }
};

const ENVIRONMENT_PRESETS: Record<Exclude<EnvironmentPresetId, 'custom'>, EnvironmentSettings> = {
    day: {
        preset: 'day',
        background: [0.62, 0.78, 0.96],
        ambient: [0.78, 0.82, 0.88],
        exposure: 1.08,
        toneMapping: 'neutral',
        fog: {
            type: 'none',
            color: [0.72, 0.82, 0.92],
            density: 0,
            start: 80,
            end: 420
        }
    },
    dusk: {
        preset: 'dusk',
        background: [0.48, 0.24, 0.16],
        ambient: [0.72, 0.42, 0.28],
        exposure: 0.86,
        toneMapping: 'filmic',
        fog: {
            type: 'exp2',
            color: [0.55, 0.32, 0.24],
            density: 0.004,
            start: 35,
            end: 260
        }
    },
    night: {
        preset: 'night',
        background: [0.02, 0.035, 0.07],
        ambient: [0.14, 0.18, 0.28],
        exposure: 0.48,
        toneMapping: 'aces',
        fog: {
            type: 'exp2',
            color: [0.05, 0.07, 0.12],
            density: 0.008,
            start: 25,
            end: 180
        }
    },
    overcast: {
        preset: 'overcast',
        background: [0.42, 0.46, 0.5],
        ambient: [0.56, 0.58, 0.6],
        exposure: 0.92,
        toneMapping: 'neutral',
        fog: {
            type: 'exp2',
            color: [0.55, 0.58, 0.6],
            density: 0.012,
            start: 18,
            end: 190
        }
    }
};

const toColor = (value: ColorTuple) => new Color(value[0], value[1], value[2]);

const toTuple = (color: Color): ColorTuple => {
    return [color.r, color.g, color.b];
};

const cloneSettings = (settings: EnvironmentSettings): EnvironmentSettings => {
    return {
        preset: settings.preset,
        background: [...settings.background] as ColorTuple,
        ambient: [...settings.ambient] as ColorTuple,
        exposure: settings.exposure,
        toneMapping: settings.toneMapping,
        fog: {
            type: settings.fog.type,
            color: [...settings.fog.color] as ColorTuple,
            density: settings.fog.density,
            start: settings.fog.start,
            end: settings.fog.end
        }
    };
};

const clamp = (value: number, min: number, max: number) => {
    return Math.max(min, Math.min(max, value));
};

const registerEnvironmentEvents = (events: Events, scene: Scene) => {
    const readCurrentSettings = (): EnvironmentSettings => {
        const appScene = scene.app.scene;
        const bgClr = events.invoke('bgClr') as Color;
        return {
            preset: 'custom',
            background: bgClr ? toTuple(bgClr) : [0, 0, 0],
            ambient: toTuple(appScene.ambientLight),
            exposure: appScene.exposure,
            toneMapping: scene.camera.tonemapping,
            fog: {
                type: appScene.fog.type,
                color: toTuple(appScene.fog.color),
                density: appScene.fog.density,
                start: appScene.fog.start,
                end: appScene.fog.end
            }
        };
    };

    let settings = readCurrentSettings();

    const emitSettings = () => {
        events.fire('environment.preset', settings.preset);
        events.fire('environment.settings', cloneSettings(settings));
    };

    const applySettings = (next: EnvironmentSettings) => {
        const appScene = scene.app.scene;

        settings = cloneSettings(next);
        events.fire('setBgClr', toColor(settings.background));
        appScene.ambientLight.copy(toColor(settings.ambient));
        appScene.exposure = settings.exposure;
        scene.camera.tonemapping = settings.toneMapping;

        appScene.fog.type = settings.fog.type;
        appScene.fog.color.copy(toColor(settings.fog.color));
        appScene.fog.density = settings.fog.density;
        appScene.fog.start = settings.fog.start;
        appScene.fog.end = settings.fog.end;

        scene.forceRender = true;
        emitSettings();
    };

    events.function('environment.preset', () => settings.preset);
    events.function('environment.settings', () => cloneSettings(settings));

    events.on('environment.setPreset', (preset: EnvironmentPresetId) => {
        if (preset === 'custom') {
            settings.preset = 'custom';
            emitSettings();
            return;
        }

        const presetSettings = ENVIRONMENT_PRESETS[preset];
        if (presetSettings) {
            applySettings(presetSettings);
        }
    });

    events.on('environment.setSettings', (next: Partial<EnvironmentSettings>) => {
        const merged = cloneSettings(settings);
        merged.preset = next.preset ?? 'custom';
        merged.background = next.background ?? merged.background;
        merged.ambient = next.ambient ?? merged.ambient;
        merged.exposure = next.exposure ?? merged.exposure;
        merged.toneMapping = next.toneMapping ?? merged.toneMapping;
        merged.fog = {
            ...merged.fog,
            ...next.fog
        };
        applySettings(merged);
    });

    events.on('environment.setExposure', (value: number) => {
        const next = cloneSettings(settings);
        next.preset = 'custom';
        next.exposure = clamp(value, 0.2, 2.5);
        applySettings(next);
    });

    events.on('environment.setFogDensity', (value: number) => {
        const next = cloneSettings(settings);
        next.preset = 'custom';
        next.fog.density = clamp(value, 0, 0.04);
        next.fog.type = next.fog.density > 0 ? 'exp2' : 'none';
        applySettings(next);
    });

    emitSettings();
};

export { ENVIRONMENT_PRESETS, registerEnvironmentEvents };
export type { EnvironmentPresetId, EnvironmentSettings };
