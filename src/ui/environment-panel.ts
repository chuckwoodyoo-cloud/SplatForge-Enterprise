import { BooleanInput, Container, Label, SelectInput, SliderInput } from '@playcanvas/pcui';

import { EnvironmentSettings } from '../environment';
import { Events } from '../events';
import { WeatherSettings } from '../weather-system';
import { localize } from './localization';
import { Tooltips } from './tooltips';

class EnvironmentPanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'environment-panel',
            class: 'panel',
            hidden: true
        };

        super(args);

        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        const header = new Container({
            class: 'panel-header'
        });

        const icon = new Label({
            text: '\uE341',
            class: 'panel-header-icon'
        });

        const label = new Label({
            text: localize('panel.environment'),
            class: 'panel-header-label'
        });

        header.append(icon);
        header.append(label);

        const presetRow = new Container({
            class: 'environment-panel-row'
        });

        const presetLabel = new Label({
            text: localize('panel.environment.preset'),
            class: 'environment-panel-row-label'
        });

        const presetSelect = new SelectInput({
            class: 'environment-panel-row-select',
            defaultValue: 'custom',
            options: [
                { v: 'day', t: localize('panel.environment.preset.day') },
                { v: 'dusk', t: localize('panel.environment.preset.dusk') },
                { v: 'night', t: localize('panel.environment.preset.night') },
                { v: 'overcast', t: localize('panel.environment.preset.overcast') },
                { v: 'custom', t: localize('panel.environment.preset.custom') }
            ]
        });

        presetRow.append(presetLabel);
        presetRow.append(presetSelect);

        const exposureRow = new Container({
            class: 'environment-panel-row'
        });

        const exposureLabel = new Label({
            text: localize('panel.environment.exposure'),
            class: 'environment-panel-row-label'
        });

        const exposureSlider = new SliderInput({
            class: 'environment-panel-row-slider',
            min: 0.2,
            max: 2.5,
            precision: 2,
            value: 1
        });

        exposureRow.append(exposureLabel);
        exposureRow.append(exposureSlider);

        const fogRow = new Container({
            class: 'environment-panel-row'
        });

        const fogLabel = new Label({
            text: localize('panel.environment.fog'),
            class: 'environment-panel-row-label'
        });

        const fogSlider = new SliderInput({
            class: 'environment-panel-row-slider',
            min: 0,
            max: 0.04,
            precision: 3,
            value: 0
        });

        fogRow.append(fogLabel);
        fogRow.append(fogSlider);

        const weatherRow = new Container({
            class: 'environment-panel-row'
        });

        const weatherLabel = new Label({
            text: localize('panel.environment.weather'),
            class: 'environment-panel-row-label'
        });

        const weatherSelect = new SelectInput({
            class: 'environment-panel-row-select',
            defaultValue: 'clear',
            options: [
                { v: 'clear', t: localize('panel.environment.weather.clear') },
                { v: 'rain', t: localize('panel.environment.weather.rain') },
                { v: 'snow', t: localize('panel.environment.weather.snow') },
                { v: 'fog', t: localize('panel.environment.weather.fog') },
                { v: 'cloudy', t: localize('panel.environment.weather.cloudy') },
                { v: 'storm', t: localize('panel.environment.weather.storm') },
                { v: 'timeline', t: localize('panel.environment.weather.timeline') }
            ]
        });

        weatherRow.append(weatherLabel);
        weatherRow.append(weatherSelect);

        const weatherIntensityRow = new Container({
            class: 'environment-panel-row'
        });

        const weatherIntensityLabel = new Label({
            text: localize('panel.environment.weatherIntensity'),
            class: 'environment-panel-row-label'
        });

        const weatherIntensitySlider = new SliderInput({
            class: 'environment-panel-row-slider',
            min: 0,
            max: 1,
            precision: 2,
            value: 0.6
        });

        weatherIntensityRow.append(weatherIntensityLabel);
        weatherIntensityRow.append(weatherIntensitySlider);

        const weatherTimeRow = new Container({
            class: 'environment-panel-row'
        });

        const weatherTimeLabel = new Label({
            text: localize('panel.environment.weatherTime'),
            class: 'environment-panel-row-label'
        });

        const weatherTimeSlider = new SliderInput({
            class: 'environment-panel-row-slider',
            min: 0,
            max: 24,
            precision: 1,
            value: 12
        });

        weatherTimeRow.append(weatherTimeLabel);
        weatherTimeRow.append(weatherTimeSlider);

        const weatherTimelineRow = new Container({
            class: 'environment-panel-row'
        });

        const weatherTimelineLabel = new Label({
            text: localize('panel.environment.weatherTimelinePlaying'),
            class: 'environment-panel-row-label'
        });

        const weatherTimelineToggle = new BooleanInput({
            type: 'toggle',
            class: 'environment-panel-row-toggle',
            value: false
        });

        weatherTimelineRow.append(weatherTimelineLabel);
        weatherTimelineRow.append(weatherTimelineToggle);

        this.append(header);
        this.append(presetRow);
        this.append(exposureRow);
        this.append(fogRow);
        this.append(weatherRow);
        this.append(weatherIntensityRow);
        this.append(weatherTimeRow);
        this.append(weatherTimelineRow);

        const setVisible = (visible: boolean) => {
            if (visible === this.hidden) {
                this.hidden = !visible;
                events.fire('environmentPanel.visible', visible);
            }
        };

        events.function('environmentPanel.visible', () => !this.hidden);

        events.on('environmentPanel.setVisible', (visible: boolean) => {
            setVisible(visible);
        });

        events.on('environmentPanel.toggleVisible', () => {
            setVisible(this.hidden);
        });

        events.on('viewPanel.visible', (visible: boolean) => {
            if (visible) {
                setVisible(false);
            }
        });

        events.on('colorPanel.visible', (visible: boolean) => {
            if (visible) {
                setVisible(false);
            }
        });

        presetSelect.on('change', (value: string) => {
            events.fire('environment.setPreset', value);
        });

        exposureSlider.on('change', (value: number) => {
            events.fire('environment.setExposure', value);
        });

        fogSlider.on('change', (value: number) => {
            events.fire('environment.setFogDensity', value);
        });

        weatherSelect.on('change', (value: string) => {
            events.fire('weather.setMode', value);
        });

        weatherIntensitySlider.on('change', (value: number) => {
            events.fire('weather.setIntensity', value);
        });

        weatherTimeSlider.on('change', (value: number) => {
            events.fire('weather.setTimelineTime', value);
        });

        weatherTimelineToggle.on('change', (value: boolean) => {
            events.fire('weather.setTimelinePlaying', value);
        });

        events.on('environment.settings', (settings: EnvironmentSettings) => {
            presetSelect.value = settings.preset;
            exposureSlider.value = settings.exposure;
            fogSlider.value = settings.fog.density;
        });

        events.on('weather.settings', (settings: WeatherSettings) => {
            weatherSelect.value = settings.mode;
            weatherIntensitySlider.value = settings.intensity;
            weatherTimeSlider.value = settings.timelineTime;
            weatherTimelineToggle.value = settings.timelinePlaying;
        });

        events.on('weather.timeline', (settings: { time: number, playing: boolean }) => {
            weatherTimeSlider.value = settings.time;
            weatherTimelineToggle.value = settings.playing;
        });

        tooltips.register(presetSelect, localize('panel.environment.preset'), 'left');
        tooltips.register(exposureSlider, localize('panel.environment.exposure'), 'left');
        tooltips.register(fogSlider, localize('panel.environment.fog'), 'left');
        tooltips.register(weatherSelect, localize('panel.environment.weather'), 'left');
        tooltips.register(weatherIntensitySlider, localize('panel.environment.weatherIntensity'), 'left');
        tooltips.register(weatherTimeSlider, localize('panel.environment.weatherTime'), 'left');
        tooltips.register(weatherTimelineToggle, localize('panel.environment.weatherTimelinePlaying'), 'left');
    }
}

export { EnvironmentPanel };
