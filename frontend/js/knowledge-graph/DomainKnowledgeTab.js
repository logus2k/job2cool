/**
 * DomainKnowledgeTab - Vector RAG + Graph status cards + Rebuild button.
 *
 * Polls `/api/domains/{id}/status` (combined vector + graph) every 2s
 * while mounted. Stops on destroy(). Visual treatment reuses the
 * `grm-phase-*` classes from the Knowledge Base Monitor.
 *
 * Endpoints:
 *   GET  /api/domains/{id}/status
 *   GET  /api/rag/index/format_breakdown?collection={id}__corpus
 *   POST /api/domains/{id}/rebuild
 */

import { modalConfirm } from '../modal.js';
import { notify } from '../Notify.js';


const POLL_MS = 2000;


// Phase + sub-phase machine names → human-readable labels for the UI.
// Keep the machine names unchanged in the backend (logs, telemetry,
// log-grep tooling all match against them) and humanize at the render
// boundary only. Anything missing from these maps falls through with a
// best-effort title-case transform.
const PHASE_LABELS = {
    'idle':              'Idle',
    'starting':          'Starting',
    'adding_doc':        'Adding document',
    'removing_doc':      'Removing document',
    'extracting':        'Extracting entities',
    'summarizing':       'Summarizing communities',
    'writing':           'Writing graph',
    'caching':           'Caching',
    'sameas':            'Resolving aliases',
    'similar_to':        'Resolving similar concepts',
    'recluster_loading': 'Loading for recluster',
    'pagerank':          'Ranking entities',
    'leiden':            'Detecting communities',
    'done':              'Done',
    'failed':            'Failed',
    'unreachable':       'Unreachable',
    'error':             'Error',
};

const SUB_PHASE_LABELS = {
    'parsing':                     'Parsing source document',
    'writing.chunks_insert':       'Writing markdown chunks',
    'writing.chunked_into_edges':  'Linking chunks to document',
    'writing.thematic_merge':      'Merging entity properties',
    'writing.mention_edges':       'Writing mention edges',
    'writing.thematic_update':     'Updating entity ranks',
    'writing.community_nodes':     'Writing community nodes',
    'writing.analytics_edges':     'Writing analytics edges',
    'writing.graphbatch_post':     'Bulk write via GraphBatch',
};

function humanizePhase(phase) {
    if (!phase) return '-';
    if (PHASE_LABELS[phase]) return PHASE_LABELS[phase];
    // Fallback: snake_case → Title Case so unknown new phases still
    // render reasonably.
    return String(phase).replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanizeSubPhase(subPhase) {
    if (!subPhase) return '';
    if (SUB_PHASE_LABELS[subPhase]) return SUB_PHASE_LABELS[subPhase];
    return String(subPhase).replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}


function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
}


function fmtDuration(seconds) {
    if (!seconds || seconds < 0) return '-';
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return `${m}m ${r}s`;
    const h = Math.floor(m / 60), mr = m % 60;
    return `${h}h ${mr}m`;
}


export class DomainKnowledgeTab {

    constructor(ctx) {
        this._ctx = ctx;
        this._els = {};
        this._timer = null;
        this._rebuildInFlight = false;
    }

