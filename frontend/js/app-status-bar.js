/**
 * app-status-bar.js - Status bar management for the noted application.
 *
 * Handles the bottom status bar including:
 * - System info pills (host OS, container OS, Python version)
 * - Git branch display
 * - Project name display
 * - Pipeline status tracking
 * - Serving model status polling
 * - Problems/diagnostics indicator and panel
 * - Editor cursor position (Ln/Col/Spaces/Language)
 * - Notification bell and panel
 *
 * All methods are attached to the App instance via initStatusBar(app).
 * Requires: notify (from Notify.js), this._client (KernelClient with Socket.IO)
 */

import { notify } from './Notify.js';

/**
 * Attach status bar methods to the App instance.
 * @param {object} app - The App instance
 */
export function initStatusBar(app) {

    /**
     * Build the status bar UI from system info API response.
     * Creates pills for OS, Python, pipeline, serving, problems, and cursor info.
     */
    app._initStatusBar = async function() {
        const bar = document.getElementById('status-bar');
        if (!bar) return;
        try {
            const resp = await fetch('api/system/info');
            if (!resp.ok) return;
            const info = await resp.json();
            bar.innerHTML = '';

            // Host OS - golden pill
            const host = document.createElement('span');
            host.className = 'status-pill host';
            host.innerHTML = `<i class="${app._osIcon(info.host_os)}" style="font-size:9px"></i> ${info.host_os}`;
            bar.appendChild(host);

            // Container OS - pastel green pill
            const shortOS = info.container_os.replace('GNU/Linux ', '');
            const container = document.createElement('span');
            container.className = 'status-pill container';
            container.innerHTML = `<i class="fa-brands fa-docker" style="font-size:9px"></i> ${shortOS}`;
            bar.appendChild(container);

            // Git branch - updated on notebook change
            const branch = document.createElement('span');
            branch.className = 'status-item';
            branch.id = 'status-branch';
            branch.style.display = 'none';
            bar.appendChild(branch);

            // Project name - updated on notebook change
            const project = document.createElement('span');
            project.className = 'status-item';
            project.id = 'status-project';
            project.style.display = 'none';
            bar.appendChild(project);

            // Python version - after branch, left side
            const py = document.createElement('span');
            py.className = 'status-item';
            py.id = 'status-python';
            py.innerHTML = `<i class="fa-brands fa-python" style="font-size:9px"></i> Python ${info.python}`;
            bar.appendChild(py);

            // Pipeline status pill - shows when DAG runs are active
            const pipelinePill = document.createElement('span');
            pipelinePill.className = 'status-pill pipeline';
            pipelinePill.id = 'status-pipeline';
            pipelinePill.style.display = 'none';
            pipelinePill.innerHTML = '<i class="fa-solid fa-diagram-project" style="font-size:9px"></i> Idle';
            bar.appendChild(pipelinePill);

            // Track active pipeline runs
            app._activePipelineRuns = new Map();
            app._client.on('pipeline:status', (data) => {
                const { dag_id, dag_run_id, state } = data;
                const key = `${dag_id}:${dag_run_id}`;
                if (state === 'running' || state === 'queued') {
                    app._activePipelineRuns.set(key, { dag_id, state });
                } else {
                    app._activePipelineRuns.delete(key);
                }
                app._updatePipelineStatus(pipelinePill);
            });

            // Serving status pill - disabled (kept as no-op so callers
            // like ExplorerRegistryViews that dispatch 'serving:model-changed'
            // don't break).
            app._checkServingHealth = () => {};

            // Problems indicator (errors/warnings count)
            const problemsPill = document.createElement('span');
            problemsPill.className = 'status-pill problems';
            problemsPill.id = 'status-problems';
            problemsPill.style.display = 'none';
            problemsPill.style.cursor = 'pointer';
            problemsPill.addEventListener('click', () => app._toggleProblemsPanel());
            bar.appendChild(problemsPill);

            // Spacer pushes right items to the right
            const spacer = document.createElement('span');
            spacer.className = 'status-spacer';
            bar.appendChild(spacer);

            // Cell ordinal (notebook only) - clickable to jump to a cell.
            // Placed before cursor info so it sits leftmost in the right group.
            const cellOrd = document.createElement('span');
            cellOrd.className = 'status-right';
            cellOrd.id = 'status-cell';
            cellOrd.style.display = 'none';
            cellOrd.style.cursor = 'pointer';
            cellOrd.title = 'Click to jump to cell';
            cellOrd.addEventListener('click', () => app._showGoToCellModal());
            bar.appendChild(cellOrd);

            // Editor cursor info (right side)
            const cursor = document.createElement('span');
            cursor.className = 'status-right';
            cursor.id = 'status-cursor';
            cursor.style.display = 'none';
            bar.appendChild(cursor);

            const indent = document.createElement('span');
            indent.className = 'status-right';
            indent.id = 'status-indent';
            indent.style.display = 'none';
            bar.appendChild(indent);

            const encoding = document.createElement('span');
            encoding.className = 'status-right';
            encoding.id = 'status-encoding';
            encoding.textContent = 'UTF-8';
            bar.appendChild(encoding);

            const lineEnding = document.createElement('span');
            lineEnding.className = 'status-right';
            lineEnding.id = 'status-eol';
            lineEnding.textContent = 'LF';
            bar.appendChild(lineEnding);

            const lang = document.createElement('span');
            lang.className = 'status-right';
            lang.id = 'status-lang';
            lang.style.display = 'none';
            bar.appendChild(lang);

            // Notifications bell icon (far right)
            const bell = document.createElement('span');
            bell.className = 'status-right status-bell';
            bell.innerHTML = '<i class="fa-regular fa-bell" style="font-size:10px"></i>';
            bell.title = 'Notifications';
            bell.style.cursor = 'pointer';
            bell.addEventListener('click', (e) => {
                e.stopPropagation();
                app._toggleNotificationPanel();
            });
            bar.appendChild(bell);

            app._notifBell = bell;
            app._notifBadge = document.createElement('span');
            app._notifBadge.className = 'status-bell-badge';
            app._notifBadge.style.display = 'none';
            bell.appendChild(app._notifBadge);

            // Track unseen count
            app._notifSeenCount = 0;
            notify.onChange(() => app._onNotification());
        } catch (e) {
            console.warn('Failed to load system info:', e);
        }
    };

    /** Map OS name to Font Awesome icon class. */
    app._osIcon = function(name) {
        const n = name.toLowerCase();
        if (n.includes('windows')) return 'fa-brands fa-windows';
        if (n.includes('docker'))  return 'fa-brands fa-docker';
        if (n.includes('mac') || n.includes('darwin')) return 'fa-brands fa-apple';
        if (n.includes('ubuntu'))  return 'fa-brands fa-ubuntu';
        if (n.includes('debian'))  return 'fa-brands fa-debian';
        if (n.includes('fedora'))  return 'fa-brands fa-fedora';
        if (n.includes('redhat') || n.includes('rhel')) return 'fa-brands fa-redhat';
        if (n.includes('linux'))   return 'fa-brands fa-linux';
        return 'fa-solid fa-desktop';
    };

    /** Update pipeline status pill based on active DAG runs. */
    app._updatePipelineStatus = function(pill) {
        const count = app._activePipelineRuns.size;
        if (count === 0) {
            pill.style.display = 'none';
            return;
        }
        pill.style.display = '';
        const runs = [...app._activePipelineRuns.values()];
        const dagIds = [...new Set(runs.map(r => r.dag_id))];
        const label = count === 1
            ? `${dagIds[0]} running`
            : `${count} DAG runs active`;
        pill.innerHTML = `<i class="fa-solid fa-diagram-project" style="font-size:9px"></i> ${label}`;
    };

    /**
     * Update the Problems status pill with current diagnostic counts.
     * Also refreshes the Problems panel if open.
     */
    app._updateProblemsStatus = function(diagnostics) {
        const pill = document.getElementById('status-problems');
        if (!pill) return;
        app._currentDiagnostics = diagnostics || [];

        if (app._problemsPanel) {
            app._renderProblemsContent();
        }

        const errors = diagnostics.filter(d => d.severity === 'error').length;
        const warnings = diagnostics.filter(d => d.severity === 'warning').length;
        const info = diagnostics.filter(d => d.severity === 'info').length;
        const total = errors + warnings + info;

        if (total === 0) {
            pill.style.display = 'none';
            return;
        }

        const parts = [];
        if (errors) parts.push(`<i class="fa-solid fa-circle-xmark" style="color:#e53935;font-size:12px"></i> ${errors}`);
        if (warnings) parts.push(`<i class="fa-solid fa-triangle-exclamation" style="color:#e67e22;font-size:12px"></i> ${warnings}`);
        if (info) parts.push(`<i class="fa-solid fa-circle-info" style="color:#4a9eda;font-size:12px"></i> ${info}`);
        pill.innerHTML = parts.join('  ');
        pill.title = `${total} problem${total !== 1 ? 's' : ''}: ${errors} error${errors !== 1 ? 's' : ''}, ${warnings} warning${warnings !== 1 ? 's' : ''}`;
        pill.style.display = '';
    };

    /**
     * Build HTML for the problems list panel.
     * Supports both file diagnostics (Ln X) and notebook diagnostics (Cell X, Ln Y).
     */
    app._buildProblemsListHtml = function(diags) {
        let html = '';
        for (const d of diags) {
            const icon = d.severity === 'error'
                ? '<i class="fa-solid fa-circle-xmark" style="color:#e53935;font-size:12px"></i>'
                : d.severity === 'warning'
                    ? '<i class="fa-solid fa-triangle-exclamation" style="color:#e67e22;font-size:12px"></i>'
                    : '<i class="fa-solid fa-circle-info" style="color:#4a9eda;font-size:12px"></i>';

            const msgParts = d.message.split('\x1f');
            const firstLine = msgParts[0] || d.message;
            const rest = msgParts.slice(1);
            const category = rest.find(l => l && !l.startsWith('http')) || '';
            const catParts = category.split(' - ');

            // Match Ruff codes (F401) and Biome codes (noDoubleEquals)
            const codeMatch = firstLine.match(/^([A-Za-z]\w+):\s*(.*)$/);
            const code = codeMatch ? codeMatch[1] : '';
            const msg = codeMatch ? codeMatch[2] : firstLine;

            const codeBadge = code
                ? `<span style="display:inline-block;background:#d4edda;color:#2d6a3f;font-size:9px;font-weight:600;padding:1px 5px;border-radius:3px;letter-spacing:0.3px;white-space:nowrap">${code}</span>`
                : '';
            const catBadge = catParts[0] && catParts[0] !== firstLine
                ? `<span style="display:inline-block;background:#ffe39e;color:#5a4000;font-size:9px;font-weight:600;padding:1px 5px;border-radius:3px;letter-spacing:0.3px;white-space:nowrap;text-transform:uppercase">${app._escapeHtml(catParts[0])}</span>`
                : '';

            const cellAttr = d.cellIndex != null ? ` data-cell="${d.cellIndex}"` : '';
            const location = d.cellIndex != null ? `Cell ${d.cellIndex + 1}, Ln ${d.line}` : `Ln ${d.line}`;
            html += `<div class="problems-item" data-line="${d.line}"${cellAttr} style="padding:6px 10px;border-bottom:1px solid #f0f0f0;cursor:pointer;display:flex;align-items:center;gap:8px;font-size:12px;color:#333333">
                ${icon}
                <span style="color:#333333;min-width:36px;font-size:11px">${location}</span>
                ${codeBadge}
                <span style="flex:1">${app._escapeHtml(msg.trim())}</span>
                ${catBadge}
            </div>`;
        }
        return html;
    };

    /**
     * Wire click handlers on problems list items.
     * Navigates to the diagnostic location in file or notebook.
     */
    app._wireProblemsItems = function(container) {
        container.querySelectorAll('.problems-item').forEach(item => {
            item.addEventListener('click', () => {
                const line = parseInt(item.dataset.line);
                const cellIndex = item.dataset.cell != null ? parseInt(item.dataset.cell) : null;
                const activeKey = app._tabBar?.activeKey;
                if (activeKey?.startsWith('pyfile:')) {
                    const editor = app._fileEditors.get(activeKey);
                    if (editor?._editorView) {
                        const pos = editor._editorView.state.doc.line(line).from;
                        editor._editorView.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
                        editor._editorView.focus();
                    }
                } else if (activeKey?.startsWith('notebook:') && cellIndex != null) {
                    const entry = app._editors.get(activeKey);
                    const cell = entry?.editor?.cells?.[cellIndex];
                    if (cell) {
                        entry.editor.scrollToCell(cellIndex);
                        if (cell._editorView && line > 0) {
                            const pos = cell._editorView.state.doc.line(line).from;
                            cell._editorView.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
                            cell._editorView.focus();
                        }
                    }
                }
            });
            item.addEventListener('mouseenter', () => { item.style.background = '#f5f5f5'; });
            item.addEventListener('mouseleave', () => { item.style.background = ''; });
        });
    };

    /** Re-render the problems panel content with current diagnostics. */
    app._renderProblemsContent = function() {
        if (!app._problemsPanel) return;
        const diags = app._currentDiagnostics || [];
        const listHtml = app._buildProblemsListHtml(diags);
        const scrollEl = app._problemsPanel.content.querySelector('.problems-scroll');
        if (scrollEl) {
            scrollEl.innerHTML = listHtml;
            app._wireProblemsItems(scrollEl);
        }
        app._problemsPanel.setHeaderTitle(
            `<i class="fa-solid fa-circle-exclamation" style="margin-right:6px;font-size:11px;color:#e53935"></i>Problems (${diags.length})`
        );
        if (diags.length === 0) {
            app._problemsPanel.close();
            app._problemsPanel = null;
        }
    };

    /** Toggle the Problems panel open/closed. */
    app._toggleProblemsPanel = function() {
        if (app._problemsPanel) {
            app._problemsPanel.close();
            app._problemsPanel = null;
            return;
        }
        const diags = app._currentDiagnostics || [];
        const listHtml = app._buildProblemsListHtml(diags);
        app._problemsPanel = jsPanel.create({
            headerTitle: `<i class="fa-solid fa-circle-exclamation" style="margin-right:6px;font-size:11px;color:#e53935"></i>Problems (${diags.length})`,
            theme: '#f5f5f5 filled',
            borderRadius: '5px',
            contentSize: { width: Math.min(600, window.innerWidth - 60), height: 220 },
            position: { my: 'left-bottom', at: 'left-top', of: '#status-problems', offsetY: -4 },
            headerControls: 'closeonly',
            content: `<div class="problems-scroll">${listHtml}</div>`,
            onclosed: () => { app._problemsPanel = null; },
            callback: (p) => {
                app._wireProblemsItems(p.content);
            }
        });
    };

    /** Escape HTML special characters. */
    app._escapeHtml = function(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    };

    /** Update cursor position display in status bar (Ln/Col/Spaces/Language). */
    /** Open the "Go to cell" modal (reused by the status-bar click and
     *  the Ctrl+G keybinding). No-op when no notebook is active. */
    app._showGoToCellModal = async function() {
        if (!app._editor || !app._editor._cells) return;
        const total = app._editor._cells.length;
        if (total === 0) return;
        const { modalPrompt } = await import('./modal.js');
        const input = await modalPrompt(`Cell number (1 to ${total}):`, {
            title: 'Go to cell',
            placeholder: String((app._editor._anchorIndex ?? 0) + 1),
        });
        if (input == null) return;
        const n = parseInt(input.trim(), 10);
        if (!Number.isFinite(n) || n < 1 || n > total) return;
        app._editor.scrollToCell(n - 1);
    };

    /** Update just the cell ordinal pill. Used by markdown cells in display
     *  mode where onCursorActivity never fires (no editor). */
    app._updateStatusCellOrdinal = function(cellIndex, total) {
        const cellEl = document.getElementById('status-cell');
        if (!cellEl) return;
        if (typeof cellIndex === 'number' && total > 0) {
            cellEl.textContent = `Cell ${cellIndex + 1} of ${total}`;
            cellEl.style.display = '';
        } else {
            cellEl.style.display = 'none';
        }
    };

    app._updateStatusCursor = function(info) {
        const cursorEl = document.getElementById('status-cursor');
        const indentEl = document.getElementById('status-indent');
        const langEl = document.getElementById('status-lang');
        const encEl = document.getElementById('status-encoding');
        const eolEl = document.getElementById('status-eol');
        const cellEl = document.getElementById('status-cell');
        if (!cursorEl) return;

        if (!info) {
            cursorEl.style.display = 'none';
            indentEl.style.display = 'none';
            langEl.style.display = 'none';
            if (encEl) encEl.style.display = 'none';
            if (eolEl) eolEl.style.display = 'none';
            if (cellEl) cellEl.style.display = 'none';
            return;
        }

        // Cell ordinal: 1-based to match the convention the Assistant uses
        // ("Cell N" in answers, tool calls, WORKSPACE CONTEXT). Hidden for
        // file editors (no cellIndex in payload).
        if (cellEl) {
            if (typeof info.cellIndex === 'number' && app._editor && app._editor._cells) {
                const total = app._editor._cells.length;
                cellEl.textContent = `Cell ${info.cellIndex + 1} of ${total}`;
                cellEl.style.display = '';
            } else {
                cellEl.style.display = 'none';
            }
        }

        cursorEl.textContent = `Ln ${info.line}, Col ${info.col}`;
        cursorEl.style.display = '';

        indentEl.textContent = `Spaces: ${info.tabSize}`;
        indentEl.style.display = '';

        if (encEl) encEl.style.display = '';
        if (eolEl) eolEl.style.display = '';

        if (info.lang) {
            langEl.textContent = info.lang;
            langEl.style.display = '';
        } else {
            langEl.style.display = 'none';
        }
    };

    /** Handle new notification - update badge count. */
    app._onNotification = function() {
        const total = notify.history.length;
        const unseen = total - app._notifSeenCount;
        if (unseen > 0 && app._notifBadge) {
            app._notifBadge.textContent = unseen > 9 ? '9+' : unseen;
            app._notifBadge.style.display = '';
        }
        if (app._notifOpen) {
            app._renderNotificationPanel();
            app._notifSeenCount = total;
            app._notifBadge.style.display = 'none';
        }
    };

    /** Toggle the notification panel open/closed. */
    app._toggleNotificationPanel = function() {
        if (!app._notifPanel) {
            app._notifPanel = document.createElement('div');
            app._notifPanel.className = 'notif-panel';
            document.getElementById('app').appendChild(app._notifPanel);
            app._notifOpen = false;
            document.addEventListener('click', (e) => {
                if (app._notifOpen && app._notifPanel
                    && !app._notifPanel.contains(e.target)
                    && !app._notifBell.contains(e.target)) {
                    app._hideNotificationPanel();
                }
            });
        }

        if (app._notifOpen) {
            app._hideNotificationPanel();
        } else {
            app._showNotificationPanel();
        }
    };

    app._showNotificationPanel = function() {
        app._renderNotificationPanel();
        app._notifPanel.classList.remove('notif-hiding');
        app._notifPanel.classList.add('notif-visible');
        app._notifOpen = true;
        app._notifSeenCount = notify.history.length;
        if (app._notifBadge) app._notifBadge.style.display = 'none';
    };

    app._hideNotificationPanel = function() {
        app._notifPanel.classList.remove('notif-visible');
        app._notifPanel.classList.add('notif-hiding');
        app._notifOpen = false;
        setTimeout(() => {
            if (!app._notifOpen) app._notifPanel.classList.remove('notif-hiding');
        }, 200);
    };

    /** Render the notification panel with all notification history items. */
    app._renderNotificationPanel = function() {
        const panel = app._notifPanel;
        panel.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'notif-header';
        header.textContent = 'Notifications';

        const clearBtn = document.createElement('button');
        clearBtn.className = 'notif-clear-btn';
        clearBtn.title = 'Clear all';
        clearBtn.innerHTML = '<i class="fa-solid fa-xmark" style="font-size:10px"></i>';
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            notify.history.length = 0;
            app._notifSeenCount = 0;
            app._hideNotificationPanel();
        });
        header.appendChild(clearBtn);
        panel.appendChild(header);

        const list = document.createElement('div');
        list.className = 'notif-list';

        if (notify.history.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'notif-empty';
            empty.textContent = 'No notifications';
            list.appendChild(empty);
        } else {
            for (const item of notify.history) {
                const row = document.createElement('div');
                row.className = `notif-item notif-${item.type}`;

                const icon = document.createElement('i');
                const iconMap = {
                    success: 'fa-solid fa-circle-check',
                    error: 'fa-solid fa-circle-xmark',
                    info: 'fa-solid fa-circle-info',
                    warning: 'fa-solid fa-triangle-exclamation',
                };
                icon.className = `notif-icon ${iconMap[item.type] || iconMap.info}`;

                const msg = document.createElement('span');
                msg.className = 'notif-msg';
                msg.textContent = item.message;

                const copyBtn = document.createElement('button');
                copyBtn.className = 'notif-copy-btn';
                copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i>';
                copyBtn.title = 'Copy';
                copyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(item.message);
                    copyBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
                });

                const time = document.createElement('span');
                time.className = 'notif-time';
                time.textContent = app._formatNotifTime(item.time);

                row.append(icon, msg, copyBtn, time);
                list.appendChild(row);
            }
        }

        panel.appendChild(list);
    };

    app._formatNotifTime = function(date) {
        const now = new Date();
        const diff = Math.floor((now - date) / 1000);
        if (diff < 60) return 'just now';
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    /** Update project name in the status bar. */
    app._updateStatusProject = function(projectId) {
        const el = document.getElementById('status-project');
        const pyEl = document.getElementById('status-python');
        if (!el) return;
        if (!projectId) {
            el.style.display = 'none';
            if (pyEl) pyEl.style.display = 'none';
            return;
        }
        el.innerHTML = `<i class="fa-regular fa-clipboard" style="font-size:9px"></i> ${projectId}`;
        el.style.display = '';
        if (pyEl) pyEl.style.display = '';
    };

    /** Fetch and display the current git branch for a project. */
    app._updateStatusBranch = async function(projectId) {
        const branchEl = document.getElementById('status-branch');
        if (!branchEl) return;
        if (!projectId) { branchEl.style.display = 'none'; return; }
        try {
            const resp = await fetch(`api/projects/${encodeURIComponent(projectId)}/git/branches`);
            if (!resp.ok) { branchEl.style.display = 'none'; return; }
            const data = await resp.json();
            if (data.current) {
                branchEl.innerHTML = `<i class="fa-solid fa-code-branch" style="font-size:9px"></i> ${data.current}`;
                branchEl.style.display = '';
            } else {
                branchEl.style.display = 'none';
            }
        } catch { branchEl.style.display = 'none'; }
    };
}
