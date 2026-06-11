/**
 * AgentClient - Socket.IO client for the LLM agent server.
 * Requires global io() from socket.io.min.js.
 */
export class AgentClient {
    constructor(opts = {}) {
        this.url = opts.url ? new URL(opts.url, window.location.origin).origin : window.location.origin;
        this.path = opts.path ?? '/llm/socket.io';
        this.socket = null;

        this._buffer = '';
        this._activeRunId = null;
        this._runResolve = null;
        this._runReject = null;

        this._connectedOnce = false;
        this._onReconnect = null;

        this._transcripts = { onInterim: null, onFinal: null };
        this._cb = { onStarted: null, onChunk: null, onText: null, onDone: null, onError: null };
        this._global = { onStarted: null, onChunk: null, onText: null, onDone: null, onError: null };
    }

    async connect(options = {}) {
        if (this.socket) return;
        this._onReconnect = typeof options.onReconnect === 'function' ? options.onReconnect : null;

        this.socket = io(this.url, {
            path: this.path,
            transports: ['websocket'],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 500,
            reconnectionDelayMax: 5000,
            timeout: 20000,
        });

        this.socket.on('connect', () => {
            if (this._connectedOnce && this._onReconnect) {
                try { this._onReconnect(); } catch {}
            }
        });

        // Transcript events (STT)
        this.socket.on('UserTranscript', (payload) => {
            const text = typeof payload?.text === 'string' ? payload.text : '';
            if (!text) return;
            const final = !!payload?.final;
            const cb = final ? this._transcripts.onFinal : this._transcripts.onInterim;
            if (typeof cb === 'function') try { cb({ ...payload, text, final }); } catch {}
        });

        // Streaming events
        this.socket.on('RunStarted', (payload) => {
            this._activeRunId = payload?.runId ?? null;
            const h = this._cb.onStarted || this._global.onStarted;
            if (typeof h === 'function') try { h(this._activeRunId); } catch {}
        });

        this.socket.on('ChatChunk', (payload) => {
            const piece = typeof payload?.chunk === 'string' ? payload.chunk : '';
            if (!piece) return;
            this._buffer += piece;
            const hChunk = this._cb.onChunk || this._global.onChunk;
            const hText = this._cb.onText || this._global.onText;
            if (typeof hChunk === 'function') try { hChunk(piece); } catch {}
            if (typeof hText === 'function') try { hText(this._buffer); } catch {}
        });

        this.socket.on('ChatDone', () => {
            const h = this._cb.onDone || this._global.onDone;
            if (typeof h === 'function') try { h(); } catch {}
            if (this._runResolve) this._runResolve({ runId: this._activeRunId, text: this._buffer });
            this._clearRunState();
        });

        this.socket.on('Interrupted', () => {
            const err = { code: 'INTERRUPTED', message: 'Run interrupted' };
            const h = this._cb.onError || this._global.onError;
            if (typeof h === 'function') try { h(err); } catch {}
            if (this._runReject) this._runReject(Object.assign(new Error(err.message), { code: err.code }));
            this._clearRunState();
        });

        this.socket.on('Error', (payload) => {
            const err = {
                code: payload?.code || 'ERROR',
                message: payload?.message || 'Unknown error',
                runId: payload?.runId ?? null,
            };
            const h = this._cb.onError || this._global.onError;
            if (typeof h === 'function') try { h(err); } catch {}
            if (this._runReject) this._runReject(Object.assign(new Error(err.message), { code: err.code }));
            this._clearRunState();
        });

        await new Promise((resolve, reject) => {
            const ok = () => { this.socket.off('connect_error', ko); resolve(); };
            const ko = (e) => { this.socket.off('connect', ok); reject(e); };
            this.socket.once('connect', ok);
            this.socket.once('connect_error', ko);
        });
        this._connectedOnce = true;
    }

    disconnect() {
        if (!this.socket) return;
        try { this.socket.disconnect(); } catch {}
        this.socket = null;
        this._clearRunState();
    }

