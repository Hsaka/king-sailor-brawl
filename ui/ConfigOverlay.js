import { CONFIG } from '../config.js';

let DEFAULT_CONFIG = null;
const PERSISTED_TOP_LEVEL = ['MOVEMENT', 'COMBAT', 'DEATH_ZONE', 'MAPS', 'SHIPS'];

export class ConfigOverlay {
    constructor() {
        if (!DEFAULT_CONFIG) {
            DEFAULT_CONFIG = JSON.parse(JSON.stringify(CONFIG));
        }

        this.container = document.createElement('div');
        this.container.id = 'config-overlay';
        this.container.className = 'config-overlay hidden';

        this.content = document.createElement('div');
        this.content.className = 'config-content';

        const title = document.createElement('h2');
        title.textContent = 'Game Configuration';
        title.style.color = '#fff';
        title.style.textAlign = 'center';
        this.content.appendChild(title);

        this.form = document.createElement('div');
        this.form.className = 'config-form';
        this.content.appendChild(this.form);

        this.inputs = {};
        this.openSections = new Set();

        const actions = document.createElement('div');
        actions.className = 'config-actions';

        const defaultBtn = document.createElement('button');
        defaultBtn.textContent = 'Restore Defaults';
        defaultBtn.className = 'btn-default';
        defaultBtn.onclick = () => this.restoreDefaults();

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.className = 'btn-cancel';
        cancelBtn.onclick = () => this.hide();

        const applyBtn = document.createElement('button');
        applyBtn.textContent = 'Apply';
        applyBtn.className = 'btn-apply';
        applyBtn.onclick = () => this.applyChanges();

        const actionsLeft = document.createElement('div');
        actionsLeft.className = 'config-actions-left';

        const exportBtn = document.createElement('button');
        exportBtn.textContent = 'Export JSON';
        exportBtn.className = 'btn-export';
        exportBtn.onclick = () => this.exportConfig();

        const importBtn = document.createElement('button');
        importBtn.textContent = 'Import JSON';
        importBtn.className = 'btn-import';
        importBtn.onclick = () => this.importConfig();

        actionsLeft.appendChild(exportBtn);
        actionsLeft.appendChild(importBtn);

        const actionsRight = document.createElement('div');
        actionsRight.className = 'config-actions-right';

        actionsRight.appendChild(defaultBtn);
        actionsRight.appendChild(cancelBtn);
        actionsRight.appendChild(applyBtn);

        actions.appendChild(actionsLeft);
        actions.appendChild(actionsRight);

        this.content.appendChild(actions);
        this.container.appendChild(this.content);
        document.body.appendChild(this.container);

        // Prevent LittleJS from eating input events
        const stopProp = (e) => e.stopPropagation();
        this.container.addEventListener('mousedown', stopProp);
        this.container.addEventListener('mouseup', stopProp);
        this.container.addEventListener('touchstart', stopProp);
        this.container.addEventListener('touchmove', stopProp, { passive: true });
        this.container.addEventListener('touchend', stopProp);
        this.container.addEventListener('wheel', stopProp, { passive: true });
        this.container.addEventListener('keydown', stopProp);
        this.container.addEventListener('keyup', stopProp);
        this.container.addEventListener('pointerdown', stopProp);
        this.container.addEventListener('pointerup', stopProp);
        this.container.addEventListener('pointermove', stopProp);

        this.loadConfigs();
    }

    isPlainObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    deepMerge(base, override) {
        if (Array.isArray(base)) {
            return Array.isArray(override)
                ? JSON.parse(JSON.stringify(override))
                : JSON.parse(JSON.stringify(base));
        }

        if (!this.isPlainObject(base)) {
            return override !== undefined ? override : base;
        }

        const result = {};
        for (const key of Object.keys(base)) {
            result[key] = this.deepMerge(base[key], undefined);
        }

        if (!this.isPlainObject(override)) {
            return result;
        }

        for (const [key, value] of Object.entries(override)) {
            if (key in result) {
                result[key] = this.deepMerge(result[key], value);
            } else {
                result[key] = JSON.parse(JSON.stringify(value));
            }
        }

        return result;
    }

    applyConfigToRuntime(newConfig) {
        const merged = this.deepMerge(DEFAULT_CONFIG, newConfig);
        for (const key of Object.keys(CONFIG)) {
            delete CONFIG[key];
        }
        Object.assign(CONFIG, merged);
    }

    getPersistableConfigSnapshot(configObj) {
        const source = configObj || CONFIG;
        const snapshot = {};
        for (const key of PERSISTED_TOP_LEVEL) {
            if (Object.prototype.hasOwnProperty.call(source, key)) {
                snapshot[key] = JSON.parse(JSON.stringify(source[key]));
            }
        }
        return snapshot;
    }

