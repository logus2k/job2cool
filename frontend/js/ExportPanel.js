/**
 * ExportPanel - jsPanel-based export dialog with tabbed options.
 * Supports Word, Markdown, HTML, and PDF exports.
 */

export class ExportPanel {
    constructor({ onExport }) {
        this._panel = null;
        this._onExport = onExport;
    }

    get isOpen() { return !!this._panel; }

    open(format = 'word') {
        if (this._panel) {
            this._panel.front();
            return;
        }

        const isWord = format === 'word';
        const title = isWord ? 'Export Word Document' : `Export ${format}`;

        this._panel = jsPanel.create({
            headerTitle: `<i class="fa-solid fa-file-export" style="color:#5ba4e6;margin-right:6px"></i>${title}`,
            theme: 'none',
            borderRadius: '5px',
            border: '1px solid var(--border-color)',
            panelSize: { width: 460, height: isWord ? 420 : 180 },
            position: 'center',
            boxShadow: 3,
            headerControls: { minimize: 'remove', smallify: 'remove', normalize: 'remove', maximize: 'remove' },
            addCloseControl: 1,
            cssClass: ['export-panel'],
            onclosed: () => { this._panel = null; },
            callback: (panel) => {
                if (isWord) {
                    this._buildWordPanel(panel);
                } else {
                    this._buildSimplePanel(panel, format);
                }
            }
        });
    }

    close() {
        if (this._panel) {
            this._panel.close();
            this._panel = null;
        }
    }

    _buildWordPanel(panel) {
        const content = panel.content;
        content.innerHTML = '';
        content.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;';

        // Tabs
        const tabs = document.createElement('div');
        tabs.className = 'export-tabs';
        const tabDefs = [
            { key: 'document', label: 'Document' },
            { key: 'typography', label: 'Typography' },
            { key: 'header', label: 'Header / Footer' },
            { key: 'layout', label: 'Layout' },
        ];

        const pages = {};
        for (const t of tabDefs) {
            const btn = document.createElement('button');
            btn.className = 'export-tab' + (t.key === 'document' ? ' active' : '');
            btn.textContent = t.label;
            btn.dataset.key = t.key;
            btn.addEventListener('click', () => {
                tabs.querySelectorAll('.export-tab').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                Object.values(pages).forEach(p => p.style.display = 'none');
                pages[t.key].style.display = '';
            });
            tabs.appendChild(btn);
        }
        content.appendChild(tabs);

        // Tab pages container
        const pagesContainer = document.createElement('div');
        pagesContainer.className = 'export-pages';

        // --- Document tab ---
        const docPage = this._createPage();
        docPage.innerHTML = `
            <label class="export-cb"><input type="checkbox" id="exp-hide-code"><span>Hide Code Inputs</span></label>
            <label class="export-cb"><input type="checkbox" id="exp-keep-text" checked><span>Keep Text Outputs</span></label>
            <label class="export-cb"><input type="checkbox" id="exp-toc" checked><span>Include Table of Contents</span></label>
            <div class="export-field">
                <label>Paper Size</label>
                <select id="exp-paper-size">
                    <option value="A4" selected>A4 (210 x 297 mm)</option>
                    <option value="Letter">Letter (8.5 x 11 in)</option>
                </select>
            </div>
            <div class="export-sep"></div>
            <label class="export-cb"><input type="checkbox" id="exp-export-html"><span>Also export HTML</span></label>
            <label class="export-cb"><input type="checkbox" id="exp-export-md"><span>Also export Markdown</span></label>
        `;
        pages.document = docPage;
        pagesContainer.appendChild(docPage);

        // --- Typography tab ---
        const typoPage = this._createPage();
        typoPage.style.display = 'none';
        typoPage.innerHTML = `
            <div class="export-row">
                <div class="export-field">
                    <label>Font Family</label>
                    <select id="exp-font">
                        <option value="Aptos" selected>Aptos</option>
                        <option value="Arial">Arial</option>
                        <option value="Calibri">Calibri</option>
                        <option value="Cambria">Cambria</option>
                        <option value="Times New Roman">Times New Roman</option>
                    </select>
                </div>
                <div class="export-field">
                    <label>Text Alignment</label>
                    <select id="exp-align">
                        <option value="justify" selected>Justified</option>
                        <option value="left">Left Aligned</option>
                    </select>
                </div>
            </div>
            <div class="export-row">
                <div class="export-field"><label>Body (pt)</label><input type="number" id="exp-size-body" value="12"></div>
                <div class="export-field"><label>Table (pt)</label><input type="number" id="exp-size-table" value="11"></div>
                <div class="export-field"><label>Code (pt)</label><input type="number" id="exp-size-code" value="10"></div>
                <div class="export-field"><label>Header (pt)</label><input type="number" id="exp-size-header" value="9"></div>
            </div>
        `;
        pages.typography = typoPage;
        pagesContainer.appendChild(typoPage);

        // --- Header / Footer tab ---
        const headerPage = this._createPage();
        headerPage.style.display = 'none';
        headerPage.innerHTML = `
            <div class="export-row">
                <div class="export-field" style="flex:2">
                    <label>Header Text</label>
                    <input type="text" id="exp-header-text" placeholder="Auto (notebook filename)">
                </div>
                <div class="export-field">
                    <label>Page Number</label>
                    <select id="exp-page-pos">
                        <option value="right" selected>Right</option>
                        <option value="center">Center</option>
                        <option value="left">Left</option>
                    </select>
                </div>
            </div>
            <label class="export-cb"><input type="checkbox" id="exp-show-page-word"><span>Show "Page" word before number</span></label>
        `;
        pages.header = headerPage;
        pagesContainer.appendChild(headerPage);

        // --- Layout tab ---
        const layoutPage = this._createPage();
        layoutPage.style.display = 'none';
        layoutPage.innerHTML = `
            <label class="export-cb"><input type="checkbox" id="exp-resize-images" checked><span>Fit Images to Page Width</span></label>
            <label class="export-cb"><input type="checkbox" id="exp-resize-tables" checked><span>Fit Tables to Page Width</span></label>
        `;
        pages.layout = layoutPage;
        pagesContainer.appendChild(layoutPage);

        content.appendChild(pagesContainer);

        // Footer with Export button
        const footer = document.createElement('div');
        footer.className = 'export-footer';

        this._statusEl = document.createElement('span');
        this._statusEl.className = 'export-status';
        footer.appendChild(this._statusEl);

        const exportBtn = document.createElement('button');
        exportBtn.className = 'export-btn';
        exportBtn.textContent = 'Export';
        exportBtn.addEventListener('click', () => this._doExport('word'));
        footer.appendChild(exportBtn);
        content.appendChild(footer);
    }