    onStream(cbs = {}) {
        this._global.onStarted = typeof cbs.onStarted === 'function' ? cbs.onStarted : null;
        this._global.onChunk = typeof cbs.onChunk === 'function' ? cbs.onChunk : null;
        this._global.onText = typeof cbs.onText === 'function' ? cbs.onText : null;
        this._global.onDone = typeof cbs.onDone === 'function' ? cbs.onDone : null;
        this._global.onError = typeof cbs.onError === 'function' ? cbs.onError : null;
    }

    runText(text, options, cbs = {}) {
        if (!this.socket?.connected) {
            return Promise.reject(Object.assign(new Error('Not connected'), { code: 'NOT_CONNECTED' }));
        }
        if (!text?.length) {
            return Promise.reject(Object.assign(new Error('Text is required'), { code: 'BAD_ARGS' }));
        }
        if (!options?.agent?.length) {
            return Promise.reject(Object.assign(new Error('Agent is required'), { code: 'BAD_ARGS' }));
        }

        this._cb.onStarted = typeof cbs.onStarted === 'function' ? cbs.onStarted : null;
        this._cb.onChunk = typeof cbs.onChunk === 'function' ? cbs.onChunk : null;
        this._cb.onText = typeof cbs.onText === 'function' ? cbs.onText : null;
        this._cb.onDone = typeof cbs.onDone === 'function' ? cbs.onDone : null;
        this._cb.onError = typeof cbs.onError === 'function' ? cbs.onError : null;

        this._buffer = '';
        this._activeRunId = null;

        const payload = {
            text,
            agent: options.agent,
            thread_id: options.threadId || null,
        };

        return new Promise((resolve, reject) => {
            this._runResolve = resolve;
            this._runReject = reject;
            try {
                this.socket.emit('Chat', payload);
            } catch (e) {
                this._runResolve = null;
                this._runReject = null;
                reject(Object.assign(new Error('Emit failed'), { code: 'EMIT_FAILED', cause: e }));
            }
        });
    }

    cancel() {
        if (!this.socket?.connected) return;
        try { this.socket.emit('Interrupt', { runId: this._activeRunId ?? null }); } catch {}
    }

    get activeRunId() {
        return this._activeRunId;
    }

    onTranscripts(cbs = {}) {
        this._transcripts.onInterim = typeof cbs.onInterim === 'function' ? cbs.onInterim : null;
        this._transcripts.onFinal = typeof cbs.onFinal === 'function' ? cbs.onFinal : null;
    }

    sttSubscribe({ sttUrl, clientId, agent, threadId, transcriptOnly } = {}) {
        if (!this.socket?.connected) return Promise.reject(new Error('Not connected'));
        return new Promise((resolve, reject) => {
            this.socket.emit('JoinSTT', { sttUrl, clientId, agent, threadId: threadId || null, transcriptOnly: !!transcriptOnly }, (ack) => {
                if (ack?.error) return reject(new Error(ack.error));
                resolve();
            });
        });
    }

    sttUnsubscribe({ sttUrl, clientId } = {}) {
        if (!this.socket?.connected) return Promise.reject(new Error('Not connected'));
        return new Promise((resolve, reject) => {
            this.socket.emit('LeaveSTT', { sttUrl, clientId }, (ack) => {
                if (ack?.error) return reject(new Error(ack.error));
                resolve();
            });
        });
    }

    ttsSubscribe({ clientId, voice, speed } = {}) {
        if (!this.socket?.connected) return Promise.reject(new Error('Not connected'));
        return new Promise((resolve, reject) => {
            this.socket.emit('JoinTTS', { clientId, voice, speed }, (ack) => resolve(ack));
        });
    }

    ttsUnsubscribe({ clientId } = {}) {
        if (!this.socket?.connected) return Promise.reject(new Error('Not connected'));
        return new Promise((resolve, reject) => {
            this.socket.emit('LeaveTTS', { clientId }, (ack) => resolve(ack));
        });
    }

    _clearRunState() {
        this._activeRunId = null;
        this._runResolve = null;
        this._runReject = null;
        this._buffer = '';
        this._cb = { onStarted: null, onChunk: null, onText: null, onDone: null, onError: null };
    }
}
