import { modalConfirm } from './modal.js';

/**
 * RunManagerPanel - Visual MLflow run definition and execution.
 *
 * Lists defined runs for a notebook. Each run is a named template (cell group)
 * that can be executed repeatedly, each time creating a new MLflow run.
 */

const RUN_COLORS = [
    '#4a90d9', '#d94a4a', '#50b850', '#e6a23c',
    '#9b59b6', '#1abc9c', '#e67e22', '#7f8c8d',
];

export class RunManagerPanel {
    /**
     * @param {object} opts
     * @param {function} opts.getCells       - Returns current cells array
     * @param {function} opts.getMetadata    - Returns notebook.metadata
     * @param {function} opts.onSave         - Called after metadata change (triggers save)
     * @param {function} opts.onExecuteRun   - (runId, runName, cells, datasets) called to execute
     * @param {function} opts.onActiveRunChange - (runId|null) called when active run changes
     * @param {function} [opts.getDvcFiles]  - Returns Promise<[{path, hash, size}]> of DVC-tracked files
     * @param {function} [opts.getHydraDataFile] - Returns Promise<{file, hash, tracked}|null>
     *     When the current notebook has a Hydra config, returns the resolved
     *     cfg.data.file and its DVC hash. Used to render a read-only Data
     *     lineage line instead of the multi-select picker, so Composer and
     *     Run Manager cannot disagree about which file the run consumed.
     */
    constructor(opts) {
        this._getCells = opts.getCells;
        this._getMetadata = opts.getMetadata;
        this._onSave = opts.onSave;
        this._onExecuteRun = opts.onExecuteRun;
        this._onActiveRunChange = opts.onActiveRunChange;
        this._getDvcFiles = opts.getDvcFiles || null;
        this._getHydraDataFile = opts.getHydraDataFile || null;
        this._panel = null;
        this._activeRunId = null;
    }

    get activeRunId() { return this._activeRunId; }
    get isOpen() { return !!this._panel; }

    toggle() {
        if (this._panel) {
            this._panel.close();
            return;
        }
        this._open();
    }

    close() {
        if (this._panel) this._panel.close();
    }

    refresh() {
        if (this._panel) {
            this._renderContent(this._panel.content);
        }
    }

    _ensureRuns() {
        const meta = this._getMetadata();
        if (!meta.mlflow_runs) meta.mlflow_runs = {};
        return meta.mlflow_runs;
    }

    _open() {
        this._panel = jsPanel.create({
            headerTitle: '<i class="fa-solid fa-vial" style="color:#e08b8b;-webkit-text-stroke:1px #202020;paint-order:stroke fill;margin-right:6px"></i>Experiments',
            theme: 'none',
            borderRadius: '5px',
            border: '1px solid var(--border-color)',
            boxShadow: 3,
            panelSize: { width: 380, height: 440 },
            position: 'center',
            headerControls: {
                minimize: 'remove', smallify: 'remove',
                normalize: 'remove', maximize: 'remove',
            },
            cssClass: ['run-manager-panel'],
            onclosed: () => {
                this._panel = null;
                this._setActiveRun(null);
            },
            callback: (panel) => {
                panel.content.style.padding = '0';
                panel.content.style.overflow = 'hidden';
                panel.content.style.display = 'flex';
                panel.content.style.flexDirection = 'column';
                this._renderContent(panel.content);
            },
        });
    }

