import { CellEditor, editorThemes } from '../CellEditor.js';
import { FileEditor } from '../FileEditor.js';
import { terminalThemes, setTerminalTheme } from '../TerminalThemes.js';
import { cssPatterns, fetchImageWallpapers, applyCssPattern, applyImageWallpaper } from '../wallpapers.js';

/**
 * DisplaySettingsPanel - Settings UI hosted in the center tab pane.
 * Organized into sections: Editor, Terminal, Notebook.
 */
export class DisplaySettingsPanel {
    constructor() {
        this._wrapper = document.createElement('div');
        this._wrapper.className = 'settings-panel-wrapper';

        this._content = document.createElement('div');
        this._content.className = 'settings-panel-content';
        this._wrapper.appendChild(this._content);

        this._buildContent(this._content);
    }

    get element() {
        return this._wrapper;
    }

    _buildContent(container) {
        // --- Editor section ---
        this._addSection(container, 'Editor');
        this._addSelectRow(container, 'Theme', 'settings-theme-select',
            Object.keys(editorThemes),
            localStorage.getItem('notebook-editor-theme') || 'Tomorrow',
            (val) => { CellEditor.setTheme(val); FileEditor.setTheme(val); },
        );

        // --- Terminal section ---
        this._addSection(container, 'Terminal');
        this._addSelectRow(container, 'Theme', 'settings-theme-select',
            Object.keys(terminalThemes),
            localStorage.getItem('notebook-terminal-theme') || 'Adventure',
            (val) => setTerminalTheme(val),
        );

        // --- Notebook section ---
        this._addSection(container, 'Notebook');

        const toggles = [
            { key: 'show-cell-titles', label: 'Cell Titles', bodyClass: 'hide-cell-titles', defaultOn: true },
            { key: 'show-cell-borders', label: 'Cell Borders', bodyClass: 'hide-cell-borders', defaultOn: true },
            { key: 'show-cell-bg', label: 'Cells Background', bodyClass: 'hide-cell-bg', defaultOn: true },
            { key: 'show-code-cells', label: 'Code Cells', bodyClass: 'hide-code-cells', defaultOn: true },
            { key: 'show-line-numbers', label: 'Line Numbers', bodyClass: 'hide-line-numbers', defaultOn: true },
            { key: 'show-output', label: 'Output Cells', bodyClass: 'hide-output', defaultOn: true },
            { key: 'show-table-stripes', label: 'Alternating Row Shading', bodyClass: 'hide-table-stripes', defaultOn: true },
            { key: 'show-add-cell-areas', label: 'Add Cell Buttons', bodyClass: 'hide-add-cell-areas', defaultOn: true },
            { key: 'show-bg-image', label: 'Background Image', bodyClass: 'hide-bg-image', defaultOn: true },
            { key: 'show-bg-color', label: 'Background Color', bodyClass: 'hide-bg-color', defaultOn: true },
        ];

        for (const t of toggles) {
            const savedVal = localStorage.getItem(`notebook-${t.key}`);
            const isOn = savedVal !== null ? savedVal === '1' : t.defaultOn;
            if (!isOn) document.body.classList.add(t.bodyClass);

            const row = document.createElement('div');
            row.className = 'settings-toggle-row';

            const label = document.createElement('label');
            label.textContent = t.label;

            const toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.className = 'settings-toggle';
            toggle.checked = isOn;
            toggle.addEventListener('change', () => {
                if (toggle.checked) {
                    document.body.classList.remove(t.bodyClass);
                } else {
                    document.body.classList.add(t.bodyClass);
                }
                localStorage.setItem(`notebook-${t.key}`, toggle.checked ? '1' : '0');
            });

            row.append(label, toggle);
            container.appendChild(row);
        }

        // --- Wallpaper section ---
        this._addSection(container, 'Wallpaper');
        this._buildWallpaperSection(container);
    }

    _buildWallpaperSection(container) {
        const grid = document.createElement('div');
        grid.className = 'wallpaper-grid';

        const saved = localStorage.getItem('wallpaper');
        let activeName = null;
        if (saved) {
            try {
                const data = JSON.parse(saved);
                activeName = data.name || null;
            } catch { /* ignore */ }
        }

        // CSS patterns
        for (const pattern of cssPatterns) {
            const card = this._createWallpaperCard(pattern.name, activeName === pattern.name);

            // Preview swatch
            const swatch = card.querySelector('.wallpaper-swatch');
            swatch.style.backgroundColor = pattern.backgroundColor;
            swatch.style.backgroundImage = pattern.backgroundImage;
            swatch.style.backgroundSize = pattern.backgroundSize;
            if (pattern.backgroundPosition) swatch.style.backgroundPosition = pattern.backgroundPosition;

            card.addEventListener('click', () => {
                applyCssPattern(pattern);
                localStorage.setItem('wallpaper', JSON.stringify({ type: 'pattern', name: pattern.name }));
                this._setActiveCard(grid, card);
            });

            grid.appendChild(card);
        }

        container.appendChild(grid);

        // Image wallpapers (loaded async)
        const imgGrid = document.createElement('div');
        imgGrid.className = 'wallpaper-grid';
        container.appendChild(imgGrid);

        fetchImageWallpapers().then(images => {
            if (images.length === 0) return;
            for (const img of images) {
                const card = this._createWallpaperCard(img.name, activeName === img.name);

                const swatch = card.querySelector('.wallpaper-swatch');
                swatch.style.backgroundImage = `url('${img.url}')`;
                swatch.style.backgroundSize = 'cover';
                swatch.style.backgroundPosition = 'center';

                card.addEventListener('click', () => {
                    applyImageWallpaper(img.url);
                    localStorage.setItem('wallpaper', JSON.stringify({ type: 'image', name: img.name, url: img.url }));
                    this._setActiveCard(grid, null); // deselect pattern cards
                    this._setActiveCard(imgGrid, card);
                });

                imgGrid.appendChild(card);
            }
        });
    }

    _createWallpaperCard(name, active) {
        const card = document.createElement('div');
        card.className = 'wallpaper-card' + (active ? ' active' : '');

        const swatch = document.createElement('div');
        swatch.className = 'wallpaper-swatch';
        card.appendChild(swatch);

        const label = document.createElement('div');
        label.className = 'wallpaper-label';
        label.textContent = name;
        card.appendChild(label);

        return card;
    }

    _setActiveCard(grid, activeCard) {
        // Clear all grids
        for (const g of this._content.querySelectorAll('.wallpaper-grid')) {
            for (const c of g.querySelectorAll('.wallpaper-card')) {
                c.classList.remove('active');
            }
        }
        if (activeCard) activeCard.classList.add('active');
    }

    _addSection(container, title) {
        const heading = document.createElement('div');
        heading.className = 'settings-section-heading';
        heading.textContent = title;
        container.appendChild(heading);

        const hr = document.createElement('hr');
        hr.className = 'settings-section-hr';
        container.appendChild(hr);
    }

    _addSelectRow(container, label, className, options, selectedValue, onChange) {
        const row = document.createElement('div');
        row.className = 'settings-toggle-row';

        const lbl = document.createElement('label');
        lbl.textContent = label;

        const select = document.createElement('select');
        select.className = className;
        for (const name of options) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            if (name === selectedValue) opt.selected = true;
            select.appendChild(opt);
        }
        select.addEventListener('change', () => onChange(select.value));

        row.append(lbl, select);
        container.appendChild(row);
    }
}
