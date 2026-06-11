import { CellEditor } from './CellEditor.js';
import { POST_IT_ICON_CELL } from './CellPostIt.js';
import { ImageActions } from './ImageActions.js';
import { NotebookDragDrop } from './NotebookDragDrop.js';
import { NotebookSelection } from './NotebookSelection.js';
import { notify } from './Notify.js';
import { DebugClient } from './DebugClient.js';

/** Generate a UUID v4. Uses crypto.randomUUID when available (secure
 * contexts), falls back to a small polyfill otherwise. */
function _generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * NotebookEditor - Main notebook container, manages cells array.
 */
export class NotebookEditor {
    /**
     * @param {HTMLElement} containerEl
     * @param {import('./KernelClient.js').KernelClient} kernelClient
     */
    constructor(containerEl, kernelClient) {
        this._container = containerEl;
        this._client = kernelClient;
        this._cells = [];
        this._notebook = null;
        this._projectId = null;
        this._notebookPath = null;
        this._notebookKey = '';
        this._wrapperEl = null;
        this._debounceTimers = {};

        // Top bar inside the notebook with project/notebook breadcrumb
        this._topBar = this._createTopBar();
        this._secondBar = this._createSecondBar();
        this._debugBar = this._createDebugBar();
        this._buildTopBarContent();

        // Multi-cell selection state
        this._selectedIndices = new Set();
        this._anchorIndex = null;
        this._clipboard = null; // { cells: [...cellJSON], isCut: bool }

        // Notebook-level undo stack (snapshots)
        this._undoStack = [];
        this._maxUndoSize = 20;

        // Sequential execution queue (for Run All / Run Above / Run Below)
        this._execQueue = [];
        this._execRunning = false;

        // External change listener
        this._onChangeCallback = null;

        // Loading state
        this._onLoadCallback = null;
        this._loadingOverlay = null;
        this._readyResolve = null;
        this.ready = new Promise(resolve => { this._readyResolve = resolve; });

        // Callback to ensure kernel is running before execution (returns Promise)
        this._ensureKernelCallback = null;

        // Delegate modules
        this.selection = new NotebookSelection(this);
        this.dragDrop = new NotebookDragDrop(this);
        new ImageActions(this._container);

        this._setupClientListeners();
        this._setupContainerListeners();
    }

    get cells() { return this._cells; }
    get projectId() { return this._projectId; }
    get notebookPath() { return this._notebookPath; }
    get lastFocusedCellIndex() { return this._lastFocusedCellIndex ?? null; }
    get selectedCellIndices() { return [...this._selectedIndices].sort((a, b) => a - b); }
    get lastMlflowRunId() { return this._notebook?.metadata?.noted?.last_run_id ?? null; }
    set onCellsChanged(fn) { this._onChangeCallback = fn; }
    set onEnsureKernel(fn) { this._ensureKernelCallback = fn; }
    set onLoad(fn) { this._onLoadCallback = fn; }

    _setupContainerListeners() {
        // Open links in new tab
        this._container.addEventListener('click', (e) => {
            const a = e.target.closest('a[href]');
            if (a && this._container.contains(a)) {
                e.preventDefault();
                window.open(a.href, '_blank', 'noopener');
            }
        });

        this._container.addEventListener('mousedown', (e) => {
            if (!e.target.closest('.cell') && !e.target.closest('.add-cell-container')
                && !e.target.closest('.welcome-screen') && !e.target.closest('.project-browser')
                && !e.target.closest('.notebook-second-bar')) {
                e.preventDefault();
                const active = document.activeElement;
                if (active && active.closest('.cell')) active.blur();
            }
        });

        this._docMousedownHandler = (e) => {
            // Only act when this editor is the visible (active) tab
            if (this._container.style.display === 'none') return;
            if (!this._container.contains(e.target)
                && !e.target.closest('#toolbar') && !e.target.closest('#info-bar')
                && !e.target.closest('.jsPanel') && !e.target.closest('#right-panel')
                && !e.target.closest('#service-tab-container') && !e.target.closest('#sidebar-panel')) {
                e.preventDefault();
                const active = document.activeElement;
                if (active && active.closest('.cell')) active.blur();
            }
        };
        document.addEventListener('mousedown', this._docMousedownHandler);
    }

    _setupClientListeners() {
        // Filter helper: only process events for this notebook (or unscoped events)
        const forMe = (data) => !data.notebook_key || data.notebook_key === this._notebookKey;

        this._clientListeners = [];
        const on = (event, handler) => {
            this._client.on(event, handler);
            this._clientListeners.push({ event, handler });
        };

        on('notebook:state', (data) => {
            if (forMe(data)) this._onNotebookState(data);
        });
        on('notebook:saved', (data) => {
            if (forMe(data)) this._onNotebookSaved(data);
        });
        on('cell:updated', (data) => {
            if (forMe(data)) this._onRemoteCellUpdate(data);
        });
        on('cell:added', (data) => {
            if (forMe(data)) this._onRemoteCellAdd(data);
        });
        on('cell:deleted', (data) => {
            if (forMe(data)) this._onRemoteCellDelete(data);
        });
        on('cell:moved', (data) => {
            if (forMe(data)) this._onRemoteCellMove(data);
        });
        on('cell:output', (data) => {
            if (forMe(data)) this._onCellOutput(data);
        });
        on('cell:execute_start', (data) => {
            if (forMe(data)) {
                const cell = this._cells[data.cell_index];
                if (cell) cell.startExecuting();
            }
        });
        on('cell:execute_complete', (data) => {
            if (forMe(data)) this._onExecuteComplete(data);
        });
        on('cell:diagnostics', (data) => {
            if (forMe(data)) this._onCellDiagnostics(data);
        });
        on('cell:lock_changed', (data) => {
            if (forMe(data)) this._onLockChanged(data);
        });
        on('error', (data) => {
            if (forMe(data)) this._onError(data);
        });
    }

    _removeClientListeners() {
        if (!this._clientListeners) return;
        for (const { event, handler } of this._clientListeners) {
            this._client.off(event, handler);
        }
        this._clientListeners = [];
    }

    // --- Public API ---

    get notebookKey() { return this._notebookKey; }

    openNotebook(projectId, notebookPath, userName) {
        this._projectId = projectId;
        this._notebookPath = notebookPath;
        this._notebookKey = `notebook:${projectId}:${notebookPath}`;
        CellEditor.setProjectId(projectId);
        this._showLoadingOverlay();
        this._client.openNotebook(projectId, notebookPath, userName);
        this._loadHydraConfig(projectId);
        this._loadProjectDags(projectId);
    }

    get hydraConfig() {
        return this._selectedHydraConfig || null;
    }

    closeNotebook() {
        if (this._projectId && this._notebookPath) {
            this._client.closeNotebook(this._projectId, this._notebookPath);
        }
        this._removeClientListeners();
        if (this._docMousedownHandler) {
            document.removeEventListener('mousedown', this._docMousedownHandler);
            this._docMousedownHandler = null;
        }
        this._clear();
    }

    save() {
        if (!this._notebook) {
            notify.error('No notebook open');
            return;
        }
        try {
            const content = this._serializeNotebook();
            this._savePending = true;
            this._client.saveNotebook(content, this._notebookKey);
        } catch (err) {
            notify.error('Save failed');
            console.error('Save serialization error:', err);
        }
    }

    export() {
        if (!this._notebook) return;
        const content = this._serializeNotebook();
        const json = JSON.stringify(content, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = this._notebookPath || 'notebook.ipynb';
        a.click();
        URL.revokeObjectURL(url);
    }

    // --- Execution queue ---

    runAll() {
        this._runSequential(0, this._cells.length);
    }

    async debugAll() {
        await this._debugSequential(0, this._cells.length);
    }

    runAbove(index) {
        this._runSequential(0, index);
    }

    runBelow(index) {
        this._runSequential(index, this._cells.length);
    }

    clearAllOutputs() {
        for (const cell of this._cells) {
            if (cell.cellType === 'code') {
                cell.clearOutput();
            }
        }
    }

    async _debugSequential(from, to) {
        const indices = [];
        for (let i = from; i < to; i++) {
            if (this._cells[i]?.cellType === 'code') indices.push(i);
        }
        if (!indices.length) return;

        // Ensure kernel
        if (this._ensureKernelCallback) {
            const ok = await this._ensureKernelCallback();
            if (!ok) {
                notify.error('No kernel selected - choose an environment first');
                return;
            }
        }

        const sessionId = this._notebookKey;
        if (!sessionId) return;

        try {
            // Generate shadow file and get cell map
            const cells = this._cells.map(c => ({
                cell_type: c.cellType,
                source: c.source,
            }));
            const shadowResp = await fetch('api/dap/debug-notebook', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    project_id: this._projectId || '',
                    notebook_path: this._notebookPath || '',
                    cells,
                }),
            });
            if (!shadowResp.ok) {
                notify.error('Failed to generate debug file');
                return;
            }
            const { shadow_path, cell_map } = await shadowResp.json();
            this._debugShadowPath = shadow_path;
            this._debugCellMap = cell_map;

            // Connect debug client
            if (!this._debugClient) {
                this._debugClient = new DebugClient();
                this._debugClient.on('stopped', (body) => this._onDebugStopped(body));
                this._debugClient.on('continued', () => this._onDebugContinued());
                this._debugClient.on('terminated', () => this._onDebugTerminated());
                this._debugClient.on('disconnected', () => this._onDebugTerminated());
                this._debugClient.on('output', (body) => {
                    if (body.category === 'stderr' && body.output) {
                        notify.error(body.output);
                    }
                });
            }

            if (!this._debugClient.connected) {
                const statusResp = await fetch('api/dap/status');
                const statusData = await statusResp.json();
                let kernelSession = statusData.sessions?.find(s =>
                    s.session_id.startsWith(sessionId.replace('notebook:', ''))
                );
                if (!kernelSession) {
                    kernelSession = statusData.sessions?.find(s =>
                        sessionId.includes(s.session_id.split('_')[0]?.replace('notebook:', ''))
                    );
                }
                if (!kernelSession) {
                    notify.error('No debug-ready kernel found');
                    return;
                }
                const sid = kernelSession.session_id;
                await this._debugClient.connect(sid);
            }

            // Set breakpoints on the SHADOW FILE using global line numbers
            const allBreakpoints = [];
            for (const entry of cell_map) {
                const cell = this._cells[entry.cell_index];
                if (!cell || cell.cellType !== 'code') continue;
                const bps = cell.getBreakpoints();
                for (const bp of bps) {
                    // Translate cell-relative line to shadow file line
                    allBreakpoints.push({ line: entry.start_line + bp - 1 });
                }
            }

            if (allBreakpoints.length > 0) {
                await this._debugClient.setBreakpoints(
                    { path: shadow_path, name: this._notebookPath || 'notebook' },
                    allBreakpoints,
                );
            }

            await this._debugClient._request('configurationDone');

            // Notify debug panel
            this._container.dispatchEvent(new CustomEvent('debug:started', {
                bubbles: true,
                detail: { debugClient: this._debugClient, cells: this._cells },
            }));

            // Show debug bar
            this._debugBar.style.display = '';
            this._debugStatusText.textContent = 'Running...';

