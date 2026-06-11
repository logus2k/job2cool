/**
 * KernelClient - Socket.IO communication layer.
 * Wraps all socket events and provides an event emitter interface.
 *
 * All notebook-scoped methods accept a notebookKey parameter
 * (format: "notebook:{project_id}:{notebook_path}") to support
 * multiple notebooks open simultaneously.
 */
export class KernelClient {
    constructor() {
        this._socket = null;
        this._listeners = {};
        this._heartbeatInterval = null;
        this._connected = false;
    }

    connect(url = '') {
        // Derive Socket.IO path from page URL so it works behind subpath proxies
        const basePath = new URL('.', window.location.href).pathname;

        this._socket = io(url, {
            path: basePath + 'socket.io',
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionAttempts: 10
        });

        this._socket.on('connect', () => {
            this._connected = true;
            this._startHeartbeat();
            this._emit('connected');
        });

        this._socket.on('disconnect', (reason) => {
            this._connected = false;
            this._stopHeartbeat();
            this._emit('disconnected', { reason });
        });

        this._socket.on('connect_error', (err) => {
            this._emit('connection_error', { error: err.message });
        });

        // Notebook events
        this._socket.on('notebook:state', (data) => this._emit('notebook:state', data));
        this._socket.on('notebook:saved', (data) => this._emit('notebook:saved', data));

        // Cell events
        this._socket.on('cell:updated', (data) => this._emit('cell:updated', data));
        this._socket.on('cell:added', (data) => this._emit('cell:added', data));
        this._socket.on('cell:deleted', (data) => this._emit('cell:deleted', data));
        this._socket.on('cell:moved', (data) => this._emit('cell:moved', data));
        this._socket.on('cell:output', (data) => this._emit('cell:output', data));
        this._socket.on('cell:execute_start', (data) => this._emit('cell:execute_start', data));
        this._socket.on('cell:execute_complete', (data) => this._emit('cell:execute_complete', data));
        this._socket.on('cell:lock_changed', (data) => this._emit('cell:lock_changed', data));
        this._socket.on('cell:diagnostics', (data) => this._emit('cell:diagnostics', data));

        // Kernel events
        this._socket.on('kernel:status', (data) => this._emit('kernel:status', data));

        // Collaboration events
        this._socket.on('user:joined', (data) => this._emit('user:joined', data));
        this._socket.on('user:left', (data) => this._emit('user:left', data));

        // Run Manager events
        this._socket.on('run:started', (data) => this._emit('run:started', data));
        this._socket.on('run:complete', (data) => this._emit('run:complete', data));

        // Live metrics
        this._socket.on('metrics:update', (data) => this._emit('metrics:update', data));

        // Pipeline status
        this._socket.on('pipeline:status', (data) => this._emit('pipeline:status', data));
        this._socket.on('pipeline:task_status', (data) => this._emit('pipeline:task_status', data));

        // Errors
        this._socket.on('error', (data) => this._emit('error', data));

        // Service-health LED strip — backend HealthMonitor pushes
        // {services: {<id>: {status, latency_ms, last_error, ...}}}
        // on state change. Subscribers are responsible for rendering.
        this._socket.on('services:health', (data) => this._emit('services:health', data));

        // F5 Workflow framework events. Pushed by app.workflow.telemetry
        // on every workflow lifecycle transition. WorkflowMonitorPanel
        // subscribes; other code generally doesn't need them.
        const _wfEvents = [
            'workflow_started', 'step_started', 'step_completed', 'step_failed',
            'workspace_sync', 'workflow_completed', 'workflow_failed',
            'workflow_suspended', 'workflow_resumed', 'system_request',
        ];
        for (const ev of _wfEvents) {
            this._socket.on(ev, (data) => this._emit(ev, data));
        }
    }

    get connected() { return this._connected; }
    get sid() { return this._socket ? this._socket.id : null; }
    get socket() { return this._socket; }

    // --- Notebook ---

