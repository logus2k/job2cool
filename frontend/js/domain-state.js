/**
 * domain-state.js — client-side singleton for the active Domain + Domain list.
 *
 * Bootstraps once on app start by fetching `/api/domains` (list) and
 * `/api/domains/active`. Exposes synchronous getters used by every
 * Domain-aware fetch in the frontend (GraphPanel / ExplorerPanel /
 * Knowledge Base Monitor / etc.).
 *
 * P3.3: single-active. The active value is the first element of the list
 * returned by `/api/domains/active`. Listeners are notified on switch so they
 * can refresh.
 *
 * Usage:
 *   import { domainState } from './domain-state.js';
 *   await domainState.bootstrap();           // call once on app start
 *   domainState.getActiveDomain();           // -> 'general'
 *   domainState.getDomains();                // -> [{domain_id, name, ...}, ...]
 *   await domainState.setActive('foo');      // PATCHes server + fires onChange
 *   await domainState.refresh();             // re-pull list + active
 *   domainState.onChange(() => { ... });     // subscribe to active-Domain changes
 */

const STATE = {
    activeList: ['general'],   // last-known active set (multi-active)
    domains: [],               // cached Domain list
    listeners: new Set(),
    bootstrapped: false,
};

async function _fetchActive() {
    const r = await fetch('api/domains/active', { cache: 'no-store' });
    if (!r.ok) throw new Error(`/api/domains/active HTTP ${r.status}`);
    const d = await r.json();
    return Array.isArray(d.active) && d.active.length > 0 ? d.active : ['general'];
}

async function _fetchList() {
    const r = await fetch('api/domains', { cache: 'no-store' });
    if (!r.ok) throw new Error(`/api/domains HTTP ${r.status}`);
    const d = await r.json();
    return Array.isArray(d.domains) ? d.domains : [];
}

function _fire(prevList) {
    for (const cb of STATE.listeners) {
        try {
            cb(STATE.activeList, prevList);
        } catch (e) {
            console.warn('[domain-state] listener threw:', e);
        }
    }
}

function _listsEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

export const domainState = {
    /** First active Domain id, regardless of knowledge half. */
    getActiveDomain() {
        return STATE.activeList[0] || 'general';
    },

    /** First active Domain id WITH a knowledge half (graph + vector).
     * View-style callers (GraphPanel, Explorer Domain tree, Domain Monitor)
     * should use this so capability-only Domains like `general` don't
     * become the query target and return empty results.
     *
     * Falls back to the first active id (capability-only) when no
     * knowledge Domain is active. Backend returns 200 with empty payload
     * for capability-only Domains, so callers get a clean empty state
     * instead of console-error 404s. */
    getFirstKnowledgeDomain() {
        for (const id of STATE.activeList) {
            const d = STATE.domains.find((x) => x.domain_id === id);
            if (d && d.has_knowledge) return id;
        }
        return STATE.activeList[0] || 'general';
    },

    /** Full active Domain set (multi-active). Tool dispatchers
     * (graph_and_vector_search) fan out across this list. */
    getActiveDomains() {
        return STATE.activeList.slice();
    },

    /** True when `domainId` is in the active set. */
    isActive(domainId) {
        return STATE.activeList.indexOf(domainId) !== -1;
    },

    /** Synchronous getter for the cached Domain list. */
    getDomains() {
        return STATE.domains.slice();
    },

    /** Find one Domain record by id. */
    getDomain(domainId) {
        return STATE.domains.find((k) => k.domain_id === domainId);
    },

    /** Initial fetch, called once from app boot. */
    async bootstrap() {
        try {
            const [list, active] = await Promise.all([_fetchList(), _fetchActive()]);
            STATE.domains = list;
            STATE.activeList = active;
            STATE.bootstrapped = true;
        } catch (e) {
            console.warn('[domain-state] bootstrap failed (using defaults):', e);
            STATE.bootstrapped = true;
        }
    },

    /** Re-pull list + active from the server. */
    async refresh() {
        const prev = STATE.activeList.slice();
        const [list, active] = await Promise.all([_fetchList(), _fetchActive()]);
        STATE.domains = list;
        STATE.activeList = active;
        if (!_listsEqual(active, prev)) _fire(prev);
    },

    /** Replace the active set. Accepts either a single domain_id (string,
     * legacy single-active callers) or a list (multi-active). PATCHes
     * the server, fires onChange listeners. */
    async setActive(domainIdOrList) {
        const list = Array.isArray(domainIdOrList) ? domainIdOrList : [domainIdOrList];
        if (list.length === 0) {
            throw new Error('active set cannot be empty');
        }
        const prev = STATE.activeList.slice();
        const params = new URLSearchParams();
        for (const k of list) params.append('active', k);
        const r = await fetch(`api/domains/active?${params.toString()}`, { method: 'PATCH' });
        if (!r.ok) {
            const detail = await r.text().catch(() => '');
            throw new Error(`PATCH /api/domains/active HTTP ${r.status}: ${detail.slice(0, 200)}`);
        }
        const d = await r.json();
        STATE.activeList = Array.isArray(d.active) && d.active.length > 0 ? d.active : list;
        if (!_listsEqual(STATE.activeList, prev)) _fire(prev);
    },

    /** Subscribe to active-set changes. Callback receives (newList, prevList).
     * Returns an unsubscribe function. */
    onChange(cb) {
        STATE.listeners.add(cb);
        return () => STATE.listeners.delete(cb);
    },
};
