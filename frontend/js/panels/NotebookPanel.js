/**
 * NotebookPanel - jsPanel floating panel for notebook selection.
 */
import { modalPrompt, modalError } from '../modal.js';

export class NotebookPanel {
    /**
     * @param {object} callbacks - { onNotebookSelect(projectId, notebookName) }
     */
    constructor(callbacks = {}) {
        this._callbacks = callbacks;
        this._panel = null;
        this._projectId = null;
        this._notebooks = [];
    }

    async open(projectId) {
        this._projectId = projectId;

        if (this._panel) {
            this._panel.front();
            this._refresh();
            return;
        }

        this._panel = jsPanel.create({
            id: 'notebook-panel',
            headerTitle: 'Notebooks',
            theme: 'none',
            borderRadius: '5px',
            border: '1px solid var(--border-color)',
            boxShadow: 3,
            position: { my: 'center-top', at: 'center-top', offsetY: 100 },
            panelSize: { width: 340, height: 420 },
            headerControls: { minimize: 'remove', smallify: 'remove', normalize: 'remove', maximize: 'remove' },
            onclosed: () => { this._panel = null; },
            callback: (panel) => {
                this._panel = panel;
                panel.content.innerHTML = '<div class="panel-loading">Loading...</div>';
                this._refresh();
            }
        });
    }

    close() {
        if (this._panel) {
            this._panel.close();
            this._panel = null;
        }
    }

    async _refresh() {
        if (!this._panel || !this._projectId) return;
        const content = this._panel.content;

        try {
            const resp = await fetch(`api/projects/${this._projectId}/notebooks`);
            this._notebooks = await resp.json();
        } catch (err) {
            content.innerHTML = `<div class="panel-error">Failed to load notebooks</div>`;
            return;
        }

        content.innerHTML = '';

        // Toolbar with create + import
        const toolbar = document.createElement('div');
        toolbar.className = 'panel-toolbar';

        const createBtn = document.createElement('button');
        createBtn.className = 'panel-action-btn';
        createBtn.textContent = '+ New Notebook';
        createBtn.addEventListener('click', () => this._onCreate());

        const importBtn = document.createElement('button');
        importBtn.className = 'panel-action-btn secondary';
        importBtn.textContent = 'Import';
        importBtn.addEventListener('click', () => this._onImport());

        toolbar.append(createBtn, importBtn);
        content.appendChild(toolbar);

        // Notebook list
        const list = document.createElement('div');
        list.className = 'panel-list';

        if (this._notebooks.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'panel-empty';
            empty.textContent = 'No notebooks yet';
            list.appendChild(empty);
        } else {
            for (const nb of this._notebooks) {
                const item = document.createElement('div');
                item.className = 'panel-list-item';
                item.addEventListener('click', () => this._onSelect(nb.name));

                const name = document.createElement('span');
                name.className = 'panel-item-name';
                name.textContent = nb.name;

                const meta = document.createElement('span');
                meta.className = 'panel-item-meta';
                meta.textContent = `${nb.cells_count || 0} cells`;

                item.append(name, meta);
                list.appendChild(item);
            }
        }
        content.appendChild(list);
    }

    async _onCreate() {
        const name = await modalPrompt('Notebook name (without .ipynb):', { title: 'New Notebook' });
        if (!name) return;
        try {
            const resp = await fetch(`api/projects/${this._projectId}/notebooks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.detail || 'Failed to create notebook');
            }
            const nbName = name.trim().endsWith('.ipynb') ? name.trim() : name.trim() + '.ipynb';
            this._onSelect(nbName);
        } catch (err) {
            modalError(err.message);
        }
    }

    _onImport() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.ipynb';
        input.addEventListener('change', async () => {
            const file = input.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const contentData = JSON.parse(text);
                if (!contentData.cells || !Array.isArray(contentData.cells)) {
                    throw new Error('Invalid notebook: missing cells array');
                }
                const name = file.name.replace(/\.ipynb$/, '');
                const resp = await fetch(`api/projects/${this._projectId}/notebooks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, content: contentData })
                });
                if (!resp.ok) {
                    const err = await resp.json();
                    throw new Error(err.detail || 'Failed to import notebook');
                }
                const nbName = name.endsWith('.ipynb') ? name : name + '.ipynb';
                this._onSelect(nbName);
            } catch (err) {
                modalError(err.message, { title: 'Import Failed' });
            }
        });
        input.click();
    }

    _onSelect(notebookName) {
        if (this._callbacks.onNotebookSelect) {
            this._callbacks.onNotebookSelect(this._projectId, notebookName);
        }
        this.close();
    }
}