    openNotebook(projectId, notebookPath, userName = 'Anonymous') {
        this._socket.emit('notebook:open', {
            project_id: projectId,
            notebook_path: notebookPath,
            user_name: userName
        });
    }

    closeNotebook(projectId, notebookPath) {
        this._socket.emit('notebook:close', {
            project_id: projectId,
            notebook_path: notebookPath,
            notebook_key: `notebook:${projectId}:${notebookPath}`
        });
    }

    saveNotebook(content, notebookKey = '') {
        this._socket.emit('notebook:save', { content, notebook_key: notebookKey });
    }

    // --- Cells ---

    lockCell(cellIndex, notebookKey = '') {
        this._socket.emit('cell:lock', { cell_index: cellIndex, notebook_key: notebookKey });
    }

    unlockCell(cellIndex, notebookKey = '') {
        this._socket.emit('cell:unlock', { cell_index: cellIndex, notebook_key: notebookKey });
    }

    updateCell(cellIndex, source, notebookKey = '') {
        this._socket.emit('cell:update', {
            cell_index: cellIndex,
            source: source,
            notebook_key: notebookKey
        });
    }

    addCell(cellIndex, cellType = 'code', cellId = null, notebookKey = '') {
        this._socket.emit('cell:add', {
            cell_index: cellIndex,
            cell_type: cellType,
            cell_id: cellId,
            notebook_key: notebookKey
        });
    }

    deleteCell(cellIndex, notebookKey = '') {
        this._socket.emit('cell:delete', { cell_index: cellIndex, notebook_key: notebookKey });
    }

    moveCell(fromIndex, toIndex, notebookKey = '') {
        this._socket.emit('cell:move', {
            from_index: fromIndex,
            to_index: toIndex,
            notebook_key: notebookKey
        });
    }

    executeCell(cellIndex, code, notebookKey = '', hydraConfig = null) {
        const data = {
            cell_index: cellIndex,
            code: code,
            notebook_key: notebookKey,
        };
        if (hydraConfig) data.hydra_config = hydraConfig;
        this._socket.emit('cell:execute', data);
    }

    // --- Run Manager ---

    executeRun(cells, runName, datasets = [], notebookKey = '', hydraConfig = null) {
        const data = {
            cells: cells,
            run_name: runName,
            datasets: datasets,
            notebook_key: notebookKey,
        };
        if (hydraConfig) data.hydra_config = hydraConfig;
        this._socket.emit('run:execute', data);
    }

    // --- Kernel ---

    startKernel(runtimeId, envName, notebookKey = '') {
        this._socket.emit('kernel:start', {
            runtime_id: runtimeId,
            env_name: envName,
            notebook_key: notebookKey
        });
    }

    stopKernel(notebookKey = '') {
        this._socket.emit('kernel:stop', { notebook_key: notebookKey });
    }

    restartKernel(notebookKey = '') {
        this._socket.emit('kernel:restart', { notebook_key: notebookKey });
    }

    interruptKernel(notebookKey = '') {
        this._socket.emit('kernel:interrupt', { notebook_key: notebookKey });
    }

    // --- Event emitter ---

    on(event, callback) {
        if (!this._listeners[event]) {
            this._listeners[event] = [];
        }
        this._listeners[event].push(callback);
    }

    off(event, callback) {
        if (!this._listeners[event]) return;
        this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
    }

    _emit(event, data = {}) {
        const callbacks = this._listeners[event] || [];
        for (const cb of callbacks) {
            try {
                cb(data);
            } catch (err) {
                console.error(`Error in ${event} listener:`, err);
            }
        }
    }

    // --- Heartbeat ---

    _startHeartbeat() {
        this._stopHeartbeat();
        this._heartbeatInterval = setInterval(() => {
            if (this._connected) {
                this._socket.emit('heartbeat', {});
            }
        }, 30000);
    }

    _stopHeartbeat() {
        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
            this._heartbeatInterval = null;
        }
    }

    disconnect() {
        this._stopHeartbeat();
        if (this._socket) {
            this._socket.disconnect();
        }
    }
}