    mount() {
        const d = this._ctx.domain;
        const root = document.createElement('div');
        root.className = 'dm-knowledge';

        if (!d.has_knowledge) {
            const info = document.createElement('div');
            info.className = 'dm-card dm-card-info';
            info.innerHTML = `
                <div class="dm-card-body">
                    This Domain is capability-only (skills + tools).
                    It has no Vector RAG or Knowledge Graph to display.
                </div>
            `;
            root.appendChild(info);
            this._ctx.container.appendChild(root);
            return;
        }

        root.innerHTML = `
            <div id="dm-recluster-banner" class="dm-recluster-banner" style="display:none">
                <i class="fa-solid fa-triangle-exclamation dm-i-warn"></i>
                <div class="dm-recluster-text">
                    <div class="dm-recluster-title">Knowledge graph is behind the corpus</div>
                    <div class="dm-recluster-reason" id="dm-recluster-reason"></div>
                </div>
            </div>

            <div class="dm-card">
                <div class="dm-card-head">
                    <span class="dm-card-title"><i class="fa-solid fa-bars-progress"></i> Vector RAG (ChromaDB)</span>
                </div>
                <div class="dm-card-body">
                    <div class="dm-info-row"><span>Total chunks</span><span id="dm-vec-chunks" class="dm-mono">-</span></div>
                    <div class="dm-info-row"><span>Sources indexed</span><span id="dm-vec-sources" class="dm-mono">-</span></div>
                    <div class="dm-info-row"><span>Format breakdown</span><span id="dm-vec-formats">-</span></div>
                </div>
            </div>

            <div class="dm-card">
                <div class="dm-card-head">
                    <span class="dm-card-title"><i class="fa-solid fa-share-nodes"></i> Knowledge Graph (ArcadeDB)</span>
                    <span id="dm-graph-phase" class="grm-phase grm-phase-idle">idle</span>
                </div>
                <div class="dm-card-body">
                    <div class="dm-info-row"><span>Entities</span><span id="dm-graph-entities" class="dm-mono">-</span></div>
                    <div class="dm-info-row"><span>Relationships</span><span id="dm-graph-rels" class="dm-mono">-</span></div>
                    <div class="dm-info-row"><span>Communities</span><span id="dm-graph-comm" class="dm-mono">-</span></div>
                    <div class="dm-info-row"><span>Last build</span><span id="dm-graph-last" class="dm-mono">-</span></div>
                    <div class="dm-info-row" id="dm-graph-progress-row" style="display:none">
                        <span>Progress</span>
                        <span class="dm-mono">
                            <span id="dm-graph-progress-text">-</span>
                            <span id="dm-graph-progress-pct" style="margin-left:6px"></span>
                        </span>
                    </div>
                    <div class="dm-info-row" id="dm-graph-subphase-row" style="display:none">
                        <span id="dm-graph-subphase-label">-</span>
                        <span class="dm-mono">
                            <span id="dm-graph-subphase-text">-</span>
                            <span id="dm-graph-subphase-pct" style="margin-left:6px"></span>
                        </span>
                    </div>
                </div>
                <div class="dm-card-actions">
                    <button class="rm-btn dm-btn-primary" id="dm-rebuild-btn">
                        <i class="fa-solid fa-rotate dm-i-rebuild"></i>
                        <span id="dm-rebuild-label">Rebuild Graph</span>
                    </button>
                    <button class="rm-btn" id="dm-preflight-btn" title="Run cheap pre-import diagnostics (Gemma JSON, ArcadeDB write, embedding probe, schema indexes).">
                        <i class="fa-solid fa-stethoscope"></i>
                        <span>Run Diagnostics</span>
                    </button>
                    <span class="dm-card-note">Full re-extraction.</span>
                </div>
            </div>
        `;
        this._ctx.container.appendChild(root);

        // Refs
        this._els.root          = root;
        this._els.banner        = root.querySelector('#dm-recluster-banner');
        this._els.bannerReason  = root.querySelector('#dm-recluster-reason');
        this._els.vecChunks     = root.querySelector('#dm-vec-chunks');
        this._els.vecSources    = root.querySelector('#dm-vec-sources');
        this._els.vecFormats    = root.querySelector('#dm-vec-formats');
        this._els.phase         = root.querySelector('#dm-graph-phase');
        this._els.entities      = root.querySelector('#dm-graph-entities');
        this._els.rels          = root.querySelector('#dm-graph-rels');
        this._els.communities   = root.querySelector('#dm-graph-comm');
        this._els.lastBuild     = root.querySelector('#dm-graph-last');
        this._els.progressRow   = root.querySelector('#dm-graph-progress-row');
        this._els.progressText  = root.querySelector('#dm-graph-progress-text');
        this._els.progressPct   = root.querySelector('#dm-graph-progress-pct');
        this._els.subPhaseRow   = root.querySelector('#dm-graph-subphase-row');
        this._els.subPhaseLabel = root.querySelector('#dm-graph-subphase-label');
        this._els.subPhaseText  = root.querySelector('#dm-graph-subphase-text');
        this._els.subPhasePct   = root.querySelector('#dm-graph-subphase-pct');
        this._els.rebuildBtn    = root.querySelector('#dm-rebuild-btn');
        this._els.rebuildLabel  = root.querySelector('#dm-rebuild-label');
        this._els.preflightBtn  = root.querySelector('#dm-preflight-btn');

        this._els.rebuildBtn.addEventListener('click', () => this._triggerRebuild());
        this._els.preflightBtn.addEventListener('click', () => this._triggerPreflight());

        this._tick();
        this._timer = setInterval(() => this._tick(), POLL_MS);
    }

