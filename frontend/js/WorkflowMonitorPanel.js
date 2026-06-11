/**
 * WorkflowMonitorPanel - floating jsPanel inspector for the workflow framework.
 *
 * Lists tenant-scoped workflows (live + on-disk snapshots merged), shows
 * selected workflow detail (per-step state + audit timeline), and exposes
 * resume / abort / rerun actions. Subscribes to the Socket.io workflow
 * events the framework emits (workflow_started / step_* / workspace_sync /
 * workflow_completed / workflow_suspended / workflow_resumed / workflow_failed)
 * so the list and detail re-render live without polling.
 *
 * Architecture: see documents/self-learning/self_learning_plan.md.
 */

const STATUS_COLORS = {
    pending: '#9aa0a6',
    running: '#4a90e2',
    suspended: '#e69138',
    completed: '#22a06b',
    failed: '#d32f2f',
    aborted: '#a05d00',
};

const STEP_STATUS_ICONS = {
    pending: 'fa-regular fa-circle',
    running: 'fa-solid fa-circle-notch fa-spin',
    completed: 'fa-solid fa-circle-check',
    failed: 'fa-solid fa-circle-xmark',
    skipped: 'fa-solid fa-forward',
};

function _fmtTimestamp(ts) {
    if (!ts) return '-';
    try {
        const d = new Date(ts * 1000);
        return d.toLocaleTimeString();
    } catch { return String(ts); }
}

