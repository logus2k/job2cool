/**
 * ExplorerMlflowViews - Experiments (MLflow), Artifacts, Run Comparison,
 * and triggerMetricsView detail views and tree data loaders.
 */

import { modalError } from '../../modal.js';
import { notify } from '../../Notify.js';
import {
    createDetailHeader, addParentLabel, addMetaRow, escapeHtml, formatSize,
} from './ExplorerHelpers.js';
import { createSnapshotViews } from './ExplorerSnapshotViews.js';

/**
 * @param {object} ctx - Shared explorer context (getters for live state).
 * @returns {object} View methods for experiments, artifacts, metrics, and run comparison.
 */
export function createMlflowViews(ctx) {

    const _snap = createSnapshotViews(ctx);

    // ── Experiments (MLflow) ────────────────────────────────────────

    async function loadExperiments() {
        try {
            const resp = await fetch('api/mlflow/experiments');
            if (!resp.ok) return [];
            const data = await resp.json();
            return (data.experiments || []).map(exp => ({
                title: exp.name,
                key: `experiment:${exp.experiment_id}`,
                icon: 'fa-solid fa-vial',
                folder: true,
                lazy: true,
            }));
        } catch { return []; }
    }

    async function loadExperimentRuns(nodeKey) {
        const experimentId = nodeKey.substring(11);
        try {
            const resp = await fetch(`api/mlflow/experiments/${encodeURIComponent(experimentId)}/runs`);
            if (!resp.ok) return [];
            const data = await resp.json();
            return (data.runs || []).map(run => {
                const icon = run.status === 'FINISHED' ? 'fa-solid fa-circle-check'
                           : run.status === 'RUNNING'  ? 'fa-solid fa-circle-play'
                           : run.status === 'FAILED'   ? 'fa-solid fa-circle-xmark'
                           : run.status === 'KILLED'   ? 'fa-solid fa-circle-stop'
                           : 'fa-solid fa-circle-question';
                const name = run.run_name || run.run_id.substring(0, 8);
                let datePrefix = '';
                if (run.start_time) {
                    const d = new Date(run.start_time);
                    const pad = (n) => String(n).padStart(2, '0');
                    datePrefix = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} - `;
                }
                return {
                    title: `${datePrefix}${name}`,
                    key: `mlrun:${experimentId}:${run.run_id}`,
                    icon,
                    folder: true,
                    lazy: true,
                };
            });
        } catch { return []; }
    }

    function showExperimentsRootDetail() {
        ctx.detailEl.innerHTML = '';
        
        const header = createDetailHeader('Experiments', 'fa-solid fa-vial');
        ctx.detailEl.appendChild(header);

        const loading = document.createElement('div');
        loading.className = 's3-object-loading';
        loading.textContent = 'Loading experiments...';
        ctx.detailEl.appendChild(loading);

        fetch('api/mlflow/experiments').then(r => r.json()).then(data => {
            const exps = data.experiments || [];
            loading.remove();

            if (exps.length === 0) {
                const empty = document.createElement('div');
                empty.style.cssText = 'color:#999;font-size:12px;padding:8px';
                empty.textContent = 'No experiments found';
                ctx.detailEl.appendChild(empty);
                return;
            }

            // Summary card
            const card = document.createElement('div');
            card.className = 's3-object-card';
            addMetaRow(card, 'Total', `${exps.length} experiment${exps.length !== 1 ? 's' : ''}`);
            ctx.detailEl.appendChild(card);

            // Experiments list
            const titleEl = document.createElement('div');
            titleEl.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin:16px 0 8px;padding:0 8px';
            titleEl.textContent = 'All Experiments';
            ctx.detailEl.appendChild(titleEl);

            const list = document.createElement('div');
            list.className = 's3-object-card';

            for (const exp of exps) {
                const row = document.createElement('div');
                row.className = 's3-meta-row';
                row.style.cssText = 'cursor:pointer;align-items:center;gap:8px;padding:7px 12px';
                row.innerHTML = `<i class="fa-solid fa-vial" style="font-size:12px;color:#e08b8b;flex-shrink:0"></i>`
                    + `<span style="font-weight:500;color:#333">${escapeHtml(exp.name)}</span>`
                    + `<span style="flex:1"></span>`
                    + `<span style="font-family:var(--font-mono);font-size:10px;color:#999">ID: ${exp.experiment_id}</span>`;
                row.addEventListener('click', () => {
                    const node = ctx.tree?.findKey(`experiment:${exp.experiment_id}`);
                    if (node) { node.setExpanded(true); node.setActive(true); }
                });
                row.addEventListener('mouseenter', () => { row.style.background = '#f5f5f5'; });
                row.addEventListener('mouseleave', () => { row.style.background = ''; });
                list.appendChild(row);
            }
            ctx.detailEl.appendChild(list);
        }).catch(() => {
            loading.textContent = 'Failed to load experiments';
        });
    }

    function renderExperimentDetailInto(targetEl, experimentId, expName) {
        targetEl.innerHTML = '';
        addParentLabel(targetEl, 'Experiments');
        const header = createDetailHeader(expName || experimentId, 'fa-solid fa-vial');
        header.insertAdjacentHTML('beforeend', ' <span style="background:#e3f2fd;color:#1565c0;padding:2px 8px;border-radius:3px;font-size:9px;font-weight:600;letter-spacing:0.5px;vertical-align:middle">LEADERBOARD</span>');
        targetEl.appendChild(header);

        const card = document.createElement('div');
        card.className = 's3-object-card';
        card.innerHTML = '<div class="s3-object-loading">Loading runs...</div>';
        targetEl.appendChild(card);

        const runsSection = document.createElement('div');
        runsSection.style.cssText = 'margin-top:16px;padding:0 8px';
        targetEl.appendChild(runsSection);

        fetch(`api/mlflow/experiments/${encodeURIComponent(experimentId)}/leaderboard`).then(r => r.json()).then(data => {
            const runs = data.runs || [];
            const metricKeys = data.metric_keys || [];
            const paramKeys = data.param_keys || [];
            card.innerHTML = '';

            addMetaRow(card, 'Experiment ID', `<span class="mono">${experimentId}</span>`);
            addMetaRow(card, 'Runs', `${runs.length}`);
            const snapshotCount = runs.filter(r => r.is_snapshot).length;
            if (snapshotCount) addMetaRow(card, 'Snapshots', `${snapshotCount}`);

            if (runs.length > 0) {
                _snap.renderLeaderboard(runsSection, runs, metricKeys, paramKeys, experimentId);

                // Bulk actions
                const bulkRow = document.createElement('div');
                bulkRow.style.cssText = 'display:flex;gap:8px;margin:12px 0;padding:0 8px;align-items:center';
                const bulkSelect = document.createElement('select');
                bulkSelect.multiple = true;
                bulkSelect.style.cssText = 'flex:1;font-size:11px;font-family:var(--font-mono);border:0.5px solid #c8c8c8;border-radius:4px;padding:4px;max-height:80px';
                for (const run of runs) {
                    const opt = document.createElement('option');
                    opt.value = run.run_id;
                    opt.textContent = `${run.run_name || run.run_id.substring(0, 8)} - ${run.status}`;
                    bulkSelect.appendChild(opt);
                }
                bulkRow.appendChild(bulkSelect);
                const bulkDeleteBtn = document.createElement('button');
                bulkDeleteBtn.className = 'rm-btn';
                bulkDeleteBtn.style.cssText = 'padding:4px 10px;font-size:11px;background:#ffcdd2;white-space:nowrap';
                bulkDeleteBtn.innerHTML = '<i class="fa-solid fa-trash" style="font-size:9px;margin-right:3px"></i>Delete Selected';
                bulkDeleteBtn.addEventListener('click', async () => {
                    const selected = [...bulkSelect.selectedOptions].map(o => o.value);
                    if (!selected.length) { notify('Select runs to delete', 'warning'); return; }
                    if (!confirm(`Delete ${selected.length} run(s)? This action cannot be undone.`)) return;
                    bulkDeleteBtn.disabled = true;
                    let deleted = 0;
                    for (const runId of selected) {
                        try {
                            const resp = await fetch(`api/mlflow/runs/${runId}`, { method: 'DELETE' });
                            if (resp.ok) deleted++;
                        } catch {}
                    }
                    notify(`Deleted ${deleted}/${selected.length} runs`, deleted ? 'success' : 'danger');
                    bulkDeleteBtn.disabled = false;
                    renderExperimentDetailInto(targetEl, experimentId, expName);
                });
                bulkRow.appendChild(bulkDeleteBtn);
                runsSection.appendChild(bulkRow);

                // Report export buttons
                const reportRow = document.createElement('div');
                reportRow.style.cssText = 'display:flex;gap:8px;margin:12px 0;padding:0 8px';

                const wordBtn = document.createElement('button');
                wordBtn.className = 'rm-btn';
                wordBtn.style.cssText = 'display:flex;align-items:center;gap:6px;background:#d0e8ff';
                wordBtn.innerHTML = '<i class="fa-solid fa-file-word" style="font-size:10px"></i> Export Word';
                wordBtn.addEventListener('click', () => _downloadReport(experimentId, 'word'));
                reportRow.appendChild(wordBtn);

                const mdBtn = document.createElement('button');
                mdBtn.className = 'rm-btn';
                mdBtn.style.cssText = 'display:flex;align-items:center;gap:6px;background:#f0f0f0';
                mdBtn.innerHTML = '<i class="fa-solid fa-file-lines" style="font-size:10px"></i> Export Markdown';
                mdBtn.addEventListener('click', () => _downloadReport(experimentId, 'markdown'));
                reportRow.appendChild(mdBtn);

                runsSection.appendChild(reportRow);
            }

        }).catch(() => {
            card.innerHTML = '<div class="s3-object-loading">Failed to load runs</div>';
        });
    }

    function showExperimentDetail(experimentId) {
        const node = ctx.tree?.findKey(`experiment:${experimentId}`);
        const expName = node?.title || experimentId;
        renderExperimentDetailInto(ctx.detailEl, experimentId, expName);
    }

    function showMlrunDetail(nodeKey) {
        const rest = nodeKey.substring(6);
        const idx = rest.indexOf(':');
        const runId = rest.substring(idx + 1);
        const runNode = ctx.tree?.findKey(nodeKey);
        const runName = runNode?.title || runId.substring(0, 8);
        renderRunDetailInto(ctx.detailEl, rest.substring(0, idx), runId, runName, runNode);
    }

    /** Render a section of key-value pairs as a responsive grid */
    function _renderKvGrid(parent, title, entries, isMono = true) {
        if (!entries.length) return;
        const section = document.createElement('div');
        section.style.cssText = 'margin-top:12px';

        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin-bottom:6px;padding:0 4px';
        titleEl.textContent = title;
        section.appendChild(titleEl);

        const cols = entries.length >= 4 ? 2 : 1;
        const grid = document.createElement('div');
        grid.style.cssText = `display:grid;grid-template-columns:repeat(${cols},1fr);gap:1px;background:#e8e8e8;border:0.5px solid #e0e0e0;border-radius:4px;overflow:hidden`;

        for (const [key, val] of entries) {
            const cell = document.createElement('div');
            cell.style.cssText = 'display:flex;align-items:baseline;padding:5px 10px;background:#fefefe;font-size:12px;gap:8px';
            const lbl = document.createElement('span');
            lbl.style.cssText = 'font-weight:600;color:#555;font-size:11px;text-transform:uppercase;letter-spacing:0.2px;min-width:80px;flex-shrink:0';
            lbl.textContent = key;
            const valEl = document.createElement('span');
            valEl.style.cssText = isMono ? 'font-family:var(--font-mono);color:#333;font-size:12px' : 'color:#333;font-size:12px';
            valEl.innerHTML = val;
            cell.appendChild(lbl);
            cell.appendChild(valEl);
            grid.appendChild(cell);
        }
        // Fill last cell if odd number and 2 columns
        if (cols === 2 && entries.length % 2 !== 0) {
            const filler = document.createElement('div');
            filler.style.cssText = 'background:#fefefe';
            grid.appendChild(filler);
        }
        section.appendChild(grid);
        parent.appendChild(section);
    }

    // Expose _renderKvGrid on ctx so sibling modules (Hydra) can use it
    ctx._renderKvGrid = _renderKvGrid;

    function _renderRunContent(targetEl, run, chartContainer) {
        const statusColor = run.status === 'FINISHED' ? '#4caf50'
                          : run.status === 'RUNNING'  ? '#2196f3'
                          : run.status === 'FAILED'   ? '#f44336'
                          : run.status === 'KILLED'   ? '#ff9800'
                          : '#999';

        const isSnapshot = run.tags?.['noted.snapshot'] === 'true';

        // Run info card
        const card = document.createElement('div');
        card.className = 's3-object-card';
        addMetaRow(card, 'Status', `<span style="color:${statusColor};font-weight:600">${run.status}</span>`
            + (isSnapshot ? ' <span style="background:#fff3cd;color:#856404;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px;font-weight:600">SNAPSHOT</span>' : ''));
        addMetaRow(card, 'Run ID', `<span class="mono">${run.run_id}</span>`);
        if (run.start_time) addMetaRow(card, 'Started', new Date(run.start_time).toLocaleString());
        if (run.end_time) addMetaRow(card, 'Ended', new Date(run.end_time).toLocaleString());
        if (run.duration_ms != null) {
            addMetaRow(card, 'Duration', `${(run.duration_ms / 1000).toFixed(1)}s`);
        }
        if (isSnapshot) {
            const branch = run.tags['noted.snapshot_branch'] || '';
            const snapshotName = run.tags['noted.snapshot_name'] || '';
            if (snapshotName) addMetaRow(card, 'Snapshot', escapeHtml(snapshotName));
            if (branch) addMetaRow(card, 'Branch', `<span class="mono" style="font-size:11px">${escapeHtml(branch)}</span>`);
        }
        targetEl.appendChild(card);

        // Snapshot actions
        if (run.status === 'FINISHED') {
            const snapSection = document.createElement('div');
            snapSection.style.cssText = 'margin:8px 0 12px;padding:0 8px;display:flex;gap:8px;flex-wrap:wrap';

            // Register Model button (always shown for finished runs)
            const regBtn = document.createElement('button');
            regBtn.className = 'rm-btn';
            regBtn.style.cssText = 'display:flex;align-items:center;gap:6px;background:#e8d5f5';
            regBtn.innerHTML = '<i class="fa-solid fa-brain" style="font-size:10px"></i> Register Model';
            regBtn.addEventListener('click', () => {
                if (ctx.views?.external?.showRegisterPanel) {
                    ctx.views.external.showRegisterPanel(run.run_id, 'model');
                }
            });
            snapSection.appendChild(regBtn);

            if (!isSnapshot) {
                const snapBtn = document.createElement('button');
                snapBtn.className = 'rm-btn';
                snapBtn.style.cssText = 'display:flex;align-items:center;gap:6px;background:#fff3cd';
                snapBtn.innerHTML = '<i class="fa-solid fa-camera" style="font-size:10px"></i> Create Snapshot';
                snapBtn.addEventListener('click', () => _snap.showSnapshotModal(run));
                snapSection.appendChild(snapBtn);
            } else {
                const restoreBtn = document.createElement('button');
                restoreBtn.className = 'rm-btn';
                restoreBtn.style.cssText = 'display:flex;align-items:center;gap:6px;background:#c8e6c0';
                restoreBtn.innerHTML = '<i class="fa-solid fa-rotate-left" style="font-size:10px"></i> Restore Snapshot';
                restoreBtn.addEventListener('click', () => _snap.restoreSnapshot(run));
                snapSection.appendChild(restoreBtn);

                const forkBtn = document.createElement('button');
                forkBtn.className = 'rm-btn';
                forkBtn.style.cssText = 'display:flex;align-items:center;gap:6px;background:#d0e8ff';
                forkBtn.innerHTML = '<i class="fa-solid fa-code-branch" style="font-size:10px"></i> New Experiment from Snapshot';
                forkBtn.addEventListener('click', () => _snap.forkFromSnapshot(run));
                snapSection.appendChild(forkBtn);
            }
            targetEl.appendChild(snapSection);
        }

        // Metrics grid
        const metricKeys = Object.keys(run.metrics || {});
        if (metricKeys.length > 0) {
            const entries = metricKeys.sort().map(k => {
                const v = run.metrics[k];
                const display = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(6)) : String(v);
                return [k, display];
            });
            _renderKvGrid(targetEl, 'Metrics', entries);
        }

        // Parameters grid
        const paramKeys = Object.keys(run.params || {});
        if (paramKeys.length > 0) {
            const entries = paramKeys.sort().map(k => [k, escapeHtml(String(run.params[k]))]);
            _renderKvGrid(targetEl, 'Parameters', entries);
        }

        // Tags grid
        const tagKeys = Object.keys(run.tags || {});
        if (tagKeys.length > 0) {
            const entries = tagKeys.sort().map(k => [k, escapeHtml(run.tags[k])]);
            _renderKvGrid(targetEl, 'Tags', entries, false);
        }

        // Ask Assistant button
        const askSection = document.createElement('div');
        askSection.style.cssText = 'margin:10px 0;display:flex;gap:6px';
        const askRunBtn = document.createElement('button');
        askRunBtn.className = 'rm-btn';
        askRunBtn.style.cssText = 'display:flex;align-items:center;gap:6px;background:#c8e6c0';
        askRunBtn.innerHTML = '<i class="fa-solid fa-comment" style="font-size:10px"></i> Ask Assistant';
        askRunBtn.addEventListener('click', () => {
            document.dispatchEvent(new CustomEvent('ask-assistant', {
                detail: { message: `Analyze MLflow run (run_id: ${run.run_id}, name: "${run.run_name || 'unnamed'}"). What can you tell me about its metrics and parameters?` }
            }));
        });
        askSection.appendChild(askRunBtn);
        targetEl.appendChild(askSection);

        // Inline charts
        if (metricKeys.length > 0 && chartContainer) {
            _renderInlineCharts(chartContainer, run.run_id, metricKeys);
        }
    }

    function renderRunDetailInto(targetEl, experimentId, runId, runName, node) {
        targetEl.innerHTML = '';

        addParentLabel(targetEl, 'Experiments');
        const statusIcon = node?.icon || 'fa-solid fa-circle-check';
        const header = createDetailHeader(runName, statusIcon);
        targetEl.appendChild(header);

        const chartContainer = document.createElement('div');
        chartContainer.style.cssText = 'padding:0 8px 8px;flex-shrink:0';
        targetEl.appendChild(chartContainer);

        const loading = document.createElement('div');
        loading.className = 's3-object-loading';
        loading.textContent = 'Loading run details...';
        targetEl.appendChild(loading);

        fetch(`api/mlflow/runs/${encodeURIComponent(runId)}`).then(r => r.json()).then(run => {
            loading.remove();
            _renderRunContent(targetEl, run, chartContainer);
        }).catch(() => {
            loading.textContent = 'Failed to load run details';
        });
    }

    async function _loadAndShowMetrics(run, metricKeys) {
        try {
            const metricsMap = {};
            await Promise.all(metricKeys.map(async (key) => {
                const resp = await fetch(`api/mlflow/runs/${encodeURIComponent(run.run_id)}/metrics/${encodeURIComponent(key)}`);
                if (resp.ok) {
                    const data = await resp.json();
                    metricsMap[key] = (data.history || []).map(p => ({ step: p.step, value: p.value }));
                }
            }));
            const cb = ctx.callbacks.onMetricsView;
            if (cb) cb(run.run_id, run.run_name || run.run_id.substring(0, 8), metricsMap);
        } catch (e) {
            console.error('Failed to load metric history:', e);
        }
    }

    async function _renderInlineCharts(container, runId, metricKeys) {
        // Reserve space immediately with empty grid to prevent layout shift
        const allKeys = metricKeys.filter(k => k).sort();
        if (!allKeys.length) return;
        const cols = allKeys.length === 1 ? 1 : 2;
        const rows = Math.ceil(allKeys.length / cols);
        container.style.minHeight = `${rows * 204}px`;

        try {
            const metricsMap = {};
            await Promise.all(allKeys.map(async (key) => {
                const resp = await fetch(`api/mlflow/runs/${encodeURIComponent(runId)}/metrics/${encodeURIComponent(key)}`);
                if (resp.ok) {
                    const data = await resp.json();
                    metricsMap[key] = (data.history || []).map(p => ({ step: p.step, value: p.value }));
                }
            }));

            // Only chart metrics with 2+ points
            const tsKeys = Object.keys(metricsMap).filter(k => metricsMap[k].length >= 2).sort();
            if (!tsKeys.length) {
                container.style.minHeight = '';
                return;
            }

            const cols = tsKeys.length === 1 ? 1 : 2;
            const rows = Math.ceil(tsKeys.length / cols);
            const grid = document.createElement('div');
            grid.style.cssText = `display:grid;grid-template-columns:repeat(${cols},1fr);gap:4px;grid-template-rows:repeat(${rows},200px)`;

            const chartEls = [];
            for (const key of tsKeys) {
                const chartEl = document.createElement('div');
                chartEl.style.cssText = 'min-height:0;overflow:hidden';
                grid.appendChild(chartEl);
                chartEls.push({ el: chartEl, key });
            }
            container.appendChild(grid);

            requestAnimationFrame(() => {
                for (const { el, key } of chartEls) {
                    const history = metricsMap[key];
                    const chart = echarts.init(el);
                    chart.setOption({
                        animation: false,
                        grid: { left: 46, right: 47, top: 38, bottom: 43, containLabel: false },
                        title: { text: key, left: 'center', top: 2, textStyle: { fontSize: 11, color: '#333', fontWeight: 500 } },
                        tooltip: {
                            trigger: 'axis',
                            textStyle: { fontSize: 11 },
                            axisPointer: { lineStyle: { color: '#a0d8a0', type: 'dashed', width: 2 } },
                            formatter: (params) => {
                                const p = params[0];
                                return `Step ${p.data[0]}<br/>${p.marker} ${p.seriesName}: <b>${p.data[1].toFixed(6)}</b>`;
                            }
                        },
                        xAxis: { type: 'value', name: 'Step', nameTextStyle: { fontSize: 9 }, axisLabel: { fontSize: 9 },
                                 splitLine: { lineStyle: { color: 'rgba(128,128,128,0.2)' } } },
                        yAxis: { type: 'value', axisLabel: { fontSize: 9 },
                                 splitLine: { lineStyle: { color: 'rgba(128,128,128,0.2)' } } },
                        series: [{
                            type: 'line', name: key, data: history.map(p => [p.step, p.value]),
                            symbol: 'circle', symbolSize: 4, lineStyle: { width: 2 },
                            itemStyle: { borderWidth: 0 },
                            emphasis: { itemStyle: { color: '#f4a0a0', borderColor: '#e06060', borderWidth: 2, shadowBlur: 6, shadowColor: 'rgba(224,96,96,0.4)' } }
                        }],
                        backgroundColor: '#fefefe',
                        textStyle: { color: '#333333' }
                    });
                    new ResizeObserver(() => {
                        if (!chart.isDisposed()) chart.resize();
                    }).observe(el);
                }
                container.style.minHeight = '';
            });
        } catch {
            container.style.minHeight = '';
            container.innerHTML = '<div class="s3-object-loading">Failed to load charts</div>';
        }
    }

    // ── Artifacts ────────────────────────────────────────────────────

    // Cache classified artifacts per run to avoid re-fetching on category expand
    const _artifactCache = new Map();
    // Cache MLflow 3.x Logged Models linked to a run. Each entry is
    //   { model_id, experiment_id, artifact_uri, artifacts: [{path, file_size, is_dir}] }
    // Populated lazily by loadRunArtifactCategories. Used by the "Logged
    // Models" category expansion and by the artifact detail renderer.
    const _loggedModelsCache = new Map();

    const CATEGORY_ICONS = {
        models: 'fa-solid fa-brain',
        images: 'fa-solid fa-image',
        charts: 'fa-solid fa-chart-simple',
        files: 'fa-solid fa-file-lines',
        // Same fa-brain as Models. Color is overridden to the Files grey
        // via .wb-row[data-type="mllm-cat"] .fa-brain in explorer-panel.css
        // so the two Models rows are visually distinct.
        logged_models: 'fa-solid fa-brain',
    };
    const CATEGORY_LABELS = {
        models: 'Models',
        images: 'Images',
        charts: 'HTML Charts',
        files: 'Files',
        logged_models: 'Logged Models',
    };

    async function loadRunArtifactCategories(nodeKey) {
        const rest = nodeKey.substring(6);
        const idx = rest.indexOf(':');
        const runId = rest.substring(idx + 1);
        try {
            // Fetch both the classified run artifacts AND the MLflow 3.x
            // Logged Models linked to this run in parallel. Logged Models
            // live in <experiment_id>/models/<model_id>/artifacts/ and are
            // not visible from the run's own artifact tree.
            const [artResp, lmResp] = await Promise.all([
                fetch(`api/mlflow/runs/${encodeURIComponent(runId)}/artifacts`),
                fetch(`api/mlflow/runs/${encodeURIComponent(runId)}/logged_models`),
            ]);
            const data = artResp.ok ? await artResp.json() : {};
            _artifactCache.set(runId, data);

            const loggedModels = lmResp.ok
                ? (await lmResp.json()).logged_models || []
                : [];
            _loggedModelsCache.set(runId, loggedModels);

            const categories = [];
            for (const cat of ['models', 'images', 'charts', 'files']) {
                if (data[cat] && data[cat].length > 0) {
                    categories.push({
                        title: CATEGORY_LABELS[cat],
                        key: `mlart-cat:${runId}:${cat}`,
                        icon: CATEGORY_ICONS[cat],
                        folder: true,
                        lazy: true,
                    });
                }
            }
            if (loggedModels.length > 0) {
                categories.push({
                    title: CATEGORY_LABELS.logged_models,
                    key: `mllm-cat:${runId}`,
                    icon: CATEGORY_ICONS.logged_models,
                    folder: true,
                    lazy: true,
                });
            }
            if (!categories.length) {
                return [{ title: 'No artifacts', key: `mlart-empty:${runId}`, icon: 'fa-solid fa-circle-info' }];
            }
            return categories;
        } catch { return []; }
    }

    // ── Logged Models (MLflow 3.x) ───────────────────────────────────

    // Category node: one child per logged model, rendered as a folder.
    function loadLoggedModelsCategory(nodeKey) {
        const runId = nodeKey.substring(9); // after "mllm-cat:"
        const models = _loggedModelsCache.get(runId) || [];
        return models.map(m => {
            // Label shows short model id; MLmodel flavor could be added later.
            const shortId = m.model_id.length > 16
                ? m.model_id.substring(0, 16) + '…'
                : m.model_id;
            const totalSize = (m.artifacts || [])
                .filter(a => !a.is_dir)
                .reduce((s, a) => s + (a.file_size || 0), 0);
            return {
                title: `${shortId} (${formatSize(totalSize)})`,
                key: `mllm:${runId}:${m.model_id}:`,
                icon: 'fa-solid fa-brain',
                folder: true,
                lazy: true,
            };
        });
    }

    // Parse a logged-model node key. Returns {runId, modelId, relPath} or null.
    function _parseLoggedModelKey(nodeKey) {
        // "mllm:{runId}:{modelId}:{relPath}"
        const rest = nodeKey.substring(5); // after "mllm:"
        const i1 = rest.indexOf(':');
        if (i1 < 0) return null;
        const runId = rest.substring(0, i1);
        const afterRun = rest.substring(i1 + 1);
        const i2 = afterRun.indexOf(':');
        if (i2 < 0) return null;
        const modelId = afterRun.substring(0, i2);
        const relPath = afterRun.substring(i2 + 1);
        return { runId, modelId, relPath };
    }

    // Directory expansion inside a logged model. Reads from the cached
    // flat artifact list (backend walked the whole tree once) and filters
    // to the immediate children of relPath.
    function loadLoggedModelSubdir(nodeKey) {
        const parsed = _parseLoggedModelKey(nodeKey);
        if (!parsed) return [];
        const { runId, modelId, relPath } = parsed;
        const models = _loggedModelsCache.get(runId) || [];
        const model = models.find(m => m.model_id === modelId);
        if (!model) return [];
        const prefix = relPath ? relPath + '/' : '';
        const children = (model.artifacts || []).filter(a => {
            if (!a.path.startsWith(prefix)) return false;
            const rest = a.path.substring(prefix.length);
            return rest.length > 0 && !rest.includes('/');
        });
        return children.map(item => {
            const name = item.path.split('/').pop();
            const size = item.file_size ? ` (${formatSize(item.file_size)})` : '';
            return {
                title: `${name}${size}`,
                key: `mllm:${runId}:${modelId}:${item.path}`,
                icon: item.is_dir ? 'fa-solid fa-folder' : 'fa-solid fa-file',
                folder: item.is_dir,
                lazy: item.is_dir,
            };
        });
    }

    function showLoggedModelsCategoryDetail(nodeKey) {
        const runId = nodeKey.substring(9);
        const models = _loggedModelsCache.get(runId) || [];
        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, 'Artifacts');
        const header = createDetailHeader('Logged Models', CATEGORY_ICONS.logged_models);
        ctx.detailEl.appendChild(header);
        const card = document.createElement('div');
        card.className = 's3-object-card';
        addMetaRow(card, 'Count', String(models.length));
        const totalSize = models.reduce(
            (s, m) => s + (m.artifacts || [])
                .filter(a => !a.is_dir)
                .reduce((ss, a) => ss + (a.file_size || 0), 0),
            0,
        );
        if (totalSize > 0) addMetaRow(card, 'Total Size', formatSize(totalSize));
        addMetaRow(card, 'Storage', 'MLflow 3.x Logged Model entities, stored outside the run\'s artifact tree');
        ctx.detailEl.appendChild(card);
    }

    function showLoggedModelDetail(nodeKey) {
        const parsed = _parseLoggedModelKey(nodeKey);
        if (!parsed) return;
        const { runId, modelId, relPath } = parsed;
        const models = _loggedModelsCache.get(runId) || [];
        const model = models.find(m => m.model_id === modelId);
        if (!model) return;

        const experimentId = model.experiment_id;
        const isRoot = !relPath;
        const node = ctx.tree?.findKey(nodeKey);
        let isDir = isRoot || node?.folder || node?.lazy || false;
        if (!isRoot) {
            const entry = (model.artifacts || []).find(a => a.path === relPath);
            if (entry) isDir = !!entry.is_dir;
        }
        const fileName = isRoot ? modelId : relPath.split('/').pop();

        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, 'Logged Models');

        const MODEL_FILES = ['MLmodel', 'conda.yaml', 'python_env.yaml', 'requirements.txt'];
        const ext = fileName.includes('.')
            ? fileName.substring(fileName.lastIndexOf('.')).toLowerCase()
            : '';
        let fileIcon = 'fa-solid fa-file-lines';
        if (isDir) fileIcon = isRoot ? 'fa-solid fa-brain' : 'fa-solid fa-folder';
        else if (MODEL_FILES.includes(fileName)
                 || ['.keras', '.h5', '.pt', '.pth', '.pkl', '.joblib', '.onnx'].includes(ext)) {
            fileIcon = 'fa-solid fa-brain';
        }
        const header = createDetailHeader(fileName, fileIcon);
        ctx.detailEl.appendChild(header);

        const downloadUrl = `api/mlflow/logged_models/${encodeURIComponent(experimentId)}/${encodeURIComponent(modelId)}/download?path=${encodeURIComponent(relPath)}`;

        if (isDir) {
            const card = document.createElement('div');
            card.className = 's3-object-card';
            addMetaRow(card, 'Model ID', `<span class="mono">${escapeHtml(modelId)}</span>`);
            addMetaRow(card, 'Experiment', experimentId);
            const prefix = relPath ? relPath + '/' : '';
            const children = (model.artifacts || []).filter(a => {
                if (!a.path.startsWith(prefix)) return false;
                const rest = a.path.substring(prefix.length);
                return rest.length > 0 && !rest.includes('/');
            });
            addMetaRow(card, 'Entries', String(children.length));
            const sizeSum = children
                .filter(a => !a.is_dir)
                .reduce((s, a) => s + (a.file_size || 0), 0);
            if (sizeSum > 0) addMetaRow(card, 'Total Size', formatSize(sizeSum));
            ctx.detailEl.appendChild(card);

            // At the model root, also fetch and show the MLmodel file body
            // inline so the user sees the model metadata immediately. Uses
            // the same hljs-based rendering as Markdown code blocks
            // (DocumentViewer._postProcessMarkdown) for consistent styling.
            if (isRoot) {
                const mlUrl = `api/mlflow/logged_models/${encodeURIComponent(experimentId)}/${encodeURIComponent(modelId)}/download?path=MLmodel`;
                const pre = document.createElement('pre');
                pre.style.cssText = 'max-height:500px;overflow:auto;margin-top:12px';
                const code = document.createElement('code');
                code.className = 'language-yaml';
                code.textContent = 'Loading model card...';
                pre.appendChild(code);
                ctx.detailEl.appendChild(pre);
                fetch(mlUrl).then(r => {
                    if (!r.ok) throw new Error('No MLmodel file');
                    return r.text();
                }).then(text => {
                    code.textContent = text;
                    if (typeof hljs !== 'undefined') {
                        delete code.dataset.highlighted;
                        hljs.highlightElement(code);
                    }
                }).catch(() => {
                    code.textContent = 'No MLmodel metadata found';
                    code.style.color = '#999';
                });
            }
            return;
        }

        // File detail: show size + download button. For text files
        // (requirements.txt, .yaml, .txt), inline a preview.
        const card = document.createElement('div');
        card.className = 's3-object-card';
        const entry = (model.artifacts || []).find(a => a.path === relPath);
        if (entry) addMetaRow(card, 'Size', formatSize(entry.file_size || 0));
        addMetaRow(card, 'Path', `<span class="mono">${escapeHtml(relPath)}</span>`);
        addMetaRow(card, 'Model', `<span class="mono">${escapeHtml(modelId)}</span>`);
        ctx.detailEl.appendChild(card);

        const dlBtn = document.createElement('a');
        dlBtn.href = downloadUrl;
        dlBtn.download = fileName;
        dlBtn.className = 'rm-btn';
        dlBtn.style.cssText = 'display:inline-block;margin-top:8px;text-decoration:none';
        dlBtn.innerHTML = '<i class="fa-solid fa-download"></i> Download';
        ctx.detailEl.appendChild(dlBtn);

        const TEXT_EXTS = ['.txt', '.yaml', '.yml', '.json', '.md'];
        const isText = TEXT_EXTS.includes(ext) || ['MLmodel', 'requirements.txt'].includes(fileName);
        if (isText) {
            // Map file to hljs language class, matching noted's Markdown
            // code-block convention (DocumentViewer uses hljs for all
            // `pre > code` blocks via hljs.highlightElement).
            let langClass = 'language-plaintext';
            if (fileName === 'MLmodel' || ext === '.yaml' || ext === '.yml') langClass = 'language-yaml';
            else if (ext === '.json') langClass = 'language-json';
            else if (ext === '.md') langClass = 'language-markdown';

            const pre = document.createElement('pre');
            pre.style.cssText = 'max-height:500px;overflow:auto;margin-top:12px';
            const code = document.createElement('code');
            code.className = langClass;
            code.textContent = 'Loading...';
            pre.appendChild(code);
            ctx.detailEl.appendChild(pre);
            fetch(downloadUrl).then(r => {
                if (!r.ok) throw new Error('fetch failed');
                return r.text();
            }).then(text => {
                code.textContent = text;
                if (typeof hljs !== 'undefined') {
                    delete code.dataset.highlighted;
                    hljs.highlightElement(code);
                }
            }).catch(() => {
                code.textContent = '(preview unavailable)';
                code.style.color = '#999';
            });
        }
    }

    function loadArtifactCategory(nodeKey) {
        const rest = nodeKey.substring(10); // after "mlart-cat:"
        const idx = rest.indexOf(':');
        const runId = rest.substring(0, idx);
        const category = rest.substring(idx + 1);
        const cached = _artifactCache.get(runId);
        if (!cached || !cached[category]) return [];
        return cached[category].map(item => {
            const name = item.path.split('/').pop();
            const isModel = category === 'models' && item.is_dir;
            const size = item.file_size ? ` (${formatSize(item.file_size)})` : '';
            return {
                title: `${name}${size}`,
                key: `mlart:${runId}:${item.path}`,
                icon: isModel ? 'fa-solid fa-brain' : CATEGORY_ICONS[category] || 'fa-solid fa-file',
                folder: item.is_dir,
                lazy: item.is_dir,
            };
        });
    }

    async function loadArtifactSubdir(nodeKey) {
        const rest = nodeKey.substring(6); // after "mlart:"
        const idx = rest.indexOf(':');
        const runId = rest.substring(0, idx);
        const path = rest.substring(idx + 1);
        try {
            const resp = await fetch(`api/mlflow/runs/${encodeURIComponent(runId)}/artifacts?path=${encodeURIComponent(path)}`);
            if (!resp.ok) return [];
            const data = await resp.json();
            return (data.artifacts || []).map(item => {
                const name = item.path.split('/').pop();
                const size = item.file_size ? ` (${formatSize(item.file_size)})` : '';
                return {
                    title: `${name}${size}`,
                    key: `mlart:${runId}:${item.path}`,
                    icon: item.is_dir ? 'fa-solid fa-folder' : 'fa-solid fa-file',
                    folder: item.is_dir,
                    lazy: item.is_dir,
                };
            });
        } catch { return []; }
    }

    function showArtifactCategoryDetail(nodeKey) {
        const rest = nodeKey.substring(10);
        const idx = rest.indexOf(':');
        const runId = rest.substring(0, idx);
        const category = rest.substring(idx + 1);
        const cached = _artifactCache.get(runId);
        const items = cached?.[category] || [];

        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, 'Artifacts');
        const header = createDetailHeader(CATEGORY_LABELS[category] || category, CATEGORY_ICONS[category]);
        ctx.detailEl.appendChild(header);

        const card = document.createElement('div');
        card.className = 's3-object-card';
        addMetaRow(card, 'Items', String(items.length));
        const totalSize = items.reduce((s, i) => s + (i.file_size || 0), 0);
        if (totalSize > 0) addMetaRow(card, 'Total Size', formatSize(totalSize));
        ctx.detailEl.appendChild(card);
    }

    function showArtifactDetail(nodeKey) {
        const rest = nodeKey.substring(6);
        const idx = rest.indexOf(':');
        const runId = rest.substring(0, idx);
        const artifactPath = rest.substring(idx + 1);
        const fileName = artifactPath.split('/').pop();
        const ext = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')).toLowerCase() : '';

        // Check if this is a directory node (model directory)
        const node = ctx.tree?.findKey(nodeKey);
        let isDir = node?.folder || node?.lazy || false;
        // Also check from cached artifact data
        if (!isDir && _artifactCache.has(runId)) {
            const cached = _artifactCache.get(runId);
            for (const cat of Object.values(cached)) {
                const match = cat.find(i => i.path === artifactPath);
                if (match) { isDir = !!match.is_dir; break; }
            }
        }

        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, 'Artifacts');

        // Match icon to file type
        const MODEL_FILES = ['MLmodel', 'conda.yaml', 'python_env.yaml'];
        let fileIcon = 'fa-solid fa-file-lines';
        if (isDir) fileIcon = 'fa-solid fa-brain';
        else if (['.keras', '.h5', '.pt', '.pth', '.pkl', '.joblib', '.onnx', '.pmml', '.safetensors', '.bin'].includes(ext) || MODEL_FILES.includes(fileName)) fileIcon = 'fa-solid fa-brain';
        else if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.bmp', '.webp'].includes(ext)) fileIcon = 'fa-solid fa-image';
        else if (['.html', '.htm'].includes(ext)) fileIcon = 'fa-solid fa-chart-simple';
        const header = createDetailHeader(fileName, fileIcon);
        ctx.detailEl.appendChild(header);

        // Model directory: show MLmodel content as model card
        if (isDir) {
            const mlmodelUrl = `api/mlflow/runs/${encodeURIComponent(runId)}/artifacts/download?path=${encodeURIComponent(artifactPath + '/MLmodel')}`;
            const pre = document.createElement('pre');
            pre.style.cssText = 'font-size:12px;font-family:var(--font-mono,monospace);background:#fefefe;border:1px solid var(--border-color);border-radius:4px;padding:12px;overflow:auto;max-height:500px;margin-bottom:12px;color:#333';
            pre.textContent = 'Loading model card...';
            ctx.detailEl.appendChild(pre);
            fetch(mlmodelUrl).then(r => {
                if (!r.ok) throw new Error('No MLmodel file');
                return r.text();
            }).then(text => {
                pre.textContent = text;
            }).catch(() => {
                pre.textContent = 'No MLmodel metadata found';
                pre.style.color = '#999';
            });

            // List files in model directory
            const card = document.createElement('div');
            card.className = 's3-object-card';
            card.innerHTML = '<div class="s3-object-loading">Loading contents...</div>';
            ctx.detailEl.appendChild(card);

            fetch(`api/mlflow/runs/${encodeURIComponent(runId)}/artifacts?path=${encodeURIComponent(artifactPath)}`)
                .then(r => r.json()).then(data => {
                    card.innerHTML = '';
                    const items = data.artifacts || [];
                    addMetaRow(card, 'Path', `<span class="mono">${escapeHtml(artifactPath)}</span>`);
                    addMetaRow(card, 'Files', String(items.length));
                    const totalSize = items.reduce((s, i) => s + (i.file_size || 0), 0);
                    if (totalSize > 0) addMetaRow(card, 'Total Size', formatSize(totalSize));
                    for (const item of items) {
                        const name = item.path.split('/').pop();
                        const size = item.file_size ? formatSize(item.file_size) : '';
                        addMetaRow(card, name, `<span class="mono">${size}</span>`);
                    }
                }).catch(() => {
                    card.innerHTML = '';
                });
            return;
        }

        const downloadUrl = `api/mlflow/runs/${encodeURIComponent(runId)}/artifacts/download?path=${encodeURIComponent(artifactPath)}`;

        // Image viewer
        if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.bmp', '.webp'].includes(ext)) {
            const img = document.createElement('img');
            img.src = downloadUrl;
            img.style.cssText = 'max-width:100%;max-height:500px;border:1px solid var(--border-color);border-radius:4px;margin-bottom:12px';
            img.alt = fileName;
            ctx.detailEl.appendChild(img);
        }
        // HTML chart viewer
        else if (['.html', '.htm'].includes(ext)) {
            const iframe = document.createElement('iframe');
            iframe.src = downloadUrl;
            iframe.sandbox = 'allow-scripts';
            iframe.style.cssText = 'width:100%;height:400px;border:1px solid var(--border-color);border-radius:4px;margin-bottom:12px;background:#fff';
            ctx.detailEl.appendChild(iframe);
        }
        // YAML / text viewer
        else if (['.yaml', '.yml', '.json', '.txt', '.csv', '.md', '.py', '.r'].includes(ext) || fileName === 'MLmodel' || fileName === 'conda.yaml' || fileName === 'requirements.txt' || fileName === 'python_env.yaml') {
            const pre = document.createElement('pre');
            pre.style.cssText = 'font-size:12px;font-family:var(--font-mono,monospace);background:#fefefe;border:1px solid var(--border-color);border-radius:4px;padding:12px;overflow:auto;max-height:500px;margin-bottom:12px;color:#333';
            pre.textContent = '';
            ctx.detailEl.appendChild(pre);
            fetch(downloadUrl).then(r => r.text()).then(text => {
                pre.textContent = text;
            }).catch(() => {
                pre.textContent = 'Failed to load file content';
                pre.style.color = '#c74e39';
            });
        }

        // Metadata card
        const card = document.createElement('div');
        card.className = 's3-object-card';
        addMetaRow(card, 'Path', `<span class="mono">${escapeHtml(artifactPath)}</span>`);
        // Look up file size from cached data
        const cached = _artifactCache.get(runId);
        if (cached) {
            for (const cat of Object.values(cached)) {
                const match = cat.find(i => i.path === artifactPath);
                if (match && match.file_size) {
                    addMetaRow(card, 'Size', formatSize(match.file_size));
                    break;
                }
            }
        }
        addMetaRow(card, 'Run', `<span class="mono">${escapeHtml(runId.substring(0, 8))}</span>`);
        ctx.detailEl.appendChild(card);
    }

    // ── Public API ──────────────────────────────────────────────────

    async function triggerMetricsView(runId, runName) {
        try {
            const resp = await fetch(`api/mlflow/runs/${encodeURIComponent(runId)}`);
            if (!resp.ok) return;
            const run = await resp.json();
            const metricKeys = Object.keys(run.metrics || {});
            if (!metricKeys.length) return;
            const metricsMap = {};
            await Promise.all(metricKeys.map(async (key) => {
                const r = await fetch(`api/mlflow/runs/${encodeURIComponent(runId)}/metrics/${encodeURIComponent(key)}`);
                if (r.ok) {
                    const data = await r.json();
                    metricsMap[key] = (data.history || []).map(p => ({ step: p.step, value: p.value }));
                }
            }));
            const cb = ctx.callbacks.onMetricsView;
            if (cb) cb(runId, runName, metricsMap);
        } catch (e) {
            console.error('Failed to load metric history:', e);
        }
    }

    // ── Run Comparison ────────────────────────────────────────────────

    async function startRunComparison(runIdA, runNameA, experimentId) {
        // 1. Fetch runs for the experiment to let user pick the second run
        let runs;
        try {
            const resp = await fetch(`api/mlflow/experiments/${encodeURIComponent(experimentId)}/runs`);
            if (!resp.ok) throw new Error('Failed to load runs');
            const data = await resp.json();
            runs = (data.runs || []).filter(r => r.run_id !== runIdA);
        } catch (err) {
            modalError('Could not load experiment runs: ' + err.message);
            return;
        }
        if (!runs.length) {
            modalError('No other runs in this experiment to compare with.');
            return;
        }

        // 2. Show picker modal
        const { modalSelect } = await import('../../modal.js');
        const options = runs.map(r => ({
            value: r.run_id,
            label: `${r.run_name || r.run_id.substring(0, 8)} (${r.run_id.substring(0, 8)}) - ${r.status}`,
        }));
        const selectedId = await modalSelect('Select run to compare with:', options, { title: 'Compare Runs' });
        if (!selectedId) return;

        // 3. Fetch both runs
        let runA, runB;
        try {
            const [respA, respB] = await Promise.all([
                fetch(`api/mlflow/runs/${encodeURIComponent(runIdA)}`),
                fetch(`api/mlflow/runs/${encodeURIComponent(selectedId)}`),
            ]);
            runA = await respA.json();
            runB = await respB.json();
        } catch (err) {
            modalError('Failed to load run data: ' + err.message);
            return;
        }

        // Format Run B name with date to match Run A (tree node title format)
        let runNameB = runB.run_name || selectedId.substring(0, 8);
        if (runB.start_time) {
            const d = new Date(runB.start_time);
            const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
            runNameB = `${dateStr} - ${runNameB}`;
        }
        const shortA = runIdA.substring(0, 8);
        const shortB = selectedId.substring(0, 8);

        // 4. Build comparison panel
        _openComparisonPanel(runA, runB, runNameA, runNameB, shortA, shortB);
    }

    function _openComparisonPanel(runA, runB, nameA, nameB, shortA, shortB) {
        const offset = (window._compareCount = (window._compareCount || 0) + 1);

        const panel = jsPanel.create({
            headerTitle: `Compare: ${nameA} vs ${nameB}`,
            theme: '#ffe39e filled',
            borderRadius: '5px',
            contentSize: { width: Math.min(820, window.innerWidth - 80), height: Math.min(600, window.innerHeight - 100) },
            position: { my: 'center', at: 'center', offsetX: offset * 20, offsetY: offset * 20 },
            headerControls: 'closeonly',
            content: '<div class="run-compare-container"></div>',
            onclosed: () => { window._compareCount = Math.max(0, (window._compareCount || 1) - 1); },
            callback: (p) => { p.content.style.backgroundColor = '#fefefe'; },
        });

        const container = panel.content.querySelector('.run-compare-container');
        container.className = 'run-compare-container explorer-detail-content';
        container.style.cssText = 'height:100%;overflow-y:auto;padding:12px;font-size:12px;background:#fefefe;overscroll-behavior:contain';

        // --- Header ---
        const headerEl = document.createElement('div');
        headerEl.style.cssText = 'display:flex;gap:16px;margin-bottom:16px';
        headerEl.innerHTML = `
            <div style="flex:1;padding:8px 12px;border-radius:4px;background:#e8f5e9;border:0.5px solid #c8e6c9">
                <div style="font-weight:600;color:#2e7d32"><i class="fa-solid fa-circle" style="font-size:8px;margin-right:4px;color:#4caf50"></i> ${escapeHtml(nameA)}</div>
                <div style="color:#888;font-size:11px;font-family:var(--font-mono)">${shortA}</div>
            </div>
            <div style="flex:1;padding:8px 12px;border-radius:4px;background:#e3f2fd;border:0.5px solid #bbdefb">
                <div style="font-weight:600;color:#1565c0"><i class="fa-solid fa-circle" style="font-size:8px;margin-right:4px;color:#2196f3"></i> ${escapeHtml(nameB)}</div>
                <div style="color:#888;font-size:11px;font-family:var(--font-mono)">${shortB}</div>
            </div>
        `;
        container.appendChild(headerEl);

        // --- Metrics Diff Table ---
        const allMetricKeys = [...new Set([
            ...Object.keys(runA.metrics || {}),
            ...Object.keys(runB.metrics || {}),
        ])].sort();

        if (allMetricKeys.length) {
            _appendDiffSection(container, 'Metrics', allMetricKeys, runA.metrics || {}, runB.metrics || {}, true);
        }

        // --- Parameters Diff Table ---
        const allParamKeys = [...new Set([
            ...Object.keys(runA.params || {}),
            ...Object.keys(runB.params || {}),
        ])].sort();

        if (allParamKeys.length) {
            _appendDiffSection(container, 'Parameters', allParamKeys, runA.params || {}, runB.params || {});
        }

        // --- Tags Diff Table ---
        const allTagKeys = [...new Set([
            ...Object.keys(runA.tags || {}),
            ...Object.keys(runB.tags || {}),
        ])].sort().filter(k => !k.startsWith('mlflow.'));

        if (allTagKeys.length) {
            _appendDiffSection(container, 'Tags', allTagKeys, runA.tags || {}, runB.tags || {});
        }

        // --- Overlaid Metric Charts ---
        const timeSeriesKeys = allMetricKeys.filter(k => {
            const valA = runA.metrics?.[k];
            const valB = runB.metrics?.[k];
            return valA !== undefined || valB !== undefined;
        });

        if (timeSeriesKeys.length) {
            const chartTitle = document.createElement('div');
            chartTitle.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin:16px 0 8px';
            chartTitle.textContent = 'Metric History';
            container.appendChild(chartTitle);

            const chartGrid = document.createElement('div');
            chartGrid.style.cssText = 'display:grid;grid-template-columns:repeat(2,1fr);gap:8px';
            container.appendChild(chartGrid);

            _renderComparisonCharts(chartGrid, runA, runB, nameA, nameB, timeSeriesKeys);
        }

        // Ask Assistant to explain differences
        const askDiffSection = document.createElement('div');
        askDiffSection.style.cssText = 'margin:12px 0;display:flex;gap:6px';
        const askDiffBtn = document.createElement('button');
        askDiffBtn.className = 'rm-btn';
        askDiffBtn.style.cssText = 'display:flex;align-items:center;gap:6px;background:#c8e6c0';
        askDiffBtn.innerHTML = '<i class="fa-solid fa-comment" style="font-size:10px"></i> Explain Differences';
        askDiffBtn.addEventListener('click', () => {
            document.dispatchEvent(new CustomEvent('ask-assistant', {
                detail: { message: `Compare MLflow runs (run_id: ${runA.run_id}, name: "${nameA}") and (run_id: ${runB.run_id}, name: "${nameB}"). What are the key differences in metrics and parameters, and what might explain them?` }
            }));
        });
        askDiffSection.appendChild(askDiffBtn);
        container.appendChild(askDiffSection);

        // Scrollbar styling
        container.style.overscrollBehavior = 'contain';
    }

    function _appendDiffSection(container, title, keys, objA, objB, isMetric = false) {
        const section = document.createElement('div');
        section.style.cssText = 'margin-bottom:16px';

        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin-bottom:6px';
        titleEl.textContent = title;
        section.appendChild(titleEl);

        const table = document.createElement('table');
        table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px';

        // Header
        const thead = document.createElement('thead');
        thead.innerHTML = `<tr>
            <th style="text-align:left;padding:6px 10px;background:#bfdcff;font-weight:600;border:0.5px solid #e0e0e0">Key</th>
            <th style="text-align:left;padding:6px 10px;background:#e8f5e9;font-weight:600;border:0.5px solid #e0e0e0"><i class="fa-solid fa-circle" style="font-size:6px;color:#4caf50;margin-right:4px"></i>Run A</th>
            <th style="text-align:left;padding:6px 10px;background:#e3f2fd;font-weight:600;border:0.5px solid #e0e0e0"><i class="fa-solid fa-circle" style="font-size:6px;color:#2196f3;margin-right:4px"></i>Run B</th>
            ${isMetric ? '<th style="text-align:right;padding:6px 10px;background:#bfdcff;font-weight:600;border:0.5px solid #e0e0e0">Delta</th>' : ''}
        </tr>`;
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const key of keys) {
            const valA = objA[key];
            const valB = objB[key];
            const isDiff = String(valA ?? '') !== String(valB ?? '');

            const tr = document.createElement('tr');
            tr.style.background = isDiff ? '#fff8e1' : '#fefefe';

            const fmtVal = (v) => {
                if (v === undefined || v === null) return '<span style="color:#ccc">-</span>';
                if (typeof v === 'number') return `<span style="font-family:var(--font-mono)">${Number.isInteger(v) ? v : v.toFixed(6)}</span>`;
                return `<span style="font-family:var(--font-mono)">${escapeHtml(String(v))}</span>`;
            };

            let deltaHtml = '';
            if (isMetric && typeof valA === 'number' && typeof valB === 'number') {
                const delta = valB - valA;
                const pct = valA !== 0 ? ((delta / Math.abs(valA)) * 100).toFixed(1) : '-';
                const color = delta < 0 ? '#4caf50' : delta > 0 ? '#f44336' : '#888';
                const arrow = delta < 0 ? '\u2193' : delta > 0 ? '\u2191' : '';
                deltaHtml = `<td style="text-align:right;padding:6px 10px;border:0.5px solid #f0f0f0;font-family:var(--font-mono);color:${color}">${arrow} ${Math.abs(delta).toFixed(6)} (${pct}%)</td>`;
            } else if (isMetric) {
                deltaHtml = '<td style="text-align:right;padding:6px 10px;border:0.5px solid #f0f0f0;color:#ccc">-</td>';
            }

            tr.innerHTML = `
                <td style="padding:6px 10px;border:0.5px solid #f0f0f0;font-weight:${isDiff ? '600' : '400'};color:#333">${escapeHtml(key)}</td>
                <td style="padding:6px 10px;border:0.5px solid #f0f0f0">${fmtVal(valA)}</td>
                <td style="padding:6px 10px;border:0.5px solid #f0f0f0">${fmtVal(valB)}</td>
                ${deltaHtml}
            `;
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        section.appendChild(table);
        container.appendChild(section);
    }

    async function _renderComparisonCharts(grid, runA, runB, nameA, nameB, metricKeys) {
        const { default: echarts } = await import('../../vendor/echarts/echarts.esm.min.js');

        for (const key of metricKeys) {
            const cell = document.createElement('div');
            cell.style.cssText = 'height:200px;background:#fdfdfd;border:0.5px solid #e0e0e0;border-radius:4px;padding:4px';
            grid.appendChild(cell);

            // Fetch both histories
            const [histA, histB] = await Promise.all([
                fetch(`api/mlflow/runs/${encodeURIComponent(runA.run_id)}/metrics/${encodeURIComponent(key)}`)
                    .then(r => r.ok ? r.json() : { history: [] }).then(d => d.history || []),
                fetch(`api/mlflow/runs/${encodeURIComponent(runB.run_id)}/metrics/${encodeURIComponent(key)}`)
                    .then(r => r.ok ? r.json() : { history: [] }).then(d => d.history || []),
            ]);

            // Skip single-point metrics (summary values)
            if (histA.length < 2 && histB.length < 2) {
                cell.style.display = 'none';
                continue;
            }

            const chart = echarts.init(cell);
            const series = [];
            if (histA.length >= 2) {
                series.push({
                    name: `${nameA}`,
                    type: 'line',
                    data: histA.map(p => [p.step, p.value]),
                    lineStyle: { width: 2, color: '#4caf50' },
                    itemStyle: { color: '#4caf50' },
                    symbol: 'circle',
                    symbolSize: 4,
                });
            }
            if (histB.length >= 2) {
                series.push({
                    name: `${nameB}`,
                    type: 'line',
                    data: histB.map(p => [p.step, p.value]),
                    lineStyle: { width: 2, color: '#2196f3' },
                    itemStyle: { color: '#2196f3' },
                    symbol: 'circle',
                    symbolSize: 4,
                });
            }

            chart.setOption({
                title: { text: key, left: 'center', top: 4, textStyle: { fontSize: 12, color: '#333' } },
                tooltip: {
                    trigger: 'axis',
                    textStyle: { fontSize: 11 },
                    formatter: (params) => {
                        let html = `Step ${params[0]?.axisValue}<br>`;
                        for (const p of params) {
                            html += `<span style="color:${p.color}">\u25CF</span> ${escapeHtml(p.seriesName)}: <b>${p.value[1]?.toFixed(6)}</b><br>`;
                        }
                        return html;
                    },
                },
                legend: { bottom: 4, textStyle: { fontSize: 10 }, itemWidth: 12, itemHeight: 8 },
                grid: { left: 50, right: 20, top: 30, bottom: 36 },
                xAxis: { type: 'value', name: 'Step', nameTextStyle: { fontSize: 10 }, axisLabel: { fontSize: 10 } },
                yAxis: { type: 'value', axisLabel: { fontSize: 10 } },
                series,
            });

            // Resize observer
            const ro = new ResizeObserver(() => chart.resize());
            ro.observe(cell);
        }
    }

    // ── Report Export ─────────────────────────────────────────────

    async function _downloadReport(experimentId, format) {
        notify.info(`Generating ${format} report...`);
        try {
            const resp = await fetch(`api/reports/experiment/${encodeURIComponent(experimentId)}?format=${format}`);
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${resp.status}`);
            }
            const blob = await resp.blob();
            const ext = format === 'word' ? '.docx' : '.md';
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `experiment_report_${experimentId}${ext}`;
            a.click();
            URL.revokeObjectURL(a.href);
            notify.success('Report downloaded');
        } catch (err) {
            notify.error(err.message);
        }
    }

    // Leaderboard + Snapshots delegated to ExplorerSnapshotViews.js

    return {
        // Experiments
        loadExperiments,
        loadExperimentRuns,
        showExperimentsRootDetail,
        showExperimentDetail,
        renderExperimentDetailInto,
        showMlrunDetail,
        renderRunDetailInto,
        triggerMetricsView,
        startRunComparison,
        // Artifacts
        loadRunArtifactCategories,
        loadArtifactCategory,
        loadArtifactSubdir,
        showArtifactCategoryDetail,
        showArtifactDetail,
        // Logged Models (MLflow 3.x)
        loadLoggedModelsCategory,
        loadLoggedModelSubdir,
        showLoggedModelsCategoryDetail,
        showLoggedModelDetail,
    };
}
