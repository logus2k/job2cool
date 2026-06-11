/**
 * ProjectPanel - jsPanel floating panel for project selection.
 */
import { modalPrompt, modalError } from '../modal.js';

export class ProjectPanel {
    /**
     * @param {object} callbacks - { onProjectSelect(projectId) }
     */
    constructor(callbacks = {}) {
        this._callbacks = callbacks;
        this._panel = null;
        this._projects = [];
    }

    async open() {
        if (this._panel) {
            this._panel.front();
            this._refresh();
            return;
        }

        this._panel = jsPanel.create({
            id: 'project-panel',
            headerTitle: 'Projects',
            theme: 'none',
            borderRadius: '5px',
            border: '1px solid var(--border-color)',
            boxShadow: 3,
            position: { my: 'left-top', at: 'left-top', offsetX: 60, offsetY: 100 },
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
        if (!this._panel) return;
        const content = this._panel.content;

        try {
            const resp = await fetch('api/projects');
            this._projects = await resp.json();
        } catch (err) {
            content.innerHTML = `<div class="panel-error">Failed to load projects</div>`;
            return;
        }

        content.innerHTML = '';

        // Create button
        const toolbar = document.createElement('div');
        toolbar.className = 'panel-toolbar';
        const createBtn = document.createElement('button');
        createBtn.className = 'panel-action-btn';
        createBtn.textContent = '+ New Project';
        createBtn.addEventListener('click', () => this._onCreate());
        toolbar.appendChild(createBtn);
        content.appendChild(toolbar);

        // Project list
        const list = document.createElement('div');
        list.className = 'panel-list';

        if (this._projects.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'panel-empty';
            empty.textContent = 'No projects yet';
            list.appendChild(empty);
        } else {
            for (const p of this._projects) {
                const item = document.createElement('div');
                item.className = 'panel-list-item';
                item.addEventListener('click', () => this._onSelect(p.id));

                const name = document.createElement('span');
                name.className = 'panel-item-name';
                name.textContent = p.id;

                const meta = document.createElement('span');
                meta.className = 'panel-item-meta';
                meta.textContent = `${p.notebooks_count} notebook${p.notebooks_count !== 1 ? 's' : ''}`;

                item.append(name, meta);
                list.appendChild(item);
            }
        }
        content.appendChild(list);
    }

    async _onCreate() {
        const name = await modalPrompt('Project name:', { title: 'New Project' });
        if (!name) return;
        try {
            const resp = await fetch('api/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ project_id: name })
            });
            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.detail || 'Failed to create project');
            }
            this._onSelect(name.trim());
        } catch (err) {
            modalError(err.message);
        }
    }

    _onSelect(projectId) {
        if (this._callbacks.onProjectSelect) {
            this._callbacks.onProjectSelect(projectId);
        }
        this.close();
    }
}