function _fmtDateTime(ts) {
    if (!ts) return '-';
    try {
        const d = new Date(ts * 1000);
        return d.toLocaleString(undefined, {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
    } catch { return String(ts); }
}

function _fmtElapsed(start, finish) {
    if (!start) return '-';
    const end = finish || (Date.now() / 1000);
    const sec = end - start;
    if (sec < 1) return `${Math.round(sec * 1000)}ms`;
    if (sec < 60) return `${sec.toFixed(1)}s`;
    return `${Math.round(sec / 60)}m`;
}

export class WorkflowMonitorPanel {
    constructor(client = null) {
        this._panel = null;
        this._els = {};
        this._client = client;
        this._workflows = [];
        this._selected = null;
        this._socketListeners = [];
    }

    /**
     * Open the panel.
     * @param {string|null} selectWorkflowId - if provided, refresh and select the
     *   matching workflow row + render its detail. Used by the Explorer's tool
     *   detail card "open in Workflow Monitor" link (F6.5).
     */
    open(selectWorkflowId = null) {
        if (selectWorkflowId) {
            this._pendingSelect = selectWorkflowId;
        }
        if (this._panel) {
            this._panel.front();
            this._refresh().then(() => this._applyPendingSelection());
            return;
        }
        this._panel = jsPanel.create({
            id: 'workflow-monitor-panel',
            headerTitle: '<i class="fa-solid fa-diagram-project" style="font-size:12px;margin-right:6px;color:#666"></i> Workflow Monitor',
            theme: 'none',
            borderRadius: '5px',
            border: '1px solid var(--border-color)',
            boxShadow: 3,
            position: 'center',
            contentSize: { width: 880, height: 640 },
            headerControls: { minimize: 'remove', smallify: 'remove', normalize: 'remove', maximize: 'remove' },
            addCloseControl: 1,
            onclosed: () => {
                this._tearDown();
                this._panel = null;
            },
            callback: (panel) => {
                this._panel = panel;
                panel.content.style.overflow = 'hidden';
                panel.content.style.padding = '0';
                this._buildUI();
                this._wireSocketListeners();
                this._refresh().then(() => this._applyPendingSelection());
            },
        });
    }

    close() { if (this._panel) this._panel.close(); }

    _buildUI() {
        const root = document.createElement('div');
        root.className = 'wfm-root';
        root.innerHTML = `
            <div class="wfm-header">
                <span class="wfm-title">Workflows</span>
                <span class="wfm-counts" id="wfm-counts"></span>
                <span class="wfm-spacer"></span>
                <select id="wfm-status-filter" class="wfm-input">
                    <option value="">all status</option>
                    <option value="running">running</option>
                    <option value="suspended">suspended</option>
                    <option value="completed">completed</option>
                    <option value="failed">failed</option>
                    <option value="aborted">aborted</option>
                </select>
                <select id="wfm-type-filter" class="wfm-input">
                    <option value="">all types</option>
                </select>
                <button class="wfm-btn" id="wfm-refresh" title="Refresh">
                    <i class="fa-solid fa-rotate"></i>
                </button>
            </div>
            <div class="wfm-body">
                <div class="wfm-list" id="wfm-list"></div>
                <div class="wfm-detail" id="wfm-detail">
                    <div class="wfm-detail-empty">Select a workflow to inspect.</div>
                </div>
            </div>
        `;
        this._panel.content.appendChild(root);
        this._els.list = root.querySelector('#wfm-list');
        this._els.detail = root.querySelector('#wfm-detail');
        this._els.counts = root.querySelector('#wfm-counts');
        this._els.statusFilter = root.querySelector('#wfm-status-filter');
        this._els.typeFilter = root.querySelector('#wfm-type-filter');
        this._els.refresh = root.querySelector('#wfm-refresh');

        this._els.refresh.addEventListener('click', () => this._refresh());
        this._els.statusFilter.addEventListener('change', () => this._renderList());
        this._els.typeFilter.addEventListener('change', () => this._renderList());

        this._loadTypes();
    }

    async _loadTypes() {
        try {
            const r = await fetch('api/workflows/types');
            if (!r.ok) return;
            const data = await r.json();
            const opts = (data.types || []).map((t) =>
                `<option value="${t.type}">${t.type}</option>`
            ).join('');
            this._els.typeFilter.innerHTML = '<option value="">all types</option>' + opts;
        } catch { /* ignore */ }
    }

    async _refresh() {
        try {
            const r = await fetch('api/workflows');
            if (!r.ok) {
                this._els.list.innerHTML = `<div class="wfm-empty">List failed: HTTP ${r.status}</div>`;
                return;
            }
            const data = await r.json();
            this._workflows = data.workflows || [];
            const c = data.counts || {};
            this._els.counts.textContent = `${c.returned ?? this._workflows.length} (live ${c.live ?? 0} / disk ${c.from_disk ?? 0})`;
            this._renderList();
            if (this._selected) this._renderDetail(this._selected);
        } catch (e) {
            this._els.list.innerHTML = `<div class="wfm-empty">List error: ${e.message}</div>`;
        }
    }

    _renderList() {
        const statusFilter = this._els.statusFilter.value;
        const typeFilter = this._els.typeFilter.value;
        const filtered = this._workflows.filter((w) => {
            if (statusFilter && w.status !== statusFilter) return false;
            if (typeFilter && w.workflow_type !== typeFilter) return false;
            return true;
        }).sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
        if (filtered.length === 0) {
            this._els.list.innerHTML = '<div class="wfm-empty">No workflows match the current filter.</div>';
            return;
        }
        this._els.list.innerHTML = filtered.map((w) => this._renderRow(w)).join('');
        this._els.list.querySelectorAll('.wfm-row').forEach((row) => {
            row.addEventListener('click', () => {
                const id = row.dataset.workflowId;
                this._selected = id;
                this._loadDetail(id);
                this._els.list.querySelectorAll('.wfm-row.selected').forEach((r) => r.classList.remove('selected'));
                row.classList.add('selected');
            });
        });
    }

    _renderRow(w) {
        const color = STATUS_COLORS[w.status] || '#666';
        const elapsed = _fmtElapsed(w.started_at, w.finished_at);
        const startedAt = _fmtDateTime(w.started_at);
        const stepsDone = (w.steps || []).filter((s) => s.status === 'completed').length;
        const stepsTotal = (w.steps || []).length;
        return `
            <div class="wfm-row" data-workflow-id="${w.workflow_id}">
                <div class="wfm-row-top">
                    <span class="wfm-status-pill" style="background:${color}">${w.status}</span>
                    <span class="wfm-row-type">${w.workflow_type}</span>
                </div>
                <div class="wfm-row-time">${startedAt}</div>
                <div class="wfm-row-meta">
                    <span>${stepsDone}/${stepsTotal} steps</span>
                    <span>${elapsed}</span>
                </div>
                <div class="wfm-row-id">${w.workflow_id}</div>
            </div>
        `;
    }

    async _loadDetail(workflowId) {
        try {
            const r = await fetch(`api/workflows/${encodeURIComponent(workflowId)}`);
            if (!r.ok) {
                this._els.detail.innerHTML = `<div class="wfm-detail-empty">Detail failed: HTTP ${r.status}</div>`;
                return;
            }
            const data = await r.json();
            this._renderDetailData(workflowId, data);
        } catch (e) {
            this._els.detail.innerHTML = `<div class="wfm-detail-empty">Detail error: ${e.message}</div>`;
        }
    }

    _renderDetail(workflowId) {
        // Re-fetches when called from a refresh; cheap.
        this._loadDetail(workflowId);
    }

    /**
     * Render the rewind banner above the steps list when A2 has rewound
     * to api_tester after a smoke-test failure. Without this, the workflow
     * appears to "loop" through api_tester / publish_tool / run_smoke_tests
     * with no visible reason — A2 silently resets each step's retries
     * counter on rewind.
     */
    _renderRewindBanner(s) {
        const rewinds = s.smoke_rewinds || 0;
        if (rewinds === 0) return '';
        const cap = 2;
        const lastErr = s.last_smoke_error || '';
        // Pull just the assertion / error line from the pytest tail.
        const summary = (() => {
            const m = lastErr.match(/(SyntaxError|AssertionError|ImportError|NameError|TypeError|ValueError):.*/);
            if (m) return m[0].slice(0, 240);
            return lastErr.slice(-240).trim();
        })();
        const inProgress = (s.status === 'running');
        const label = inProgress
            ? `Smoke rewind ${rewinds}/${cap} in progress — regenerating api_tester after smoke-test failure`
            : `Smoke rewind ${rewinds}/${cap} — last attempt failed`;
        return `
            <div class="wfm-rewind-banner">
                <div class="wfm-rewind-label">
                    <i class="fa-solid fa-rotate-right"></i> ${this._escape(label)}
                </div>
                ${summary ? `<div class="wfm-rewind-reason">${this._escape(summary)}</div>` : ''}
            </div>
        `;
    }

    _renderDetailData(workflowId, data) {
        const s = data.state || {};
        const audit = data.audit || [];
        const color = STATUS_COLORS[s.status] || '#666';
        const stepsHtml = (s.steps || []).map((st, i) => {
            const stepColor = STATUS_COLORS[st.status] || '#888';
            const icon = STEP_STATUS_ICONS[st.status] || STEP_STATUS_ICONS.pending;
            const elapsed = _fmtElapsed(st.started_at, st.finished_at);
            const errBlock = st.error
                ? `<div class="wfm-step-error">${this._escape(st.error)}</div>`
                : '';
            const outputKeys = Object.keys(st.output || {});
            const outputBlock = outputKeys.length
                ? `<div class="wfm-step-output">output keys: ${outputKeys.join(', ')}</div>`
                : '';
            // Highlight the retries counter when the step is on attempt 2+
            // so the user can see it's been retried.
            const retriesCls = (st.retries || 0) > 0 ? ' wfm-step-meta-retried' : '';
            return `
                <div class="wfm-step" data-step="${i}">
                    <i class="${icon}" style="color:${stepColor};margin-right:6px"></i>
                    <span class="wfm-step-name">${this._escape(st.name)}</span>
                    <span class="wfm-step-meta${retriesCls}">attempts=${(st.retries || 0) + 1} · ${elapsed}</span>
                    ${errBlock}
                    ${outputBlock}
                </div>
            `;
        }).join('');

        const auditHtml = audit.map((e) => {
            const t = e.at ? new Date(e.at).toLocaleTimeString() : '';
            const p = e.payload || {};
            let meta = p.step_name ? `: ${p.step_name}` : '';
            // smoke_rewind events carry rewind_index/cap + the failure
            // reason; render them distinctively so the user can see
            // why the workflow looped.
            if (e.event === 'smoke_rewind') {
                const idx = p.rewind_index || 0;
                const cap = p.rewind_cap || 0;
                meta = ` (${idx}/${cap}) → ${p.rewinding_to || 'api_tester'}`;
            }
            const eventCls = e.event === 'smoke_rewind' ? ' wfm-audit-event-rewind' : '';
            return `<div class="wfm-audit-line"><span class="wfm-audit-time">${t}</span> <span class="wfm-audit-event${eventCls}">${e.event}</span><span class="wfm-audit-meta">${this._escape(meta)}</span></div>`;
        }).join('');

        const isSuspended = s.status === 'suspended';
        const isRunning = s.status === 'running';

        const buttons = `
            <button class="wfm-btn wfm-btn-rerun" id="wfm-action-rerun">
                <i class="fa-solid fa-rotate-right"></i> Re-run
            </button>
            <button class="wfm-btn wfm-btn-resume ${isSuspended ? '' : 'wfm-btn-disabled'}" id="wfm-action-resume" ${isSuspended ? '' : 'disabled'}>
                <i class="fa-solid fa-play"></i> Resume
            </button>
            <button class="wfm-btn wfm-btn-abort ${isSuspended ? '' : 'wfm-btn-disabled'}" id="wfm-action-abort" ${isSuspended ? '' : 'disabled'}>
                <i class="fa-solid fa-stop"></i> Abort
            </button>
            <button class="wfm-btn wfm-btn-delete ${isRunning ? 'wfm-btn-disabled' : ''}" id="wfm-action-delete" ${isRunning ? 'disabled' : ''} title="${isRunning ? 'Abort the workflow first' : 'Delete this workflow record (does not undo published tools/skills)'}">
                <i class="fa-solid fa-trash"></i> Delete
            </button>
        `;

        this._els.detail.innerHTML = `
            <div class="wfm-detail-header">
                <div>
                    <span class="wfm-status-pill" style="background:${color}">${s.status}</span>
                    <span class="wfm-detail-type">${s.workflow_type}</span>
                </div>
                <div class="wfm-detail-actions">${buttons}</div>
            </div>
            <div class="wfm-detail-meta">
                <code>${s.workflow_id}</code>
                ${s.suspend_reason ? `<span class="wfm-suspend-reason"><i class="fa-solid fa-circle-exclamation"></i> ${this._escape(s.suspend_reason)}</span>` : ''}
            </div>
            ${this._renderRewindBanner(s)}
            <div class="wfm-detail-section-title">Steps</div>
            <div class="wfm-steps">${stepsHtml || '<i>no steps</i>'}</div>
            <div class="wfm-detail-section-title">Outcomes</div>
            <div class="wfm-outcomes">${(s.outcomes || []).map((o) => `<span class="wfm-outcome-pill">${o}</span>`).join('') || '<i style="color:#888">none yet</i>'}</div>
            <div class="wfm-detail-section-title">Audit (${audit.length})</div>
            <div class="wfm-audit">${auditHtml || '<i>no events</i>'}</div>
        `;
        this._els.detail.querySelector('#wfm-action-rerun').addEventListener('click', () => this._action('rerun', workflowId));
        const rb = this._els.detail.querySelector('#wfm-action-resume');
        if (rb && !rb.disabled) rb.addEventListener('click', () => this._action('resume', workflowId));
        const ab = this._els.detail.querySelector('#wfm-action-abort');
        if (ab && !ab.disabled) ab.addEventListener('click', () => this._action('abort', workflowId));
        const db = this._els.detail.querySelector('#wfm-action-delete');
        if (db && !db.disabled) db.addEventListener('click', () => this._deleteWorkflow(workflowId));
    }

    async _deleteWorkflow(workflowId) {
        if (!confirm(`Delete workflow ${workflowId}?\n\nThis removes the workflow record only — any tool or skill it published stays in place. Use the corresponding remove_tool to undo those.`)) return;
        try {
            const r = await fetch(`api/workflows/${encodeURIComponent(workflowId)}`, { method: 'DELETE' });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
                alert(`Delete failed: HTTP ${r.status} ${data.detail || ''}`);
                return;
            }
            // Drop from local cache + clear selection if it was the active row
            this._workflows = this._workflows.filter((w) => w.workflow_id !== workflowId);
            if (this._selected === workflowId) {
                this._selected = null;
                this._els.detail.innerHTML = '<div class="wfm-detail-empty">Select a workflow to inspect.</div>';
            }
            this._renderList();
        } catch (e) {
            alert(`Delete error: ${e.message}`);
        }
    }

    async _action(name, workflowId) {
        try {
            const r = await fetch(`api/workflows/${encodeURIComponent(workflowId)}/${name}`, { method: 'POST' });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
                alert(`${name} failed: HTTP ${r.status} ${data.detail || ''}`);
                return;
            }
            if (name === 'rerun' && data.workflow_id) {
                // Switch selection to the new workflow.
                this._selected = data.workflow_id;
                setTimeout(() => this._refresh(), 200);
                return;
            }
            this._refresh();
        } catch (e) {
            alert(`${name} error: ${e.message}`);
        }
    }

    _escape(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    _wireSocketListeners() {
        if (!this._client) return;
        const events = [
            'workflow_started', 'step_started', 'step_completed', 'step_failed',
            'workspace_sync', 'workflow_completed', 'workflow_failed',
            'workflow_suspended', 'workflow_resumed', 'system_request',
        ];
        const handler = (data) => {
            // Simplest reactive shape: any event triggers a list refresh
            // and (if the event's workflow_id matches the selection) a
            // detail refresh. The server is authoritative; we just re-pull.
            this._refresh();
            if (data && data.type === 'approve_resume') {
                this._showSystemRequest(data);
            }
        };
        for (const ev of events) {
            this._client.on(ev, handler);
            this._socketListeners.push({ event: ev, handler });
        }
    }

    _showSystemRequest(data) {
        // Minimal HITL modal. The framework already suspends; this just
        // surfaces the prompt so the user knows to act on the suspended
        // workflow via the detail pane's Resume / Abort buttons.
        if (!data || !data.workflow_id) return;
        const msg = data.prompt || 'Workflow needs approval.';
        const known = this._workflows.find((w) => w.workflow_id === data.workflow_id);
        const ctx = known ? `${known.workflow_type} (${data.workflow_id})` : data.workflow_id;
        // Match the project's modal pattern (frontend/js/modal.js): centered,
        // contentSize so the title bar gets its own height, and an explicit
        // backdrop cleanup on close. Without the cleanup, jsPanel sometimes
        // leaves the .jsPanel-modal-backdrop element behind, which renders
        // the page faded + unclickable.
        try {
            jsPanel.modal.create({
                id: `wfm-hitl-${data.workflow_id}`,
                theme: 'warning',
                headerTitle: 'Workflow needs your decision',
                content: `<div style="padding:14px">
                    <div style="margin-bottom:8px"><strong>${this._escape(ctx)}</strong></div>
                    <div>${this._escape(msg)}</div>
                    <div style="margin-top:10px;color:#777;font-size:12px">Open the Workflow Monitor to Resume or Abort.</div>
                </div>`,
                contentSize: { width: 420, height: 'auto' },
                position: 'center',
                dragit: false,
                resizeit: false,
                headerControls: 'closeonly',
                onclosed: [() => {
                    document.querySelectorAll('.jsPanel-modal-backdrop').forEach(el => el.remove());
                    return true;
                }],
            });
        } catch { /* jsPanel.modal optional */ }
    }

    _applyPendingSelection() {
        if (!this._pendingSelect) return;
        const targetId = this._pendingSelect;
        this._pendingSelect = null;
        const row = this._els.list?.querySelector(`.wfm-row[data-workflow-id="${CSS.escape(targetId)}"]`);
        if (row) {
            row.click();
            row.scrollIntoView({ block: 'center' });
        } else {
            // Workflow not in the current filtered list - load detail directly.
            this._selected = targetId;
            this._loadDetail(targetId);
        }
    }

    _tearDown() {
        if (this._client) {
            for (const { event, handler } of this._socketListeners) {
                if (typeof this._client.off === 'function') {
                    this._client.off(event, handler);
                }
            }
        }
        this._socketListeners = [];
    }
}