    _buildSimplePanel(panel, format) {
        const content = panel.content;
        content.innerHTML = '';
        content.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;';

        const page = this._createPage();
        page.innerHTML = `<p style="color:var(--text-secondary);font-size:12px;">Export the current notebook as ${format.toUpperCase()}.</p>`;
        content.appendChild(page);

        const footer = document.createElement('div');
        footer.className = 'export-footer';

        this._statusEl = document.createElement('span');
        this._statusEl.className = 'export-status';
        footer.appendChild(this._statusEl);

        const exportBtn = document.createElement('button');
        exportBtn.className = 'export-btn';
        exportBtn.textContent = 'Export';
        exportBtn.addEventListener('click', () => this._doExport(format));
        footer.appendChild(exportBtn);
        content.appendChild(footer);
    }

    _createPage() {
        const page = document.createElement('div');
        page.className = 'export-page';
        return page;
    }

    _getOptions() {
        const val = (id) => {
            const el = document.getElementById(id);
            if (!el) return undefined;
            if (el.type === 'checkbox') return el.checked;
            if (el.type === 'number') return parseInt(el.value, 10);
            return el.value;
        };
        return {
            hide_code: val('exp-hide-code'),
            keep_text: val('exp-keep-text'),
            include_toc: val('exp-toc'),
            paper_size: val('exp-paper-size'),
            export_html: val('exp-export-html'),
            export_markdown: val('exp-export-md'),
            header_text: val('exp-header-text'),
            page_number_pos: val('exp-page-pos'),
            show_page_word: val('exp-show-page-word'),
            text_align: val('exp-align'),
            font_family: val('exp-font'),
            font_size_body: val('exp-size-body'),
            font_size_table: val('exp-size-table'),
            font_size_code: val('exp-size-code'),
            font_size_header: val('exp-size-header'),
            resize_images: val('exp-resize-images'),
            resize_tables: val('exp-resize-tables'),
        };
    }

    setStatus(text) {
        if (this._statusEl) this._statusEl.textContent = text;
    }

    _doExport(format) {
        const options = format === 'word' ? this._getOptions() : {};
        if (this._onExport) this._onExport(format, options);
    }
}