    buildForm(obj, parentEl, path) {
        const allowedTopLevel = PERSISTED_TOP_LEVEL;

        for (const key in obj) {
            if (path === '' && !allowedTopLevel.includes(key)) continue;

            const val = obj[key];
            const currentPath = path ? `${path}.${key}` : key;

            if (typeof val === 'object' && val !== null) {
                // Create collapsible section
                const section = document.createElement('details');
                section.className = 'config-section';
                section.open = this.openSections.has(currentPath); // only if previously open

                section.addEventListener('toggle', () => {
                    if (section.open) {
                        this.openSections.add(currentPath);
                    } else {
                        this.openSections.delete(currentPath);
                    }
                });

                const summary = document.createElement('summary');
                summary.style.display = 'flex';
                summary.style.justifyContent = 'space-between';
                summary.style.alignItems = 'center';

                const titleSpan = document.createElement('span');

                let displayName = key;
                if (Array.isArray(obj)) {
                    displayName = (typeof val === 'object' && val !== null) ? (val.name || val.weaponName || val.id || `Item ${key}`) : `Index ${key}`;
                }
                titleSpan.textContent = displayName;
                summary.appendChild(titleSpan);

                if (Array.isArray(obj)) {
                    const removeBtn = document.createElement('button');
                    removeBtn.textContent = 'Remove';
                    removeBtn.style.padding = '3px 6px';
                    removeBtn.style.background = '#FF6B6B';
                    removeBtn.style.color = '#fff';
                    removeBtn.style.border = 'none';
                    removeBtn.style.borderRadius = '3px';
                    removeBtn.style.cursor = 'pointer';
                    removeBtn.style.fontSize = '12px';
                    removeBtn.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        this.syncInputsToCurrentConfig();
                        obj.splice(Number(key), 1);
                        this.rebuildForm();
                    };
                    summary.appendChild(removeBtn);
                }

                section.appendChild(summary);

                const sectionContent = document.createElement('div');
                sectionContent.className = 'config-section-content';
                this.buildForm(val, sectionContent, currentPath);

                if (Array.isArray(val)) {
                    const addBtn = document.createElement('button');
                    addBtn.textContent = '+ Add Entry';
                    addBtn.style.marginTop = '6px';
                    addBtn.style.padding = '4px 8px';
                    addBtn.style.background = '#70A1FF';
                    addBtn.style.color = '#fff';
                    addBtn.style.border = 'none';
                    addBtn.style.borderRadius = '4px';
                    addBtn.style.cursor = 'pointer';
                    addBtn.style.fontSize = '12px';
                    addBtn.onclick = (e) => {
                        e.preventDefault();
                        this.syncInputsToCurrentConfig();
                        let newEntry = {};
                        if (val.length > 0) {
                            newEntry = JSON.parse(JSON.stringify(val[0]));
                        } else {
                            const defaultItem = this.getDefaultArrayItem(currentPath);
                            if (defaultItem) {
                                newEntry = JSON.parse(JSON.stringify(defaultItem));
                            }
                        }
                        if (newEntry.id) newEntry.id += '_new';
                        val.push(newEntry);
                        this.rebuildForm();
                    };
                    sectionContent.appendChild(addBtn);
                }

                section.appendChild(sectionContent);
                parentEl.appendChild(section);
            } else {
                let type = 'text';
                if (typeof val === 'number') type = 'number';
                if (typeof val === 'boolean') type = 'checkbox';
                if (typeof val === 'string' && val.startsWith('#') && val.length === 7) type = 'color';

                const group = this.createFormGroup(key, currentPath, val, type);

                if (Array.isArray(obj)) {
                    const removeBtn = document.createElement('button');
                    removeBtn.textContent = 'X';
                    removeBtn.style.marginLeft = '10px';
                    removeBtn.style.padding = '3px 6px';
                    removeBtn.style.background = '#FF6B6B';
                    removeBtn.style.color = '#fff';
                    removeBtn.style.border = 'none';
                    removeBtn.style.borderRadius = '3px';
                    removeBtn.style.cursor = 'pointer';
                    removeBtn.onclick = (e) => {
                        e.preventDefault();
                        this.syncInputsToCurrentConfig();
                        obj.splice(Number(key), 1);
                        this.rebuildForm();
                    };
                    group.appendChild(removeBtn);
                }

                parentEl.appendChild(group);
            }
        }
    }

    getDefaultArrayItem(path) {
        if (!path) return undefined;
        const parts = path.split('.');
        let current = DEFAULT_CONFIG;
        for (const p of parts) {
            if (current == null) return undefined;
            if (Array.isArray(current) && current[p] === undefined) {
                current = current[0];
            } else {
                current = current[p];
            }
        }
        if (Array.isArray(current) && current.length > 0) {
            return current[0];
        }
        return undefined;
    }

    createFormGroup(label, path, value, type) {
        const group = document.createElement('div');
        group.className = 'config-group';

        const labelEl = document.createElement('label');
        labelEl.textContent = label;
        labelEl.htmlFor = `config_${path}`;

        let input;
        if (type === 'json') {
            input = document.createElement('textarea');
            input.value = JSON.stringify(value, null, 2);
            input.rows = 4;
        } else {
            input = document.createElement('input');
            input.type = type;
            if (type === 'checkbox') {
                input.checked = value;
            } else {
                input.value = value;
            }
            if (type === 'number') {
                input.step = 'any';
            }
        }

        input.id = `config_${path}`;
        this.inputs[path] = { input, type };

        group.appendChild(labelEl);
        group.appendChild(input);
        return group;
    }

    rebuildForm() {
        this.form.innerHTML = '';
        this.inputs = {};
        this.buildForm(this.currentConfig, this.form, '');
    }

    show() {
        this.currentConfig = JSON.parse(JSON.stringify(CONFIG));
        this.openSections.clear();
        this.rebuildForm();
        this.container.classList.remove('hidden');
        this.container.style.display = 'flex';
    }

    hide() {
        this.container.classList.add('hidden');
        this.container.style.display = 'none';
        if (window.game && window.game.audioSystem) {
            window.game.audioSystem.playUIClick();
        }
    }

    refreshInputs(obj, path) {
        for (const key in obj) {
            const val = obj[key];
            const currentPath = path ? `${path}.${key}` : key;

            if (typeof val === 'object' && val !== null) {
                this.refreshInputs(val, currentPath);
            } else if (this.inputs[currentPath]) {
                if (this.inputs[currentPath].type === 'checkbox') {
                    this.inputs[currentPath].input.checked = val;
                } else {
                    this.inputs[currentPath].input.value = val;
                }
            }
        }
    }

    syncInputsToCurrentConfig() {
        for (const path in this.inputs) {
            const { input, type } = this.inputs[path];
            let val;
            if (type === 'checkbox') {
                val = input.checked;
            } else if (type === 'number') {
                val = parseFloat(input.value);
            } else {
                val = input.value;
            }
            this.setValueAtPath(this.currentConfig, path, val);
        }
    }

    applyChanges() {
        this.syncInputsToCurrentConfig();
        const persistable = this.getPersistableConfigSnapshot(this.currentConfig);
        this.applyConfigToRuntime(persistable);

        // Save
        this.saveConfigs();
        this.hide();
    }

    exportConfig() {
        this.syncInputsToCurrentConfig();
        const persistable = this.getPersistableConfigSnapshot(this.currentConfig);
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(persistable, null, 2));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", "config.json");
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    }

    importConfig() {
        let input = document.getElementById('config-file-import');
        if (!input) {
            input = document.createElement('input');
            input.id = 'config-file-import';
            input.type = 'file';
            input.accept = '.json,application/json,text/plain,*/*';
            input.style.display = 'none';
            document.body.appendChild(input);
        }

        input.value = ''; // Reset value to trigger change if same file is picked

        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = event => {
                try {
                    const parsed = JSON.parse(event.target.result);
                    const persistable = this.getPersistableConfigSnapshot(parsed);
                    this.currentConfig = this.deepMerge(this.currentConfig, persistable);
                    this.rebuildForm();
                } catch (err) {
                    console.error('Failed to parse config JSON', err);
                    alert('Invalid JSON file.');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    setValueAtPath(obj, path, value) {
        const parts = path.split('.');
        const last = parts.pop();
        let current = obj;
        for (const p of parts) {
            if (current[p] === undefined) {
                current[p] = {};
            }
            current = current[p];
        }
        current[last] = value;
    }

    restoreDefaults() {
        if (confirm('Restore default configuration?')) {
            this.currentConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
            this.rebuildForm();
        }
    }

    saveConfigs() {
        const persistable = this.getPersistableConfigSnapshot(CONFIG);
        localStorage.setItem('gameConfigs', JSON.stringify(persistable));
    }

    loadConfigs() {
        const saved = localStorage.getItem('gameConfigs');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                const persistable = this.getPersistableConfigSnapshot(parsed);
                this.applyConfigToRuntime(persistable);
                // No need to refresh form here as show() does it using currentConfig
            } catch (e) {
                console.error('Failed to load configs', e);
            }
        }
    }
}
