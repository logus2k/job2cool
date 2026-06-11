/**
 * DebugClient.js - DAP WebSocket client for the debug UI.
 *
 * Connects to /ws/dap and communicates with debugpy via DAP protocol.
 * Handles:
 * - Session initialization (DAP initialize + attach)
 * - Breakpoint management (setBreakpoints)
 * - Execution control (continue, stepOver, stepIn, stepOut, pause)
 * - Event handling (stopped, continued, terminated, output)
 * - Variable and stack frame requests
 *
 * Usage:
 *   const client = new DebugClient();
 *   await client.connect(sessionId);
 *   await client.setBreakpoints(source, [{line: 5}]);
 *   client.on('stopped', (event) => { ... });
 */

export class DebugClient {
    constructor() {
        this._ws = null;
        this._seq = 1;
        this._pendingRequests = new Map();  // seq -> {resolve, reject, timeout}
        this._listeners = {};               // event type -> [callbacks]
        this._sessionId = null;
        this._initialized = false;
        this._threadId = null;  // primary thread ID (Python is single-threaded)
    }

    get connected() { return this._ws?.readyState === WebSocket.OPEN; }
    get initialized() { return this._initialized; }
    get threadId() { return this._threadId; }

    /**
     * Connect to the DAP WebSocket endpoint for a kernel session.
     * Sends DAP initialize + attach to start the debug session.
     */
    async connect(sessionId, wsPath = 'dap') {
        if (this._ws) this.disconnect();
        this._sessionId = sessionId;

        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const base = `${proto}//${location.host}${location.pathname}`.replace(/\/+$/, '');
        const url = `${base}/ws/${wsPath}?session=${encodeURIComponent(sessionId)}`;

        return new Promise((resolve, reject) => {
            this._ws = new WebSocket(url);

            this._ws.onopen = async () => {
                try {
                    // DAP initialize handshake
                    const initResult = await this._request('initialize', {
                        clientID: 'noted',
                        clientName: 'noted',
                        adapterID: 'debugpy',
                        pathFormat: 'path',
                        linesStartAt1: true,
                        columnsStartAt1: true,
                        supportsVariableType: true,
                        supportsRunInTerminalRequest: false,
                    });

                    this._initialized = true;

                    // Set up listener for 'initialized' event before sending attach
                    // debugpy sends this event during attach processing
                    this._configReady = false;
                    this.on('initialized', () => { this._configReady = true; });

                    // Attach to the running kernel process
                    // Don't await - we need to handle the initialized event during attach
                    this._request('attach', {
                        justMyCode: false,
                        subProcess: false,
                    }).catch(() => {});

                    // Wait for the initialized event (sent during attach handling)
                    await new Promise((res) => {
                        if (this._configReady) { res(); return; }
                        const check = setInterval(() => {
                            if (this._configReady) { clearInterval(check); res(); }
                        }, 50);
                        setTimeout(() => { clearInterval(check); res(); }, 5000);
                    });

                    resolve();
                } catch (e) {
                    reject(e);
                }
            };

            this._ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    this._handleMessage(msg);
                } catch (e) {
                    console.warn('[DebugClient] malformed message:', e);
                }
            };

            this._ws.onerror = () => reject(new Error('DAP WebSocket error'));
            this._ws.onclose = () => {
                this._initialized = false;
                this._emit('disconnected');
            };
        });
    }

    disconnect() {
        if (this._ws) {
            this._ws.close();
            this._ws = null;
        }
        this._initialized = false;
        this._stepping = false;
        this._pendingRequests.forEach(p => {
            clearTimeout(p.timeout);
            p.reject(new Error('disconnected'));
        });
        this._pendingRequests.clear();
    }

    // --- Breakpoints ---

    /**
     * Set breakpoints for a source file/cell.
     * @param {object} source - DAP Source object {path, name, sourceReference}
     * @param {Array} breakpoints - [{line, condition?, hitCondition?, logMessage?}]
     * @returns {Array} Verified breakpoints from debugpy
     */
    async setBreakpoints(source, breakpoints) {
        const result = await this._request('setBreakpoints', {
            source,
            breakpoints,
            sourceModified: false,
        });
        return result.breakpoints || [];
    }

    // --- Execution Control ---

    async continue_() {
        if (this._threadId == null || this._stepping) return;
        this._stepping = true;
        return this._request('continue', { threadId: this._threadId });
    }

    async stepOver() {
        if (this._threadId == null || this._stepping) return;
        this._stepping = true;
        return this._request('next', { threadId: this._threadId });
    }

    async stepIn() {
        if (this._threadId == null || this._stepping) return;
        this._stepping = true;
        return this._request('stepIn', { threadId: this._threadId });
    }

    async stepOut() {
        if (this._threadId == null || this._stepping) return;
        this._stepping = true;
        return this._request('stepOut', { threadId: this._threadId });
    }

    async pause() {
        if (this._threadId == null) return;
        return this._request('pause', { threadId: this._threadId });
    }

    // --- Inspection ---

    /** Get all threads (Python typically has one main thread). */
    async threads() {
        return this._request('threads');
    }

    /** Get stack frames for a thread. */
    async stackTrace(threadId, startFrame = 0, levels = 20) {
        return this._request('stackTrace', {
            threadId: threadId || this._threadId,
            startFrame,
            levels,
        });
    }

    /** Get scopes for a stack frame (locals, globals). */
    async scopes(frameId) {
        return this._request('scopes', { frameId });
    }

    /** Get variables for a scope or variable reference. */
    async variables(variablesReference) {
        return this._request('variables', { variablesReference });
    }

    /** Evaluate an expression in the context of a stack frame. */
    async evaluate(expression, frameId, context = 'hover') {
        return this._request('evaluate', { expression, frameId, context });
    }

    // --- Events ---

    on(event, callback) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(callback);
    }

    off(event, callback) {
        const list = this._listeners[event];
        if (list) this._listeners[event] = list.filter(cb => cb !== callback);
    }

    // --- Internal ---

    _emit(event, data) {
        for (const cb of (this._listeners[event] || [])) {
            try { cb(data); } catch (e) { console.error('[DebugClient] event handler error:', e); }
        }
    }

    _handleMessage(msg) {
        if (msg.type === 'response') {
            const pending = this._pendingRequests.get(msg.request_seq);
            if (pending) {
                this._pendingRequests.delete(msg.request_seq);
                clearTimeout(pending.timeout);
                if (msg.success) {
                    pending.resolve(msg.body || {});
                } else {
                    pending.reject(new Error(msg.message || 'DAP request failed'));
                }
            }
        } else if (msg.type === 'event') {
            this._handleEvent(msg);
        }
    }

    _handleEvent(msg) {
        const event = msg.event;
        const body = msg.body || {};

        switch (event) {
            case 'stopped':
                // Execution paused (breakpoint, step, exception)
                this._stepping = false;
                this._threadId = body.threadId;
                this._emit('stopped', body);
                break;
            case 'continued':
                this._emit('continued', body);
                break;
            case 'terminated':
                this._stepping = false;
                this._emit('terminated', body);
                break;
            case 'output':
                this._emit('output', body);
                break;
            case 'thread':
                if (body.reason === 'started') this._threadId = body.threadId;
                this._emit('thread', body);
                break;
            case 'initialized':
                // debugpy is ready for configuration (breakpoints, etc.)
                this._emit('initialized', body);
                break;
            default:
                this._emit(event, body);
        }
    }

    async _request(command, args = {}) {
        if (!this.connected) throw new Error('Not connected');
        const seq = this._seq++;

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this._pendingRequests.delete(seq);
                reject(new Error(`DAP ${command} timed out`));
            }, 15000);

            this._pendingRequests.set(seq, { resolve, reject, timeout });

            this._send({
                type: 'request',
                seq,
                command,
                arguments: args,
            });
        });
    }

    _send(msg) {
        if (this.connected) {
            this._ws.send(JSON.stringify(msg));
        }
    }
}
