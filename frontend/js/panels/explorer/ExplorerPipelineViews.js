/**
 * ExplorerPipelineViews - DAG Graph Visualization and Pipelines (Airflow)
 * detail views and tree data loaders.
 */

import { notify } from '../../Notify.js';
import { modalConfirm } from '../../modal.js';
import { getTerminalTheme, onTerminalThemeChange } from '../../TerminalThemes.js';
import {
    createDetailHeader, addParentLabel, addMetaRow, escapeHtml,
} from './ExplorerHelpers.js';

/** Capitalize first letter of a string. */
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';

/**
 * @param {object} ctx - Shared explorer context (getters for live state).
 * @returns {object} View methods for pipelines and DAG visualization.
 */
export function createPipelineViews(ctx) {

    // ── DAG Graph Visualization ────────────────────────────────────

    // State colors for task nodes (shared across render + update)
    const _nodeTextColor = '#1d1d1d';
    const _nodeLabelColor = '#333333';
    const _stateColors = {
        success: { bg: '#a5d6a7', border: '#388e3c' },
        running: { bg: '#90caf9', border: '#1976d2' },
        failed: { bg: '#ef9a9a', border: '#d32f2f' },
        queued: { bg: '#ffe0b2', border: '#f57c00' },
        skipped: { bg: '#cfd8dc', border: '#78909c' },
        pending: { bg: '#e8e8e8', border: '#9e9e9e' },
    };
    const _defaultColors = { bg: '#e0e0e0', border: '#888' };

    // Active graph instance for live updates
    let _activeGraph = null;

    // ── DAG Graph (SVG) ────────────────────────────────────────

    function _renderDagGraph(container, structure, dagId, taskStates, dagRunId) {
        const { nodes, edges } = structure;
        if (!nodes.length) return;

        // Use dagre for layout
        const g = new dagre.graphlib.Graph();
        g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80, marginx: 30, marginy: 20 });
        g.setDefaultEdgeLabel(() => ({}));

        const nodeWidth = 150;
        const nodeHeight = 44;

        for (const n of nodes) {
            g.setNode(n.id, { width: nodeWidth, height: nodeHeight, label: n.id });
        }
        for (const e of edges) {
            g.setEdge(e.source, e.target);
        }

        dagre.layout(g);

        const graphInfo = g.graph();
        const graphWidth = Math.max(graphInfo.width + 60, 300);
        const graphHeight = Math.max(graphInfo.height + 40, 120);
        container.style.height = graphHeight + 'px';

        const svgNs = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('viewBox', `0 0 ${graphWidth} ${graphHeight}`);
        svg.style.cssText = 'font-family:var(--font-sans);font-size:11px';

        // Defs for arrow marker
        const defs = document.createElementNS(svgNs, 'defs');
        const marker = document.createElementNS(svgNs, 'marker');
        marker.setAttribute('id', `arrow-${dagId}`);
        marker.setAttribute('viewBox', '0 0 10 10');
        marker.setAttribute('refX', '10');
        marker.setAttribute('refY', '5');
        marker.setAttribute('markerWidth', '8');
        marker.setAttribute('markerHeight', '8');
        marker.setAttribute('orient', 'auto-start-reverse');
        const arrowPath = document.createElementNS(svgNs, 'path');
        arrowPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
        arrowPath.setAttribute('fill', '#777');
        marker.appendChild(arrowPath);
        defs.appendChild(marker);
        svg.appendChild(defs);

        // Tooltip element (appended to body to avoid clipping)
        const tooltip = document.createElement('div');
        tooltip.style.cssText = 'position:fixed;display:none;background:#333;color:#fff;padding:6px 10px;border-radius:4px;font-size:11px;font-family:var(--font-sans);pointer-events:none;z-index:10000;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.3)';

        // Draw edges
        for (const e of g.edges()) {
            const edgeData = g.edge(e);
            const points = edgeData.points || [];
            if (points.length < 2) continue;

            const path = document.createElementNS(svgNs, 'path');
            let d = `M ${points[0].x} ${points[0].y}`;
            for (let i = 1; i < points.length; i++) {
                d += ` L ${points[i].x} ${points[i].y}`;
            }
            path.setAttribute('d', d);
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', '#888');
            path.setAttribute('stroke-width', '1.5');
            path.setAttribute('marker-end', `url(#arrow-${dagId})`);
            svg.appendChild(path);
        }

        // Track node elements for live updates
        const nodeElements = {};

        // Draw nodes
        for (const n of nodes) {
            const nodeData = g.node(n.id);
            const x = nodeData.x - nodeWidth / 2;
            const y = nodeData.y - nodeHeight / 2;

            const state = taskStates?.[n.id] || 'pending';
            const colors = _stateColors[state] || _defaultColors;

            // Group for the node (for easy updates)
            const group = document.createElementNS(svgNs, 'g');
            group.setAttribute('data-task-id', n.id);
            group.style.cursor = 'pointer';

            // Node rectangle
            const rect = document.createElementNS(svgNs, 'rect');
            rect.setAttribute('x', x);
            rect.setAttribute('y', y);
            rect.setAttribute('width', nodeWidth);
            rect.setAttribute('height', nodeHeight);
            rect.setAttribute('rx', '6');
            rect.setAttribute('ry', '6');
            rect.setAttribute('fill', colors.bg);
            rect.setAttribute('stroke', colors.border);
            rect.setAttribute('stroke-width', '1.5');
            rect.style.transition = 'fill 0.3s, stroke 0.3s';
            group.appendChild(rect);

            // Task name
            const text = document.createElementNS(svgNs, 'text');
            text.setAttribute('x', nodeData.x);
            text.setAttribute('y', nodeData.y - 3);
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('dominant-baseline', 'middle');
            text.setAttribute('fill', _nodeTextColor);
            text.setAttribute('font-weight', '600');
            text.setAttribute('font-size', '11px');
            text.textContent = n.id;
            text.style.pointerEvents = 'none';
            text.style.transition = 'fill 0.3s';
            group.appendChild(text);

            // Operator label
            if (n.operator) {
                const opText = document.createElementNS(svgNs, 'text');
                opText.setAttribute('x', nodeData.x);
                opText.setAttribute('y', nodeData.y + 12);
                opText.setAttribute('text-anchor', 'middle');
                opText.setAttribute('dominant-baseline', 'middle');
                opText.setAttribute('fill', _nodeLabelColor);
                opText.setAttribute('font-size', '9px');
                opText.setAttribute('opacity', '0.6');
                opText.textContent = n.operator;
                opText.style.pointerEvents = 'none';
                group.appendChild(opText);
            }

            // State indicator dot
            const dot = document.createElementNS(svgNs, 'circle');
            dot.setAttribute('cx', x + nodeWidth - 10);
            dot.setAttribute('cy', y + 10);
            dot.setAttribute('r', state !== 'pending' ? '5' : '0');
            dot.setAttribute('fill', colors.border);
            dot.style.transition = 'r 0.3s, fill 0.3s';
            group.appendChild(dot);

            // Store references for live updates
            nodeElements[n.id] = { group, rect, text, dot, operator: n.operator, x: nodeData.x, y: nodeData.y, bx: x, by: y };

            // Click -> navigate to task in tree
            group.addEventListener('click', () => {
                if (dagRunId) {
                    const taskKey = `dagtask:${dagId}:${dagRunId}:${n.id}`;
                    const taskNode = ctx.tree?.findKey(taskKey);
                    if (taskNode) taskNode.setActive(true);
                }
            });

            // Hover -> tooltip with metadata
            group.addEventListener('mouseenter', (ev) => {
                rect.style.filter = 'brightness(0.92)';
                const taskState = taskStates?.[n.id] || 'pending';
                let html = `<strong>${escapeHtml(n.id)}</strong>`;
                html += `<br>State: <span style="color:${(_stateColors[taskState] || _defaultColors).bg}">${taskState}</span>`;
                if (n.operator) html += `<br>Operator: ${escapeHtml(n.operator)}`;
                if (n.trigger_rule && n.trigger_rule !== 'all_success') html += `<br>Trigger: ${escapeHtml(n.trigger_rule)}`;
                tooltip.innerHTML = html;
                tooltip.style.display = 'block';
                const svgRect = svg.getBoundingClientRect();
                const scaleX = svgRect.width / graphWidth;
                const scaleY = svgRect.height / graphHeight;
                const tipLeft = svgRect.left + (nodeData.x * scaleX) - tooltip.offsetWidth / 2;
                const tipTop = svgRect.top + (y * scaleY) - tooltip.offsetHeight - 8;
                tooltip.style.left = tipLeft + 'px';
                tooltip.style.top = Math.max(0, tipTop) + 'px';
            });
            group.addEventListener('mouseleave', () => {
                rect.style.filter = '';
                tooltip.style.display = 'none';
            });

            svg.appendChild(group);
        }

        container.innerHTML = '';
        container.appendChild(svg);
        document.body.appendChild(tooltip);
        // Clean up tooltip when container is removed from DOM
        const observer = new MutationObserver(() => {
            if (!container.isConnected) {
                tooltip.remove();
                observer.disconnect();
            }
        });
        observer.observe(container.parentNode || document.body, { childList: true, subtree: true });

        // Store active graph for live updates
        if (dagRunId) {
            _activeGraph = { dagId, dagRunId, nodeElements, taskStates: { ...(taskStates || {}) }, container, svg };
        }
    }

    /**
     * Update a single task node's state in the active graph (called from Socket.IO events).
     */
    function updateGraphTaskState(dagId, dagRunId, taskId, state) {
        if (!_activeGraph) return;
        if (_activeGraph.dagId !== dagId || _activeGraph.dagRunId !== dagRunId) return;
        const el = _activeGraph.nodeElements[taskId];
        if (!el) return;
        const colors = _stateColors[state] || _defaultColors;
        _activeGraph.taskStates[taskId] = state;

        // Animate color transitions
        el.rect.setAttribute('fill', colors.bg);
        el.rect.setAttribute('stroke', colors.border);
        el.text.setAttribute('fill', _nodeTextColor);
        el.dot.setAttribute('fill', colors.border);
        el.dot.setAttribute('r', '5');

        // Update operator text color too
        const opText = el.group.querySelector('text:nth-child(4)');
        if (opText) opText.setAttribute('fill', _nodeLabelColor);

        // Knowledge Graph live updates will be handled by the graph service
    }

    // ── Pipelines (Airflow) ─────────────────────────────────────────

    const _dagStateIcon = (state) => {
        if (state === 'success' || state === 'finished') return { icon: 'fa-solid fa-circle-check', color: '#4caf50' };
        if (state === 'running') return { icon: 'fa-solid fa-circle-play', color: '#2196f3' };
        if (state === 'failed') return { icon: 'fa-solid fa-circle-xmark', color: '#f44336' };
        if (state === 'queued') return { icon: 'fa-solid fa-clock', color: '#ff9800' };
        if (state === 'skipped') return { icon: 'fa-solid fa-forward', color: '#999' };
        return { icon: 'fa-solid fa-circle-question', color: '#999' };
    };

    async function loadPipelines() {
        try {
            const resp = await fetch('api/airflow/dags');
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                return [{ title: err.detail || 'Failed to load pipelines', key: 'pipe-error', icon: 'fa-solid fa-circle-exclamation' }];
            }
            const data = await resp.json();
            const dags = data.dags || [];
            if (!dags.length) return [{ title: 'No pipelines found', key: 'pipe-empty', icon: 'fa-solid fa-circle-info' }];

            const nodes = dags.map(d => ({
                title: d.dag_id,
                key: `dag:${d.dag_id}`,
                icon: d.is_paused ? 'fa-solid fa-circle-pause' : 'fa-solid fa-diagram-project',
                folder: true,
                lazy: true,
                _data: d,
            }));

            // Async: compute pipeline health badge on root node
            _updatePipelineHealth(dags);

            return nodes;
        } catch { return [{ title: 'Airflow not reachable', key: 'pipe-error', icon: 'fa-solid fa-circle-exclamation' }]; }
    }

    async function _updatePipelineHealth(dags) {
        try {
            const activeDags = dags.filter(d => !d.is_paused);
            if (!activeDags.length) return;

            // Fetch latest run for each active DAG (in parallel, limit 1)
            const results = await Promise.allSettled(
                activeDags.map(d =>
                    fetch(`api/airflow/dags/${encodeURIComponent(d.dag_id)}/runs?limit=1`)
                        .then(r => r.ok ? r.json() : null)
                )
            );

            let hasFailed = false, hasRunning = false, hasSuccess = false;
            for (const r of results) {
                if (r.status !== 'fulfilled' || !r.value) continue;
                const runs = r.value.runs || [];
                if (!runs.length) continue;
                const state = runs[0].state;
                if (state === 'failed') hasFailed = true;
                else if (state === 'running' || state === 'queued') hasRunning = true;
                else if (state === 'success') hasSuccess = true;
            }

            // Determine health color
            let healthColor, healthTitle;
            if (hasFailed) { healthColor = '#f44336'; healthTitle = 'Some pipelines failed'; }
            else if (hasRunning) { healthColor = '#2196f3'; healthTitle = 'Pipelines running'; }
            else if (hasSuccess) { healthColor = '#4caf50'; healthTitle = 'All pipelines healthy'; }
            else return;

            // Apply badge to root-pipelines node
            const rootNode = ctx.tree?.findKey('root-pipelines');
            if (rootNode) {
                const titleEl = rootNode.span?.querySelector('.wb-title');
                if (titleEl) {
                    // Remove any existing health badge
                    titleEl.querySelector('.pipeline-health-dot')?.remove();
                    const dot = document.createElement('span');
                    dot.className = 'pipeline-health-dot';
                    dot.title = healthTitle;
                    dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${healthColor};margin-left:6px;vertical-align:middle`;
                    titleEl.appendChild(dot);
                }
            }
        } catch { /* non-critical */ }
    }

    async function loadDagRuns(nodeKey) {
        const dagId = nodeKey.substring(4);
        try {
            const resp = await fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/runs?limit=10`);
            if (!resp.ok) return [];
            const data = await resp.json();
            const runs = data.runs || [];
            if (!runs.length) return [{ title: 'No DAG runs yet', key: `dagrun-empty:${dagId}`, icon: 'fa-solid fa-circle-info' }];
            return runs.map(r => {
                const si = _dagStateIcon(r.state);
                let dateStr = '';
                const dateSource = r.start_date || r.logical_date;
                if (dateSource) {
                    const d = new Date(dateSource);
                    dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
                }
                return {
                    title: `${dateStr} - ${cap(r.state)}`,
                    key: `dagrun:${dagId}:${r.dag_run_id}`,
                    icon: si.icon,
                    folder: true,
                    lazy: true,
                    _data: r,
                };
            });
        } catch { return []; }
    }

    async function loadDagRunTasks(nodeKey) {
        const rest = nodeKey.substring(7);
        const idx = rest.indexOf(':');
        const dagId = rest.substring(0, idx);
        const runId = rest.substring(idx + 1);
        try {
            const resp = await fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/runs/${encodeURIComponent(runId)}/tasks`);
            if (!resp.ok) return [];
            const data = await resp.json();
            const tasks = data.tasks || [];
            if (!tasks.length) return [{ title: 'No tasks', key: `dagtask-empty:${dagId}`, icon: 'fa-solid fa-circle-info' }];
            return tasks.map(t => {
                const si = _dagStateIcon(t.state);
                const mapped = t.map_index != null && t.map_index >= 0;
                const label = mapped ? `${t.task_id}[${t.map_index}]` : t.task_id;
                return {
                    title: `${label} (${cap(t.state || 'pending')})`,
                    key: `dagtask:${dagId}:${runId}:${t.task_id}${mapped ? ':' + t.map_index : ''}`,
                    icon: si.icon,
                    _data: t,
                };
            });
        } catch { return []; }
    }

    function showPipelinesRootDetail() {
        ctx.detailEl.innerHTML = '';
        
        const header = createDetailHeader('Orchestration', 'fa-solid fa-diagram-project');
        ctx.detailEl.appendChild(header);

        // Placeholder for health card (filled async)
        const cardPlaceholder = document.createElement('div');
        cardPlaceholder.className = 's3-object-card';
        cardPlaceholder.innerHTML = '<div class="s3-object-loading">Connecting...</div>';
        ctx.detailEl.appendChild(cardPlaceholder);

        const loading = document.createElement('div');
        loading.className = 's3-object-loading';
        loading.textContent = 'Loading pipelines...';
        ctx.detailEl.appendChild(loading);

        fetch('api/airflow/dags').then(r => r.json()).then(data => {
            const dags = data.dags || [];
            loading.remove();

            // Fill health card
            fetch('api/airflow/health').then(r => r.json()).then(h => {
                cardPlaceholder.innerHTML = '';
                addMetaRow(cardPlaceholder, 'Status', h.healthy
                    ? '<span style="color:#4caf50;font-weight:600">Connected</span>'
                    : `<span style="color:#f44336;font-weight:600">Unreachable</span>`);
                addMetaRow(cardPlaceholder, 'Pipelines', `${dags.length}`);
                addMetaRow(cardPlaceholder, 'Active', `${dags.filter(d => d.is_active && !d.is_paused).length}`);
                addMetaRow(cardPlaceholder, 'Paused', `${dags.filter(d => d.is_paused).length}`);
            }).catch(() => { cardPlaceholder.innerHTML = '<div class="s3-object-loading">Health check failed</div>'; });

            if (dags.length) {
                const titleEl = document.createElement('div');
                titleEl.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin:16px 0 8px;padding:0 8px';
                titleEl.textContent = 'All Pipelines';
                ctx.detailEl.appendChild(titleEl);

                const list = document.createElement('div');
                list.className = 's3-object-card';
                for (const dag of dags) {
                    const row = document.createElement('div');
                    row.className = 's3-meta-row';
                    row.style.cssText = 'cursor:pointer;align-items:center;gap:8px;padding:7px 12px';
                    const iconClass = dag.is_paused ? 'fa-circle-pause' : 'fa-diagram-project';
                    const iconColor = dag.is_paused ? '#ff9800' : '#5c9ce6';
                    row.innerHTML = `<i class="fa-solid ${iconClass}" style="font-size:12px;color:${iconColor};flex-shrink:0"></i>`
                        + `<span style="font-weight:500;color:#333">${escapeHtml(dag.dag_id)}</span>`
                        + `<span style="flex:1"></span>`
                        + `<span style="font-size:11px;color:#888">${dag.schedule}</span>`;
                    if (dag.tags.length) {
                        row.innerHTML += dag.tags.map(t =>
                            `<span style="font-size:9px;background:#e3f2fd;color:#1565c0;padding:1px 5px;border-radius:3px">${escapeHtml(t)}</span>`
                        ).join('');
                    }
                    row.addEventListener('click', () => {
                        const node = ctx.tree?.findKey(`dag:${dag.dag_id}`);
                        if (node) { node.setExpanded(true); node.setActive(true); }
                    });
                    row.addEventListener('mouseenter', () => { row.style.background = '#f5f5f5'; });
                    row.addEventListener('mouseleave', () => { row.style.background = ''; });
                    list.appendChild(row);
                }
                ctx.detailEl.appendChild(list);
            }
        }).catch(() => {
            loading.textContent = 'Failed to load pipelines';
        });
    }

    function showDagDetail(nodeKey, targetEl) {
        const dagId = nodeKey.substring(4);
        const el = targetEl || ctx.detailEl;
        el.innerHTML = '';
        addParentLabel(el, 'Orchestration');
        const node = ctx.tree?.findKey(nodeKey);
        const dagData = node?._data || {};
        const isPaused = dagData.is_paused;
        const header = createDetailHeader(dagId, isPaused ? 'fa-solid fa-circle-pause' : 'fa-solid fa-diagram-project');
        el.appendChild(header);

        // Quick info subtitle
        const subtitle = document.createElement('div');
        subtitle.style.cssText = 'font-size:11px;color:#888;margin:-6px 0 8px 30px;display:flex;gap:8px;align-items:center';
        if (dagData.schedule) subtitle.innerHTML = escapeHtml(dagData.schedule);
        if (dagData.tags?.length) subtitle.innerHTML += `<span style="color:#aaa">|</span> ` + dagData.tags.map(t =>
            `<span style="font-size:9px;background:#e3f2fd;color:#1565c0;padding:1px 5px;border-radius:3px">${escapeHtml(t)}</span>`
        ).join(' ');
        el.appendChild(subtitle);

        const loading = document.createElement('div');
        loading.className = 's3-object-loading';
        loading.textContent = 'Loading DAG details...';
        el.appendChild(loading);

        Promise.all([
            fetch(`api/airflow/dags/${encodeURIComponent(dagId)}`).then(r => r.json()),
            fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/runs?limit=10`).then(r => r.json()),
        ]).then(([dag, runsData]) => {
            loading.remove();

            // Info card
            const card = document.createElement('div');
            card.className = 's3-object-card';
            addMetaRow(card, 'Status', dag.is_paused
                ? '<span style="color:#ff9800;font-weight:600">Paused</span>'
                : '<span style="color:#4caf50;font-weight:600">Enabled</span>');
            if (dag.description) addMetaRow(card, 'Description', escapeHtml(dag.description));
            addMetaRow(card, 'Schedule', dag.schedule || 'None');
            if (dag.owners?.length) addMetaRow(card, 'Owners', dag.owners.join(', '));
            if (dag.tags?.length) addMetaRow(card, 'Tags', dag.tags.map(t =>
                `<span style="font-size:10px;background:#e3f2fd;color:#1565c0;padding:1px 5px;border-radius:3px;margin-right:4px">${escapeHtml(t)}</span>`
            ).join(''));
            if (dag.next_dagrun) addMetaRow(card, 'Next Run', new Date(dag.next_dagrun).toLocaleString());
            el.appendChild(card);

            // DAG Graph Visualization
            fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/structure`)
                .then(r => r.ok ? r.json() : null)
                .then(structure => {
                    if (!structure?.nodes?.length) return;
                    const graphTitle = document.createElement('div');
                    graphTitle.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin:16px 0 8px;padding:0 8px';
                    graphTitle.textContent = 'Task Graph';
                    const triggerEl = el.querySelector('.dag-trigger-section');
                    if (triggerEl) {
                        el.insertBefore(graphTitle, triggerEl);
                    } else {
                        el.appendChild(graphTitle);
                    }

                    const graphContainer = document.createElement('div');
                    graphContainer.style.cssText = 'margin:0 8px 12px;background:#fefefe;border-radius:4px;border:0.5px solid #e0e0e0;overflow:hidden';

                    if (triggerEl) {
                        el.insertBefore(graphContainer, triggerEl);
                    } else {
                        el.appendChild(graphContainer);
                    }

                    _renderDagGraph(graphContainer, structure, dagId);
                })
                .catch(() => {});

            // Trigger button
            const triggerSection = document.createElement('div');
            triggerSection.className = 'dag-trigger-section';
            triggerSection.style.cssText = 'margin-top:12px;padding:0 8px';
            const triggerBtn = document.createElement('button');
            triggerBtn.className = 'rm-btn';
            triggerBtn.style.cssText = 'display:flex;align-items:center;gap:6px';
            triggerBtn.innerHTML = '<i class="fa-solid fa-play" style="font-size:10px"></i> Run DAG';
            triggerBtn.addEventListener('click', () => showTriggerPanel(dagId));
            triggerSection.appendChild(triggerBtn);

            // Pause/Unpause button
            const pauseBtn = document.createElement('button');
            pauseBtn.className = 'rm-btn';
            pauseBtn.style.cssText = 'display:flex;align-items:center;gap:6px;margin-left:8px;background:#ffe0b2';
            pauseBtn.innerHTML = dag.is_paused
                ? '<i class="fa-solid fa-play" style="font-size:10px"></i> Unpause'
                : '<i class="fa-solid fa-pause" style="font-size:10px"></i> Pause';
            pauseBtn.addEventListener('click', async () => {
                try {
                    await fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/pause`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ is_paused: !dag.is_paused }),
                    });
                    notify.success(dag.is_paused ? 'DAG unpaused' : 'DAG paused');
                    // Update tree node icon
                    const dagNode = ctx.tree?.findKey(nodeKey);
                    if (dagNode) {
                        dagNode.icon = dag.is_paused ? 'fa-solid fa-diagram-project' : 'fa-solid fa-circle-pause';
                        dagNode._data = { ...dagNode._data, is_paused: !dag.is_paused };
                        dagNode.update();
                    }
                    showDagDetail(nodeKey, el); // Refresh detail
                } catch (e) { notify.error(e.message); }
            });
            // Validate button (disabled - to be moved to DAG file editor in future)
            const validateBtn = document.createElement('button');
            validateBtn.className = 'rm-btn';
            validateBtn.style.cssText = 'display:none';
            validateBtn.addEventListener('click', async () => {
                validateBtn.disabled = true;
                validateBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="font-size:10px"></i> Checking...';
                try {
                    // Fetch DAG source file and validate
                    const dagFileResp = await fetch(`api/airflow/dags/${encodeURIComponent(dagId)}`);
                    const dagInfo = await dagFileResp.json();
                    const filePath = dagInfo.file_loc || dagInfo.fileloc || '';
                    // Read DAG file content
                    let content = '';
                    if (filePath) {
                        const fResp = await fetch(`api/files/read?path=${encodeURIComponent(filePath)}`);
                        if (fResp.ok) content = (await fResp.json()).content || '';
                    }
                    if (!content) { notify('Could not read DAG file', 'warning'); return; }
                    const vResp = await fetch('api/airflow/validate-dag', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content }),
                    });
                    const result = await vResp.json();
                    const warnings = result.warnings || [];
                    // Show results
                    let existingResults = el.querySelector('.dag-validation-results');
                    if (existingResults) existingResults.remove();
                    const resultsEl = document.createElement('div');
                    resultsEl.className = 'dag-validation-results';
                    resultsEl.style.cssText = 'margin:8px 8px 0;padding:8px 12px;background:#fafafa;border:0.5px solid #e0e0e0;border-radius:4px;font-size:11px';
                    for (const w of warnings) {
                        const icon = w.level === 'error' ? 'fa-circle-xmark' : w.level === 'warning' ? 'fa-triangle-exclamation' : 'fa-circle-check';
                        const color = w.level === 'error' ? '#f44336' : w.level === 'warning' ? '#ff9800' : '#4caf50';
                        const row = document.createElement('div');
                        row.style.cssText = 'padding:3px 0;display:flex;gap:6px;align-items:start';
                        row.innerHTML = `<i class="fa-solid ${icon}" style="color:${color};margin-top:2px;flex-shrink:0"></i><span>${escapeHtml(w.message)}</span>`;
                        resultsEl.appendChild(row);
                    }
                    triggerSection.after(resultsEl);
                } catch (e) { notify(`Validation failed: ${e.message}`, 'danger'); }
                validateBtn.disabled = false;
                validateBtn.innerHTML = '<i class="fa-solid fa-check-double" style="font-size:10px"></i> Validate';
            });

            triggerSection.style.display = 'flex';
            triggerSection.appendChild(pauseBtn);
            triggerSection.appendChild(validateBtn);
            el.appendChild(triggerSection);

            // Schedule section
            const schedSection = document.createElement('div');
            schedSection.style.cssText = 'margin:12px 8px 0;padding:8px 12px;background:#fafafa;border:0.5px solid #e0e0e0;border-radius:4px';
            const schedTitle = document.createElement('div');
            schedTitle.style.cssText = 'font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin-bottom:6px';
            schedTitle.textContent = 'Schedule';
            schedSection.appendChild(schedTitle);

            const schedRow = document.createElement('div');
            schedRow.style.cssText = 'display:flex;align-items:center;gap:6px';
            const schedInput = document.createElement('input');
            schedInput.type = 'text';
            schedInput.style.cssText = 'flex:1;padding:4px 8px;font-size:12px;border:0.5px solid #c8c8c8;border-radius:4px;font-family:var(--font-mono);color:#333';
            schedInput.placeholder = 'e.g. 0 */6 * * * or @daily';
            schedRow.appendChild(schedInput);

            const schedSaveBtn = document.createElement('button');
            schedSaveBtn.className = 'rm-btn';
            schedSaveBtn.style.cssText = 'padding:4px 10px;font-size:11px';
            schedSaveBtn.textContent = 'Set';
            schedRow.appendChild(schedSaveBtn);

            const schedClearBtn = document.createElement('button');
            schedClearBtn.className = 'rm-btn';
            schedClearBtn.style.cssText = 'padding:4px 10px;font-size:11px;background:#ffcdd2';
            schedClearBtn.textContent = 'Clear';
            schedRow.appendChild(schedClearBtn);
            schedSection.appendChild(schedRow);

            // Visual cron builder
            const cronBuilder = document.createElement('div');
            cronBuilder.style.cssText = 'margin-top:8px;display:flex;flex-wrap:wrap;gap:4px';
            const presets = [
                { label: '@hourly', cron: '@hourly' },
                { label: '@daily', cron: '@daily' },
                { label: '@weekly', cron: '@weekly' },
                { label: 'Every 6h', cron: '0 */6 * * *' },
                { label: 'Every 12h', cron: '0 */12 * * *' },
                { label: 'Weekdays 9am', cron: '0 9 * * 1-5' },
            ];
            for (const p of presets) {
                const btn = document.createElement('button');
                btn.className = 'rm-btn';
                btn.style.cssText = 'padding:2px 8px;font-size:10px;background:#e8eaf6';
                btn.textContent = p.label;
                btn.addEventListener('click', () => { schedInput.value = p.cron; });
                cronBuilder.appendChild(btn);
            }
            schedSection.appendChild(cronBuilder);

            const schedNote = document.createElement('div');
            schedNote.style.cssText = 'font-size:10px;color:#999;margin-top:4px';
            schedNote.textContent = 'Changes take effect on the next DAG parse cycle (~30s). DAG must use Variable.get() pattern.';
            schedSection.appendChild(schedNote);
            el.appendChild(schedSection);

            // Load current schedule
            fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/schedule`)
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                    if (data?.schedule) schedInput.value = data.schedule;
                }).catch(() => {});

            schedSaveBtn.addEventListener('click', async () => {
                const val = schedInput.value.trim();
                if (!val) return;
                try {
                    await fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/schedule`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ schedule: val }),
                    });
                    notify.success(`Schedule set: ${val}`);
                } catch (e) { notify.error(e.message); }
            });

            schedClearBtn.addEventListener('click', async () => {
                try {
                    await fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/schedule`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ schedule: null }),
                    });
                    schedInput.value = '';
                    notify.success('Schedule cleared');
                } catch (e) { notify.error(e.message); }
            });

            // Recent runs
            const runs = runsData.runs || [];
            if (runs.length) {
                const titleEl = document.createElement('div');
                titleEl.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin:16px 0 8px;padding:0 8px';
                titleEl.textContent = `DAG Run History (${runs.length})`;
                el.appendChild(titleEl);

                // History table
                const table = document.createElement('table');
                table.style.cssText = 'width:100%;border-collapse:collapse;font-size:11px;margin:0 8px;';
                table.style.width = 'calc(100% - 16px)';
                const thead = document.createElement('thead');
                thead.innerHTML = `<tr>
                    <th style="text-align:left;padding:6px 8px;background:#bfdcff;font-weight:600;border:0.5px solid #e0e0e0;width:30px"></th>
                    <th style="text-align:left;padding:6px 8px;background:#bfdcff;font-weight:600;border:0.5px solid #e0e0e0">Started</th>
                    <th style="text-align:left;padding:6px 8px;background:#bfdcff;font-weight:600;border:0.5px solid #e0e0e0">Duration</th>
                    <th style="text-align:left;padding:6px 8px;background:#bfdcff;font-weight:600;border:0.5px solid #e0e0e0">State</th>
                    <th style="text-align:left;padding:6px 8px;background:#bfdcff;font-weight:600;border:0.5px solid #e0e0e0">Lineage</th>
                </tr>`;
                table.appendChild(thead);

                const tbody = document.createElement('tbody');
                for (const run of runs) {
                    const si = _dagStateIcon(run.state);
                    let dateStr = '-';
                    if (run.start_date) {
                        const d = new Date(run.start_date);
                        dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
                    }
                    const durStr = run.duration != null ? `${run.duration.toFixed(1)}s` : '-';
                    const tr = document.createElement('tr');
                    tr.style.cssText = 'cursor:pointer';
                    tr.addEventListener('mouseenter', () => { tr.style.background = '#f5f5f5'; });
                    tr.addEventListener('mouseleave', () => { tr.style.background = ''; });
                    // Double-click navigates to run in tree
                    tr.addEventListener('dblclick', () => {
                        const node = ctx.tree?.findKey(`dagrun:${dagId}:${run.dag_run_id}`);
                        if (node) node.setActive(true);
                    });

                    // Build lineage chips for the last column
                    const conf = run.conf || {};
                    const hydraHash = conf.hydra_config_hash || '';
                    const mlflowId = run.mlflow_run_id || '';
                    const dvcDatasets = conf._dvc_datasets || [];

                    tr.innerHTML = `
                        <td style="padding:6px 8px;border:0.5px solid #f0f0f0;text-align:center"><i class="fa-solid ${si.icon}" style="font-size:11px;color:${si.color}"></i></td>
                        <td style="padding:6px 8px;border:0.5px solid #f0f0f0;font-family:var(--font-mono);font-size:10px">${dateStr}</td>
                        <td style="padding:6px 8px;border:0.5px solid #f0f0f0;font-family:var(--font-mono);font-size:10px">${durStr}</td>
                        <td style="padding:6px 8px;border:0.5px solid #f0f0f0;font-weight:500;color:${si.color}">${escapeHtml(cap(run.state || 'unknown'))}</td>
                        <td style="padding:6px 8px;border:0.5px solid #f0f0f0"></td>`;
                    tbody.appendChild(tr);

                    // Populate lineage cell with chips
                    const lineageTd = tr.querySelector('td:last-child');
                    const chipRow = document.createElement('div');
                    chipRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;align-items:center';

                    const chipBase = 'display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:10px;font-size:9px;cursor:default';
                    const hashStyle = 'font-family:var(--font-mono)';

                    if (mlflowId) {
                        const chip = document.createElement('a');
                        chip.href = '#';
                        chip.className = 'mlflow-run-link';
                        chip.dataset.runId = mlflowId;
                        chip.style.cssText = chipBase + ';background:#e3f2fd;color:#1565c0;text-decoration:none;border:0.5px solid #bbdefb;cursor:pointer';
                        chip.innerHTML = `<i class="fa-solid fa-flask" style="font-size:9px"></i><span style="${hashStyle}">${escapeHtml(mlflowId.substring(0, 10))}</span>`;
                        chip.title = `MLflow Run: ${mlflowId}\nClick to navigate`;
                        chipRow.appendChild(chip);
                    }
                    if (hydraHash) {
                        const shortHash = hydraHash.startsWith('sha256:') ? hydraHash.substring(7, 19) : hydraHash.substring(0, 12);
                        const chip = document.createElement('span');
                        chip.style.cssText = chipBase + ';background:#f3e5f5;color:#7b1fa2;border:0.5px solid #e1bee7';
                        chip.innerHTML = `<i class="fa-solid fa-sliders" style="font-size:9px"></i><span style="${hashStyle}">${escapeHtml(shortHash)}</span>`;
                        chip.title = `Hydra Config:\n${hydraHash}`;
                        chipRow.appendChild(chip);
                    }
                    for (const ds of dvcDatasets) {
                        const shortHash = (ds.hash || '').substring(0, 8);
                        const fileName = ds.path.split('/').pop();
                        const chip = document.createElement('span');
                        chip.style.cssText = chipBase + ';background:#e0f2f1;color:#00695c;border:0.5px solid #b2dfdb';
                        chip.innerHTML = `<i class="fa-solid fa-database" style="font-size:8px"></i><span style="${hashStyle}">${escapeHtml(fileName)}</span><span style="${hashStyle};opacity:0.5">${shortHash}</span>`;
                        chip.title = `DVC Dataset: ${ds.path}\nHash: ${ds.hash || '?'}`;
                        chipRow.appendChild(chip);
                    }
                    if (chipRow.childNodes.length) {
                        lineageTd.appendChild(chipRow);
                    } else {
                        lineageTd.style.color = '#999';
                        lineageTd.textContent = '-';
                    }
                }
                table.appendChild(tbody);
                el.appendChild(table);

                // Wire up MLflow links
                table.querySelectorAll('.mlflow-run-link').forEach(link => {
                    link.addEventListener('click', async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const runId = link.dataset.runId;

                        // Try direct lookup first (already expanded)
                        let runNode = ctx.tree?.findFirst(n => n.key?.includes(runId));
                        if (runNode) { runNode.setActive(true); return; }

                        // Expand experiments root, then find and expand the matching experiment
                        const root = ctx.tree?.findKey('root-experiments');
                        if (!root) return;
                        await root.setExpanded(true);

                        // Find the experiment that contains this run by trying each one
                        for (const expNode of root.children || []) {
                            await expNode.setExpanded(true);
                            runNode = ctx.tree?.findFirst(n => n.key?.includes(runId));
                            if (runNode) { runNode.setActive(true); return; }
                        }
                        notify.info(`MLflow run ${runId.substring(0, 8)} not found in experiments`);
                    });
                });
            }
        }).catch(() => {
            loading.textContent = 'Failed to load DAG details';
        });
    }

    function showDagRunDetail(nodeKey, targetEl) {
        const rest = nodeKey.substring(7);
        const idx = rest.indexOf(':');
        const dagId = rest.substring(0, idx);
        const runId = rest.substring(idx + 1);
        const el = targetEl || ctx.detailEl;

        el.innerHTML = '';
        addParentLabel(el, 'Orchestration');
        const header = createDetailHeader(runId, 'fa-solid fa-clock');
        el.appendChild(header);

        const loading = document.createElement('div');
        loading.className = 's3-object-loading';
        loading.textContent = 'Loading run details...';
        el.appendChild(loading);

        Promise.all([
            fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/runs/${encodeURIComponent(runId)}`).then(r => r.json()),
            fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/runs/${encodeURIComponent(runId)}/tasks`).then(r => r.json()),
        ]).then(([run, tasksData]) => {
            loading.remove();

            const stateInfo = _dagStateIcon(run.state);
            // Update header icon with actual state
            const headerIcon = header.querySelector('i');
            if (headerIcon) {
                headerIcon.className = `fa-solid ${stateInfo.icon}`;
                headerIcon.style.color = stateInfo.color;
            }
            const card = document.createElement('div');
            card.className = 's3-object-card';
            addMetaRow(card, 'State', `<span style="color:${stateInfo.color};font-weight:600">${cap(run.state)}</span>`);
            addMetaRow(card, 'Run ID', `<span class="mono" style="font-size:11px">${escapeHtml(run.dag_run_id || runId)}</span>`);
            if (run.logical_date) addMetaRow(card, 'Logical Date', new Date(run.logical_date).toLocaleString());
            if (run.start_date) addMetaRow(card, 'Started', new Date(run.start_date).toLocaleString());
            if (run.end_date) addMetaRow(card, 'Ended', new Date(run.end_date).toLocaleString());
            if (run.conf && Object.keys(run.conf).length) {
                addMetaRow(card, 'Config', `<pre style="margin:0;font-size:11px;font-family:var(--font-mono)">${escapeHtml(JSON.stringify(run.conf, null, 2))}</pre>`);
            }
            el.appendChild(card);

            // Stop button for running/queued DAG runs
            if (run.state === 'running' || run.state === 'queued') {
                const actionBar = document.createElement('div');
                actionBar.style.cssText = 'display:flex;gap:8px;margin:8px 0;padding:0 4px';
                const stopBtn = document.createElement('button');
                stopBtn.className = 'info-bar-text-btn';
                stopBtn.style.cssText = 'display:flex;align-items:center;gap:4px;padding:4px 12px;background:#d32f2f;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px';
                stopBtn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop Run';
                stopBtn.addEventListener('click', async () => {
                    stopBtn.disabled = true;
                    stopBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Stopping...';
                    try {
                        const resp = await fetch(
                            `api/airflow/dags/${encodeURIComponent(dagId)}/runs/${encodeURIComponent(runId)}/stop`,
                            { method: 'PATCH' }
                        );
                        if (!resp.ok) {
                            const err = await resp.json().catch(() => ({}));
                            throw new Error(err.detail || 'Failed to stop');
                        }
                        notify.success('DAG run stopped');
                        // Refresh the detail page to reflect the new state
                        showDagRunDetail(nodeKey, el);
                    } catch (err) {
                        notify.error(`Failed to stop run: ${err.message}`);
                        stopBtn.disabled = false;
                        stopBtn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop Run';
                    }
                });
                actionBar.appendChild(stopBtn);
                el.appendChild(actionBar);
            }

            // DAG Graph with task states
            const tasks = tasksData.tasks || [];
            const taskStates = {};
            for (const t of tasks) {
                taskStates[t.task_id] = t.state || 'pending';
            }
            fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/structure`)
                .then(r => r.ok ? r.json() : null)
                .then(structure => {
                    if (!structure?.nodes?.length) return;
                    const graphTitle = document.createElement('div');
                    graphTitle.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin:16px 0 8px;padding:0 8px';
                    graphTitle.textContent = 'Task Graph';
                    const taskSection = el.querySelector('.dag-tasks-section');
                    if (taskSection) {
                        el.insertBefore(graphTitle, taskSection);
                    } else {
                        el.appendChild(graphTitle);
                    }
                    const graphContainer = document.createElement('div');
                    graphContainer.style.cssText = 'margin:0 8px 12px;background:#fefefe;border-radius:4px;border:0.5px solid #e0e0e0;overflow:hidden';
                    if (taskSection) {
                        el.insertBefore(graphContainer, taskSection);
                    } else {
                        el.appendChild(graphContainer);
                    }
                    _renderDagGraph(graphContainer, structure, dagId, taskStates, runId);
                })
                .catch(() => {});

            // Task instances
            if (tasks.length) {
                const tasksSection = document.createElement('div');
                tasksSection.className = 'dag-tasks-section';
                const titleEl = document.createElement('div');
                titleEl.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin:16px 0 8px;padding:0 8px';
                titleEl.textContent = `Tasks (${tasks.length})`;
                tasksSection.appendChild(titleEl);

                // Sort tasks by start_date for execution order
                tasks.sort((a, b) => {
                    if (!a.start_date && !b.start_date) return 0;
                    if (!a.start_date) return 1;
                    if (!b.start_date) return -1;
                    return new Date(a.start_date) - new Date(b.start_date);
                });

                const list = document.createElement('div');
                list.className = 's3-object-card';
                for (const task of tasks) {
                    const tsi = _dagStateIcon(task.state);
                    const duration = task.duration != null ? `${task.duration.toFixed(1)}s` : '-';
                    let timeStr = '';
                    if (task.start_date) {
                        const d = new Date(task.start_date);
                        timeStr = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
                    }
                    const row = document.createElement('div');
                    row.className = 's3-meta-row';
                    row.style.cssText = 'cursor:pointer;align-items:center;gap:8px;padding:7px 12px';
                    row.innerHTML = (timeStr ? `<span style="font-family:var(--font-mono);font-size:10px;color:#888;flex-shrink:0">${timeStr}</span>` : '')
                        + `<i class="fa-solid ${tsi.icon}" style="font-size:12px;color:${tsi.color};flex-shrink:0"></i>`
                        + `<span style="font-weight:500;color:#333">${escapeHtml(task.task_id)}</span>`
                        + `<span style="font-size:11px;color:#888">${task.operator || ''}</span>`
                        + `<span style="flex:1"></span>`
                        + `<span style="font-family:var(--font-mono);font-size:10px;color:#888;flex-shrink:0">${duration}</span>`;
                    row.addEventListener('click', () => {
                        _showTaskLog(dagId, runId, task.task_id, task.try_number || 1, null, task.state);
                    });
                    row.addEventListener('mouseenter', () => { row.style.background = '#f5f5f5'; });
                    row.addEventListener('mouseleave', () => { row.style.background = ''; });
                    list.appendChild(row);
                }
                tasksSection.appendChild(list);
                el.appendChild(tasksSection);
            }
        }).catch(() => {
            loading.textContent = 'Failed to load run details';
        });
    }

    function showDagTaskDetail(nodeKey, targetEl) {
        const rest = nodeKey.substring(8); // remove 'dagtask:'
        const firstColon = rest.indexOf(':');
        const lastColon = rest.lastIndexOf(':');
        const dagId = rest.substring(0, firstColon);
        const taskId = rest.substring(lastColon + 1);
        const runId = rest.substring(firstColon + 1, lastColon);
        const el = targetEl || ctx.detailEl;
        // Fetch task state to enable live polling
        fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/runs/${encodeURIComponent(runId)}/tasks`)
            .then(r => r.json())
            .then(data => {
                const tasks = data.tasks || data.task_instances || [];
                const task = tasks.find(t => t.task_id === taskId);
                _showTaskLog(dagId, runId, taskId, task?.try_number || 1, el, task?.state);
            })
            .catch(() => _showTaskLog(dagId, runId, taskId, 1, el));
    }

    function _showTaskLog(dagId, runId, taskId, tryNumber, targetEl, taskState) {
        const el = targetEl || ctx.detailEl;
        el.innerHTML = '';
        addParentLabel(el, 'Orchestration');
        const header = createDetailHeader(taskId, 'fa-solid fa-terminal');
        el.appendChild(header);

        // Action bar: copy log + retry (if failed)
        const actionBar = document.createElement('div');
        actionBar.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;padding:0 4px';

        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn btn-sm btn-outline-secondary';
        copyBtn.innerHTML = '<i class="fa-solid fa-copy" style="margin-right:4px"></i>Copy Log';
        copyBtn.style.cssText = 'font-size:11px;padding:3px 10px;background:#d0e8ff;border-color:#a0c4e8';
        copyBtn.disabled = true;
        actionBar.appendChild(copyBtn);

        const failedStates = ['failed', 'upstream_failed'];
        if (taskState && failedStates.includes(taskState)) {
            const retryBtn = document.createElement('button');
            retryBtn.className = 'btn btn-sm btn-outline-warning';
            retryBtn.innerHTML = '<i class="fa-solid fa-rotate-right" style="margin-right:4px"></i>Retry Task';
            retryBtn.style.cssText = 'font-size:11px;padding:3px 10px';
            retryBtn.addEventListener('click', () => {
                retryBtn.disabled = true;
                retryBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:4px"></i>Retrying...';
                fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/clear`, { method: 'POST' })
                    .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
                    .then(() => {
                        notify('Task queued for retry', 'success');
                        retryBtn.innerHTML = '<i class="fa-solid fa-check" style="margin-right:4px"></i>Queued';
                    })
                    .catch(err => {
                        notify(`Retry failed: ${err.message}`, 'danger');
                        retryBtn.disabled = false;
                        retryBtn.innerHTML = '<i class="fa-solid fa-rotate-right" style="margin-right:4px"></i>Retry Task';
                    });
            });
            actionBar.appendChild(retryBtn);
        }

        // Ask Assistant about this task
        const askLogBtn = document.createElement('button');
        askLogBtn.className = 'btn btn-sm btn-outline-success';
        askLogBtn.innerHTML = '<i class="fa-solid fa-comment" style="margin-right:4px"></i>Ask Assistant';
        askLogBtn.style.cssText = 'font-size:11px;padding:3px 10px;background:#c8e6c0;border-color:#a0c8a0';
        askLogBtn.addEventListener('click', () => {
            const logPre = el.querySelector('pre');
            const logSnippet = logPre ? logPre.textContent.slice(-1000) : '';
            const stateInfo = taskState === 'failed' ? 'This task FAILED. ' : '';
            document.dispatchEvent(new CustomEvent('ask-assistant', {
                detail: { message: `${stateInfo}Explain the log for task "${taskId}" in DAG "${dagId}":\n\`\`\`\n${logSnippet}\n\`\`\`` }
            }));
        });
        actionBar.appendChild(askLogBtn);

        el.appendChild(actionBar);

        const loading = document.createElement('div');
        loading.className = 's3-object-loading';
        loading.textContent = 'Loading log...';
        el.appendChild(loading);

        fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/logs?try_number=${tryNumber}`)
            .then(r => r.json()).then(data => {
                loading.remove();
                let logText = data.log || 'No log content available';
                // Prevent double scrollbars: detail pane handles layout, xterm handles its own scroll
                el.style.overflow = 'hidden';
                el.style.display = 'flex';
                el.style.flexDirection = 'column';
                const termContainer = document.createElement('div');
                termContainer.className = 'dag-log-term';
                termContainer.style.cssText = 'flex:1;min-height:200px;border-radius:4px;overflow:hidden';
                el.appendChild(termContainer);

                const inlineTheme = getTerminalTheme();
                termContainer.style.background = inlineTheme.background;

                Promise.all([
                    document.fonts.load('12px "MesloLGS NF"'),
                    document.fonts.load('bold 12px "MesloLGS NF"'),
                ]).catch(() => {}).then(() => {
                    const term = new Terminal({
                        convertEol: true,
                        cursorBlink: false,
                        disableStdin: true,
                        fontSize: 12,
                        fontFamily: '"MesloLGS NF", "JetBrains Mono", "Fira Code", "Consolas", monospace',
                        theme: { ...inlineTheme, cursor: 'transparent' },
                        cols: 120, scrollback: 5000, allowProposedApi: true,
                    });
                    onTerminalThemeChange((t) => {
                        term.options.theme = { ...t, cursor: 'transparent' };
                        termContainer.style.background = t.background;
                    });
                    term.open(termContainer);

                    // Fit terminal to container
                    const fitTerminal = () => {
                        const dims = term._core._renderService.dimensions;
                        if (!dims || !dims.css?.cell?.height || !dims.css?.cell?.width) return;
                        const cols = Math.max(20, Math.floor(termContainer.clientWidth / dims.css.cell.width));
                        const rows = Math.max(4, Math.floor(termContainer.clientHeight / dims.css.cell.height));
                        if (rows !== term.rows || cols !== term.cols) term.resize(cols, rows);
                    };
                    const resizeObs = new ResizeObserver(() => fitTerminal());
                    resizeObs.observe(termContainer);
                    fitTerminal();

                    // Write initial log
                    let writtenLines = 0;
                    const writeNewLines = (text) => {
                        const lines = text.split('\n');
                        for (let i = writtenLines; i < lines.length; i++) {
                            term.writeln(lines[i]);
                        }
                        writtenLines = lines.length;
                    };
                    writeNewLines(logText);
                    term.scrollToTop();

                    // Poll for updates while task is running
                    const isRunning = taskState === 'running' || taskState === 'queued' || taskState === 'up_for_retry';
                    if (isRunning) {
                        const pollUrl = `api/airflow/dags/${encodeURIComponent(dagId)}/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/logs?try_number=${tryNumber}`;
                        const poll = setInterval(async () => {
                            // Stop polling if element was removed from DOM
                            if (!termContainer.isConnected) { clearInterval(poll); return; }
                            try {
                                const resp = await fetch(pollUrl);
                                if (!resp.ok) return;
                                const d = await resp.json();
                                const newText = d.log || '';
                                if (newText.length > logText.length) {
                                    logText = newText;
                                    writeNewLines(logText);
                                }
                            } catch {}
                        }, 3000);
                    }
                });

                // Enable copy button now that log is loaded
                copyBtn.disabled = false;
                copyBtn.addEventListener('click', () => {
                    navigator.clipboard.writeText(logText).then(() => {
                        const orig = copyBtn.innerHTML;
                        copyBtn.innerHTML = '<i class="fa-solid fa-check" style="margin-right:4px"></i>Copied';
                        copyBtn.disabled = true;
                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                copyBtn.innerHTML = orig;
                                copyBtn.disabled = false;
                            });
                        });
                    });
                });
            }).catch(() => {
                loading.textContent = 'Failed to load log';
            });
    }

    function showTriggerPanel(dagId) {
        const offset = (window._triggerCount = (window._triggerCount || 0) + 1);

        const panel = jsPanel.create({
            headerTitle: `<i class="fa-solid fa-play" style="font-size:11px;margin-right:6px"></i>Run DAG: ${dagId}`,
            theme: '#ffe39e filled',
            borderRadius: '5px',
            contentSize: { width: Math.min(1000, window.innerWidth - 80), height: Math.min(520, window.innerHeight - 100) },
            position: { my: 'center', at: 'center', offsetX: offset * 20, offsetY: offset * 20 },
            headerControls: 'closeonly',
            content: '<div class="trigger-panel-content"></div>',
            callback: (p) => { p.content.style.backgroundColor = '#fefefe'; },
            onclosed: () => { window._triggerCount = Math.max(0, (window._triggerCount || 1) - 1); },
        });

        const container = panel.content.querySelector('.trigger-panel-content');
        container.className = 'trigger-panel-content explorer-detail-content';
        container.style.cssText = 'height:100%;overflow-y:auto;padding:16px;font-size:12px';

        // Helper: flatten composed Hydra config to DAG param names
        function _flattenHydra(resolved, hash) {
            const flat = {};
            if (resolved.model) {
                if (resolved.model.type) flat['model_type'] = resolved.model.type;
                if (resolved.model.units1 != null) flat['units1'] = resolved.model.units1;
                if (resolved.model.units2 != null) flat['units2'] = resolved.model.units2;
                if (resolved.model.dropout != null) flat['dropout'] = resolved.model.dropout;
            }
            if (resolved.training) {
                if (resolved.training.epochs != null) flat['epochs'] = resolved.training.epochs;
                if (resolved.training.batch_size != null) flat['batch_size'] = resolved.training.batch_size;
                if (resolved.training.learning_rate != null) flat['learning_rate'] = resolved.training.learning_rate;
            }
            if (hash) flat['hydra_config_hash'] = hash;
            return flat;
        }

        // Helper: apply flat config to param input fields
        function _applyToInputs(flat, paramInputs) {
            for (const [key, inputEl] of Object.entries(paramInputs)) {
                if (key in flat) {
                    const v = flat[key];
                    if (inputEl.type === 'checkbox') {
                        inputEl.checked = v === true || v === 'true';
                    } else if (inputEl.tagName === 'SELECT') {
                        inputEl.value = String(v);
                    } else {
                        inputEl.value = typeof v === 'object' ? JSON.stringify(v) : String(v);
                    }
                }
            }
        }

        // Load DAG params
        let hashRowPlaceholder = null;
        fetch(`api/airflow/dags/${encodeURIComponent(dagId)}`).then(r => r.json()).then(dag => {
            const params = dag.params || {};
            const paramInputs = {};

            // Hydra config group selectors (if project has Hydra config)
            const projectTag = dag.tags?.find(t => t !== 'noted' && t !== 'training') || '';
            const hydraProjectId = projectTag || '';

            if (hydraProjectId) {
                fetch(`api/hydra/schema/${encodeURIComponent(hydraProjectId)}`).then(r => r.ok ? r.json() : null).then(schema => {
                    if (!schema?.has_config || !schema.groups || !Object.keys(schema.groups).length) return;

                    const hydraTitle = document.createElement('div');
                    hydraTitle.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin-bottom:8px';
                    hydraTitle.textContent = 'Hydra Configuration';
                    container.insertBefore(hydraTitle, container.firstChild);

                    const hydraSelects = {};
                    const hydraRow = document.createElement('div');
                    hydraRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:4px;align-items:center';

                    // Sort groups: more options first
                    const sortedGroups = Object.entries(schema.groups).sort((a, b) => (b[1].options?.length || 0) - (a[1].options?.length || 0));
                    for (const [group, info] of sortedGroups) {
                        const label = document.createElement('span');
                        label.style.cssText = 'font-weight:500;color:#333;font-size:11px';
                        label.textContent = group + ':';
                        hydraRow.appendChild(label);
                        const select = document.createElement('select');
                        select.style.cssText = 'padding:4px 10px;font-size:12px;min-width:120px;border:0.5px solid #c8c8c8;border-radius:4px;color:#222';
                        for (const opt of info.options) {
                            const o = document.createElement('option');
                            o.value = opt;
                            o.textContent = opt + (info.default === opt ? ' *' : '');
                            if (info.default === opt) o.selected = true;
                            select.appendChild(o);
                        }
                        hydraRow.appendChild(select);
                        hydraSelects[group] = select;
                    }

                    // Custom checkbox
                    const customLabel = document.createElement('label');
                    customLabel.style.cssText = 'display:flex;align-items:center;gap:4px;margin-left:12px;font-size:11px;color:#555;cursor:pointer';
                    const customCb = document.createElement('input');
                    customCb.type = 'checkbox';
                    customCb.style.cssText = 'cursor:pointer';
                    customLabel.appendChild(customCb);
                    customLabel.appendChild(document.createTextNode('Custom'));
                    hydraRow.appendChild(customLabel);

                    container.insertBefore(hydraRow, hydraTitle.nextSibling);

                    // Placeholder for hydra_config_hash row (moved from params section)
                    hashRowPlaceholder = document.createElement('div');
                    hashRowPlaceholder.style.cssText = 'margin-bottom:12px';
                    container.insertBefore(hashRowPlaceholder, hydraRow.nextSibling);

                    // Toggle custom mode
                    function setCustomMode(custom) {
                        for (const sel of Object.values(hydraSelects)) sel.disabled = custom;
                        for (const [key, inputEl] of Object.entries(paramInputs)) {
                            if (key === 'hydra_config_hash') {
                                inputEl.disabled = !custom;
                                inputEl.style.opacity = custom ? '1' : '0.6';
                            } else {
                                inputEl.disabled = !custom;
                                inputEl.style.opacity = custom ? '1' : '0.6';
                            }
                        }
                    }

                    customCb.addEventListener('change', () => {
                        setCustomMode(customCb.checked);
                        if (!customCb.checked) composeAndApply();
                    });

                    // Compose and apply on change
                    async function composeAndApply() {
                        if (customCb.checked) return;
                        const selections = {};
                        for (const [g, sel] of Object.entries(hydraSelects)) selections[g] = sel.value;
                        try {
                            const resp = await fetch('api/hydra/compose', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ project_id: hydraProjectId, group_selections: selections }),
                            });
                            if (!resp.ok) return;
                            const data = await resp.json();
                            _applyToInputs(_flattenHydra(data.resolved || {}, data.hash || ''), paramInputs);
                        } catch {}
                    }

                    for (const sel of Object.values(hydraSelects)) {
                        sel.addEventListener('change', composeAndApply);
                    }

                    // Move hydra_config_hash row to after Hydra selects
                    const hashInput = paramInputs['hydra_config_hash'];
                    if (hashInput && hashRowPlaceholder) {
                        const hashRow = hashInput.closest('div');
                        if (hashRow) hashRowPlaceholder.appendChild(hashRow);
                    }

                    // Auto-compose on open and lock inputs to Hydra mode
                    composeAndApply().then(() => setCustomMode(false));
                }).catch(() => {});
            }

            if (Object.keys(params).length) {
                const titleEl = document.createElement('div');
                titleEl.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin-bottom:8px';
                titleEl.textContent = 'DAG Parameters';
                container.appendChild(titleEl);

                for (const [key, schema] of Object.entries(params)) {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px';
                    const label = document.createElement('div');
                    label.style.cssText = 'min-width:120px;flex-shrink:0';
                    label.innerHTML = `<div style="font-weight:500;color:#333;font-family:var(--font-mono);font-size:11px">${escapeHtml(key)}</div>`
                        + (schema?.description ? `<div style="font-size:10px;color:#888;margin-top:1px">${escapeHtml(schema.description)}</div>` : '');
                    row.appendChild(label);

                    const pType = schema?.type || 'string';
                    const defaultVal = schema?.value ?? schema?.default ?? '';
                    const inputStyle = 'flex:1;padding:4px 8px;font-size:12px;border:0.5px solid #c8c8c8;border-radius:4px;font-family:var(--font-mono);color:#333';
                    let inputEl;

                    if (schema?.enum || schema?.values) {
                        // Dropdown for enum values
                        inputEl = document.createElement('select');
                        inputEl.style.cssText = inputStyle;
                        for (const opt of (schema.enum || schema.values)) {
                            const o = document.createElement('option');
                            o.value = opt;
                            o.textContent = opt;
                            if (String(opt) === String(defaultVal)) o.selected = true;
                            inputEl.appendChild(o);
                        }
                    } else if (pType === 'boolean') {
                        // Checkbox for booleans
                        inputEl = document.createElement('input');
                        inputEl.type = 'checkbox';
                        inputEl.checked = defaultVal === true || defaultVal === 'true';
                        inputEl.style.cssText = 'width:16px;height:16px;cursor:pointer';
                    } else if (pType === 'integer') {
                        inputEl = document.createElement('input');
                        inputEl.type = 'number';
                        inputEl.step = '1';
                        if (schema?.minimum != null) inputEl.min = schema.minimum;
                        if (schema?.maximum != null) inputEl.max = schema.maximum;
                        inputEl.style.cssText = inputStyle;
                        inputEl.value = defaultVal;
                    } else if (pType === 'number') {
                        inputEl = document.createElement('input');
                        inputEl.type = 'number';
                        inputEl.step = 'any';
                        if (schema?.minimum != null) inputEl.min = schema.minimum;
                        if (schema?.maximum != null) inputEl.max = schema.maximum;
                        inputEl.style.cssText = inputStyle;
                        inputEl.value = defaultVal;
                    } else {
                        // Default: text input
                        inputEl = document.createElement('input');
                        inputEl.type = 'text';
                        inputEl.style.cssText = inputStyle;
                        inputEl.value = typeof defaultVal === 'object' ? JSON.stringify(defaultVal) : String(defaultVal);
                    }
                    inputEl.placeholder = schema?.description || key;
                    row.appendChild(inputEl);
                    container.appendChild(row);
                    paramInputs[key] = inputEl;
                }
            } else {
                const note = document.createElement('div');
                note.style.cssText = 'color:#888;font-size:12px;margin-bottom:12px';
                note.textContent = 'This DAG has no configurable parameters.';
                container.appendChild(note);
            }

            // "Load last config" button - pre-fill from last successful run
            if (Object.keys(params).length) {
                const loadLastBtn = document.createElement('button');
                loadLastBtn.className = 'btn btn-sm btn-outline-secondary';
                loadLastBtn.innerHTML = '<i class="fa-solid fa-clock-rotate-left" style="margin-right:4px"></i>Load Last Run Config';
                loadLastBtn.style.cssText = 'font-size:11px;padding:3px 10px;margin-bottom:8px';
                loadLastBtn.addEventListener('click', () => {
                    loadLastBtn.disabled = true;
                    loadLastBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:4px"></i>Loading...';
                    fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/runs?limit=5`)
                        .then(r => r.json())
                        .then(data => {
                            const runs = data.runs || [];
                            const lastSuccess = runs.find(r => r.state === 'success') || runs[0];
                            if (lastSuccess && lastSuccess.conf) {
                                for (const [key, inputEl] of Object.entries(paramInputs)) {
                                    if (key in lastSuccess.conf) {
                                        const v = lastSuccess.conf[key];
                                        if (inputEl.type === 'checkbox') {
                                            inputEl.checked = v === true || v === 'true';
                                        } else if (inputEl.tagName === 'SELECT') {
                                            inputEl.value = String(v);
                                        } else {
                                            inputEl.value = typeof v === 'object' ? JSON.stringify(v) : String(v);
                                        }
                                    }
                                }
                                loadLastBtn.innerHTML = '<i class="fa-solid fa-check" style="margin-right:4px"></i>Loaded';
                                setTimeout(() => {
                                    loadLastBtn.innerHTML = '<i class="fa-solid fa-clock-rotate-left" style="margin-right:4px"></i>Load Last Run Config';
                                    loadLastBtn.disabled = false;
                                }, 1500);
                            } else {
                                loadLastBtn.innerHTML = '<i class="fa-solid fa-clock-rotate-left" style="margin-right:4px"></i>No previous runs';
                                loadLastBtn.disabled = false;
                            }
                        })
                        .catch(() => {
                            loadLastBtn.innerHTML = '<i class="fa-solid fa-clock-rotate-left" style="margin-right:4px"></i>Load Last Run Config';
                            loadLastBtn.disabled = false;
                        });
                });
                container.appendChild(loadLastBtn);

                // (Hydra config loading handled by group dropdowns above)
            }

            const confInput = { value: '' }; // dummy for trigger conf merge

            // DVC tracked datasets for the DAG's project
            const dvcFiles = [];
            const dataInfo = document.createElement('div');
            dataInfo.style.cssText = 'margin-top:8px;font-size:11px;color:#888';
            container.appendChild(dataInfo);
            if (dag.tags?.length) {
                const projectTag = dag.tags[0];
                fetch('api/dvc/data-overview').then(r => r.ok ? r.json() : null).then(data => {
                    if (!data || !Array.isArray(data)) return;
                    const col = data.find(c => c.name === projectTag);
                    if (col?.files?.length) {
                        dvcFiles.push(...col.files);
                        const title = document.createElement('div');
                        title.style.cssText = 'font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin-bottom:4px';
                        title.textContent = 'DVC Datasets';
                        dataInfo.appendChild(title);
                        for (const f of col.files) {
                            const row = document.createElement('div');
                            row.style.cssText = 'padding:2px 0;display:flex;align-items:center;gap:6px';
                            row.innerHTML = `<i class="fa-solid fa-database" style="color:#1a7f9b;font-size:9px"></i>`
                                + `<span>${escapeHtml(f.path)}</span>`
                                + `<span style="color:#aaa;font-family:var(--font-mono);font-size:10px">${f.hash?.substring(0, 12) || '?'}</span>`;
                            dataInfo.appendChild(row);
                        }
                    }
                }).catch(() => {});
            }

            // Trigger + Sweep buttons
            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'margin-top:16px;display:flex;gap:8px';
            const triggerBtn = document.createElement('button');
            triggerBtn.className = 'rm-btn';
            triggerBtn.innerHTML = '<i class="fa-solid fa-play" style="font-size:10px;margin-right:4px"></i>Trigger';
            btnRow.appendChild(triggerBtn);

            if (Object.keys(params).length) {
                const sweepBtn = document.createElement('button');
                sweepBtn.className = 'rm-btn';
                sweepBtn.style.background = '#d0e8ff';
                sweepBtn.innerHTML = '<i class="fa-solid fa-table-cells" style="font-size:10px;margin-right:4px"></i>Sweep';
                sweepBtn.addEventListener('click', () => {
                    _showSweepPanel(dagId, params, paramInputs, confInput);
                });
                btnRow.appendChild(sweepBtn);
            }
            container.appendChild(btnRow);

            const resultArea = document.createElement('div');
            resultArea.style.cssText = 'margin-top:12px';
            container.appendChild(resultArea);

            triggerBtn.addEventListener('click', async () => {
                // Check if DAG is paused
                if (dag.is_paused) {
                    const choice = await new Promise(resolve => {
                        const overlay = document.createElement('div');
                        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center';
                        overlay.innerHTML = `
                            <div style="background:#fff;border-radius:6px;box-shadow:0 8px 32px rgba(0,0,0,.2);max-width:440px;width:90%;font-family:var(--font-family)">
                                <div style="padding:12px 16px;font-weight:600;font-size:14px;color:#333;border-bottom:1px solid #eee">
                                    <i class="fa-solid fa-circle-pause" style="margin-right:6px;color:#ff9800"></i>DAG is Paused
                                </div>
                                <div style="padding:20px 24px;font-size:13px;color:#555;line-height:1.5">
                                    This DAG is currently paused. Paused DAGs do not execute - runs will remain queued until the DAG is unpaused.
                                </div>
                                <div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid #eee">
                                    <button class="modal-btn modal-cancel">Cancel</button>
                                    <button class="modal-btn modal-confirm" data-choice="queue-only">Keep Paused & Queue Run</button>
                                    <button class="modal-btn modal-confirm" data-choice="unpause-run" style="background:#4caf50;color:#fff">Unpause & Run Immediately</button>
                                </div>
                            </div>`;
                        document.body.appendChild(overlay);
                        const cleanup = (val) => { overlay.remove(); resolve(val); };
                        overlay.querySelector('.modal-cancel').addEventListener('click', () => cleanup('cancel'));
                        for (const btn of overlay.querySelectorAll('.modal-confirm')) {
                            btn.addEventListener('click', () => cleanup(btn.dataset.choice));
                        }
                        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup('cancel'); });
                    });
                    if (choice === 'cancel') return;
                    if (choice === 'unpause-run') {
                        try {
                            await fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/pause`, {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ is_paused: false }),
                            });
                            dag.is_paused = false;
                            notify.success('DAG unpaused');
                        } catch {
                            notify.error('Failed to unpause DAG');
                            return;
                        }
                    }
                    // 'run-only' falls through to trigger without unpausing
                }

                triggerBtn.disabled = true;
                triggerBtn.textContent = 'Triggering...';
                resultArea.innerHTML = '';

                // Build conf
                let conf = {};
                for (const [key, inputEl] of Object.entries(paramInputs)) {
                    if (inputEl.type === 'checkbox') {
                        conf[key] = inputEl.checked;
                    } else {
                        const val = inputEl.value;
                        try { conf[key] = JSON.parse(val); } catch { conf[key] = val; }
                    }
                }
                // Include DVC dataset hashes
                if (dvcFiles.length) {
                    conf._dvc_datasets = dvcFiles.map(f => ({ path: f.path, hash: f.hash }));
                }

                // Merge additional JSON config
                const extraJson = confInput.value.trim();
                if (extraJson) {
                    try {
                        const extra = JSON.parse(extraJson);
                        conf = { ...conf, ...extra };
                    } catch (e) {
                        resultArea.innerHTML = `<div style="color:#c00;font-size:12px">Invalid JSON: ${escapeHtml(e.message)}</div>`;
                        triggerBtn.disabled = false;
                        triggerBtn.innerHTML = '<i class="fa-solid fa-play" style="font-size:10px;margin-right:4px"></i>Trigger';
                        return;
                    }
                }

                try {
                    const resp = await fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/trigger`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ conf: Object.keys(conf).length ? conf : null }),
                    });
                    if (!resp.ok) { const err = await resp.json(); throw new Error(err.detail || 'Failed'); }
                    const result = await resp.json();
                    resultArea.innerHTML = `<div style="color:#4caf50;font-weight:600;margin-bottom:6px">DAG Run started</div>`
                        + `<div style="font-size:11px;color:#666">Run ID: <span class="mono">${escapeHtml(result.dag_run_id || '')}</span></div>`
                        + `<div style="font-size:11px;color:#666">State: ${cap(result.state || 'queued')}</div>`;
                    notify.success('DAG Run started');
                    // Close the trigger panel and refresh DAG tree node
                    panel.close();
                    const dagNode = ctx.tree?.findKey(`dag:${dagId}`);
                    if (dagNode) { dagNode.resetLazy(); dagNode.setExpanded(true); }
                } catch (err) {
                    resultArea.innerHTML = `<div style="color:#c00;font-size:12px">${escapeHtml(err.message)}</div>`;
                }
                triggerBtn.disabled = false;
                triggerBtn.innerHTML = '<i class="fa-solid fa-play" style="font-size:10px;margin-right:4px"></i>Trigger';
            });
        }).catch(() => {
            container.innerHTML = '<div style="color:#c00;font-size:12px">Failed to load DAG parameters</div>';
        });
    }

    function _showSweepPanel(dagId, params, paramInputs, confInput) {
        const offset = (window._sweepCount = (window._sweepCount || 0) + 1);

        const panel = jsPanel.create({
            headerTitle: `<i class="fa-solid fa-table-cells" style="font-size:11px;margin-right:6px"></i>Sweep: ${dagId}`,
            theme: '#ffe39e filled',
            borderRadius: '5px',
            contentSize: { width: Math.min(600, window.innerWidth - 80), height: Math.min(500, window.innerHeight - 100) },
            position: { my: 'center', at: 'center', offsetX: offset * 20, offsetY: offset * 20 },
            headerControls: 'closeonly',
            content: '<div class="sweep-panel-content"></div>',
            callback: (p) => { p.content.style.backgroundColor = '#fefefe'; },
            onclosed: () => { window._sweepCount = Math.max(0, (window._sweepCount || 1) - 1); },
        });

        const container = panel.content.querySelector('.sweep-panel-content');
        container.className = 'sweep-panel-content explorer-detail-content';
        container.style.cssText = 'height:100%;overflow-y:auto;padding:16px;font-size:12px';

        // Instructions
        const info = document.createElement('div');
        info.style.cssText = 'color:#666;font-size:11px;margin-bottom:12px;line-height:1.5';
        info.textContent = 'Enter comma-separated values for each parameter you want to sweep. Parameters with a single value are kept constant across all combinations.';
        container.appendChild(info);

        // Multi-value inputs
        const sweepInputs = {};
        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin-bottom:8px';
        titleEl.textContent = 'Parameter Grid';
        container.appendChild(titleEl);

        for (const [key, schema] of Object.entries(params)) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px';
            const label = document.createElement('div');
            label.style.cssText = 'min-width:120px;flex-shrink:0';
            label.innerHTML = `<div style="font-weight:500;color:#333;font-family:var(--font-mono);font-size:11px">${escapeHtml(key)}</div>`
                + (schema?.description ? `<div style="font-size:10px;color:#888">${escapeHtml(schema.description)}</div>` : '');
            row.appendChild(label);

            const input = document.createElement('input');
            input.type = 'text';
            input.style.cssText = 'flex:1;padding:4px 8px;font-size:12px;border:0.5px solid #c8c8c8;border-radius:4px;font-family:var(--font-mono);color:#333';
            // Pre-fill from trigger panel value
            const currentVal = paramInputs[key]?.type === 'checkbox'
                ? String(paramInputs[key].checked)
                : (paramInputs[key]?.value || String(schema?.value ?? ''));
            input.value = currentVal;
            input.placeholder = 'e.g. value1, value2, value3';
            row.appendChild(input);
            container.appendChild(row);
            sweepInputs[key] = input;
        }

        // Preview area
        const previewTitle = document.createElement('div');
        previewTitle.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin:12px 0 8px';
        previewTitle.textContent = 'Combination Preview';
        container.appendChild(previewTitle);

        const previewArea = document.createElement('div');
        previewArea.style.cssText = 'max-height:200px;overflow-y:auto';
        container.appendChild(previewArea);

        function updatePreview() {
            const grid = _buildParamGrid(sweepInputs, params);
            const keys = Object.keys(grid);
            const valueLists = keys.map(k => grid[k]);

            if (!keys.length || valueLists.some(v => !v.length)) {
                previewArea.innerHTML = '<div style="color:#888;font-size:11px">Enter values to see combinations</div>';
                return;
            }

            // Generate combinations
            const combos = _cartesianProduct(valueLists);
            const table = document.createElement('table');
            table.style.cssText = 'width:100%;border-collapse:collapse;font-size:11px';
            const thead = document.createElement('thead');
            thead.innerHTML = `<tr><th style="text-align:left;padding:4px 8px;background:#bfdcff;font-weight:600;border:0.5px solid #e0e0e0">#</th>`
                + keys.map(k => `<th style="text-align:left;padding:4px 8px;background:#bfdcff;font-weight:600;border:0.5px solid #e0e0e0">${escapeHtml(k)}</th>`).join('')
                + '</tr>';
            table.appendChild(thead);

            const tbody = document.createElement('tbody');
            for (let i = 0; i < combos.length; i++) {
                const tr = document.createElement('tr');
                tr.style.background = i % 2 ? '#f8f8f8' : '';
                tr.innerHTML = `<td style="padding:4px 8px;border:0.5px solid #f0f0f0;color:#888">${i + 1}</td>`
                    + combos[i].map(v => `<td style="padding:4px 8px;border:0.5px solid #f0f0f0;font-family:var(--font-mono)">${escapeHtml(String(v))}</td>`).join('');
                tbody.appendChild(tr);
            }
            table.appendChild(tbody);

            previewArea.innerHTML = '';
            previewArea.appendChild(table);

            const countEl = document.createElement('div');
            countEl.style.cssText = 'font-size:11px;color:#666;margin-top:4px';
            countEl.textContent = `${combos.length} combination${combos.length !== 1 ? 's' : ''} will be triggered`;
            previewArea.appendChild(countEl);
        }

        // Update preview on input change
        for (const input of Object.values(sweepInputs)) {
            input.addEventListener('input', updatePreview);
        }
        updatePreview();

        // Submit sweep button
        const submitRow = document.createElement('div');
        submitRow.style.cssText = 'margin-top:12px;display:flex;gap:8px';
        const submitBtn = document.createElement('button');
        submitBtn.className = 'rm-btn';
        submitBtn.innerHTML = '<i class="fa-solid fa-rocket" style="font-size:10px;margin-right:4px"></i>Submit Sweep';
        submitRow.appendChild(submitBtn);
        container.appendChild(submitRow);

        const resultArea = document.createElement('div');
        resultArea.style.cssText = 'margin-top:12px';
        container.appendChild(resultArea);

        submitBtn.addEventListener('click', async () => {
            const grid = _buildParamGrid(sweepInputs, params);
            const keys = Object.keys(grid);
            if (!keys.length) return;

            // Only include multi-value params in the grid, single-value as base_conf
            const paramGrid = {};
            const baseConf = {};
            for (const [k, vals] of Object.entries(grid)) {
                if (vals.length > 1) {
                    paramGrid[k] = vals;
                } else if (vals.length === 1) {
                    baseConf[k] = vals[0];
                }
            }

            if (!Object.keys(paramGrid).length) {
                // No multi-value params - just a regular trigger
                resultArea.innerHTML = '<div style="color:#888;font-size:11px">No multi-value parameters. Use Trigger for a single run.</div>';
                return;
            }

            // Merge additional JSON config
            const extraJson = confInput?.value?.trim();
            if (extraJson) {
                try {
                    Object.assign(baseConf, JSON.parse(extraJson));
                } catch {}
            }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Submitting...';
            resultArea.innerHTML = '';

            try {
                const resp = await fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/sweep`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        param_grid: paramGrid,
                        base_conf: Object.keys(baseConf).length ? baseConf : null,
                    }),
                });
                if (!resp.ok) { const err = await resp.json(); throw new Error(err.detail || 'Failed'); }
                const result = await resp.json();

                resultArea.innerHTML = `<div style="color:#4caf50;font-weight:600;margin-bottom:6px">Sweep submitted: ${result.combinations} runs</div>`
                    + `<div style="font-size:11px;color:#666;margin-bottom:4px">Sweep ID: ${escapeHtml(result.sweep_id || '')}</div>`;

                for (const run of result.runs || []) {
                    const status = run.error
                        ? `<span style="color:#c00">${escapeHtml(run.error)}</span>`
                        : `<span style="color:#4caf50">${cap(run.state)}</span>`;
                    const paramStr = Object.entries(run.params || {}).map(([k, v]) => `${k}=${v}`).join(', ');
                    resultArea.innerHTML += `<div style="font-size:11px;color:#555;margin:2px 0"><span class="mono">[${run.index}]</span> ${escapeHtml(paramStr)} - ${status}</div>`;
                }

                notify.success(`Sweep: ${result.combinations} runs submitted`);
                const dagNode = ctx.tree?.findKey(`dag:${dagId}`);
                if (dagNode) { dagNode.resetLazy(); dagNode.setExpanded(true); }
            } catch (err) {
                resultArea.innerHTML = `<div style="color:#c00;font-size:12px">${escapeHtml(err.message)}</div>`;
            }
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fa-solid fa-rocket" style="font-size:10px;margin-right:4px"></i>Submit Sweep';
        });
    }

    function _buildParamGrid(sweepInputs, params) {
        const grid = {};
        for (const [key, input] of Object.entries(sweepInputs)) {
            const raw = input.value.trim();
            if (!raw) continue;
            const pType = params[key]?.type || 'string';
            const values = raw.split(',').map(v => v.trim()).filter(v => v);
            grid[key] = values.map(v => {
                if (pType === 'integer') return parseInt(v, 10);
                if (pType === 'number') return parseFloat(v);
                if (pType === 'boolean') return v === 'true';
                return v;
            });
        }
        return grid;
    }

    function _cartesianProduct(arrays) {
        return arrays.reduce((acc, arr) =>
            acc.flatMap(combo => arr.map(val => [...combo, val])),
            [[]]
        );
    }

    return {
        loadPipelines,
        loadDagRuns,
        loadDagRunTasks,
        showPipelinesRootDetail,
        showDagDetail,
        showDagRunDetail,
        showDagTaskDetail,
        showTriggerPanel,
        updateGraphTaskState,
    };
}
