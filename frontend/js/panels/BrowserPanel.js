/**
 * BrowserPanel - jsPanel for browsing projects and their notebooks in a tree.
 * Click a project to expand/collapse its notebooks. Click a notebook to select it.
 */
import { modalPrompt, modalError } from '../modal.js';

export class BrowserPanel {
    /**
     * @param {object} callbacks - { onSelect(projectId, notebookName) }
     */
    constructor(callbacks = {}) {
        this._callbacks = callbacks;
        this._panel = null;
        this._expandedProject = null; // project id whose notebooks are shown
        this._notebooks = [];         // cached notebooks for expanded project
    }

    async open() {
        if (this._panel) {
            this._panel.front();
            this._refresh();
            return;
        }

        this._panel = jsPanel.create({
            id: 'browser-panel',
            headerTitle: 'Projects',
            theme: 'none',
            borderRadius: '5px',
            border: '1px solid var(--border-color)',
            boxShadow: 3,
            position: { my: 'left-top', at: 'left-top', offsetX: 60, offsetY: 100 },
            panelSize: { width: 360, height: 460 },
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

        let projects;
        try {
            const resp = await fetch('api/projects');
            projects = await resp.json();
        } catch (err) {
            content.innerHTML = '<div class="panel-error">Failed to load projects</div>';
            return;
        }

        content.innerHTML = '';

        // Toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'panel-toolbar';

        const createProjectBtn = document.createElement('button');
        createProjectBtn.className = 'panel-action-btn';
        createProjectBtn.textContent = '+ New Project';
        createProjectBtn.addEventListener('click', () => this._onCreateProject());
        toolbar.appendChild(createProjectBtn);
        content.appendChild(toolbar);

        // Tree list
        const list = document.createElement('div');
        list.className = 'panel-list';

        if (projects.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'panel-empty';
            empty.textContent = 'No projects yet';
            list.appendChild(empty);
        } else {
            for (const p of projects) {
                const isExpanded = this._expandedProject === p.id;

                // Project row
                const projectItem = document.createElement('div');
                projectItem.className = 'panel-list-item panel-project-item';
                if (isExpanded) projectItem.classList.add('expanded');
                projectItem.addEventListener('click', () => this._toggleProject(p.id));

                const chevron = document.createElement('span');
                chevron.className = 'panel-tree-chevron';
                chevron.textContent = isExpanded ? '▾' : '▸';

                const name = document.createElement('span');
                name.className = 'panel-item-name';
                name.textContent = p.id;

                const meta = document.createElement('span');
                meta.className = 'panel-item-meta';
                meta.textContent = `${p.notebooks_count}`;

                projectItem.append(chevron, name, meta);
                list.appendChild(projectItem);

                // Notebook children (if expanded)
                if (isExpanded) {
                    // "New Notebook" row
                    const newNbItem = document.createElement('div');
                    newNbItem.className = 'panel-list-item panel-notebook-item panel-new-item';
                    newNbItem.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this._onCreateNotebook(p.id);
                    });
                    const newLabel = document.createElement('span');
                    newLabel.className = 'panel-item-name muted';
                    newLabel.textContent = '+ New Notebook';
                    newNbItem.appendChild(newLabel);
                    list.appendChild(newNbItem);

                    for (const nb of this._notebooks) {
                        const nbItem = document.createElement('div');
                        nbItem.className = 'panel-list-item panel-notebook-item';
                        nbItem.addEventListener('click', (e) => {
                            e.stopPropagation();
                            this._onSelectNotebook(p.id, nb.name);
                        });

                        const nbName = document.createElement('span');
                        nbName.className = 'panel-item-name';
                        nbName.textContent = nb.name;

                        const nbMeta = document.createElement('span');
                        nbMeta.className = 'panel-item-meta';
                        nbMeta.textContent = `${nb.cells_count || 0} cells`;

                        nbItem.append(nbName, nbMeta);
                        list.appendChild(nbItem);
                    }
                }
            }
        }
        content.appendChild(list);
    }

    async _toggleProject(projectId) {
        if (this._expandedProject === projectId) {
            // Collapse
            this._expandedProject = null;
            this._notebooks = [];
        } else {
            // Expand: fetch notebooks
            this._expandedProject = projectId;
            try {
                const resp = await fetch(`api/projects/${projectId}/notebooks`);
                this._notebooks = await resp.json();
            } catch {
                this._notebooks = [];
            }
        }
        this._refresh();
    }

    async _onCreateProject() {
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
            // Expand the new project
            this._expandedProject = name;
            this._notebooks = [];
            this._refresh();
        } catch (err) {
            modalError(err.message);
        }
    }

    async _onCreateNotebook(projectId) {
        const name = await modalPrompt('Notebook name (without .ipynb):', { title: 'New Notebook' });
        if (!name) return;
        try {
            const resp = await fetch(`api/projects/${projectId}/notebooks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.detail || 'Failed to create notebook');
            }
            const nbName = name.endsWith('.ipynb') ? name : name + '.ipynb';
            this._onSelectNotebook(projectId, nbName);
        } catch (err) {
            modalError(err.message);
        }
    }

    _onSelectNotebook(projectId, notebookName) {
        if (this._callbacks.onSelect) {
            this._callbacks.onSelect(projectId, notebookName);
        }
        this.close();
    }
}