            // Execute cells
            this._debugAllActive = true;
            if (this._kernelLanguage === 'javascript') {
                // JS Debug All: single-execution mode.
                // Execute only the first cell (backend runs the full shadow file).
                // Mark all cells as executing upfront so output can be routed.
                this._debugExecQueue = [];
                for (const idx of indices) {
                    const c = this._cells[idx];
                    if (c) {
                        c.clearOutput();
                        c.setDebugMode(true);
                    }
                }
                this._debugCellIndex = indices[0];
                const firstCell = this._cells[indices[0]];
                firstCell.startExecuting(true);
                this._client.executeCell(indices[0], firstCell.source, this._notebookKey, this._selectedHydraConfig);
            } else {
                // Python: execute cells sequentially
                this._debugExecQueue = indices;
                this._debugExecNext();
            }

        } catch (e) {
            if (e.message !== 'disconnected') {
                notify.error(`Debug failed: ${e.message}`);
            }
        }
    }

    async _resendCellBreakpoints(cellIndex) {
        /** Re-send breakpoints for a single cell during an active debug session. */
        const cell = this._cells[cellIndex];
        if (!cell || cell.cellType !== 'code' || !this._debugClient?.connected) return;
        const bps = cell.getBreakpoints();
        try {
            await this._debugClient.setBreakpoints(
                { cellCode: cell.source, name: `Cell ${cellIndex + 1}` },
                bps.map(line => ({ line }))
            );
        } catch (e) {
            console.warn('[Debug] Failed to update cell breakpoints:', e);
        }
    }

    async _resendBreakpoints() {
        /**  Re-send all breakpoints to the debugger during an active Debug All session.
         *  Called when breakpoints are added or removed while debugging. */
        const allBreakpoints = [];
        for (const entry of this._debugCellMap) {
            const cell = this._cells[entry.cell_index];
            if (!cell || cell.cellType !== 'code') continue;
            const bps = cell.getBreakpoints();
            for (const bp of bps) {
                allBreakpoints.push({ line: entry.start_line + bp - 1 });
            }
        }
        try {
            await this._debugClient.setBreakpoints(
                { path: this._debugShadowPath, name: this._notebookPath || 'notebook' },
                allBreakpoints,
            );
        } catch (e) {
            console.warn('[Debug] Failed to update breakpoints:', e);
        }
    }

    _debugExecNext() {
        if (!this._debugExecQueue?.length) {
            this._debugAllActive = false;
            return;
        }
        const idx = this._debugExecQueue.shift();
        const cell = this._cells[idx];
        if (!cell || cell.cellType !== 'code') {
            this._debugExecNext();
            return;
        }
        this._debugCellIndex = idx;
        cell.setDebugMode(true);
        cell.startExecuting(true);
        this._client.executeCell(idx, cell.source, this._notebookKey, this._selectedHydraConfig);
    }

    async _runSequential(from, to) {
        const indices = [];
        for (let i = from; i < to; i++) {
            if (this._cells[i]?.cellType === 'code') {
                indices.push(i);
            }
        }
        if (!indices.length) return;
        if (this._ensureKernelCallback) {
            const ok = await this._ensureKernelCallback();
            if (!ok) {
                notify.error('No kernel selected — choose an environment first');
                return;
            }
        }
        this._execQueue = indices;
        this._execRunning = true;
        this._execNext();
    }

    _execNext() {
        if (!this._execQueue.length) {
            this._execRunning = false;
            return;
        }
        const idx = this._execQueue.shift();
        const cell = this._cells[idx];
        if (cell) {
            cell._onRun();
        } else {
            this._execNext();
        }
    }

    _cancelExecQueue() {
        this._execQueue = [];
        this._execRunning = false;
    }

    // --- Rendering ---

    async loadNotebook(nb) {
        await this._onNotebookState({ notebook: this._prepareWire(nb) });
    }

    _prepareWire(nb) {
        const wire = JSON.parse(JSON.stringify(nb));
        for (const cell of wire.cells || []) {
            if (Array.isArray(cell.source)) cell.source = cell.source.join('');
        }
        return wire;
    }

    async _onNotebookState(data) {
        this._notebook = data.notebook;
        await this._render();

        // Apply any buffered diagnostics that arrived before cells were ready
        if (this._cellDiagnostics) {
            for (const [idx, diags] of Object.entries(this._cellDiagnostics)) {
                const cell = this._cells[parseInt(idx)];
                if (cell) cell.setLintDiagnostics(diags);
            }
        }

        // Refresh run badges
        this.refreshRunBadges();

        const locks = data.locks || {};
        for (const [idx, lock] of Object.entries(locks)) {
            const cell = this._cells[parseInt(idx)];
            if (cell) {
                const isSelf = lock.owner_sid === this._client.sid;
                cell.setLock(lock.owner_name, lock.owner_sid, isSelf);
            }
        }
        if (this._onChangeCallback) this._onChangeCallback();
    }

    async _render() {
        this._clear();
        if (!this._notebook || !this._notebook.cells) {
            this._hideLoadingOverlay();
            return;
        }

        const cells = this._notebook.cells;
        const total = cells.length;

        // Switch from indeterminate to determinate progress
        this._updateLoadingProgress(0);

        this._wrapperEl = document.createElement('div');
        this._wrapperEl.className = 'notebook';
        this._wrapperEl.appendChild(this._topBar);
        this._wrapperEl.appendChild(this._secondBar);
        this._wrapperEl.appendChild(this._debugBar);

        if (total === 0) {
            const addBtn = this._createAddCellButton();
            addBtn.classList.add('add-cell-last');
            this._wrapperEl.appendChild(addBtn);
            this._container.appendChild(this._wrapperEl);
            this.dragDrop.setup();
            this._hideLoadingOverlay();
            this._onRenderComplete();
            return;
        }

        // Batch size: render N cells per frame to balance progress updates vs speed
        const BATCH = Math.max(1, Math.ceil(total / 20));

        for (let i = 0; i < total; i++) {
            if (i === 0) {
                this._wrapperEl.appendChild(this._createAddCellButton());
            }

            const cellEditor = this._createCellEditor(cells[i], i);
            cellEditor.setLSPContext(this._projectId, this._notebookPath, this._venvName || '');
            this._cells.push(cellEditor);
            this._wrapperEl.appendChild(cellEditor.element);
            const addBtn = this._createAddCellButton();
            if (i === total - 1) addBtn.classList.add('add-cell-last');
            this._wrapperEl.appendChild(addBtn);

            // Yield to the browser every BATCH cells to update progress
            if ((i + 1) % BATCH === 0 && i < total - 1) {
                this._updateLoadingProgress(Math.round(((i + 1) / total) * 100));
                await new Promise(r => requestAnimationFrame(r));
            }
        }

        this._container.appendChild(this._wrapperEl);
        this.dragDrop.setup();
        this._hideLoadingOverlay();
        this._onRenderComplete();
    }

    _showLoadingOverlay() {
        if (this._loadingOverlay) this._loadingOverlay.remove();
        const overlay = document.createElement('div');
        overlay.className = 'notebook-loading-overlay';
        overlay.innerHTML = `
            <div class="notebook-loading-content">
                <div class="notebook-loading-label">Loading notebook...</div>
                <div class="notebook-loading-bar-track">
                    <div class="notebook-loading-bar-fill indeterminate"></div>
                </div>
                <div class="notebook-loading-percent"></div>
            </div>`;
        this._container.appendChild(overlay);
        this._loadingOverlay = overlay;
    }

    _updateLoadingProgress(pct) {
        if (!this._loadingOverlay) return;
        const fill = this._loadingOverlay.querySelector('.notebook-loading-bar-fill');
        const label = this._loadingOverlay.querySelector('.notebook-loading-percent');
        if (fill) {
            fill.classList.remove('indeterminate');
            fill.style.width = `${pct}%`;
        }
        if (label) label.textContent = `${pct}%`;
    }

    _hideLoadingOverlay() {
        if (this._loadingOverlay) {
            this._loadingOverlay.remove();
            this._loadingOverlay = null;
        }
    }

    _onRenderComplete() {
        notify.success('Notebook loaded');
        if (this._readyResolve) this._readyResolve();
        if (this._onLoadCallback) this._onLoadCallback();
    }

    _createTopBar() {
        const bar = document.createElement('div');
        bar.className = 'notebook-top-bar';
        return bar;
    }

    _createSecondBar() {
        const S = 'stroke="#555" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
        const ICONS = {
            runAll:    `<i class="fa-solid fa-play" style="font-size:12px;color:#555"></i>`,
            restart:   `<i class="fa-solid fa-arrow-rotate-left" style="font-size:12px;color:#555"></i>`,
            stop:      `<i class="fa-solid fa-power-off" style="font-size:12px;color:#555"></i>`,
            interrupt: `<i class="fa-solid fa-stop" style="font-size:12px;color:#555"></i>`,
            clearAll:  `<i class="fa-solid fa-eraser" style="font-size:12px;color:#555"></i>`,
            upload:    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" ${S}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
            download:  `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" ${S}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
        };

        const bar = document.createElement('div');
        bar.className = 'notebook-second-bar';

        const mkBtn = (icon, label, onClick, cls) => {
            const btn = document.createElement('button');
            btn.className = cls || 'info-bar-text-btn';
            btn.innerHTML = icon + `<span class="info-bar-btn-label">${label}</span>`;
            btn.title = label;
            btn.addEventListener('click', onClick);
            return btn;
        };

        // Left: Save + Post-it
        const leftGroup = document.createElement('div');
        leftGroup.className = 'second-bar-left';

        const FS = 'stroke="#555" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
        this._secondBarSaveBtn = document.createElement('button');
        this._secondBarSaveBtn.className = 'info-bar-text-btn';
        this._secondBarSaveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk" style="font-size:14px;color:#4caf50;-webkit-text-stroke:1px #555;paint-order:stroke fill"></i>';
        this._secondBarSaveBtn.title = 'Save';
        this._secondBarSaveBtn.addEventListener('click', () => this.save());
        leftGroup.appendChild(this._secondBarSaveBtn);

        this._secondBarPostItBtn = document.createElement('button');
        this._secondBarPostItBtn.className = 'info-bar-text-btn';
        this._secondBarPostItBtn.innerHTML = '<i class="fa-solid fa-note-sticky" style="font-size:14px;color:#f7e15c;-webkit-text-stroke:1px #555;paint-order:stroke fill"></i>';
        this._secondBarPostItBtn.title = 'Notes';
        this._secondBarPostItBtn.style.position = 'relative';
        this._secondBarPostItBtn.addEventListener('click', () => this._onPostItToggle?.());
        this._secondBarNotesBadge = document.createElement('span');
        this._secondBarNotesBadge.className = 'toolbar-notes-badge';
        this._secondBarPostItBtn.appendChild(this._secondBarNotesBadge);
        leftGroup.appendChild(this._secondBarPostItBtn);

        // Runs button (Run Manager)
        this._runsBtn = document.createElement('button');
        this._runsBtn.className = 'info-bar-text-btn';
        this._runsBtn.innerHTML = '<i class="fa-solid fa-vial" style="font-size:13px;color:#e08b8b;-webkit-text-stroke:1px #555;paint-order:stroke fill"></i>';
        this._runsBtn.title = 'Experiments';
        this._runsBtn.addEventListener('click', () => this._onRunsToggle?.());
        leftGroup.appendChild(this._runsBtn);

        // Metrics button (Live Charts)
        this._metricsBtn = document.createElement('button');
        this._metricsBtn.className = 'info-bar-text-btn';
        this._metricsBtn.innerHTML = '<i class="fa-solid fa-chart-simple" style="font-size:14px;color:#42a5f5;-webkit-text-stroke:1px #555;paint-order:stroke fill"></i>';
        this._metricsBtn.title = 'Live Metrics';
        this._metricsBtn.addEventListener('click', () => this._onMetricsToggle?.());
        leftGroup.appendChild(this._metricsBtn);

        // Run as Pipeline button
        this._pipelineBtn = document.createElement('button');
        this._pipelineBtn.className = 'info-bar-text-btn';
        this._pipelineBtn.innerHTML = '<i class="fa-solid fa-rocket" style="font-size:13px;color:#ff9800;-webkit-text-stroke:1px #555;paint-order:stroke fill"></i>';
        this._pipelineBtn.title = 'Run as Pipeline';
        this._pipelineBtn.style.display = 'none';
        this._pipelineBtn.addEventListener('click', () => this._triggerPipeline());
        leftGroup.appendChild(this._pipelineBtn);

        // Load Model button (insert predict cell)
        this._loadModelBtn = document.createElement('button');
        this._loadModelBtn.className = 'info-bar-text-btn';
        this._loadModelBtn.innerHTML = '<i class="fa-solid fa-brain" style="font-size:12px;color:#e091d0;-webkit-text-stroke:1px #555;paint-order:stroke fill"></i>';
        this._loadModelBtn.title = 'Load Model from Registry';
        this._loadModelBtn.addEventListener('click', () => this._showLoadModelModal());
        leftGroup.appendChild(this._loadModelBtn);

        // Hydra config button + label (replaces dropdown)
        this._configBtn = document.createElement('button');
        this._configBtn.className = 'info-bar-text-btn';
        this._configBtn.innerHTML = '<img src="static/vendor/icons/hydra.svg" style="width:14px;height:14px;vertical-align:middle">';
        this._configBtn.title = 'Configuration Composer';
        this._configBtn.style.display = 'none';
        this._configBtn.addEventListener('click', () => this._showComposePanel?.());
        leftGroup.appendChild(this._configBtn);

        // Hydra baseline badge (M5): shows BASELINE or RUN <6-chars> based
        // on notebook metadata. Clickable: in Local mode, opens the most
        // recent run (if any); in MLflow mode, opens the pinned run in the
        // Explorer tree. Hidden when the notebook has no Hydra config.
        this._baselineBadge = document.createElement('span');
        this._baselineBadge.className = 'hydra-baseline-badge';
        this._baselineBadge.style.cssText = 'display:none;align-items:center;margin-left:4px;padding:2px 8px;font-size:10px;border:0.5px solid #c8c8c8;border-radius:10px;background:#fff;color:#555;cursor:pointer;white-space:nowrap;user-select:none';
        this._baselineBadge.addEventListener('click', () => {
            const meta = this._notebook?.metadata?.noted || {};
            const src = meta.hydra_baseline_source || 'project://config/';
            if (src.startsWith('mlflow://')) {
                const runId = src.substring('mlflow://'.length).replace(/^\/+|\/+$/g, '');
                if (runId && this._onRunIndicatorClick) {
                    this._onRunIndicatorClick(runId);
                }
            } else if (this._activeRunId && this._onRunIndicatorClick) {
                // In Local mode, clicking jumps to the current/latest run
                this._onRunIndicatorClick(this._activeRunId);
            }
        });
        leftGroup.appendChild(this._baselineBadge);


        // Hidden select for backward compatibility (metadata storage)
        this._configSelector = document.createElement('select');
        this._configSelector.style.display = 'none';
        this._configSelector.addEventListener('change', () => this._onConfigChange());

        // Active run indicator
        this._runIndicator = document.createElement('span');
        this._runIndicator.style.cssText = 'display:none;align-items:center;gap:4px;margin-left:6px;padding:2px 8px;font-size:10px;background:#e8f5e9;border:0.5px solid #c8e6c9;border-radius:10px;color:#2e7d32;cursor:pointer;white-space:nowrap';
        this._runIndicator.title = 'Click to view run in Experiments';
        this._runIndicator.addEventListener('click', () => {
            if (this._activeRunId && this._onRunIndicatorClick) {
                this._onRunIndicatorClick(this._activeRunId);
            }
        });
        leftGroup.appendChild(this._runIndicator);
        this._activeRunId = null;
        this._activeRunName = null;
        this._runIndicatorTimeout = null;

        bar.appendChild(leftGroup);

        // Center: kernel controls
        const controls = document.createElement('div');
        controls.className = 'info-bar-controls';
        // Run All with debug dropdown
        const runAllWrap = document.createElement('div');
        runAllWrap.style.cssText = 'display:flex;align-items:center;position:relative';
        runAllWrap.appendChild(mkBtn(ICONS.runAll, 'Run All', () => this.runAll()));

        const runAllChevron = document.createElement('button');
        runAllChevron.innerHTML = '<span style="font-size:8px;color:#333">\u25BC</span>';
        runAllChevron.title = 'Run All / Debug All';
        runAllChevron.style.cssText = 'padding:0;margin-left:-3px;background:none;border:none;cursor:pointer';
        runAllChevron.addEventListener('click', (e) => {
            e.stopPropagation();
            const existing = document.querySelector('.cell-run-dropdown');
            if (existing) { existing.remove(); return; }
            const dd = document.createElement('div');
            dd.className = 'cell-run-dropdown';
            const items = [
                { icon: '<span style="color:#4caf50;-webkit-text-stroke:1.5px #202020;paint-order:stroke fill">\u25B6</span>', label: 'Run All Cells', action: () => this.runAll() },
                { icon: '<i class="fa-solid fa-bug" style="color:#e53935;-webkit-text-stroke:1.5px #202020;paint-order:stroke fill"></i>', label: 'Debug All Cells', action: () => this.debugAll() },
            ];
            for (const item of items) {
                const row = document.createElement('div');
                row.className = 'cell-run-dropdown-item';
                row.innerHTML = `<span class="cell-run-dropdown-icon">${item.icon}</span>${item.label}`;
                row.addEventListener('click', (ev) => { ev.stopPropagation(); dd.remove(); item.action(); });
                dd.appendChild(row);
            }
            const rect = runAllChevron.getBoundingClientRect();
            dd.style.position = 'fixed';
            dd.style.left = `${rect.left}px`;
            dd.style.top = `${rect.bottom + 2}px`;
            document.body.appendChild(dd);
            const close = (ev) => { if (!dd.contains(ev.target)) { dd.remove(); document.removeEventListener('mousedown', close); } };
            dd.addEventListener('mouseleave', () => { dd.remove(); document.removeEventListener('mousedown', close); });
            requestAnimationFrame(() => document.addEventListener('mousedown', close));
        });
        runAllWrap.appendChild(runAllChevron);
        controls.appendChild(runAllWrap);
        controls.appendChild(mkBtn(ICONS.restart, 'Restart', () => this._client.restartKernel(this._notebookKey)));
        controls.appendChild(mkBtn(ICONS.stop, 'Stop', () => this._client.stopKernel(this._notebookKey)));
        controls.appendChild(mkBtn(ICONS.interrupt, 'Interrupt', () => this._client.interruptKernel(this._notebookKey)));
        controls.appendChild(mkBtn(ICONS.clearAll, 'Clear All Outputs', () => this.clearAllOutputs()));
        bar.appendChild(controls);

        // Right: kernel selector
        const rightGroup = document.createElement('div');
        rightGroup.className = 'second-bar-right';

        this._kernelItem = document.createElement('div');
        this._kernelItem.className = 'info-bar-kernel';
        this._kernelItem.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleKernelPicker();
        });

        this._kernelDot = document.createElement('span');
        this._kernelDot.className = 'kernel-status-dot dead';

        this._kernelLabel = document.createElement('span');
        this._kernelLabel.className = 'info-bar-label';
        this._kernelLabel.textContent = 'Select Environment Kernel';

        this._kernelItem.append(this._kernelDot, this._kernelLabel);
        rightGroup.appendChild(this._kernelItem);
        bar.appendChild(rightGroup);

        return bar;
    }

    /**
     * Create the debug toolbar bar. Hidden by default, shown during debug sessions.
     * Contains: Continue (F5), Step Over (F10), Step In (F11), Step Out (Shift+F11), Stop.
     */
    _createDebugBar() {
        const bar = document.createElement('div');
        bar.className = 'notebook-debug-bar';
        bar.style.display = 'none';  // hidden until debug session starts

        const mkBtn = (icon, title, onClick, shortcut = '') => {
            const btn = document.createElement('button');
            btn.className = 'debug-bar-btn';
            btn.innerHTML = icon;
            btn.title = shortcut ? `${title} (${shortcut})` : title;
            btn.addEventListener('click', onClick);
            return btn;
        };

        const controls = document.createElement('div');
        controls.className = 'debug-bar-controls';

        controls.appendChild(mkBtn(
            '<i class="fa-solid fa-circle-play" style="color:#4caf50;font-size:15px"></i>',
            'Continue', () => this._debugContinue(), 'F5'));
        controls.appendChild(mkBtn(
            '<i class="fa-solid fa-circle-right" style="color:#1976d2;font-size:15px"></i>',
            'Step Over', () => this._debugStepOver(), 'F10'));
        controls.appendChild(mkBtn(
            '<i class="fa-solid fa-circle-down" style="color:#1976d2;font-size:15px"></i>',
            'Step In', () => this._debugStepIn(), 'F11'));
        controls.appendChild(mkBtn(
            '<i class="fa-solid fa-circle-left" style="color:#1976d2;font-size:15px"></i>',
            'Step Out', () => this._debugStepOut(), 'Shift+F11'));
        controls.appendChild(mkBtn(
            '<i class="fa-solid fa-circle-stop" style="color:#e53935;font-size:15px"></i>',
            'Stop Debugging', () => this._debugStop(), 'Shift+F5'));

        bar.appendChild(controls);

        // Status text (shows reason for pause)
        this._debugStatusText = document.createElement('span');
        this._debugStatusText.className = 'debug-bar-status';
        bar.appendChild(this._debugStatusText);

        // Debug keyboard shortcuts (active only when debug bar is visible)
        document.addEventListener('keydown', (e) => {
            if (bar.style.display === 'none') return;
            if (e.key === 'F5' && !e.shiftKey) {
                e.preventDefault();
                this._debugContinue();
            } else if (e.key === 'F5' && e.shiftKey) {
                e.preventDefault();
                this._debugStop();
            } else if (e.key === 'F10') {
                e.preventDefault();
                this._debugStepOver();
            } else if (e.key === 'F11' && !e.shiftKey) {
                e.preventDefault();
                this._debugStepIn();
            } else if (e.key === 'F11' && e.shiftKey) {
                e.preventDefault();
                this._debugStepOut();
            }
        });

        return bar;
    }

    // --- Debug Session Management ---

    /**
     * Start a debug session and execute a cell with breakpoints.
     * Called when user triggers "Debug Cell" (e.g., Shift+Ctrl+Enter).
     */
    async debugCell(cellIndex) {
        const cell = this._cells[cellIndex];
        if (!cell || cell.cellType !== 'code') return;

        // Ensure kernel is running
        if (this._ensureKernelCallback) {
            const ok = await this._ensureKernelCallback();
            if (!ok) {
                notify.error('No kernel selected - choose an environment first');
                return;
            }
        }

        // Get the kernel session ID for DAP connection
        const sessionId = this._notebookKey;
        if (!sessionId) return;

        try {
            // Connect debug client if not connected
            if (!this._debugClient) {
                this._debugClient = new DebugClient();
                this._debugClient.on('stopped', (body) => this._onDebugStopped(body));
                this._debugClient.on('continued', () => this._onDebugContinued());
                this._debugClient.on('terminated', () => this._onDebugTerminated());
                this._debugClient.on('disconnected', () => this._onDebugTerminated());
                this._debugClient.on('output', (body) => {
                    if (body.category === 'stderr' && body.output) {
                        notify.error(body.output);
                    }
                });
            }

            if (!this._debugClient.connected) {
                // Find kernel session from the room key
                const statusResp = await fetch('api/dap/status');
                const statusData = await statusResp.json();
                let kernelSession = statusData.sessions?.find(s =>
                    s.session_id.startsWith(sessionId.replace('notebook:', ''))
                );
                if (!kernelSession) {
                    // Try matching by notebook key pattern
                    kernelSession = statusData.sessions?.find(s =>
                        sessionId.includes(s.session_id.split('_')[0]?.replace('notebook:', ''))
                    );
                }
                if (!kernelSession) {
                    notify.error('No debug-ready kernel found');
                    return;
                }
                const sid = kernelSession.session_id;
                await this._debugClient.connect(sid);
            }

            // Set breakpoints for ALL cells that have them
            for (let i = 0; i < this._cells.length; i++) {
                const c = this._cells[i];
                if (c.cellType !== 'code') continue;
                const bps = c.getBreakpoints();
                if (bps.length > 0) {
                    const source = {
                        cellCode: c.source,
                        name: `Cell ${i + 1}`,
                    };
                    await this._debugClient.setBreakpoints(source, bps.map(line => ({ line })));
                }
            }

            // Send configurationDone to start the debug session
            await this._debugClient._request('configurationDone');

            // Show debug bar
            this._debugBar.style.display = '';
            this._debugStatusText.textContent = 'Running...';

            // Track which cell is being debugged for line highlighting
            this._debugCellIndex = cellIndex;
            cell.setDebugMode(true);

            // Notify debug panel
            this._container.dispatchEvent(new CustomEvent('debug:started', {
                bubbles: true,
                detail: { debugClient: this._debugClient, cells: this._cells },
            }));

            // Execute the cell normally (debugpy will intercept at breakpoints)
            cell.startExecuting(true);
            this._client.executeCell(cellIndex, cell.source, this._notebookKey, this._selectedHydraConfig);

        } catch (e) {
            notify.error(`Debug failed: ${e.message}`);
            console.error('[Debug]', e);
        }
    }

    _onDebugStopped(body) {
        // JS debug: auto-continue past the internal debugger; sync point.
        // The IIFE wrapper injects "debugger;" so V8 pauses for breakpoint
        // binding. This pause is invisible to the user.
        if (this._kernelLanguage === 'javascript' &&
            (body.reason === 'debugger_statement' ||
             (body.reason === 'pause' && body.description?.includes('debugger statement')))) {
            if (this._debugClient) {
                this._debugClient.continue_();
            }
            return;
        }

        this._debugStatusText.textContent = `Paused: ${body.reason || 'breakpoint'}`;
        this._debugBar.style.display = '';

        // Get stack trace to find which cell/line we're on
        if (this._debugClient) {
            this._debugClient.stackTrace(body.threadId).then(result => {
                const frames = result.stackFrames || [];
                if (frames.length > 0) {
                    const frame = frames[0];
                    const line = frame.line;

                    // Clear all highlights
                    for (const cell of this._cells) {
                        cell.setDebugCurrentLine(0);
                    }

                    // Track current line for last-line detection
                    this._debugCurrentLine = line;

                    // Map line to the correct cell
                    let cellIdx = this._debugCellIndex ?? 0;
                    let cellLine = line;

                    if (this._debugAllActive && this._debugCellMap) {
                        // Debug All: map shadow file line to cell + cell-relative line
                        for (const entry of this._debugCellMap) {
                            if (line >= entry.start_line && line <= entry.end_line) {
                                cellIdx = entry.cell_index;
                                cellLine = line - entry.start_line + 1;
                                break;
                            }
                        }
                    }

                    const cell = this._cells[cellIdx];
                    if (cell) {
                        cell.setDebugCurrentLine(cellLine);
                        cell.element.scrollIntoView({ block: 'center' });
                    }

                    this._debugStatusText.textContent =
                        `Paused: ${body.reason || 'breakpoint'} (line ${cellLine}, Cell ${cellIdx + 1})`;

                    // Notify debug panel with stack frames
                    this._container.dispatchEvent(new CustomEvent('debug:stopped', {
                        bubbles: true,
                        detail: {
                            debugClient: this._debugClient,
                            threadId: body.threadId,
                            stackFrames: frames,
                        },
                    }));
                }
            }).catch(e => console.warn('[Debug] stackTrace error:', e));
        }
    }

    _onDebugContinued() {
        this._debugStatusText.textContent = 'Running...';
        for (const cell of this._cells) {
            cell.setDebugCurrentLine(0);
        }
        this._container.dispatchEvent(new CustomEvent('debug:continued', { bubbles: true }));
    }

    _onDebugTerminated() {
        if (!this._debugClient && this._debugCellIndex == null) return;
        this._debugBar.style.display = 'none';
        this._debugStatusText.textContent = '';
        if (this._debugCellIndex != null) {
            const cell = this._cells[this._debugCellIndex];
            if (cell) {
                cell.setDebugMode(false);
                // Mark cell to ignore the ghost execute_complete
                cell._debugAborted = true;
            }
        }
        this._debugCellIndex = null;
        this._debugCurrentLine = 0;
        this._debugAllActive = false;
        this._debugExecQueue = [];
        this._debugShadowPath = null;
        this._debugCellMap = null;
        for (const cell of this._cells) {
            cell.setDebugCurrentLine(0);
        }
        const client = this._debugClient;
        this._debugClient = null;
        if (client) {
            try { client.disconnect(); } catch {}
        }
        this._container.dispatchEvent(new CustomEvent('debug:terminated', { bubbles: true }));
    }

    async _debugContinue() {
        if (this._debugClient?.connected) await this._debugClient.continue_();
    }
    async _debugStepOver() {
        if (!this._debugClient?.connected) return;

        // Check if we're at the last line of the current cell's region
        let atBoundary = false;
        if (this._debugAllActive && this._debugCellMap) {
            // Debug All: check against the shadow file cell map
            for (const entry of this._debugCellMap) {
                if (entry.cell_index === this._debugCellIndex) {
                    if (this._debugCurrentLine >= entry.end_line) atBoundary = true;
                    break;
                }
            }
        } else {
            // Single cell debug: check against cell line count
            const cell = this._cells[this._debugCellIndex];
            if (cell && this._debugCurrentLine >= cell.source.split('\n').length) {
                atBoundary = true;
            }
        }

        if (atBoundary) {
            await this._debugClient.continue_();
        } else {
            await this._debugClient.stepOver();
        }
    }
    async _debugStepIn() {
        if (this._debugClient?.connected) await this._debugClient.stepIn();
    }
    async _debugStepOut() {
        if (this._debugClient?.connected) await this._debugClient.stepOut();
    }
    async _debugStop() {
        if (this._debugClient?.connected) {
            this._debugClient.disconnect();
        }
        this._onDebugTerminated();
    }

    setOnPostItToggle(cb) { this._onPostItToggle = cb; }
    setOnSave(cb) { this._onSave = cb; }

    updateNotesBadge(count) {
        if (!this._secondBarNotesBadge) return;
        this._secondBarNotesBadge.textContent = count || '';
        this._secondBarNotesBadge.style.display = count ? 'inline-block' : 'none';
    }

    _buildTopBarContent() {
        this._topBar.innerHTML = '';
        this._venvName = null;
        this._displayName = null;
        this._kernelLanguage = '';
        this._kernelStatus = 'dead';

        // Left: breadcrumb
        this._projectLabel = document.createElement('span');
        this._projectLabel.className = 'info-bar-text';
        this._projectLabel.textContent = '';

        this._topBarSep = document.createElement('span');
        this._topBarSep.className = 'info-bar-separator';
        this._topBarSep.textContent = '|';
        this._topBarSep.style.display = 'none';

        this._notebookLabel = document.createElement('span');
        this._notebookLabel.className = 'info-bar-text';
        this._notebookLabel.textContent = '';

        // Spacer to push undock button to the right
        const spacer = document.createElement('span');
        spacer.style.cssText = 'flex:1';

        // Undock button
        this._undockBtn = document.createElement('button');
        this._undockBtn.className = 'info-bar-text-btn';
        this._undockBtn.innerHTML = '<i class="fa-solid fa-up-right-from-square" style="font-size:11px;color:#555555"></i>';
        this._undockBtn.title = 'Undock to floating panel';
        this._undockBtn.addEventListener('click', () => this._onUndock?.());

        // Close button
        this._closeBtn = document.createElement('button');
        this._closeBtn.className = 'info-bar-text-btn';
        this._closeBtn.innerHTML = '<i class="fa-solid fa-xmark" style="font-size:11px;color:#555555"></i>';
        this._closeBtn.title = 'Close';
        this._closeBtn.addEventListener('click', () => this._onClose?.());

        this._topBar.append(this._projectLabel, this._topBarSep, this._notebookLabel, spacer, this._undockBtn, this._closeBtn);

        // Listen for kernel status (filtered by notebook key)
        this._kernelStatusHandler = (data) => {
            if (!data.notebook_key || data.notebook_key === this._notebookKey) {
                this._setKernelStatus(data.status);
            }
        };
        this._client.on('kernel:status', this._kernelStatusHandler);
    }

    destroy() {
        if (this._kernelStatusHandler) {
            this._client.off('kernel:status', this._kernelStatusHandler);
            this._kernelStatusHandler = null;
        }
    }

    setOnKernelSelect(cb) { this._onKernelSelect = cb; }
    setOnCreateEnv(cb) { this._onCreateEnv = cb; }
    setGetEnvs(cb) { this._getEnvs = cb; }

    setOnRunsToggle(cb) { this._onRunsToggle = cb; }
    setOnMetricsToggle(cb) { this._onMetricsToggle = cb; }
    setOnUndock(cb) { this._onUndock = cb; }
    setOnDock(cb) { this._onDock = cb; }
    setOnClose(cb) { this._onClose = cb; }
    set undocked(val) { this._undocked = val; }

    setNotebookMetadata(key, value) {
        if (this._notebook?.metadata) {
            this._notebook.metadata[key] = value;
        }
    }

    getNotebookMetadata() {
        return this._notebook?.metadata || {};
    }

    refreshRunBadges() {
        const runs = this._notebook?.metadata?.mlflow_runs || {};
        for (const cell of this._cells) {
            cell.updateRunBadges(runs);
        }
    }

    setRunManagerActiveRun(runId) {
        this._runManagerActiveRunId = runId;
    }

    _handleCellClick(idx, e) {
        // If Run Manager has an active run, toggle cell membership instead
        if (this._runManagerActiveRunId != null) {
            const cell = this._cells[idx];
            if (cell && cell._cellType === 'code') {
                cell.toggleRunMembership(this._runManagerActiveRunId);
                this.refreshRunBadges();
                this.save();
                if (this._onRunManagerRefresh) this._onRunManagerRefresh();
                return;
            }
        }
        this.selection.onCellClick(idx, e);
    }

    setOnRunManagerRefresh(cb) { this._onRunManagerRefresh = cb; }
    setGetActiveRunId(fn) { this._getActiveRunId = fn; }

    setProject(name) {
        this._projectLabel.textContent = name || '';
        this._updateTopBarSep();
    }

    setNotebook(name) {
        this._notebookLabel.textContent = name || '';
        this._updateTopBarSep();
    }

    setVenv(name, displayName, runtimeId) {
        this._venvName = name;
        this._displayName = displayName;
        // Derive kernel language from runtimeId (e.g., "javascript/20" -> "javascript")
        this._kernelLanguage = runtimeId
            ? runtimeId.split('/')[0] : '';
        // Update language label and clear stale diagnostics on all existing cells
        for (const cell of this._cells) {
            if (cell?.element) {
                cell.element.dataset.kernelLanguage = this._kernelLanguage;
            }
            // Propagate to the CellEditor instance so language-aware code
            // paths (completion trigger heuristics, syntax mode selection on
            // re-mount) see the right language. Without this, cells loaded
            // before the venv was picked stay on their initial language and
            // R completions never fire.
            if (cell && '_kernelLanguage' in cell) {
                cell._kernelLanguage = this._kernelLanguage;
            }
            // Clear Python lint diagnostics when switching to a non-Python kernel
            if (this._kernelLanguage !== 'python' && cell?.setLintDiagnostics) {
                cell.setLintDiagnostics([]);
            }
        }
        this._cellDiagnostics = null;
        if (name && this._kernelStatus === 'dead') {
            this._kernelDot.className = 'kernel-status-dot standby';
        }
        this._updateKernelLabel();
        // Persist venv in notebook metadata
        if (this._notebook) {
            if (!this._notebook.metadata) this._notebook.metadata = {};
            if (name) {
                this._notebook.metadata.noted = {
                    ...(this._notebook.metadata.noted || {}),
                    venv: { name, runtimeId: runtimeId || null, displayName: displayName || null }
                };
                // Update standard kernelspec so the backend and other tools
                // know the notebook's language (P1: zero lock-in)
                this._notebook.metadata.kernelspec = {
                    display_name: displayName || name,
                    language: this._kernelLanguage,
                    name: this._kernelLanguage === 'javascript' ? 'javascript' : 'python3',
                };
            } else {
                if (this._notebook.metadata.noted) {
                    delete this._notebook.metadata.noted.venv;
                }
            }
        }
    }

    getVenvMetadata() {
        return this._notebook?.metadata?.noted?.venv || null;
    }

    _setKernelStatus(status) {
        const prev = this._kernelStatus;
        this._kernelStatus = status;
        this._kernelDot.className = `kernel-status-dot ${status}`;
        this._updateKernelLabel();
        if (status === 'idle' && prev === 'starting') {
            this._flashKernelStatus('Ready');
            const label = this._venvName
                ? this._displayName ? `${this._venvName} (${this._displayName})` : this._venvName
                : 'Kernel';
            notify.success(`${label} started`);
        } else if (status === 'dead' && prev === 'starting') {
            const label = this._venvName
                ? this._displayName ? `${this._venvName} (${this._displayName})` : this._venvName
                : 'Kernel';
            notify.error(`${label} failed to start`);
        }
    }

    _updateKernelLabel() {
        const statusText = { starting: 'Starting', dead: 'Stopped' };
        const suffix = statusText[this._kernelStatus] || '';
        if (this._venvName) {
            const info = suffix ? `(${suffix})` : this._displayName ? `(${this._displayName})` : '';
            this._kernelLabel.textContent = info ? `${this._venvName} ${info}` : this._venvName;
        } else {
            this._kernelLabel.textContent = 'Select Environment Kernel';
        }
    }

    _flashKernelStatus(text) {
        if (this._flashTimer) clearTimeout(this._flashTimer);
        this._kernelLabel.textContent = `${this._venvName || 'Kernel'} (${text})`;
        this._flashTimer = setTimeout(() => {
            this._flashTimer = null;
            this._updateKernelLabel();
        }, 2000);
    }

    _toggleKernelPicker() {
        if (this._kernelPicker) {
            this._closeKernelPicker();
            return;
        }
        this._openKernelPicker();
    }

    async _openKernelPicker() {
        if (this._kernelPicker) return;

        const picker = document.createElement('div');
        picker.className = 'kernel-picker';
        this._kernelPicker = picker;

        // Position relative to kernel item, appended to body to escape overflow clipping
        const rect = this._kernelItem.getBoundingClientRect();
        picker.style.position = 'fixed';
        picker.style.top = (rect.bottom + 4) + 'px';
        picker.style.right = (window.innerWidth - rect.right) + 'px';

        // Loading state
        picker.innerHTML = '<div class="kernel-picker-loading">Loading...</div>';
        document.body.appendChild(picker);

        // Close on outside click
        this._kernelPickerClose = (e) => {
            if (!picker.contains(e.target) && !this._kernelItem.contains(e.target)) {
                this._closeKernelPicker();
            }
        };
        setTimeout(() => document.addEventListener('click', this._kernelPickerClose), 0);

        // Close on mouse leave (for undocked panels where picker is detached)
        picker.addEventListener('mouseleave', () => {
            this._kernelPickerLeaveTimer = setTimeout(() => this._closeKernelPicker(), 300);
        });
        picker.addEventListener('mouseenter', () => {
            clearTimeout(this._kernelPickerLeaveTimer);
        });
        this._kernelItem.addEventListener('mouseenter', () => {
            clearTimeout(this._kernelPickerLeaveTimer);
        });

        // Fetch envs
        let envs = [];
        if (this._getEnvs) {
            try { envs = await this._getEnvs(); } catch { /* empty */ }
        }

        if (!this._kernelPicker) return; // closed while loading
        picker.innerHTML = '';

        // Title
        const title = document.createElement('div');
        title.className = 'kernel-picker-title';
        title.textContent = 'Select Environment Kernel';
        picker.appendChild(title);

        if (envs.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'kernel-picker-empty';
            empty.textContent = 'No environments found';
            picker.appendChild(empty);
        }

        const list = document.createElement('div');
        list.className = 'kernel-picker-list';

        for (const env of envs) {
            const item = document.createElement('div');
            item.className = 'kernel-picker-item';
            if (this._venvName === env.name) item.classList.add('active');

            const starCol = document.createElement('span');
            starCol.className = 'kernel-picker-star';
            if (this._venvName === env.name) {
                starCol.innerHTML = '<i class="fa-solid fa-star"></i>';
            }
            item.appendChild(starCol);

            const name = document.createElement('span');
            name.className = 'kernel-picker-name';
            name.textContent = env.name;

            const version = document.createElement('span');
            version.className = 'kernel-picker-version';
            version.textContent = env.python_version ? `Python ${env.python_version}` : env.display_name || '';

            item.append(name, version);
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                this._closeKernelPicker();
                if (this._onKernelSelect) {
                    this._onKernelSelect({
                        name: env.name,
                        runtimeId: env.runtime_id,
                        displayName: env.display_name,
                        pythonVersion: env.python_version || null,
                    });
                }
            });
            list.appendChild(item);
        }
        picker.appendChild(list);

        // Create Environment button
        const createRow = document.createElement('div');
        createRow.className = 'kernel-picker-footer';
        const createBtn = document.createElement('button');
        createBtn.className = 'explorer-btn primary';
        createBtn.textContent = 'Create Environment';
        createBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._closeKernelPicker();
            if (this._onCreateEnv) this._onCreateEnv();
        });
        createRow.appendChild(createBtn);
        picker.appendChild(createRow);
    }

    _closeKernelPicker() {
        if (this._kernelPickerClose) {
            document.removeEventListener('click', this._kernelPickerClose);
            this._kernelPickerClose = null;
        }
        if (this._kernelPicker) {
            this._kernelPicker.remove();
            this._kernelPicker = null;
        }
    }

    _updateTopBarSep() {
        const hasProject = !!this._projectLabel.textContent;
        const hasNotebook = !!this._notebookLabel.textContent;
        this._topBarSep.style.display = (hasProject && hasNotebook) ? '' : 'none';
    }

    _clear() {
        for (const cell of this._cells) {
            cell.destroy();
        }
        this._cells = [];
        this._selectedIndices.clear();
        this._container.innerHTML = '';
        this._wrapperEl = null;
    }

    _createCellEditor(cellData, index) {
        return new CellEditor(cellData, index, {
            onFocus: () => { this._lastFocusedCellIndex = index; },
            onBlur: () => {},
            onChange: (idx, source) => this._onCellChange(idx, source),
            onRun: (idx, code) => this._onCellRun(idx, code),
            onDebugRun: (idx, code) => this.debugCell(idx),
            onDebugStop: () => this._debugStop(),
            onBreakpointChange: (idx) => {
                // Re-send breakpoints to debugger if a debug session is active
                if (this._debugClient?.connected) {
                    if (this._debugAllActive && this._debugShadowPath && this._debugCellMap) {
                        this._resendBreakpoints();
                    } else {
                        this._resendCellBreakpoints(idx);
                    }
                }
                this._container.dispatchEvent(new CustomEvent('debug:breakpoints-changed', {
                    bubbles: true,
                    detail: { cells: this._cells },
                }));
            },
            onInterrupt: () => this._client.interruptKernel(this._notebookKey),
            onDelete: (idx) => this._onCellDelete(idx),
            onAddCell: (idx, type) => this._addCell(idx, type),
            onRunAbove: (idx) => this.runAbove(idx),
            onRunBelow: (idx) => this.runBelow(idx),
            onCellKeydown: (idx, e) => this.selection.onCellKeydown(idx, e),
            onCellMousedown: (idx, e) => this.selection.onCellMousedown(idx, e),
            onCellClick: (idx, e) => this._handleCellClick(idx, e),
            onCellDragStart: (idx, e) => this.dragDrop.onDragStart(idx, e),
            onCellDragEnd: () => this.dragDrop.onDragEnd(),
            onEditorFocus: (idx) => this._client.lockCell(idx, this._notebookKey),
            onEditorBlur: (idx) => this._client.unlockCell(idx, this._notebookKey),
            onCursorActivity: (info) => { if (this.onCursorActivity) this.onCursorActivity({ ...info, cellIndex: index }); },
            onRunBadgeClick: () => {
                this.refreshRunBadges();
                this.save();
                if (this._onRunManagerRefresh) this._onRunManagerRefresh();
            },
            onAddToRun: (idx) => {
                const activeRunId = this._getActiveRunId?.();
                if (activeRunId == null) {
                    if (this._onRunsToggle) this._onRunsToggle();
                    return;
                }
                const cell = this._cells[idx];
                if (cell) {
                    cell.toggleRunMembership(activeRunId);
                    this.refreshRunBadges();
                    this.save();
                    if (this._onRunManagerRefresh) this._onRunManagerRefresh();
                }
            }
        }, this._kernelLanguage || 'python');
    }

    _createAddCellButton() {
        const container = document.createElement('div');
        container.className = 'add-cell-container';

        const getIndex = () => {
            const addBtns = this._wrapperEl.querySelectorAll('.add-cell-container');
            return [...addBtns].indexOf(container);
        };

        const codeBtn = document.createElement('button');
        codeBtn.className = 'add-cell-button add-cell-code';
        codeBtn.textContent = '+ code';
        codeBtn.addEventListener('click', () => this._addCell(getIndex(), 'code'));

        const mdBtn = document.createElement('button');
        mdBtn.className = 'add-cell-button add-cell-markdown';
        mdBtn.textContent = '+ markdown';
        mdBtn.addEventListener('click', () => this._addCell(getIndex(), 'markdown'));

        const center = document.createElement('div');
        center.className = 'add-cell-buttons';
        center.append(codeBtn, mdBtn);
        container.append(center);
        return container;
    }

    // --- Local cell operations ---

    _addCell(index, cellType = 'code', { skipUndo = false } = {}) {
        if (!skipUndo) this._pushUndo();

        const cellId = Math.random().toString(36).substring(2, 10);
        const cellData = {
            cell_type: cellType,
            id: cellId,
            metadata: {},
            source: [],
            outputs: [],
            execution_count: null
        };

        const cellEditor = this._createCellEditor(cellData, index);
        this._cells.splice(index, 0, cellEditor);
        this._reindexCells();

        if (this._wrapperEl) {
            const addBtn = this._createAddCellButton();
            // Find the add-cell button that was clicked (at position `index` among all add-cell buttons)
            const allAddBtns = this._wrapperEl.querySelectorAll('.add-cell-container');
            const clickedAddBtn = allAddBtns[index];
            if (clickedAddBtn) {
                // Insert new cell and its trailing add-button after the clicked add-button
                clickedAddBtn.after(cellEditor.element, addBtn);
            }
            this._updateAddCellLast();
        }

        this._client.addCell(index, cellType, cellId, this._notebookKey);
        if (this._onChangeCallback) this._onChangeCallback();
    }

    _onCellDelete(index) {
        this._pushUndo();

        const isLastCell = this._cells.length <= 1;
        const cell = this._cells[index];
        // Remove the add-cell button after this cell
        const addBtnAfter = cell.element.nextElementSibling;
        if (addBtnAfter?.classList.contains('add-cell-container')) addBtnAfter.remove();
        cell.destroy();
        this._cells.splice(index, 1);

        this._reindexCells();
        this._updateAddCellLast();
        this._client.deleteCell(index, this._notebookKey);
        if (this._onChangeCallback) this._onChangeCallback();

        if (isLastCell) {
            this._addCell(0, 'code', { skipUndo: true });
            this.selection.selectCell(0);
            this._cells[0].focusCell();
        }
    }

    _reindexCells() {
        for (let i = 0; i < this._cells.length; i++) {
            this._cells[i].index = i;
        }
    }

    _reorderDOM() {
        if (!this._wrapperEl) return;
        // Remove all children after topBar and secondBar
        while (this._wrapperEl.children.length > 2) {
            this._wrapperEl.lastChild.remove();
        }
        // Re-append addBtn + cell pairs in current _cells order
        for (let i = 0; i < this._cells.length; i++) {
            this._wrapperEl.appendChild(this._createAddCellButton());
            this._wrapperEl.appendChild(this._cells[i].element);
        }
        // Final add-cell button
        const lastBtn = this._createAddCellButton();
        lastBtn.classList.add('add-cell-last');
        this._wrapperEl.appendChild(lastBtn);
    }

    _updateAddCellLast() {
        if (!this._wrapperEl) return;
        const addBtns = this._wrapperEl.querySelectorAll('.add-cell-container');
        addBtns.forEach(btn => btn.classList.remove('add-cell-last'));
        if (addBtns.length > 0) {
            addBtns[addBtns.length - 1].classList.add('add-cell-last');
        }
    }

    // --- Cell callbacks ---

    _onCellChange(index, source) {
        clearTimeout(this._debounceTimers[index]);
        this._debounceTimers[index] = setTimeout(() => {
            this._client.updateCell(index, source, this._notebookKey);
        }, 300);
        if (this._onChangeCallback) this._onChangeCallback();
    }

    async _onCellRun(index, code) {
        if (this._ensureKernelCallback) {
            const ok = await this._ensureKernelCallback();
            if (!ok) {
                notify.error('No kernel selected — choose an environment first');
                return;
            }
        }
        const cell = this._cells[index];
        if (cell) cell.startExecuting();
        this._client.executeCell(index, code, this._notebookKey, this._selectedHydraConfig);
    }

    // --- Undo ---

    _pushUndo() {
        this._undoStack.push(this._cells.map(c => c.toJSON()));
        if (this._undoStack.length > this._maxUndoSize) {
            this._undoStack.shift();
        }
    }

    /** Public undo entry point used by the menu (Edit > Undo).
     *
     * When a cell editor has focus, the menu bar's keyboard handler
     * lets Ctrl+Z fall through to CodeMirror's history (character-
     * level undo within the cell). This method only runs when the
     * menu's Edit > Undo is invoked WITHOUT an editor focused, in
     * which case the user wants the cell-level structural undo.
     */
    undo() {
        this._undo();
    }

    _undo() {
        if (this._undoStack.length === 0) return;
        const snapshot = this._undoStack.pop();

        for (let i = this._cells.length - 1; i >= 0; i--) {
            this._client.deleteCell(i, this._notebookKey);
        }

        this._notebook.cells = snapshot;
        this._cells = [];
        this._render();

        for (let i = 0; i < snapshot.length; i++) {
            const cell = snapshot[i];
            this._client.addCell(i, cell.cell_type, cell.id, this._notebookKey);
            const src = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
            if (src) {
                this._client.updateCell(i, src, this._notebookKey);
            }
        }

        if (this._cells.length > 0) {
            this.selection.selectCell(0);
            this._cells[0].focusCell();
        }
    }

    /** Scroll cell into view and select it. Used by the LLM scroll_to_cell tool. */
    scrollToCell(index) {
        const cell = this._cells[index];
        if (!cell) return false;
        this.selection.selectCell(index);
        cell.element.scrollIntoView({ block: 'start' });
        return true;
    }

    // --- Remote events ---

    _onCellDiagnostics(data) {
        const cell = this._cells[data.cell_index];
        if (cell) {
            cell.setLintDiagnostics(data.diagnostics || []);
        }
        if (!this._cellDiagnostics) this._cellDiagnostics = {};
        this._cellDiagnostics[data.cell_index] = data.diagnostics || [];
        if (this.onDiagnosticsChange) {
            this.onDiagnosticsChange(this.getDiagnostics());
        }
    }

    getDiagnostics() {
        if (!this._cellDiagnostics) return [];
        const all = [];
        for (const [cellIdx, diags] of Object.entries(this._cellDiagnostics)) {
            for (const d of diags) {
                const line = (d.range?.start?.line ?? 0) + 1;
                const severity = d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info';
                all.push({
                    severity,
                    message: d.message || '',
                    line,
                    cellIndex: parseInt(cellIdx),
                });
            }
        }
        return all;
    }

    _onRemoteCellUpdate(data) {
        const cell = this._cells[data.cell_index];
        if (cell) {
            cell.setSource(data.source);
        }
    }

    _onRemoteCellAdd(data) {
        const cellData = {
            cell_type: data.cell_type,
            id: data.cell_id,
            metadata: {},
            source: [],
            outputs: [],
            execution_count: null
        };
        const index = data.cell_index;
        const cellEditor = this._createCellEditor(cellData, index);
        this._cells.splice(index, 0, cellEditor);
        this._reindexCells();

        if (this._wrapperEl) {
            const addBtn = this._createAddCellButton();
            const allAddBtns = this._wrapperEl.querySelectorAll('.add-cell-container');
            const refAddBtn = allAddBtns[index];
            if (refAddBtn) {
                refAddBtn.after(cellEditor.element, addBtn);
            }
        }
    }

    _onRemoteCellDelete(data) {
        const index = data.cell_index;
        if (index >= 0 && index < this._cells.length) {
            const cell = this._cells[index];
            const addBtnAfter = cell.element.nextElementSibling;
            if (addBtnAfter?.classList.contains('add-cell-container')) addBtnAfter.remove();
            cell.destroy();
            this._cells.splice(index, 1);
            this._reindexCells();
        }
    }

    _onRemoteCellMove(data) {
        const { from_index, to_index } = data;
        if (from_index < 0 || from_index >= this._cells.length) return;
        if (to_index < 0 || to_index >= this._cells.length) return;

        const [cell] = this._cells.splice(from_index, 1);
        this._cells.splice(to_index, 0, cell);
        this._reindexCells();

        this._notebook.cells = this._cells.map(c => c.toJSON());
        this._reorderDOM();
    }

    _onCellOutput(data) {
        const cell = this._cells[data.cell_index];
        if (cell && !cell._debugAborted) {
            cell.addOutput(data.output);
        }
    }

    _onExecuteComplete(data) {
        const cell = this._cells[data.cell_index];
        if (cell) {
            // Skip ghost completion from debug stop cleanup
            if (cell._debugAborted) {
                cell._debugAborted = false;
                cell._executing = false;
                cell._el?.classList.remove('executing');
                cell._runBtn.textContent = '\u25B6';
                cell._runBtn.title = 'Run cell';
                cell._runBtn.classList.remove('stopping');
                const spinner = cell._output?.element?.querySelector('.output-executing');
                if (spinner) spinner.remove();
                return;
            }
            cell.onExecuteComplete(data.execution_count, data.elapsed);

            // Debug cell completed
            if (this._debugCellIndex === data.cell_index && this._debugClient) {
                // JS Debug All: boundary execute_complete has 'elapsed' field.
                // Don't terminate on those - only on the final execute_complete.
                if (data.elapsed != null && this._debugAllActive &&
                    this._kernelLanguage === 'javascript') {
                    // Boundary timing - just update the timer, don't terminate
                } else {
                    const prevCell = this._cells[this._debugCellIndex];
                    if (prevCell) prevCell.setDebugMode(false);

                    if (this._debugAllActive && this._debugExecQueue?.length) {
                        // Debug All: advance to next cell
                        this._debugExecNext();
                    } else {
                        // Single cell debug or last cell: terminate
                        this._onDebugTerminated();
                    }
                }
            }

            if (this._execRunning) {
                const hadError = cell._data.outputs?.some(
                    o => o.output_type === 'error'
                );
                if (hadError) {
                    this._cancelExecQueue();
                } else {
                    this._execNext();
                }
            }
        }
    }

    _onLockChanged(data) {
        const cell = this._cells[data.cell_index];
        if (!cell) return;
        if (data.locked) {
            const isSelf = data.owner_sid === this._client.sid;
            cell.setLock(data.owner, data.owner_sid, isSelf);
        } else {
            cell.clearLock();
        }
    }

    _onError(data) {
        if (data.code === 'INVALID_REQUEST') {
            notify.error(data.message || 'Request failed');
            return;
        }

        for (const cell of this._cells) {
            if (cell._executing) {
                cell.addOutput({
                    output_type: 'error',
                    ename: data.code || 'Error',
                    evalue: data.message || 'Unknown error',
                    traceback: []
                });
                cell.onExecuteComplete(null);
            }
        }
    }

    setOnSaved(cb) { this._onSavedCallback = cb; }

    _onNotebookSaved(data) {
        if (!this._savePending) return;
        this._savePending = false;
        if (data.success) {
            notify.success('Saved');
            this._onSavedCallback?.();
        } else {
            notify.error('Save failed');
            console.error('Save failed:', data.error);
        }
    }


    // --- Serialization ---

    _serializeNotebook() {
        const nb = JSON.parse(JSON.stringify(this._notebook));
        nb.cells = this._cells.map(c => c.toJSON());
        return nb;
    }

    // --- Active Run Indicator ---

    set onRunIndicatorClick(fn) { this._onRunIndicatorClick = fn; }

    updateRunIndicator(runId, runName) {
        if (!runId) {
            this._clearRunIndicator();
            return;
        }

        this._activeRunId = runId;
        this._activeRunName = runName || runId.substring(0, 8);
        this._runIndicator.innerHTML = `<span style="display:inline-block;width:6px;height:6px;background:#4caf50;border-radius:50%;animation:pulse 1.5s infinite"></span> ${this._escapeLabel(this._activeRunName)}`;
        this._runIndicator.style.display = 'inline-flex';

        // Auto-clear after 5 minutes of no updates
        clearTimeout(this._runIndicatorTimeout);
        this._runIndicatorTimeout = setTimeout(() => this._clearRunIndicator(), 300000);
    }

    _clearRunIndicator() {
        this._activeRunId = null;
        this._activeRunName = null;
        this._runIndicator.style.display = 'none';
        this._runIndicator.innerHTML = '';
        clearTimeout(this._runIndicatorTimeout);
    }

    _escapeLabel(str) {
        return str.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // --- Hydra Config ---

    async _loadHydraConfig(projectId) {
        this._selectedHydraConfig = null;
        this._configBtn.style.display = 'none';
        if (this._baselineBadge) this._baselineBadge.style.display = 'none';
        this._hydraGroups = null;
        this._hydraActiveSchema = null;
        this._hydraBadgeError = null;

        // Resolve the schema against the notebook's actual baseline source
        // (local config/ OR a pinned MLflow run). A failure here becomes the
        // red X state on the badge.
        const meta = this._notebook?.metadata?.noted || {};
        const baselineSource = meta.hydra_baseline_source || 'project://config/';
        const notebookUid = meta.notebook_uid || null;

        const params = new URLSearchParams();
        if (baselineSource && baselineSource !== 'project://config/') {
            params.set('baseline_source', baselineSource);
            if (notebookUid) params.set('notebook_uid', notebookUid);
        }
        const qs = params.toString();
        const url = `api/hydra/schema/${encodeURIComponent(projectId)}${qs ? '?' + qs : ''}`;

        try {
            const resp = await fetch(url);
            if (!resp.ok) {
                // If the pinned source is unreachable, fall back to the
                // local schema so the Composer still opens, but mark the
                // badge with the red X error state.
                let errDetail = `HTTP ${resp.status}`;
                try {
                    const err = await resp.json();
                    errDetail = err.detail || errDetail;
                } catch {}
                if (baselineSource.startsWith('mlflow://')) {
                    this._hydraBadgeError = errDetail;
                    // Try to fetch local schema as fallback for rendering
                    try {
                        const localResp = await fetch(`api/hydra/schema/${encodeURIComponent(projectId)}`);
                        if (localResp.ok) {
                            const localSchema = await localResp.json();
                            if (localSchema.has_config) {
                                this._configBtn.style.display = '';
                                this._hydraGroups = localSchema.groups || {};
                                this._hydraActiveSchema = localSchema;
                            }
                        }
                    } catch {}
                    this._selectedHydraConfig = { type: 'default' };
                    this._onConfigChange();
                    this._updateBaselineBadge();
                    return;
                }
                console.warn('Hydra schema fetch failed:', resp.status, url);
                return;
            }
            const schema = await resp.json();
            if (!schema.has_config) { console.warn('Hydra: no config for', projectId); return; }

            this._configBtn.style.display = '';
            this._hydraGroups = schema.groups || {};
            this._hydraActiveSchema = schema;

            // Set default config
            this._selectedHydraConfig = { type: 'default' };
            this._onConfigChange();
            this._updateBaselineBadge();
        } catch (err) {
            console.warn('Hydra config load failed:', err);
            if (baselineSource.startsWith('mlflow://')) {
                this._hydraBadgeError = err.message || String(err);
                this._configBtn.style.display = '';
                this._updateBaselineBadge();
            }
        }
    }

    /** Update the notebook-bar baseline badge from notebook metadata.
     *  Shows 'BASELINE' in Local mode, 'RUN xxxxxx' in MLflow mode.
     *  Appends a tiny overlay indicator at the bottom-right corner:
     *    - green check (fa-check)    : unchanged config
     *    - orange exclamation (fa-exclamation) : modified from baseline
     *    - red cross (fa-xmark)       : baseline source unreachable
     */
    _updateBaselineBadge() {
        if (!this._baselineBadge) return;
        const meta = this._notebook?.metadata?.noted;
        if (!meta || !this._configBtn || this._configBtn.style.display === 'none') {
            this._baselineBadge.style.display = 'none';
            return;
        }
        const src = meta.hydra_baseline_source || 'project://config/';
        const isMlflow = src.startsWith('mlflow://');

        // Base text + styling (purple for RUN, neutral for BASELINE)
        this._baselineBadge.innerHTML = '';
        const textSpan = document.createElement('span');
        if (isMlflow) {
            const runId = src.substring('mlflow://'.length).replace(/^\/+|\/+$/g, '');
            const short = runId.substring(0, 6) || '??????';
            textSpan.textContent = `RUN ${short}`;
            this._baselineBadge.style.color = '#7b1fa2';
            this._baselineBadge.style.borderColor = '#d1a7e8';
            this._baselineBadge.style.background = '#faf4fd';
        } else {
            textSpan.textContent = 'BASELINE';
            this._baselineBadge.style.color = '#555';
            this._baselineBadge.style.borderColor = '#c8c8c8';
            this._baselineBadge.style.background = '#fff';
        }
        this._baselineBadge.style.position = 'relative';
        this._baselineBadge.appendChild(textSpan);

        // Compute state: error (red X) > modified (orange !) > ok (green check)
        const state = this._computeBaselineBadgeState(src);

        // Overlay indicator (small icon at bottom-right)
        const dot = document.createElement('span');
        dot.className = 'hydra-baseline-badge-dot';
        dot.style.cssText = 'position:absolute;right:-4px;bottom:-4px;width:12px;height:12px;border-radius:50%;border:0.5px solid #999;display:flex;align-items:center;justify-content:center;font-size:8px;line-height:1;box-shadow:0 1px 2px rgba(0,0,0,0.15);color:#fff';
        const icon = document.createElement('i');
        if (state.kind === 'error') {
            icon.className = 'fa-solid fa-xmark';
            dot.style.background = '#c62828';
            dot.style.borderColor = '#c62828';
            this._baselineBadge.title = state.tooltip;
        } else if (state.kind === 'modified') {
            icon.className = 'fa-solid fa-exclamation';
            dot.style.background = '#f57c00';
            dot.style.borderColor = '#f57c00';
            this._baselineBadge.title = state.tooltip;
        } else {
            icon.className = 'fa-solid fa-check';
            dot.style.background = '#2e7d32';
            dot.style.borderColor = '#2e7d32';
            this._baselineBadge.title = state.tooltip;
        }
        dot.appendChild(icon);
        this._baselineBadge.appendChild(dot);

        this._baselineBadge.style.display = 'inline-flex';
    }

    /** Compute the badge state: error | modified | ok. */
    _computeBaselineBadgeState(src) {
        // 1. Error state: pinned MLflow source failed to resolve on load
        if (this._hydraBadgeError) {
            return {
                kind: 'error',
                tooltip: `Baseline unreachable: ${this._hydraBadgeError}\nOpen Configuration Composer to switch to a valid baseline.`,
            };
        }

        const meta = this._notebook?.metadata?.noted || {};
        const isMlflow = src.startsWith('mlflow://');
        const saved = meta.hydra_selections || {};
        const currentGroupSelections = saved.group_selections || {};
        const currentOverrides = saved.overrides || {};

        if (isMlflow) {
            // RUN mode: compare against the archived selections snapshot.
            const archived = meta.hydra_pinned_archived_selections;
            if (!archived) {
                // No snapshot available - assume unchanged (best we can do
                // for notebooks pinned before the snapshot mechanism shipped).
                return {
                    kind: 'ok',
                    tooltip: `Baseline from archived MLflow run - click to open in Explorer`,
                };
            }
            const archivedGroupSelections = archived.group_selections || {};
            const archivedOverrides = archived.overrides || {};
            const modified = !this._selectionsEqual(currentGroupSelections, archivedGroupSelections)
                          || !this._overridesEqual(currentOverrides, archivedOverrides);
            if (modified) {
                return {
                    kind: 'modified',
                    tooltip: `Config has local changes on top of the archived run. Open Configuration Composer to see details.`,
                };
            }
            return {
                kind: 'ok',
                tooltip: `Config matches the archived run - click to open it in Explorer`,
            };
        }

        // BASELINE (local) mode: compare against Hydra defaults from schema.
        const schema = this._hydraActiveSchema;
        if (!schema) {
            // Schema not loaded yet - assume unchanged.
            return {
                kind: 'ok',
                tooltip: `Local baseline (config/ folder) - click to open the current run in Explorer`,
            };
        }
        const defaultGroupSelections = {};
        for (const [group, info] of Object.entries(schema.groups || {})) {
            if (info && info.default) defaultGroupSelections[group] = info.default;
        }
        const modifiedGroups = !this._selectionsEqual(currentGroupSelections, defaultGroupSelections, /*allowPartial=*/true);
        const modifiedOverrides = Object.keys(currentOverrides).length > 0;
        if (modifiedGroups || modifiedOverrides) {
            // Build a precise tooltip listing exactly which keys differ
            // so the user (and developer) can see the drift at a glance.
            const diffParts = [];
            if (modifiedGroups) {
                for (const [g, v] of Object.entries(currentGroupSelections)) {
                    const def = defaultGroupSelections[g];
                    if (v !== def) diffParts.push(`${g}: ${v} (default: ${def})`);
                }
            }
            if (modifiedOverrides) {
                for (const [k, v] of Object.entries(currentOverrides)) {
                    diffParts.push(`${k} = ${v}`);
                }
            }
            const details = diffParts.length ? `\nDrift:\n  ${diffParts.join('\n  ')}` : '';
            return {
                kind: 'modified',
                tooltip: `Local baseline with custom selections/overrides.${details}`,
            };
        }
        return {
            kind: 'ok',
            tooltip: `Local baseline (config/ folder), using defaults - click to open the current run in Explorer`,
        };
    }

    _selectionsEqual(a, b, allowPartial = false) {
        const ka = Object.keys(a || {});
        const kb = Object.keys(b || {});
        if (allowPartial) {
            // BASELINE mode: current selections may omit keys that are at default.
            // Any explicit selection that differs from default is "modified".
            // Treat undefined, null, and empty string as "not selected" so
            // stale/partial metadata doesn't trigger phantom drift warnings.
            for (const k of new Set([...ka, ...kb])) {
                const va = a?.[k];
                const vb = b?.[k];
                if (va === undefined || va === null || va === '') continue;
                if (va !== vb) return false;
            }
            return true;
        }
        if (ka.length !== kb.length) return false;
        for (const k of ka) {
            if (a[k] !== b[k]) return false;
        }
        return true;
    }

    _overridesEqual(a, b) {
        const ka = Object.keys(a || {});
        const kb = Object.keys(b || {});
        if (ka.length !== kb.length) return false;
        for (const k of ka) {
            if (String(a[k]) !== String(b[k])) return false;
        }
        return true;
    }

    _onConfigChange() {
        // Default config - use all defaults from Hydra groups
        const baselineSource = this._notebook?.metadata?.noted?.hydra_baseline_source || 'project://config/';
        const notebookUid = this._notebook?.metadata?.noted?.notebook_uid || null;
        this._selectedHydraConfig = {
            type: 'default',
            baseline_source: baselineSource,
            notebook_uid: notebookUid,
        };

        // If notebook has saved selections (group_selections + overrides), use those
        const saved = this._notebook?.metadata?.noted?.hydra_selections;
        if (saved && typeof saved === 'object') {
            // New nested format: { group_selections: {...}, overrides: {...} }
            if (saved.group_selections || saved.overrides) {
                this._selectedHydraConfig = {
                    type: 'composed',
                    baseline_source: baselineSource,
                    notebook_uid: notebookUid,
                    group_selections: saved.group_selections || {},
                    overrides: saved.overrides || {},
                };
            } else {
                // Legacy flat format: { model: 'gru_baseline', data: 'default' }
                // Treat as group_selections only, no overrides
                this._selectedHydraConfig = {
                    type: 'composed',
                    baseline_source: baselineSource,
                    notebook_uid: notebookUid,
                    group_selections: saved,
                    overrides: {},
                };
            }
        }
    }

    /**
     * Update Hydra config with multi-group selections AND overrides from
     * the Compose panel. Both fields persist to notebook metadata.
     *
     * @param {object} selections - { group_selections: {...}, overrides: {...},
     *   baseline_source?: string } Legacy calls passing a flat
     *   group-selections object are also supported.
     */
    setHydraSelections(selections) {
        if (!this._notebook) return;

        // Ensure notebook_uid exists (lazy, only for Hydra-using notebooks)
        if (!this._notebook.metadata) this._notebook.metadata = {};
        if (!this._notebook.metadata.noted) this._notebook.metadata.noted = {};
        if (!this._notebook.metadata.noted.notebook_uid) {
            this._notebook.metadata.noted.notebook_uid = _generateUUID();
        }

        // Normalize input to { group_selections, overrides, baseline_source }
        let groupSelections, overrides, requestedBaselineSource, archivedSelections;
        if (selections && (selections.group_selections || selections.overrides || selections.baseline_source)) {
            groupSelections = selections.group_selections || {};
            overrides = selections.overrides || {};
            requestedBaselineSource = selections.baseline_source;
            archivedSelections = selections.archived_selections;
        } else {
            // Legacy flat format
            groupSelections = selections || {};
            overrides = {};
            requestedBaselineSource = undefined;
            archivedSelections = undefined;
        }

        // Write to notebook metadata in new nested format
        this._notebook.metadata.noted.hydra_selections = {
            group_selections: groupSelections,
            overrides: overrides,
        };

        // Apply baseline source if provided; otherwise keep existing/default
        if (requestedBaselineSource) {
            this._notebook.metadata.noted.hydra_baseline_source = requestedBaselineSource;
        } else if (!this._notebook.metadata.noted.hydra_baseline_source) {
            this._notebook.metadata.noted.hydra_baseline_source = 'project://config/';
        }

        // Stash the archived selections snapshot for RUN mode (used by
        // the notebook-bar badge to detect "modified" state). Clear it
        // when switching to Local mode.
        if (requestedBaselineSource && requestedBaselineSource.startsWith('mlflow://') && archivedSelections) {
            this._notebook.metadata.noted.hydra_pinned_archived_selections = archivedSelections;
        } else if (requestedBaselineSource && requestedBaselineSource.startsWith('project://')) {
            delete this._notebook.metadata.noted.hydra_pinned_archived_selections;
        }
        // Apply implies the source is currently reachable (Composer just
        // loaded or read the schema successfully). Clear any stale error.
        this._hydraBadgeError = null;
        const baselineSource = this._notebook.metadata.noted.hydra_baseline_source;
        const notebookUid = this._notebook.metadata.noted.notebook_uid;

        this._selectedHydraConfig = {
            type: 'composed',
            baseline_source: baselineSource,
            notebook_uid: notebookUid,
            group_selections: groupSelections,
            overrides: overrides,
        };
        // The badge compares current selections against the schema's
        // defaults. If the baseline source changed (or we're unsure the
        // cached schema matches the active source), refetch it before
        // the badge re-renders. Fire-and-forget.
        this._refreshActiveSchema(baselineSource, notebookUid).finally(() => {
            this._updateBaselineBadge?.();
        });
        this._onChangeCallback?.();
    }

    /** Refetch the active Hydra schema for the given baseline source so
     *  `_hydraActiveSchema` is never stale relative to what the notebook
     *  is currently pinned to. Used by the badge to determine "modified". */
    async _refreshActiveSchema(baselineSource, notebookUid) {
        if (!this._projectId) return;
        const params = new URLSearchParams();
        if (baselineSource && baselineSource !== 'project://config/') {
            params.set('baseline_source', baselineSource);
            if (notebookUid) params.set('notebook_uid', notebookUid);
        }
        const qs = params.toString();
        const url = `api/hydra/schema/${encodeURIComponent(this._projectId)}${qs ? '?' + qs : ''}`;
        try {
            const resp = await fetch(url);
            if (resp.ok) {
                const schema = await resp.json();
                if (schema && schema.has_config) {
                    this._hydraActiveSchema = schema;
                    this._hydraGroups = schema.groups || {};
                }
            }
        } catch {}
    }

    // --- Run as Pipeline ---

    async _loadProjectDags(projectId) {
        this._projectDags = [];
        this._pipelineBtn.style.display = 'none';
        try {
            const tag = projectId;
            const resp = await fetch(`api/airflow/dags?tag=${encodeURIComponent(tag)}`);
            if (!resp.ok) return;
            const data = await resp.json();
            this._projectDags = data.dags || [];
            if (this._projectDags.length) {
                this._pipelineBtn.style.display = '';
            }
        } catch {}
    }

    async _showLoadModelModal() {
        const panel = jsPanel.create({
            headerTitle: '<i class="fa-solid fa-brain" style="font-size:11px;margin-right:6px;color:#9c27b0"></i>Load Model from Registry',
            theme: '#ffe39e filled',
            borderRadius: '5px',
            contentSize: { width: Math.min(420, window.innerWidth - 80), height: 'auto' },
            position: 'center',
            headerControls: 'closeonly',
            content: '<div style="padding:16px;font-size:12px"></div>',
            callback: (p) => { p.content.style.backgroundColor = '#fefefe'; },
        });

        const container = panel.content.firstElementChild;
        container.innerHTML = '<div style="color:#888">Loading models...</div>';

        try {
            const resp = await fetch('api/registry/models');
            if (!resp.ok) throw new Error('Failed to load models');
            const data = await resp.json();
            const models = data.models || [];

            if (!models.length) {
                container.innerHTML = '<div style="color:#888">No registered models found.</div>';
                return;
            }

            container.innerHTML = '';

            // Model selector
            const modelLabel = document.createElement('div');
            modelLabel.style.cssText = 'font-weight:500;color:#333;margin-bottom:4px';
            modelLabel.textContent = 'Model';
            container.appendChild(modelLabel);

            const modelSelect = document.createElement('select');
            modelSelect.style.cssText = 'width:100%;padding:6px 8px;font-size:12px;border:0.5px solid #c8c8c8;border-radius:4px;color:#333;box-sizing:border-box;margin-bottom:12px';
            for (const m of models) {
                const o = document.createElement('option');
                o.value = m.name;
                o.textContent = m.name;
                modelSelect.appendChild(o);
            }
            container.appendChild(modelSelect);

            // Version selector
            const versionLabel = document.createElement('div');
            versionLabel.style.cssText = 'font-weight:500;color:#333;margin-bottom:4px';
            versionLabel.textContent = 'Version';
            container.appendChild(versionLabel);

            const versionSelect = document.createElement('select');
            versionSelect.style.cssText = 'width:100%;padding:6px 8px;font-size:12px;border:0.5px solid #c8c8c8;border-radius:4px;color:#333;box-sizing:border-box;margin-bottom:16px';
            container.appendChild(versionSelect);

            const loadVersions = async (modelName) => {
                versionSelect.innerHTML = '<option>Loading...</option>';
                try {
                    const vResp = await fetch(`api/registry/models/${encodeURIComponent(modelName)}/versions`);
                    if (!vResp.ok) throw new Error();
                    const vData = await vResp.json();
                    const versions = vData.versions || [];
                    versionSelect.innerHTML = '';
                    for (const v of versions) {
                        const o = document.createElement('option');
                        o.value = v.version;
                        const aliases = v.aliases?.length ? ` (${v.aliases.join(', ')})` : '';
                        o.textContent = `v${v.version}${aliases}`;
                        versionSelect.appendChild(o);
                    }
                } catch {
                    versionSelect.innerHTML = '<option>No versions found</option>';
                }
            };

            modelSelect.addEventListener('change', () => loadVersions(modelSelect.value));
            loadVersions(models[0].name);

            // Buttons
            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'rm-btn';
            cancelBtn.style.background = '#f0f0f0';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.addEventListener('click', () => panel.close());
            btnRow.appendChild(cancelBtn);

            const insertBtn = document.createElement('button');
            insertBtn.className = 'rm-btn';
            insertBtn.style.background = '#e8d5f5';
            insertBtn.innerHTML = '<i class="fa-solid fa-code" style="font-size:10px;margin-right:4px"></i>Insert Cell';
            insertBtn.addEventListener('click', async () => {
                const name = modelSelect.value;
                const version = versionSelect.value;
                if (!name || !version) return;

                // Fetch signature to generate correct sample input
                let sampleLines = [
                    'import numpy as np',
                    'input_data = np.random.randn(1, 10).astype(np.float32)  # adjust shape to your model',
                ];
                try {
                    const vResp = await fetch(`api/registry/models/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`);
                    if (vResp.ok) {
                        const vData = await vResp.json();
                        if (vData.signature?.inputs) {
                            const inputs = JSON.parse(vData.signature.inputs);
                            if (inputs[0]?.['tensor-spec']?.shape) {
                                const shape = inputs[0]['tensor-spec'].shape.map(s => s === -1 ? 1 : s);
                                sampleLines = [
                                    'import numpy as np',
                                    `input_data = np.random.randn(${shape.join(', ')}).astype(np.float32)`,
                                ];
                            }
                        }
                    }
                } catch {}

                const code = [
                    '# Load and predict with registered model',
                    'import mlflow',
                    '',
                    `model_name = "${name}"`,
                    `model_version = "${version}"`,
                    '',
                    '# Load model using direct URI (MLflow 3.x compatible)',
                    'client = mlflow.MlflowClient()',
                    'mv = client.get_model_version(model_name, model_version)',
                    'run = client.get_run(mv.run_id)',
                    'model_uri = run.data.tags.get("noted.model_uri", f"models:/{model_name}/{model_version}")',
                    'model = mlflow.pyfunc.load_model(model_uri)',
                    'print(f"Loaded {model_name} v{model_version}")',
                    '',
                    '# Sample prediction',
                    ...sampleLines,
                    'predictions = model.predict(input_data)',
                    'print(f"Prediction shape: {predictions.shape}")',
                    'print(predictions)',
                ].join('\n');
                document.dispatchEvent(new CustomEvent('noted:insert-cell', { detail: { code } }));
                panel.close();
            });
            btnRow.appendChild(insertBtn);
            container.appendChild(btnRow);
        } catch (err) {
            container.innerHTML = `<div style="color:#c00">${err.message}</div>`;
        }
    }

    async _triggerPipeline() {
        if (!this._projectDags?.length) return;

        // If multiple DAGs, let user pick; otherwise use the first
        let dagId;
        if (this._projectDags.length === 1) {
            dagId = this._projectDags[0].dag_id;
        } else {
            // Build a simple selection with notify or a dropdown
            const names = this._projectDags.map(d => d.dag_id);
            dagId = prompt(`Select DAG to trigger:\n${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n\nEnter number:`);
            if (!dagId) return;
            const idx = parseInt(dagId, 10) - 1;
            if (idx >= 0 && idx < names.length) {
                dagId = names[idx];
            } else {
                return;
            }
        }

        // Build config from current Hydra selection
        let conf = null;
        if (this._selectedHydraConfig) {
            try {
                const projectId = this._projectId;
                const resp = await fetch(`api/hydra/compose/${encodeURIComponent(projectId)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        group_selections: this._selectedHydraConfig.type === 'group'
                            ? { [this._selectedHydraConfig.group]: this._selectedHydraConfig.option }
                            : undefined,
                    }),
                });
                if (resp.ok) {
                    const data = await resp.json();
                    conf = data.resolved || null;
                }
            } catch {}
        }

        this._pipelineBtn.disabled = true;
        this._pipelineBtn.title = 'Triggering...';
        try {
            const resp = await fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/trigger`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ conf }),
            });
            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.detail || 'Trigger failed');
            }
            await resp.json();
            notify(`Pipeline ${dagId} triggered`, 'success');
        } catch (err) {
            notify(`Pipeline trigger failed: ${err.message}`, 'danger');
        }
        this._pipelineBtn.disabled = false;
        this._pipelineBtn.title = 'Run as Pipeline';
    }
}
