/**
 * ExplorerSnapshotViews - Leaderboard, Snapshot creation/restore/fork.
 * Extracted from ExplorerMlflowViews to keep file sizes manageable.
 */

import { notify } from '../../Notify.js';
import { addMetaRow, escapeHtml } from './ExplorerHelpers.js';

/**
 * @param {object} ctx - Shared explorer context.
 * @returns {object} Leaderboard and snapshot functions.
 */
export function createSnapshotViews(ctx) {

    // ── Leaderboard ──────────────────────────────────────────────

    function renderLeaderboard(container, runs, metricKeys, paramKeys, experimentId) {
        container.innerHTML = '';

        // Title row with export button
        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px';
        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666';
        titleEl.textContent = `Leaderboard (${runs.length} runs)`;
        titleRow.appendChild(titleEl);

        // Columns selector button
        const colBtnWrap = document.createElement('div');
        colBtnWrap.style.cssText = 'position:relative;margin-left:auto';
        const colBtn = document.createElement('button');
        colBtn.className = 'rm-btn';
        colBtn.style.cssText = 'padding:2px 8px;font-size:10px;background:#f3e5f5';
        colBtn.innerHTML = '<i class="fa-solid fa-table-columns" style="font-size:9px;margin-right:3px"></i>Columns';
        colBtnWrap.appendChild(colBtn);
        titleRow.appendChild(colBtnWrap);

        const exportBtn = document.createElement('button');
        exportBtn.className = 'rm-btn';
        exportBtn.style.cssText = 'padding:2px 8px;font-size:10px;background:#d0e8ff';
        exportBtn.innerHTML = '<i class="fa-solid fa-download" style="font-size:9px;margin-right:3px"></i>CSV';
        titleRow.appendChild(exportBtn);

        // Promote best config button
        if (paramKeys.length) {
            const promoteBtn = document.createElement('button');
            promoteBtn.className = 'rm-btn';
            promoteBtn.style.cssText = 'padding:2px 8px;font-size:10px;background:#fff3e0';
            promoteBtn.innerHTML = '<i class="fa-solid fa-trophy" style="font-size:9px;margin-right:3px"></i>Promote Best';
            promoteBtn.title = 'Save best run config as Hydra template';
            promoteBtn.addEventListener('click', () => {
                // Find the run with the best primary metric
                if (!runs.length || !metricKeys.length) return;
                const primaryMetric = metricKeys[0];
                const isHigherBetter = primaryMetric.includes('r2') || primaryMetric.includes('accuracy') || primaryMetric.includes('f1');
                const sorted = [...runs].filter(r => r.metrics?.[primaryMetric] != null).sort((a, b) => {
                    return isHigherBetter
                        ? (b.metrics[primaryMetric] - a.metrics[primaryMetric])
                        : (a.metrics[primaryMetric] - b.metrics[primaryMetric]);
                });
                if (!sorted.length) { notify('No runs with metrics to promote', 'warning'); return; }
                const best = sorted[0];
                const params = best.params || {};
                const name = `best_${primaryMetric}_${best.run_name || best.run_id.substring(0, 8)}`;
                // Save as Hydra config template
                fetch(`api/hydra/templates/${encodeURIComponent(experimentId)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, config: params }),
                }).then(r => {
                    if (r.ok) notify(`Config promoted as template "${name}"`, 'success');
                    else notify('Failed to save config template', 'danger');
                }).catch(() => notify('Failed to save config template', 'danger'));
            });
            titleRow.appendChild(promoteBtn);
        }

        container.appendChild(titleRow);

        // Track visible columns (default: all metrics, first 6 params)
        const visibleMetrics = new Set(metricKeys);
        const visibleParams = new Set(paramKeys.slice(0, 6));

        // Config/param filter bar
        const filterRow = document.createElement('div');
        filterRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:8px';
        const filterIcon = document.createElement('i');
        filterIcon.className = 'fa-solid fa-filter';
        filterIcon.style.cssText = 'font-size:11px;color:#888';
        filterRow.appendChild(filterIcon);
        const filterInput = document.createElement('input');
        filterInput.type = 'text';
        filterInput.placeholder = 'Filter: model_type=GRU, lr>0.001, epochs>=30';
        filterInput.style.cssText = 'flex:1;padding:4px 8px;font-size:11px;border:0.5px solid #c8c8c8;border-radius:4px;font-family:var(--font-mono);color:#333';
        filterRow.appendChild(filterInput);
        container.appendChild(filterRow);

        let filteredRuns = runs;

        // Build table
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'overflow-x:auto;border:0.5px solid #e0e0e0;border-radius:4px';

        const table = document.createElement('table');
        table.style.cssText = 'width:100%;border-collapse:collapse;font-size:11px;white-space:nowrap';

        // Header
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        const thStyle = 'text-align:left;padding:6px 8px;background:#bfdcff;font-weight:600;border:0.5px solid #e0e0e0;cursor:pointer;user-select:none';

        function _buildColumns() {
            return [
                { key: '_snapshot', label: '', sortable: false },
                { key: '_name', label: 'Run', sortable: false },
                { key: '_date', label: 'Date', sortable: true },
                ...metricKeys.filter(k => visibleMetrics.has(k)).map(k => ({ key: `m:${k}`, label: k, sortable: true, isMetric: true })),
                ...paramKeys.filter(k => visibleParams.has(k)).map(k => ({ key: `p:${k}`, label: k, sortable: false, isParam: true })),
            ];
        }
        let columns = _buildColumns();

        let currentSort = { col: null, desc: true };

        for (const col of columns) {
            const th = document.createElement('th');
            th.style.cssText = thStyle;
            if (col.isMetric) th.style.background = '#e8f5e9';
            if (col.isParam) th.style.background = '#f3e5f5';
            th.textContent = col.label;
            if (col.sortable) {
                th.style.cursor = 'pointer';
                th.addEventListener('click', () => {
                    const desc = currentSort.col === col.key ? !currentSort.desc : true;
                    currentSort = { col: col.key, desc };
                    const sorted = _sortLeaderboard(runs, col, desc);
                    _renderLeaderboardBody(tbody, sorted, columns, metricKeys, experimentId);
                    headerRow.querySelectorAll('th').forEach(h => {
                        h.textContent = h.textContent.replace(/ [▲▼]$/, '');
                    });
                    th.textContent = col.label + (desc ? ' ▼' : ' ▲');
                });
            }
            headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        _renderLeaderboardBody(tbody, filteredRuns, columns, metricKeys, experimentId);
        table.appendChild(tbody);

        wrapper.appendChild(table);
        container.appendChild(wrapper);

        // Rebuild table header + body when columns change
        function _rebuildTable() {
            columns = _buildColumns();
            headerRow.innerHTML = '';
            for (const col of columns) {
                const th = document.createElement('th');
                th.style.cssText = thStyle;
                if (col.isMetric) th.style.background = '#e8f5e9';
                if (col.isParam) th.style.background = '#f3e5f5';
                th.textContent = col.label;
                if (col.sortable) {
                    th.style.cursor = 'pointer';
                    th.addEventListener('click', () => {
                        const desc = currentSort.col === col.key ? !currentSort.desc : true;
                        currentSort = { col: col.key, desc };
                        const sorted = _sortLeaderboard(filteredRuns, col, desc);
                        _renderLeaderboardBody(tbody, sorted, columns, metricKeys, experimentId);
                    });
                }
                headerRow.appendChild(th);
            }
            _renderLeaderboardBody(tbody, filteredRuns, columns, metricKeys, experimentId);
        }

        // Column selector dropdown
        colBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const existing = colBtnWrap.querySelector('.col-dropdown');
            if (existing) { existing.remove(); return; }

            const dropdown = document.createElement('div');
            dropdown.className = 'col-dropdown';
            dropdown.style.cssText = 'position:absolute;top:100%;right:0;z-index:100;background:#fff;border:1px solid #ddd;border-radius:4px;padding:8px;max-height:250px;overflow-y:auto;min-width:180px;box-shadow:0 2px 8px rgba(0,0,0,0.15)';

            if (metricKeys.length) {
                const mTitle = document.createElement('div');
                mTitle.style.cssText = 'font-weight:600;font-size:10px;color:#2e7d32;margin-bottom:4px';
                mTitle.textContent = 'Metrics';
                dropdown.appendChild(mTitle);
                for (const k of metricKeys) {
                    const label = document.createElement('label');
                    label.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:11px;padding:2px 0;cursor:pointer';
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.checked = visibleMetrics.has(k);
                    cb.addEventListener('change', () => {
                        if (cb.checked) visibleMetrics.add(k); else visibleMetrics.delete(k);
                        _rebuildTable();
                    });
                    label.appendChild(cb);
                    label.appendChild(document.createTextNode(k));
                    dropdown.appendChild(label);
                }
            }

            if (paramKeys.length) {
                const pTitle = document.createElement('div');
                pTitle.style.cssText = 'font-weight:600;font-size:10px;color:#7b1fa2;margin:6px 0 4px';
                pTitle.textContent = 'Parameters';
                dropdown.appendChild(pTitle);
                for (const k of paramKeys) {
                    const label = document.createElement('label');
                    label.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:11px;padding:2px 0;cursor:pointer';
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.checked = visibleParams.has(k);
                    cb.addEventListener('change', () => {
                        if (cb.checked) visibleParams.add(k); else visibleParams.delete(k);
                        _rebuildTable();
                    });
                    label.appendChild(cb);
                    label.appendChild(document.createTextNode(k));
                    dropdown.appendChild(label);
                }
            }

            colBtnWrap.appendChild(dropdown);
            const close = (ev) => { if (!dropdown.contains(ev.target) && ev.target !== colBtn) { dropdown.remove(); document.removeEventListener('click', close); } };
            setTimeout(() => document.addEventListener('click', close), 0);
        });

        // Filter logic
        let filterTimeout;
        filterInput.addEventListener('input', () => {
            clearTimeout(filterTimeout);
            filterTimeout = setTimeout(() => {
                filteredRuns = _applyLeaderboardFilter(runs, filterInput.value);
                _renderLeaderboardBody(tbody, filteredRuns, columns, metricKeys, experimentId);
                titleEl.textContent = `Leaderboard (${filteredRuns.length}/${runs.length} runs)`;
            }, 300);
        });

        // CSV export
        exportBtn.addEventListener('click', () => {
            const headers = columns.filter(c => c.key !== '_snapshot').map(c => c.label);
            const csvRows = [headers.join(',')];
            for (const run of runs) {
                const row = [];
                for (const col of columns) {
                    if (col.key === '_snapshot') continue;
                    if (col.key === '_name') row.push(`"${run.run_name || run.run_id.substring(0, 8)}"`);
                    else if (col.key === '_date') row.push(run.start_time || '');
                    else if (col.isMetric) {
                        const v = run.metrics?.[col.label];
                        row.push(v != null ? v : '');
                    }
                    else if (col.isParam) row.push(`"${run.params?.[col.label] || ''}"`);
                }
                csvRows.push(row.join(','));
            }
            const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `leaderboard_${experimentId}.csv`;
            a.click();
            URL.revokeObjectURL(a.href);
            notify.success('Leaderboard exported as CSV');
        });
    }

    function _renderLeaderboardBody(tbody, runs, columns, metricKeys, experimentId) {
        tbody.innerHTML = '';

        const bestMetric = {};
        for (const mk of metricKeys) {
            const values = runs.map(r => r.metrics?.[mk]).filter(v => v != null);
            if (values.length) {
                const isHigherBetter = mk.includes('r2') || mk.includes('accuracy') || mk.includes('f1');
                bestMetric[mk] = isHigherBetter ? Math.max(...values) : Math.min(...values);
            }
        }

        for (let i = 0; i < runs.length; i++) {
            const run = runs[i];
            const tr = document.createElement('tr');
            tr.style.cssText = `cursor:pointer;background:${i % 2 ? '#f8f8f8' : ''}`;
            tr.addEventListener('mouseenter', () => { tr.style.background = '#eef5ff'; });
            tr.addEventListener('mouseleave', () => { tr.style.background = i % 2 ? '#f8f8f8' : ''; });
            tr.addEventListener('click', () => {
                const node = ctx.tree?.findKey(`mlrun:${experimentId}:${run.run_id}`);
                if (node) node.setActive(true);
            });

            for (const col of columns) {
                const td = document.createElement('td');
                td.style.cssText = 'padding:5px 8px;border:0.5px solid #f0f0f0';

                if (col.key === '_snapshot') {
                    if (run.is_snapshot) {
                        td.innerHTML = '<i class="fa-solid fa-star" style="font-size:10px;color:#f0c040" title="Snapshot"></i>';
                    }
                    td.style.width = '20px';
                    td.style.textAlign = 'center';
                } else if (col.key === '_name') {
                    const name = run.run_name || run.run_id.substring(0, 8);
                    td.innerHTML = `<span style="font-weight:500;color:#333">${escapeHtml(name)}</span>`
                        + `<span style="font-family:var(--font-mono);font-size:9px;color:#aaa;margin-left:4px">${run.run_id.substring(0, 6)}</span>`;
                } else if (col.key === '_date') {
                    if (run.start_time) {
                        const d = new Date(run.start_time);
                        td.textContent = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
                    }
                    td.style.cssText += ';font-size:10px;color:#888';
                } else if (col.isMetric) {
                    const v = run.metrics?.[col.label];
                    if (v != null) {
                        const display = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(6)) : String(v);
                        const isBest = bestMetric[col.label] != null && v === bestMetric[col.label];
                        td.innerHTML = `<span style="font-family:var(--font-mono);${isBest ? 'font-weight:700;color:#2e7d32' : 'color:#333'}">${display}</span>`;
                    } else {
                        td.innerHTML = '<span style="color:#ccc">-</span>';
                    }
                } else if (col.isParam) {
                    td.textContent = run.params?.[col.label] || '-';
                    td.style.cssText += ';font-family:var(--font-mono);font-size:10px;color:#555';
                }

                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
    }

    function _sortLeaderboard(runs, col, desc) {
        const sorted = [...runs];
        sorted.sort((a, b) => {
            let va, vb;
            if (col.key === '_date') {
                va = a.start_time || '';
                vb = b.start_time || '';
            } else if (col.isMetric) {
                va = a.metrics?.[col.label] ?? (desc ? -Infinity : Infinity);
                vb = b.metrics?.[col.label] ?? (desc ? -Infinity : Infinity);
            } else {
                return 0;
            }
            if (va < vb) return desc ? 1 : -1;
            if (va > vb) return desc ? -1 : 1;
            return 0;
        });
        return sorted;
    }

    function _applyLeaderboardFilter(runs, filterText) {
        const text = (filterText || '').trim();
        if (!text) return runs;

        // Parse filter expressions: key=value, key>value, key>=value, key<value, key<=value
        const filters = text.split(',').map(s => s.trim()).filter(Boolean).map(expr => {
            const m = expr.match(/^(\w[\w.]*)\s*(>=|<=|!=|>|<|=)\s*(.+)$/);
            if (!m) return null;
            return { key: m[1], op: m[2], value: m[3].trim() };
        }).filter(Boolean);

        if (!filters.length) return runs;

        return runs.filter(run => {
            return filters.every(f => {
                // Look in params first, then metrics
                let val = run.params?.[f.key] ?? run.metrics?.[f.key];
                if (val == null) return false;

                const numVal = Number(val);
                const numFilter = Number(f.value);
                const isNumeric = !isNaN(numVal) && !isNaN(numFilter);

                switch (f.op) {
                    case '=':  return isNumeric ? numVal === numFilter : String(val).toLowerCase() === f.value.toLowerCase();
                    case '!=': return isNumeric ? numVal !== numFilter : String(val).toLowerCase() !== f.value.toLowerCase();
                    case '>':  return isNumeric && numVal > numFilter;
                    case '>=': return isNumeric && numVal >= numFilter;
                    case '<':  return isNumeric && numVal < numFilter;
                    case '<=': return isNumeric && numVal <= numFilter;
                    default: return false;
                }
            });
        });
    }

    // ── Snapshot Actions ─────────────────────────────────────────

    async function showSnapshotModal(run) {
        const jp = window.jsPanel;
        if (!jp) return;

        const projectId = await _resolveProjectFromExperiment(run.experiment_id);

        const panel = jp.create({
            headerTitle: '<i class="fa-solid fa-camera" style="font-size:11px;margin-right:6px"></i>Create Snapshot',
            theme: '#ffe39e filled',
            borderRadius: '5px',
            contentSize: { width: Math.min(480, window.innerWidth - 80), height: 'auto' },
            position: 'center',
            headerControls: 'closeonly',
            content: '<div class="snapshot-modal-content"></div>',
            callback: (p) => { p.content.style.backgroundColor = '#fefefe'; },
        });

        const container = panel.content.querySelector('.snapshot-modal-content');
        container.style.cssText = 'padding:16px;font-size:12px';

        // Info about what will be captured
        const info = document.createElement('div');
        info.style.cssText = 'margin-bottom:12px;color:#555;line-height:1.6';
        info.innerHTML = 'A snapshot captures the complete reproducible state:'
            + '<ul style="margin:6px 0 0 16px;padding:0">'
            + '<li>Git commit (code, notebooks, DAGs, configs)</li>'
            + '<li>DVC data file hashes</li>'
            + '<li>Hydra resolved configuration</li>'
            + '<li>MLflow run metrics, parameters, and artifacts</li>'
            + '<li>Python environment (pip freeze)</li>'
            + '</ul>';
        container.appendChild(info);

        // Run summary
        const summaryCard = document.createElement('div');
        summaryCard.className = 's3-object-card';
        summaryCard.style.marginBottom = '12px';
        addMetaRow(summaryCard, 'Run', `${run.run_name || run.run_id.substring(0, 8)}`);
        const topMetrics = Object.entries(run.metrics || {}).slice(0, 4);
        if (topMetrics.length) {
            addMetaRow(summaryCard, 'Metrics', topMetrics.map(([k, v]) =>
                `<span style="font-family:var(--font-mono);font-size:11px">${escapeHtml(k)}: ${typeof v === 'number' ? v.toFixed(4) : v}</span>`
            ).join(' | '));
        }
        container.appendChild(summaryCard);

        // Git state section
        const gitSection = document.createElement('div');
        gitSection.style.cssText = 'margin-bottom:12px';
        gitSection.innerHTML = '<div style="color:#888;font-size:11px">Checking git state...</div>';
        container.appendChild(gitSection);

        // Auto-commit checkbox (hidden until needed)
        const autoCommitRow = document.createElement('div');
        autoCommitRow.style.cssText = 'display:none;margin-bottom:12px;padding:8px 10px;background:#fff3cd;border:0.5px solid #ffe082;border-radius:4px';
        const autoCommitLabel = document.createElement('label');
        autoCommitLabel.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:#333';
        const autoCommitCb = document.createElement('input');
        autoCommitCb.type = 'checkbox';
        autoCommitCb.style.cssText = 'width:14px;height:14px;cursor:pointer';
        autoCommitLabel.appendChild(autoCommitCb);
        autoCommitLabel.appendChild(document.createTextNode('Auto-commit modified files before snapshot'));
        autoCommitRow.appendChild(autoCommitLabel);
        const autoCommitNote = document.createElement('div');
        autoCommitNote.style.cssText = 'font-size:10px;color:#856404;margin-top:4px;margin-left:22px';
        autoCommitNote.textContent = 'We recommend committing your changes explicitly via Version Control for a clean commit message.';
        autoCommitRow.appendChild(autoCommitNote);
        container.appendChild(autoCommitRow);

        // Name input
        const nameLabel = document.createElement('div');
        nameLabel.style.cssText = 'font-weight:500;color:#333;margin-bottom:4px';
        nameLabel.textContent = 'Snapshot name';
        container.appendChild(nameLabel);

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.style.cssText = 'width:100%;padding:6px 8px;font-size:12px;border:0.5px solid #c8c8c8;border-radius:4px;font-family:var(--font-mono);color:#333;box-sizing:border-box;margin-bottom:8px';
        nameInput.placeholder = 'e.g. gru_128_best_val_loss';
        nameInput.value = (run.run_name || '').replace(/\s+/g, '_').toLowerCase();
        container.appendChild(nameInput);

        // Description input
        const descLabel = document.createElement('div');
        descLabel.style.cssText = 'font-weight:500;color:#333;margin-bottom:4px';
        descLabel.textContent = 'Description (optional)';
        container.appendChild(descLabel);

        const descInput = document.createElement('textarea');
        descInput.style.cssText = 'width:100%;height:50px;padding:6px 8px;font-size:12px;border:0.5px solid #c8c8c8;border-radius:4px;color:#333;resize:vertical;box-sizing:border-box;margin-bottom:12px';
        descInput.placeholder = 'Why this run is the best...';
        container.appendChild(descInput);

        // Buttons
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'rm-btn';
        cancelBtn.style.background = '#f0f0f0';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => panel.close());
        btnRow.appendChild(cancelBtn);

        const createBtn = document.createElement('button');
        createBtn.className = 'rm-btn';
        createBtn.style.background = '#fff3cd';
        createBtn.innerHTML = '<i class="fa-solid fa-camera" style="font-size:10px;margin-right:4px"></i>Create Snapshot';
        btnRow.appendChild(createBtn);
        container.appendChild(btnRow);

        // Result area
        const resultArea = document.createElement('div');
        resultArea.style.cssText = 'margin-top:12px';
        container.appendChild(resultArea);

        // Fetch git state
        let gitState = { clean: true, modified: [], untracked: [] };
        try {
            const resp = await fetch(`api/snapshots/git-state/${encodeURIComponent(projectId)}`);
            if (resp.ok) gitState = await resp.json();
        } catch {}

        // Render git state
        gitSection.innerHTML = '';
        if (gitState.clean && !gitState.untracked?.length) {
            gitSection.innerHTML = '<div style="color:#4caf50;font-size:11px"><i class="fa-solid fa-circle-check" style="margin-right:4px"></i>Git is clean - ready for snapshot</div>';
        } else {
            if (gitState.modified?.length) {
                const modDiv = document.createElement('div');
                modDiv.style.cssText = 'margin-bottom:6px';
                modDiv.innerHTML = `<div style="color:#e65100;font-weight:500;font-size:11px;margin-bottom:4px"><i class="fa-solid fa-triangle-exclamation" style="margin-right:4px"></i>${gitState.modified.length} modified file(s) - must commit before snapshot</div>`;
                const fileList = document.createElement('div');
                fileList.style.cssText = 'font-size:10px;color:#666;font-family:var(--font-mono);padding-left:16px;max-height:80px;overflow-y:auto';
                fileList.innerHTML = gitState.modified.map(f => `<div>M  ${escapeHtml(f)}</div>`).join('');
                modDiv.appendChild(fileList);
                gitSection.appendChild(modDiv);

                autoCommitRow.style.display = '';
                createBtn.disabled = true;
                createBtn.style.opacity = '0.5';

                autoCommitCb.addEventListener('change', () => {
                    createBtn.disabled = !autoCommitCb.checked;
                    createBtn.style.opacity = autoCommitCb.checked ? '1' : '0.5';
                });
            }

            if (gitState.untracked?.length) {
                const untDiv = document.createElement('div');
                untDiv.innerHTML = `<div style="color:#888;font-size:11px;margin-bottom:4px"><i class="fa-solid fa-circle-info" style="margin-right:4px"></i>${gitState.untracked.length} untracked file(s) - will NOT be included in the snapshot</div>`;
                const fileList = document.createElement('div');
                fileList.style.cssText = 'font-size:10px;color:#999;font-family:var(--font-mono);padding-left:16px;max-height:60px;overflow-y:auto';
                fileList.innerHTML = gitState.untracked.map(f => `<div>?  ${escapeHtml(f)}</div>`).join('');
                untDiv.appendChild(fileList);
                gitSection.appendChild(untDiv);
            }
        }

        // Create snapshot handler
        createBtn.addEventListener('click', async () => {
            const snapName = nameInput.value.trim();
            if (!snapName) { nameInput.focus(); return; }

            createBtn.disabled = true;
            createBtn.textContent = 'Creating snapshot...';
            resultArea.innerHTML = '';

            try {
                const resp = await fetch('api/snapshots/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        project_id: projectId,
                        experiment_id: run.experiment_id,
                        run_id: run.run_id,
                        name: snapName,
                        description: descInput.value.trim(),
                        auto_commit: autoCommitCb.checked,
                    }),
                });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(err.detail || `HTTP ${resp.status}`);
                }
                const result = await resp.json();

                resultArea.innerHTML = `<div style="color:#4caf50;font-weight:600;margin-bottom:6px">Snapshot created</div>`
                    + `<div style="font-size:11px;color:#666">Branch: <span class="mono">${escapeHtml(result.snapshot_branch || '')}</span></div>`
                    + `<div style="font-size:11px;color:#666">Version: ${result.version || ''}</div>`
                    + `<div style="font-size:11px;color:#666">Commit: <span class="mono">${escapeHtml((result.git_commit || '').substring(0, 7))}</span></div>`;

                notify.success(`Snapshot created: ${snapName}`);

                const expNode = ctx.tree?.findKey(`experiment:${run.experiment_id}`);
                if (expNode) { expNode.resetLazy(); expNode.setExpanded(true); }

            } catch (err) {
                resultArea.innerHTML = `<div style="color:#c00;font-size:12px">${escapeHtml(err.message)}</div>`;
            }
            createBtn.disabled = false;
            createBtn.innerHTML = '<i class="fa-solid fa-camera" style="font-size:10px;margin-right:4px"></i>Create Snapshot';
        });

        nameInput.focus();
    }

    async function restoreSnapshot(run) {
        const branch = run.tags?.['noted.snapshot_branch'] || '';
        const name = run.tags?.['noted.snapshot_name'] || '';
        const msg = `Restore snapshot "${name}"?\n\nThis will switch the workspace to branch "${branch}". Uncommitted changes will be stashed.`;
        if (!confirm(msg)) return;

        const projectId = await _resolveProjectFromExperiment(run.experiment_id);
        try {
            const resp = await fetch('api/snapshots/restore', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    project_id: projectId,
                    experiment_id: run.experiment_id,
                }),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${resp.status}`);
            }
            const result = await resp.json();
            notify.success(`Restored snapshot: ${name} (branch: ${result.branch})`);
        } catch (err) {
            notify.error(err.message);
        }
    }

    async function forkFromSnapshot(run) {
        const name = run.tags?.['noted.snapshot_name'] || '';
        const newName = prompt(`New experiment name (forking from "${name}"):`);
        if (!newName) return;

        const projectId = await _resolveProjectFromExperiment(run.experiment_id);
        try {
            const resp = await fetch('api/snapshots/fork', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    project_id: projectId,
                    source_experiment_id: run.experiment_id,
                    new_experiment_name: newName,
                }),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${resp.status}`);
            }
            const result = await resp.json();
            notify.success(`Forked: ${newName} (branch: ${result.branch})`);

            const rootNode = ctx.tree?.findKey('root-experiments');
            if (rootNode) { rootNode.resetLazy(); rootNode.setExpanded(true); }
        } catch (err) {
            notify.error(err.message);
        }
    }

    async function _resolveProjectFromExperiment(experimentId) {
        try {
            const resp = await fetch('api/mlflow/experiments');
            if (!resp.ok) return 'Examples';
            const data = await resp.json();
            const experiments = data.experiments || [];
            const exp = experiments.find(e => e.experiment_id === experimentId);
            if (!exp) return 'Examples';
            return exp.name;
        } catch {
            return 'Examples';
        }
    }

    return {
        renderLeaderboard,
        showSnapshotModal,
        restoreSnapshot,
        forkFromSnapshot,
    };
}
