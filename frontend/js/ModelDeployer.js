/**
 * ModelDeployer - drives the "deploy a model" user flow.
 *
 * Wraps the streaming POST /api/serving/load endpoint, which returns an
 * NDJSON stream of phase events terminated by either `{phase: 'ready',
 * result: <health>}` on success or `{phase: 'error', error: <msg>}` on
 * failure. Consumers register callbacks to react to progress and
 * completion; the class handles the ReadableStream reader, the line
 * buffering, and the JSON parsing.
 *
 * No setTimeout/setInterval - progress updates are driven by the stream
 * itself (see feedback_progress_streaming.md).
 *
 * Usage:
 *     const deployer = new ModelDeployer({
 *         onPhase: (phase, detail) => { ... },
 *         onReady: (health) => { ... },
 *         onError: (message) => { ... },
 *     });
 *     await deployer.deploy('My Model', '7');
 *     // or: deployer.unload();
 */
export class ModelDeployer {
    /**
     * @param {object} callbacks
     * @param {(phase: string, detail: string) => void} [callbacks.onPhase]
     * @param {(health: object) => void} [callbacks.onReady]
     * @param {(message: string) => void} [callbacks.onError]
     */
    constructor(callbacks = {}) {
        this._onPhase = callbacks.onPhase || (() => {});
        this._onReady = callbacks.onReady || (() => {});
        this._onError = callbacks.onError || (() => {});
        this._aborter = null;
    }

    /**
     * Start a deploy (load) request. Resolves with the final health
     * payload on success, rejects with an Error on failure or abort.
     *
     * @param {string} modelName
     * @param {string|null} version
     * @param {string|null} [alias]
     * @returns {Promise<object>}
     */
    async deploy(modelName, version, alias = null) {
        if (this._aborter) {
            throw new Error('A deploy is already in progress');
        }
        this._aborter = new AbortController();

        let resp;
        try {
            resp = await fetch('api/serving/load', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model_name: modelName, version, alias }),
                signal: this._aborter.signal,
            });
        } catch (err) {
            this._aborter = null;
            throw err;
        }

        if (!resp.ok) {
            this._aborter = null;
            let detail = `HTTP ${resp.status}`;
            try {
                const payload = await resp.json();
                detail = payload.detail || detail;
            } catch { /* body not JSON */ }
            const err = new Error(detail);
            this._onError(detail);
            throw err;
        }

        try {
            return await this._readStream(resp);
        } finally {
            this._aborter = null;
        }
    }

    /**
     * Abort an in-flight deploy. The fetch reader's read() promise will
     * reject with AbortError; deploy() propagates that to its caller.
     */
    abort() {
        if (this._aborter) {
            this._aborter.abort();
            this._aborter = null;
        }
    }

    /** Unload the currently deployed model (free memory/VRAM). */
    async unload() {
        const resp = await fetch('api/serving/unload', { method: 'POST' });
        if (!resp.ok) {
            throw new Error(`Unload failed: HTTP ${resp.status}`);
        }
        const data = await resp.json();
        if (data.refused) {
            throw new Error(data.message || 'Unload refused (a deploy is in progress)');
        }
        return data;
    }

    /**
     * Read the NDJSON stream, dispatch phase events, return the final
     * health payload when a 'ready' event arrives, or throw on 'error'.
     */
    async _readStream(resp) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const event = ModelDeployer._parseEvent(trimmed);
                if (!event) continue;

                if (event.phase === 'ready') {
                    this._onReady(event.result || {});
                    return event.result || {};
                }
                if (event.phase === 'error') {
                    const msg = event.error || 'Unknown deploy error';
                    this._onError(msg);
                    throw new Error(msg);
                }
                this._onPhase(event.phase || '', event.detail || '');
            }
        }

        // Stream closed without a terminal event. Treat as error so the
        // UI doesn't hang on an ambiguous state.
        const msg = 'Deploy stream closed unexpectedly';
        this._onError(msg);
        throw new Error(msg);
    }

    static _parseEvent(line) {
        try {
            return JSON.parse(line);
        } catch {
            return null;
        }
    }
}
