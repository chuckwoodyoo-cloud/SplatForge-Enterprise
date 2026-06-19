import { Container, Label, version as pcuiVersion, revision as pcuiRevision } from '@playcanvas/pcui';
import { version as engineVersion, revision as engineRevision } from 'playcanvas';

import { version as appVersion } from '../../package.json';

// Inline SVG for the enterprise shell logo
const logoSvg = `
<svg xmlns='http://www.w3.org/2000/svg' width="74" height="74" viewBox='0 0 74 74'>
  <rect x='5' y='5' width='64' height='64' rx='8' fill='#071112' stroke='#33d6c5' stroke-opacity='.55'/>
  <path d='M18 50h38M22 56 52 18M22 18l30 38' stroke='#33d6c5' stroke-width='3' stroke-linecap='round'/>
  <path d='M37 17 55 27v20L37 57 19 47V27z' fill='none' stroke='#ffb86b' stroke-width='3'/>
  <path d='M27 37h20M37 27v20' stroke='#f6fffc' stroke-opacity='.7' stroke-width='2'/>
  <circle cx='37' cy='37' r='5' fill='#f04f45'/>
  <circle cx='19' cy='27' r='3' fill='#33d6c5'/>
  <circle cx='55' cy='47' r='3' fill='#ffb86b'/>
</svg>
`;

class AboutPopup extends Container {
    constructor(args = {}) {
        args = {
            ...args,
            id: 'about-popup',
            hidden: true,
            tabIndex: -1
        };

        super(args);

        // Handle keyboard events
        this.dom.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                this.hidden = true;
            }
            e.stopPropagation();
        });

        // Close when clicking outside dialog
        this.on('click', () => {
            this.hidden = true;
        });

        const dialog = new Container({
            id: 'about-dialog'
        });

        // Prevent clicks inside dialog from closing
        dialog.on('click', (event: MouseEvent) => {
            event.stopPropagation();
        });

        // Header bar
        const header = new Label({
            id: 'about-header',
            text: 'About'
        });

        // Content area
        const content = new Container({
            id: 'about-content'
        });

        // Logo
        const logoContainer = new Container({
            id: 'about-logo'
        });
        logoContainer.dom.innerHTML = logoSvg;

        // App name and version
        const appInfo = new Container({
            id: 'about-app-info'
        });

        const appName = new Label({
            id: 'about-app-name',
            text: 'SplatForge Enterprise'
        });

        const appVersionLabel = new Label({
            id: 'about-app-version',
            text: `v${appVersion}`
        });

        appInfo.append(appName);
        appInfo.append(appVersionLabel);

        // Dependencies
        const depsContainer = new Container({
            id: 'about-deps'
        });

        // PCUI
        const pcuiRow = new Container({
            class: 'about-dep-row'
        });
        pcuiRow.dom.addEventListener('click', () => {
            window.open('https://github.com/playcanvas/pcui', '_blank')?.focus();
        });
        const pcuiName = new Label({ class: 'about-dep-name', text: 'PCUI' });
        const pcuiVersionL = new Label({ class: 'about-dep-version', text: `v${pcuiVersion}` });
        const pcuiRev = new Label({ class: 'about-dep-revision', text: `(${pcuiRevision.substring(0, 7)})` });
        pcuiRow.append(pcuiName);
        pcuiRow.append(pcuiVersionL);
        pcuiRow.append(pcuiRev);

        // Engine
        const engineRow = new Container({
            class: 'about-dep-row'
        });
        engineRow.dom.addEventListener('click', () => {
            window.open('https://github.com/playcanvas/engine', '_blank')?.focus();
        });
        const engineName = new Label({ class: 'about-dep-name', text: 'PlayCanvas Runtime' });
        const engineVer = new Label({ class: 'about-dep-version', text: `v${engineVersion}` });
        const engineRev = new Label({ class: 'about-dep-revision', text: `(${engineRevision.substring(0, 7)})` });
        engineRow.append(engineName);
        engineRow.append(engineVer);
        engineRow.append(engineRev);

        depsContainer.append(pcuiRow);
        depsContainer.append(engineRow);

        // Assemble content
        content.append(logoContainer);
        content.append(appInfo);
        content.append(depsContainer);

        // Assemble dialog
        dialog.append(header);
        dialog.append(content);

        this.append(dialog);

        // Focus when shown so keyboard events work
        this.on('show', () => {
            this.dom.focus();
        });
    }
}

export { AboutPopup };
