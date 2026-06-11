/**
 * ServiceHealthStrip — row of colored LEDs showing live status for the
 * platform's hard dependencies.
 *
 * Data flow:
 * 1. On mount: GET /api/health/services for the initial snapshot.
 * 2. Subscribe to KernelClient `services:health` Socket.IO event for
 *    push updates (backend HealthMonitor emits when ANY service's
 *    status changes; cadence is 30s by default but the emit only
 *    fires on actual change).
 * 3. Manual refresh button: POST /api/health/services/refresh, which
 *    triggers an immediate probe cycle and returns the result.
 *
 * Renders as a horizontal row of pills. Each pill: colored dot + label
 * + latency. Click a pill → tooltip with last_error + last_ok_at.
 *
 * Status -> color:
 *   ok      -> green (#4caf50)
 *   fail    -> red   (#f44336)
 *   unknown -> gray  (#999)
 *
 * Mounting: instantiate with a parent element, the KernelClient, and
 * the strip auto-attaches its own DOM and starts listening.
 */
export class ServiceHealthStrip {
    constructor({ client }) {
        this._client = client;
        this._state = { services: {}, checked_at: null };
        this._unsubscribe = null;
        this._refreshInFlight = false;
        this._build();
        this._bindEvents();
        this._fetchInitial();
    }

    get element() {
        return this._el;
    }

    _build() {
        this._el = document.createElement('div');
        this._el.className = 'svc-health-strip';
        this._el.innerHTML = `
            <div class="svc-health-row" id="svc-health-row"></div>
            <button class="svc-health-refresh" id="svc-health-refresh" title="Refresh now">
                <i class="fa-solid fa-rotate"></i>
            </button>
        `;
        this._row = this._el.querySelector('#svc-health-row');
        this._refreshBtn = this._el.querySelector('#svc-health-refresh');
    }

    _bindEvents() {
        this._refreshBtn.addEventListener('click', () => this._forceRefresh());
        // Subscribe to push updates. KernelClient.on returns void; track
        // listener manually so we can detach later.
        const handler = (data) => this._apply(data);
        this._client.on('services:health', handler);
        this._unsubscribe = () => this._client.off?.('services:health', handler);
    }

    destroy() {
        if (this._unsubscribe) this._unsubscribe();
        this._el.remove();
    }

    async _fetchInitial() {
        try {
            const r = await fetch('api/health/services');
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            this._apply(data);
        } catch (e) {
            // Render an "unknown" state if the initial fetch fails so
            // the strip isn't empty. Push updates will fix it once the
            // monitor's first probe completes.
            this._apply({ services: {}, checked_at: null });
        }
    }

    async _forceRefresh() {
        if (this._refreshInFlight) return;
        this._refreshInFlight = true;
        this._refreshBtn.classList.add('svc-health-refreshing');
        try {
            const r = await fetch('api/health/services/refresh', { method: 'POST' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            this._apply(data);
        } catch (e) {
            // Ignore — the next push update will resync state.
        } finally {
            this._refreshInFlight = false;
            this._refreshBtn.classList.remove('svc-health-refreshing');
        }
    }

    _apply(data) {
        if (!data || !data.services) {
            this._state = { services: {}, checked_at: null };
        } else {
            this._state = data;
        }
        this._render();
    }

    _render() {
        const services = this._state.services || {};
        const ids = Object.keys(services).filter(k => !k.startsWith('__'));
        // Stable order — match the backend PROBES list:
        // Vector DB, Graph DB, LLM Proxy, Agent Server, Embeddings,
        // Reranker, Generation.
        const order = ['noted_rag', 'noted_graph', 'llama_vision', 'agent_server', 'bge_m3', 'bge_reranker', 'gemma_4'];
        const sorted = order.filter(k => ids.includes(k))
            .concat(ids.filter(k => !order.includes(k)));

        if (sorted.length === 0) {
            this._row.innerHTML = `<span class="svc-health-empty">probing services...</span>`;
            return;
        }

        const html = sorted.map(id => {
            const svc = services[id];
            const status = svc.status || 'unknown';
            const label = svc.label || id;
            const latency = svc.latency_ms != null ? `${svc.latency_ms}ms` : '';
            const tooltipParts = [
                `${label}`,
                `status: ${status}`,
                svc.latency_ms != null ? `latency: ${svc.latency_ms}ms` : null,
                svc.last_error ? `error: ${svc.last_error}` : null,
                svc.last_ok_at ? `last ok: ${new Date(svc.last_ok_at).toLocaleTimeString()}` : null,
                svc.last_checked_at ? `checked: ${new Date(svc.last_checked_at).toLocaleTimeString()}` : null,
            ].filter(Boolean).join('\n');
            return `
                <span class="svc-health-pill svc-health-${status}" title="${this._escape(tooltipParts)}">
                    <span class="svc-health-dot"></span>
                    <span class="svc-health-label">${this._escape(label)}</span>
                    ${latency ? `<span class="svc-health-latency">${latency}</span>` : ''}
                </span>
            `;
        }).join('');
        this._row.innerHTML = html;
    }

    _escape(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}