    _renderContent(el) {
        el.innerHTML = '';
        const runs = this._ensureRuns();
        const runIds = Object.keys(runs).map(Number).sort((a, b) => a - b);

        // Toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'rm-toolbar';
        const addBtn = document.createElement('button');
        addBtn.className = 'rm-btn';
        addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Add Run';
        addBtn.addEventListener('click', () => this._addRun());
        toolbar.appendChild(addBtn);
        el.appendChild(toolbar);

        if (runIds.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'rm-empty';
            empty.textContent = 'No runs defined. Click "Add Run" to create one.';
            el.appendChild(empty);
            return;
        }

        // Run list
        const list = document.createElement('div');
        list.className = 'rm-list';

        for (const id of runIds) {
            const run = runs[String(id)];
            const cellCount = this._countCells(id);
            const isActive = this._activeRunId === id;

            const row = document.createElement('div');
            row.className = 'rm-run-row' + (isActive ? ' active' : '');

            // Active radio button
            const cb = document.createElement('input');
            cb.type = 'radio';
            cb.name = 'rm-active-run';
            cb.className = 'rm-active-cb';
            cb.checked = isActive;
            cb.title = isActive ? 'Deactivate experiment' : 'Activate to tag cells';
            cb.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isActive) {
                    cb.checked = false;
                    this._setActiveRun(null);
                }
            });
            cb.addEventListener('change', () => {
                if (cb.checked) this._setActiveRun(id);
            });

            // Run number badge (matches cell badges)
            const dot = document.createElement('span');
            dot.className = 'rm-color-dot';
            dot.innerHTML = `<i class="fa-solid fa-bookmark" style="color:${run.color || '#4a90d9'};font-size:20px"></i><span class="cell-run-badge-num">${id}</span>`;

            // Run name (editable)
            const nameInput = document.createElement('input');
            nameInput.className = 'rm-run-name';
            nameInput.value = run.name;
            nameInput.title = 'Click to rename';
            nameInput.addEventListener('change', () => {
                run.name = nameInput.value.trim() || `Run ${id}`;
                this._onSave();
            });
            nameInput.addEventListener('click', (e) => e.stopPropagation());

            // Cell count
            const countBadge = document.createElement('span');
            countBadge.className = 'rm-cell-count';
            countBadge.textContent = `${cellCount} cell${cellCount !== 1 ? 's' : ''}`;

            // Execute button
            const execBtn = document.createElement('button');
            execBtn.className = 'rm-exec-btn';
            execBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
            execBtn.title = 'Execute this run';
            execBtn.disabled = cellCount === 0;
            execBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._executeRun(id);
            });

            // Delete button
            const delBtn = document.createElement('button');
            delBtn.className = 'rm-del-btn';
            delBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            delBtn.title = 'Delete run';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._deleteRun(id);
            });

            row.append(cb, dot, nameInput, countBadge, execBtn, delBtn);
            row.addEventListener('click', () => this._setActiveRun(isActive ? null : id));
            list.appendChild(row);
        }

        el.appendChild(list);

        // Help text
        if (this._activeRunId != null) {
            const helpRow = document.createElement('div');
            helpRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 12px';
            const help = document.createElement('div');
            help.className = 'rm-help';
            help.style.cssText = 'flex:1;margin:0;padding:0';
            help.textContent = 'Click code cells to toggle membership in the selected run.';
            helpRow.appendChild(help);
            const selectAllBtn = document.createElement('button');
            selectAllBtn.className = 'rm-btn';
            selectAllBtn.style.cssText = 'white-space:nowrap;font-size:10px;padding:3px 8px';
            selectAllBtn.textContent = 'Select All';
            selectAllBtn.title = 'Add all code cells to this run';
            selectAllBtn.addEventListener('click', () => {
                const runId = this._activeRunId;
                const cells = this._getCells();
                // Check if all code cells already belong to this run
                const allSelected = cells.every((c, i) =>
                    c.cellType !== 'code' || (c._data?.metadata?.mlflow_runs || []).includes(runId));
                // Toggle: add all or remove all
                for (let i = 0; i < cells.length; i++) {
                    const c = cells[i];
                    if (c.cellType !== 'code') continue;
                    const membership = c._data?.metadata?.mlflow_runs || [];
                    const hasMembership = membership.includes(runId);
                    if (allSelected && hasMembership) c.toggleRunMembership(runId);
                    else if (!allSelected && !hasMembership) c.toggleRunMembership(runId);
                }
                this._onSave();
                this.refresh();
            });
            helpRow.appendChild(selectAllBtn);
            el.appendChild(helpRow);

            // Dataset section for active run.
            //
            // When the notebook has an active Hydra config (cfg.data.file
            // drives which CSV the code loads), the lineage is derived from
            // cfg and displayed read-only. The user-facing Composer is the
            // single source of truth for data selection - there is no
            // independent picker here, so the two UIs cannot drift.
            //
            // Without a Hydra config, we fall back to the legacy multi-
            // select picker so non-Hydra projects keep their manual
            // dataset lineage tagging.
            const dsSection = document.createElement('div');
            dsSection.className = 'rm-datasets';
            const dsTitle = document.createElement('div');
            dsTitle.className = 'rm-datasets-title';
            dsTitle.textContent = 'Datasets';
            dsSection.appendChild(dsTitle);

            const loading = document.createElement('div');
            loading.className = 'rm-empty';
            loading.textContent = 'Loading...';
            dsSection.appendChild(loading);

            const resolveHydraDatasetIfAny = this._getHydraDataFile
                ? this._getHydraDataFile()
                : Promise.resolve(null);

            resolveHydraDatasetIfAny.then(hydraDataset => {
                if (hydraDataset && hydraDataset.file) {
                    // Hydra-driven: render read-only data lineage line
                    loading.remove();
                    const row = document.createElement('div');
                    row.className = 'rm-dataset-item rm-dataset-hydra';
                    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 0;color:#555';
                    const icon = document.createElement('img');
                    icon.src = 'static/vendor/icons/hydra.svg';
                    icon.style.cssText = 'width:12px;height:12px;flex-shrink:0';
                    icon.alt = 'Hydra';
                    const text = document.createElement('span');
                    text.textContent = hydraDataset.file;
                    text.title = hydraDataset.tracked
                        ? `DVC hash: ${hydraDataset.hash} (from Hydra config)`
                        : `Not DVC-tracked yet - no lineage hash will be recorded`;
                    if (!hydraDataset.tracked) {
                        text.style.color = '#b26500';
                    }
                    const note = document.createElement('span');
                    note.style.cssText = 'margin-left:auto;font-size:10px;color:#888;font-style:italic';
                    note.textContent = 'from Hydra config';
                    row.append(icon, text, note);
                    dsSection.appendChild(row);
                    // Clear any stale `datasets` array from the run so the
                    // old multi-select residue doesn't confuse backends.
                    const run = runs[String(this._activeRunId)];
                    if (run && Array.isArray(run.datasets) && run.datasets.length > 0) {
                        run.datasets = [];
                        this._onSave();
                    }
                    return;
                }

                // Non-Hydra path: legacy multi-select picker
                if (!this._getDvcFiles) {
                    loading.remove();
                    return;
                }
                this._getDvcFiles().then(files => {
                    loading.remove();
                    if (files.length === 0) {
                        const noData = document.createElement('div');
                        noData.className = 'rm-empty';
                        noData.textContent = 'No DVC-tracked files found.';
                        dsSection.appendChild(noData);
                        return;
                    }
                    const run = runs[String(this._activeRunId)];
                    if (!run) return;
                    const selected = run.datasets || [];
                    for (const file of files) {
                        const item = document.createElement('label');
                        item.className = 'rm-dataset-item';
                        const cb = document.createElement('input');
                        cb.type = 'checkbox';
                        cb.checked = selected.includes(file.path);
                        cb.addEventListener('change', () => {
                            if (!run.datasets) run.datasets = [];
                            if (cb.checked) {
                                if (!run.datasets.includes(file.path)) run.datasets.push(file.path);
                            } else {
                                run.datasets = run.datasets.filter(p => p !== file.path);
                            }
                            this._onSave();
                        });
                        const label = document.createElement('span');
                        label.textContent = file.path;
                        label.title = `Hash: ${file.hash} | Size: ${file.size}`;
                        item.append(cb, label);
                        dsSection.appendChild(item);
                    }
                });
            });
            el.appendChild(dsSection);
        }
    }

    _addRun() {
        const runs = this._ensureRuns();
        const existingIds = Object.keys(runs).map(Number);
        const nextId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;
        const colorIdx = (nextId - 1) % RUN_COLORS.length;

        runs[String(nextId)] = {
            name: `Run ${nextId}`,
            color: RUN_COLORS[colorIdx],
            datasets: [],
        };

        this._onSave();
        this._setActiveRun(nextId);
        this.refresh();
    }

    async _deleteRun(runId) {
        const confirmed = await modalConfirm(`Delete run "${this._ensureRuns()[String(runId)]?.name}"?`);
        if (!confirmed) return;

        const runs = this._ensureRuns();
        delete runs[String(runId)];

        // Remove from all cells
        const cells = this._getCells();
        for (const cell of cells) {
            const arr = cell._data?.metadata?.mlflow_runs;
            if (arr) {
                const idx = arr.indexOf(runId);
                if (idx >= 0) arr.splice(idx, 1);
            }
        }

        if (this._activeRunId === runId) this._setActiveRun(null);
        this._onSave();
        this.refresh();
    }

    _setActiveRun(runId) {
        this._activeRunId = runId;
        if (this._onActiveRunChange) this._onActiveRunChange(runId);
        this.refresh();
    }

    _executeRun(runId) {
        const runs = this._ensureRuns();
        const run = runs[String(runId)];
        if (!run) return;

        const cells = this._getCells();
        const runCells = [];
        for (let i = 0; i < cells.length; i++) {
            const membership = cells[i]._data?.metadata?.mlflow_runs || [];
            if (membership.includes(runId) && cells[i]._cellType === 'code') {
                runCells.push({
                    cell_index: i,
                    code: cells[i].source,
                });
            }
        }

        if (runCells.length === 0) return;
        if (this._onExecuteRun) this._onExecuteRun(runId, run.name, runCells, run.datasets || []);
    }

    _countCells(runId) {
        const cells = this._getCells();
        let count = 0;
        for (const cell of cells) {
            const membership = cell._data?.metadata?.mlflow_runs || [];
            if (membership.includes(runId)) count++;
        }
        return count;
    }
}