    destroy() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        this._els = {};
        this._rebuildInFlight = false;
    }

    _statusUrl()           { return `api/domains/${encodeURIComponent(this._ctx.domain.domain_id)}/status`; }
    _rebuildUrl()          { return `api/domains/${encodeURIComponent(this._ctx.domain.domain_id)}/rebuild`; }
    _formatBreakdownUrl()  { return `api/rag/index/format_breakdown?collection=${encodeURIComponent(this._ctx.domain.domain_id)}__corpus`; }

    async _tick() {
        try {
            const [statusResp, fmtResp] = await Promise.all([
                fetch(this._statusUrl(), { cache: 'no-store' }),
                fetch(this._formatBreakdownUrl(), { cache: 'no-store' }).catch(() => null),
            ]);
            if (!statusResp.ok) throw new Error('HTTP ' + statusResp.status);
            const data = await statusResp.json();
            this._renderStatus(data);
            if (fmtResp && fmtResp.ok) {
                this._renderFormatBreakdown(await fmtResp.json());
            } else {
                this._renderFormatBreakdown(null);
            }
        } catch (e) {
            // Surface the error once, but keep polling - the backend may
            // come back. Avoid spamming the parent's error banner per tick;
            // we only set our own phase chip to "error" instead.
            if (this._els.phase) {
                this._els.phase.textContent = 'unreachable';
                this._els.phase.className = 'grm-phase grm-phase-error';
            }
        }
    }

    _renderFormatBreakdown(data) {
        const el = this._els.vecFormats;
        if (!el) return;
        if (!data || data.status === 'unavailable') {
            el.textContent = '-';
            return;
        }
        const by = data.by_format || {};
        const entries = Object.entries(by).sort((a, b) => b[1] - a[1]);
        if (!entries.length) {
            el.textContent = '-';
            return;
        }
        el.innerHTML = entries
            .map(([fmt, n]) => `<span class="grm-fmt-chip">${escapeHtml(fmt)} ${n}</span>`)
            .join(' ');
    }

    _renderStatus(data) {
        const pending = data.pending_recluster;
        const graph = data.graph || {};
        const inProgress = !!graph.rebuild_in_progress;
        const progress = graph.progress || {};
        const lastBuild = graph.last_build || {};

        // Auto-clear our in-flight flag when the server settles.
        if (this._rebuildInFlight && !pending && !inProgress) {
            this._rebuildInFlight = false;
        }

        // Recluster / running banner
        if (this._rebuildInFlight) {
            this._els.banner.style.display = '';
            this._els.bannerReason.textContent = `Rebuilding... phase: ${progress.phase || 'starting'}`;
        } else if (pending && !inProgress) {
            this._els.banner.style.display = '';
            const setAt = pending.set_at ? new Date(pending.set_at).toLocaleString() : 'unknown time';
            const reason = pending.reason ? ` - ${pending.reason}` : '';
            this._els.bannerReason.textContent = `Marked at ${setAt}${reason}`;
        } else {
            this._els.banner.style.display = 'none';
        }

        // Vector RAG block
        const vec = data.vector || {};
        if (vec.error) {
            this._els.vecChunks.textContent = `error: ${vec.error}`;
            this._els.vecSources.textContent = '-';
        } else {
            this._els.vecChunks.textContent = vec.total_chunks ?? 0;
            this._els.vecSources.textContent = (vec.sources || []).length;
        }

        // Graph block
        const phase = progress.phase || 'idle';
        this._els.phase.textContent = humanizePhase(phase);
        this._els.phase.className = 'grm-phase grm-phase-' + phase;

        const counts = graph.global_counts || {};
        this._els.entities.textContent = counts.entities ?? 0;
        this._els.rels.textContent = counts.relationships ?? 0;
        const cs = (progress.communities_summarized != null && progress.communities_total != null)
            ? `${progress.communities_summarized} / ${progress.communities_total}`
            : (counts.communities ?? '-');
        this._els.communities.textContent = cs;

        if (lastBuild.finished_at) {
            const when = new Date(lastBuild.finished_at).toLocaleString();
            const dur = fmtDuration(lastBuild.duration_seconds);
            this._els.lastBuild.textContent = `${when} (${dur})`;
        } else {
            this._els.lastBuild.textContent = inProgress ? 'in progress' : '-';
        }

        // Progress row only while in flight, and only when extraction
        // counters are present (extracting phase). Other phases use the
        // sub-phase row below.
        if (inProgress && progress.extraction_chunks_total != null) {
            const done = progress.extraction_chunks_done || 0;
            const total = progress.extraction_chunks_total || 0;
            this._els.progressRow.style.display = '';
            this._els.progressText.textContent = `${done} / ${total} chunks`;
            const pct = total ? (done / total) * 100 : 0;
            this._els.progressPct.textContent = total ? `(${pct.toFixed(1)}%)` : '';
        } else {
            this._els.progressRow.style.display = 'none';
        }

        // Sub-phase row: surfaces per-step progress that today's status
        // endpoint promotes from graph_storage's chunked write loops
        // (Phase 0b in documents/kb/kb_import_export.md). Without this,
        // the user sees `phase: writing` for ~12 minutes with no
        // movement; with it, every UNWIND batch updates the bar.
        if (inProgress && progress.sub_phase) {
            const subDone = progress.sub_done || 0;
            const subTotal = progress.sub_total || 0;
            const subPct = (typeof progress.sub_pct === 'number')
                ? progress.sub_pct
                : (subTotal ? (subDone / subTotal) * 100 : 0);
            this._els.subPhaseRow.style.display = '';
            this._els.subPhaseLabel.textContent = humanizeSubPhase(progress.sub_phase);
            // No total = indeterminate sub-phase (e.g. Docling parse).
            // Show a spinner glyph instead of fake numbers.
            if (subTotal) {
                this._els.subPhaseText.textContent = `${subDone} / ${subTotal}`;
                this._els.subPhasePct.textContent = `(${subPct.toFixed(1)}%)`;
            } else {
                this._els.subPhaseText.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="color:#888"></i>';
                this._els.subPhasePct.textContent = '';
            }
        } else {
            this._els.subPhaseRow.style.display = 'none';
        }

        // Rebuild button state
        this._els.rebuildBtn.disabled = inProgress || this._rebuildInFlight;
        this._els.rebuildLabel.textContent = (inProgress || this._rebuildInFlight)
            ? 'Rebuilding...'
            : 'Rebuild Graph';
    }

    async _triggerRebuild() {
        const d = this._ctx.domain;
        const ok = await modalConfirm(
            `Rebuild the knowledge graph for "${d.name || d.domain_id}"? This is a full re-extraction.`,
            { title: 'Rebuild Graph', confirmText: 'Rebuild', cancelText: 'Cancel' },
        );
        if (!ok) return;
        this._rebuildInFlight = true;
        this._els.rebuildBtn.disabled = true;
        this._els.rebuildLabel.textContent = 'Starting...';
        try {
            const r = await fetch(this._rebuildUrl(), { method: 'POST' });
            if (!r.ok) {
                const detail = await r.text().catch(() => '');
                throw new Error(`HTTP ${r.status}: ${detail.slice(0, 200)}`);
            }
            notify.info(`Rebuild started for ${d.domain_id}.`);
            this._tick();
        } catch (e) {
            this._rebuildInFlight = false;
            this._ctx.showError(`Rebuild failed: ${e.message}`);
            this._els.rebuildBtn.disabled = false;
            this._els.rebuildLabel.textContent = 'Rebuild Graph';
        }
    }

    /**
     * Run the preflight diagnostic battery against this domain.
     * Calls POST /api/domains/{id}/preflight (no path = system-health
     * mode: schema indexes, ArcadeDB write probe via GraphBatch, embed
     * probe, Gemma JSON smoke). Renders the structured report in a
     * modal so the user can see green/yellow/red on each check.
     *
     * Catches the failure modes that have wasted hours of import time
     * (chat-template-swap-style Gemma regressions, ArcadeDB schema
     * drift, embedding service down, ConcurrentModificationException
     * indicators). ~3-5s wall.
     */
    async _triggerPreflight() {
        const d = this._ctx.domain;
        const btn = this._els.preflightBtn;
        if (!btn) return;
        const originalLabel = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Running...</span>';
        try {
            const r = await fetch(
                `api/domains/${encodeURIComponent(d.domain_id)}/preflight`,
                { method: 'POST', cache: 'no-store' },
            );
            if (!r.ok) {
                const detail = await r.text().catch(() => '');
                throw new Error(`HTTP ${r.status}: ${detail.slice(0, 200)}`);
            }
            const report = await r.json();
            this._showPreflightReport(report);
        } catch (e) {
            this._ctx.showError(`Preflight failed: ${e.message}`);
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalLabel;
        }
    }

    _showPreflightReport(report) {
        const d = this._ctx.domain;
        const checks = Array.isArray(report.checks) ? report.checks : [];
        const okCount = checks.filter((c) => c.status === 'ok').length;
        const warnCount = checks.filter((c) => c.status === 'warn').length;
        const errCount = checks.filter((c) => c.status === 'error').length;

        const overallIcon = report.ok
            ? '<i class="fa-solid fa-circle-check" style="color:#5fb56f"></i>'
            : '<i class="fa-solid fa-circle-xmark" style="color:#d04848"></i>';
        const overallText = report.ok
            ? 'All blocking checks passed'
            : 'At least one blocking error — see details below';

        const rows = checks.map((c) => {
            const iconHtml = c.status === 'ok'
                ? '<i class="fa-solid fa-circle-check" style="color:#5fb56f"></i>'
                : (c.status === 'warn'
                    ? '<i class="fa-solid fa-circle-exclamation" style="color:#d4a836"></i>'
                    : '<i class="fa-solid fa-circle-xmark" style="color:#d04848"></i>');
            const elapsed = c.elapsed_ms != null ? `${c.elapsed_ms} ms` : '-';
            return `
                <tr>
                    <td style="padding:4px 8px;vertical-align:top;width:24px">${iconHtml}</td>
                    <td style="padding:4px 8px;vertical-align:top;font-family:var(--mono-font,monospace);white-space:nowrap">${escapeHtml(c.name)}</td>
                    <td style="padding:4px 8px;vertical-align:top;color:#888;white-space:nowrap">${elapsed}</td>
                    <td style="padding:4px 8px;vertical-align:top">${escapeHtml(c.detail || '')}</td>
                </tr>
            `;
        }).join('');

        const html = `
            <div style="padding:16px 20px;font-size:14px;line-height:1.4;color:var(--text-primary,#ccc)">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
                    <span style="font-size:20px">${overallIcon}</span>
                    <div>
                        <div style="font-weight:600">${escapeHtml(overallText)}</div>
                        <div style="color:#888;font-size:12px">
                            ${okCount} ok · ${warnCount} warn · ${errCount} error
                        </div>
                    </div>
                </div>
                <table style="width:100%;border-collapse:collapse;font-size:13px">
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;

        // Use jsPanel directly — modalConfirm is a fixed 360px wide which
        // is too narrow for the diagnostics table. Single Close button
        // (no decision needed). The `onclosed` cleanup matches the
        // pattern in modal.js (`_cleanupBackdrops`) — without it,
        // jsPanel leaves a `.jsPanel-modal-backdrop` element stuck on
        // the page so the user sees the dim overlay forever.
        jsPanel.modal.create({
            headerTitle: `Preflight diagnostics — ${d.name || d.domain_id}`,
            contentSize: { width: 640, height: 'auto' },
            content: html,
            position: 'center',
            dragit: false,
            resizeit: false,
            headerControls: 'closeonly',
            border: '1px solid var(--border-color, #444)',
            borderRadius: '6px',
            theme: 'none',
            boxShadow: 4,
            onclosed: [() => {
                document.querySelectorAll('.jsPanel-modal-backdrop').forEach((el) => el.remove());
                return true;
            }],
            footerToolbar: `
                <div style="display:flex;justify-content:flex-end;gap:8px;padding:8px 16px;width:100%">
                    <button class="modal-btn modal-confirm">Close</button>
                </div>`,
            callback: (panel) => {
                panel.footer.querySelector('.modal-confirm').addEventListener('click', () => {
                    panel.close();
                });
            },
        });
    }
}
