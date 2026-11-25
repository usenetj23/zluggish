
export const themes = [
    {id: "sauce", name: "Zluggish Default"},
    {id: "aqua", name: "Aqua Salad"},
    {id: "blue-moon", name: "Blue Moon"},
    {id: "dark", name: "Dark"},
    {id: "green", name: "Green Lantern"},
    {id: "bluepink", name: "Ice Blue Pink"},
    {id: "light", name: "Light"},
    {id: "red-sun", name: "Red Sun"},
    {id: "burgundy", name: "Ron Burgundy"},
    {id: "gpt-sunset", name: "Sunset"},
    {id: "gpt-vibrant", name: "Vibrant"},
    {id: "watermelon", name: "Watermelon"},
    {id: "transparent-dark", name: "Dark", group: "Transparent"},
    {id: "forced-background", name: "Forced Background", group: "Transparent"},
    {id: "transparent-light", name: "Light", group: "Transparent"},
    {id: "semi-transparent-dark", name: "Semi", group: "Transparent"},
    {id: "random", name: "Random (new each time)", group: "Generated"},
    {id: "custom", name: "Custom", group: "Generated"},
    {id: "glass", name: "Glass", group: "Materials"},
    {id: "liquid-glass", name: "Liquid Glass", group: "Materials"},
    {id: "metallic", name: "Metallic", group: "Materials"},
    {id: "foil", name: "Foil", group: "Materials"},
    {id: "prism", name: "Prism", group: "Materials"},
];

export const backgroundTextures = [
    {id: "cubism", name: "Cubism", default: true},
    {id: "checkered", name: "Checkered"},
    {id: "maze", name: "Maze"},
    {id: "none", name: "None"},
    {id: "carbon", name: "Carbon"},
    {id: "hex", name: "Hexagons"},
    {id: "dots", name: "Halftone"},
    {id: "diagonal", name: "Stripes"},
    {id: "grid", name: "Grid"},
    {id: "noise", name: "Noise"},
    {id: "waves", name: "Waves"},
    {id: "topo", name: "Topography"},
    {id: "scanlines", name: "Scanlines"},
    {id: "brushed", name: "Brushed"},
    {id: "triangles", name: "Low poly"},
    {id: "plaid", name: "Plaid"},
    {id: "speed", name: "Speed lines"},
    {id: "glass", name: "Glass"},
    {id: "liquid-glass", name: "Liquid glass"},
    {id: "metallic", name: "Metallic"},
    {id: "foil", name: "Foil"},
    {id: "prism", name: "Prism"},
];


class ThemeSelect extends HTMLSelectElement {

    constructor() {
        super();
        this.setAttribute('name', this.hasAttribute('override') ? 'themeOverride' : '/theme');
        this.addEventListener('change', () => {
            if (this._randomizeButton) {
                this.updateRandomizeButton();
            }
        });
        this.render();
    }

    render() {
        const options = this.hasAttribute('override') ?
            [{id: '', name: 'Use app setting'}, ...themes] :
            themes.map(x => x.id === 'sauce' ? {...x, id: ''} : x);
        const groups = new Map();
        for (const x of options) {
            if (!groups.has(x.group)) {
                groups.set(x.group, []);
            }
            groups.get(x.group).push(x);
        }
        for (const [group, entries] of groups.entries()) {
            let parent;
            if (group) {
                parent = document.createElement('optgroup');
                parent.label = group;
                this.append(parent);
            } else {
                parent = this;
            }
            for (const x of entries) {
                const option = document.createElement('option');
                option.value = x.id;
                option.label = x.name;
                parent.append(option);
            }
        }
    }

    update() {
        while (this.childNodes.length) {
            this.removeChild(this.childNodes[0]);
        }
        this.render();
    }

    connectedCallback() {
        if (!this._randomizeButton) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'theme-randomize';
            button.textContent = 'Randomize';
            button.hidden = true;
            button.addEventListener('click', async () => {
                const {makeThemePalette, settingsStore} = await import('./common.mjs');
                const palette = makeThemePalette();
                settingsStore.set(this.hasAttribute('override') ? 'customTheme' : '/customTheme', palette);
                this.value = 'custom';
                this.dispatchEvent(new Event('change'));
            });
            this._randomizeButton = button;
        }
        this.updateRandomizeButton();
    }

    disconnectedCallback() {
        if (this._randomizeButton) {
            this._randomizeButton.remove();
        }
    }

    updateRandomizeButton() {
        const shown = this.value === 'custom' || this.value === 'random';
        this._randomizeButton.hidden = !shown;
        if (shown && !this._randomizeButton.isConnected) {
            this.insertAdjacentElement('afterend', this._randomizeButton);
        }
    }
}
window.customElements.define('sauce-theme', ThemeSelect, {extends: 'select'});


class BackgroundTextureSelect extends HTMLSelectElement {

    constructor() {
        super();
        this.setAttribute('name', this.hasAttribute('override') ? 'bgTextureOverride' : '/bgTexture');
        this.render();
    }

    render() {
        const options = this.hasAttribute('override') ? [
            {id: '', name: 'Use app setting', default: true},
            ...backgroundTextures.map(x => ({...x, default: false}))
        ] : backgroundTextures;
        const groups = new Map();
        for (const x of options) {
            if (!groups.has(x.group)) {
                groups.set(x.group, []);
            }
            groups.get(x.group).push(x);
        }
        for (const [group, entries] of groups.entries()) {
            let parent;
            if (group) {
                parent = document.createElement('optgroup');
                parent.label = group;
                this.append(parent);
            } else {
                parent = this;
            }
            for (const x of entries) {
                const option = document.createElement('option');
                option.value = x.id;
                option.label = x.name;
                option.selected = x.default;
                parent.append(option);
            }
        }
    }

    update() {
        this.replaceChildren();
        this.render();
    }
}
window.customElements.define('sauce-background-texture', BackgroundTextureSelect, {extends: 'select'});
