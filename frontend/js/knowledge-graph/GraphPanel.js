/**
 * GraphPanel - Knowledge Graph floating panel with search bar, view selector,
 * and 3D rendering container. Opens as a jsPanel.
 */

import { getEntityColor, getEntityIcon } from './GraphNodeRenderer.js';
import { domainState } from '../domain-state.js';

export class GraphPanel {

    /**
     * @param {string} projectId - Project or mount ID (null in trace mode)
     * @param {object} options - { onEntityClick, initialEntityId, traceData, kbId }
     *   traceData: per-answer KG payload from graph_provenance SSE event.
     *     When present, the panel runs in trace mode (no project-graph fetch,
     *     no view selector; render the subgraph the model used to ground a
     *     specific answer with entry entities highlighted and a side panel
     *     for entity description + grounding chunks).
     *   kbId: explicit Domain id to scope per-entity HTTP fetches (neighborhood,
     *     community detail, retrieve). Required when an entity in the trace
     *     belongs to a Domain other than the first-active one (otherwise the
     *     URL hits the wrong Domain and returns 404).
     */
    constructor(projectId, options = {}) {
        this._projectId = projectId;
        this._options = options;
        this._traceData = options.traceData || null;
        this._livePreview = !!options.livePreview;
        // Resolve the Domain id for HTTP fetches: explicit option wins,
        // otherwise read it off the trace payload (top-level kb_id, or the
        // first entry entity's kb_id), otherwise fall back to the first
        // active Domain. Stays null until a fetch needs it (helper resolves
        // lazily so the trace data can arrive after construction via
        // updateTraceData()).
        this._kbId = options.kbId || null;
        this._panel = null;
        this._graph3d = null;
        this._currentView = 'overview';
        this._disposed = false;
        this._kgPanelEl = null; // .kg-panel container (set after open)

        // Universal density slider state. Persists across mode switches
        // within the same panel session. Each mode's setup function calls
        // _setSliderConfig(maxN, callback) on entry to bind the slider to
        // the current view; the value carries over (clamped to the new
        // max if needed).
        this._densityValue = 50;
        this._sliderRow = null;
        this._sliderEl = null;
        this._sliderLabel = null;
        this._densityCallback = null;
        this._densityTimer = null;

        // User question mode: cache the last retrieve payload so the
        // "Ask the assistant" button can reuse it (no duplicate BFS).
        this._lastQuestionPayload = null;
        this._lastQuestion = null;
        // Right-pane (LLM answer) DOM refs, set when first opened.
        this._answerPane = null;
        this._answerBody = null;
        this._answerAbort = null;
    }

    /** Resolve the Domain id to use for an HTTP fetch.
     *
     * Order of precedence:
     *  1. explicit option (constructor's kbId)
     *  2. the entity argument's kb_id (when the call is per-entity)
     *  3. trace payload's top-level kb_id
     *  4. first entry entity's kb_id (graph_and_vector_search merge tags it)
     *  5. domainState.getFirstKnowledgeDomain() — only valid when the panel
     *     is operating in "browse" mode against the active workspace.
     *
     * Returning the wrong Domain triggers HTTP 404 against noted-graph
     * since per-Domain databases are isolated.
     */
    _resolveKbId(entity) {
        // Two field names exist in the wild: graph_and_vector_search merge
        // tags entries with `kb_id`; the citations resolver returns
        // `domain_id`. Accept either.
        if (this._kbId) return this._kbId;
        if (entity && (entity.kb_id || entity.domain_id)) {
            return entity.kb_id || entity.domain_id;
        }
        if (this._traceData) {
            if (this._traceData.kb_id) return this._traceData.kb_id;
            if (this._traceData.domain_id) return this._traceData.domain_id;
            const entries = this._traceData.entry_entities || [];
            if (entries[0] && (entries[0].kb_id || entries[0].domain_id)) {
                return entries[0].kb_id || entries[0].domain_id;
            }
        }
        return domainState.getFirstKnowledgeDomain();
    }

    open() {
        const jp = window.jsPanel;
        if (!jp) return;

        const traceMode = !!this._traceData;
        const headerTitle = this._buildHeaderTitle();

        this._panel = jp.create({
            headerTitle,
            theme: '#ffe39e filled',
            borderRadius: '5px',
            panelSize: {
                width: Math.max(600, Math.min(1000, (window.innerWidth || 1200) - 100)),
                height: Math.max(500, Math.min(700, (window.innerHeight || 900) - 100)),
            },
            position: 'center',
            headerControls: 'closeonly',
            content: '<div class="kg-panel"></div>',
            callback: (p) => {
                p.content.style.backgroundColor = '#ffffff';
                p.content.style.padding = '0';
                p.content.style.display = 'flex';
                p.content.style.flexDirection = 'column';
                p.content.style.height = '100%';
                this._kgPanelEl = p.content.querySelector('.kg-panel');
                if (traceMode) {
                    this._buildTraceUI(this._kgPanelEl);
                } else {
                    this._buildUI(this._kgPanelEl);
                }
            },
            onclosed: () => {
                this._graph3d?.dispose();
                this._graph3d = null;
                this._disposed = true;
            },
        });
    }

    /** Compute the jsPanel title bar HTML based on current mode/state. */
    _buildHeaderTitle() {
        const ICON = '<i class="fa-solid fa-share-nodes" style="font-size:11px;margin-right:6px"></i>';
        if (this._traceData) {
            const nE = (this._traceData.entities || []).length;
            const nR = (this._traceData.per_edge_chunks || []).length;
            const label = this._livePreview ? 'Live Trace Preview' : 'Answer Trace';
            return `${ICON}${label} - ${nE} entities, ${nR} grounded relationships`;
        }
        return `${ICON}Knowledge Graph`;
    }

    /** Replace the trace data and re-render in place. Used by the live
     * trace preview to update the same panel as the user keeps typing,
     * instead of opening a new panel per keystroke. */
    updateTraceData(payload) {
        if (this._disposed || !this._kgPanelEl) return;
        this._traceData = payload;
        // Update header
        try { this._panel?.setHeaderTitle?.(this._buildHeaderTitle()); } catch {}
        // Tear down old viz then rebuild trace UI in the same container.
        this._graph3d?.dispose();
        this._graph3d = null;
        this._kgPanelEl.innerHTML = '';
        this._buildTraceUI(this._kgPanelEl);
    }

    // ── Trace mode (per-answer provenance) ──────────────────────────

    _buildTraceUI(container) {
        container.style.cssText = 'display:flex;flex-direction:column;height:100%;width:100%';

        // Header strip with question + density slider + "Open full graph".
        const header = document.createElement('div');
        header.style.cssText = 'padding:6px 10px;font-size:11px;color:#555;background:#fafafa;border-bottom:0.5px solid #e0e0e0;flex-shrink:0;display:flex;align-items:center;gap:8px';
        const q = (this._traceData.question || '').trim();
        const qSpan = document.createElement('span');
        qSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0';
        qSpan.innerHTML = q
            ? `<span style="color:#888">${this._livePreview ? 'Live preview:' : 'Trace for:'}</span> <span style="font-style:italic;color:#222">${this._escapeHtml(q.slice(0, 200))}${q.length > 200 ? '...' : ''}</span>`
            : '<span style="color:#888">Per-answer KG trace</span>';
        header.appendChild(qSpan);

        // Density slider lives in the trace header too. Built fresh each
        // render so updateTraceData() can rebind to the new payload.
        this._buildSliderRow(header);

        const firstEntry = (this._traceData.entry_entities || [])[0];
        if (firstEntry && firstEntry.id) {
            const openBtn = document.createElement('button');
            openBtn.className = 'rm-btn';
            openBtn.style.cssText = 'padding:3px 10px;font-size:10px;flex-shrink:0';
            openBtn.innerHTML = '<i class="fa-solid fa-arrow-up-right-from-square" style="font-size:9px;margin-right:4px"></i>Open full graph';
            openBtn.title = `Open Knowledge Graph in Entity neighborhood mode pre-loaded with "${firstEntry.label || firstEntry.id}"`;
            openBtn.addEventListener('click', () => {
                // Forward the trace's resolved Domain so the new panel's
                // entity-neighborhood fetch hits the correct DB. Without
                // this, the new panel falls back to the first active Domain
                // which is wrong whenever the trace's entity lives in a
                // different active Domain.
                const fullPanel = new this.constructor(null, {
                    initialEntityId: firstEntry.id,
                    kbId: firstEntry.kb_id || this._resolveKbId(firstEntry),
                });
                fullPanel.open();
            });
            header.appendChild(openBtn);
        }

        container.appendChild(header);

        // Body: side panel (LEFT) + graph.
        const body = document.createElement('div');
        body.style.cssText = 'flex:1;display:flex;min-height:0';
        container.appendChild(body);

        const sidePanel = document.createElement('div');
        sidePanel.style.cssText = 'width:300px;border-right:0.5px solid #e0e0e0;padding:10px;overflow-y:auto;font-size:11px;background:#fcfcfc;flex-shrink:0';
        sidePanel.innerHTML = '<div style="color:#888;font-style:italic">Click an entity to see its description and grounding chunks.</div>';
        body.appendChild(sidePanel);

        const graphContainer = document.createElement('div');
        graphContainer.style.cssText = 'flex:1;position:relative;overflow:hidden;min-height:0';
        body.appendChild(graphContainer);

        this._renderTraceGraph(graphContainer, sidePanel);
    }

    async _renderTraceGraph(graphContainer, sidePanel) {
        const trace = this._traceData;
        const allEntities = trace.entities || [];
        const entityById = new Map(allEntities.map(e => [e.id, e]));
        const excerptById = new Map((trace.chunk_excerpts || []).map(c => [c.id, c]));
        const entryIds = new Set((trace.entry_entities || []).map(e => e.id));

        // Side panel: detail card on top + clickable entity list below.
        const { detailEl } = this._buildTraceSidePanel(sidePanel, trace, excerptById);

        const { KnowledgeGraph3D } = await import('./KnowledgeGraph3D.js');

        const renderTopN = (n) => {
            const sorted = [...allEntities].sort((a, b) => {
                const ra = ((a.properties || {}).rank ?? a.rank ?? 0);
                const rb = ((b.properties || {}).rank ?? b.rank ?? 0);
                return rb - ra;
            });
            const must = sorted.filter(e => entryIds.has(e.id));
            const rest = sorted.filter(e => !entryIds.has(e.id));
            const slice = [...must, ...rest].slice(0, n);
            const keepIds = new Set(slice.map(e => e.id));
            const relationships = (trace.edges || [])
                .filter(e => keepIds.has(e.source) && keepIds.has(e.target))
                .map(e => ({ source: e.source, target: e.target, type: e.type }));
            const graphData = {
                entities: slice,
                relationships,
                entity_count: slice.length,
                relationship_count: relationships.length,
            };
            this._graph3d?.dispose();
            this._graph3d = new KnowledgeGraph3D(graphContainer, {
                onEntityClick: (entity) => {
                    const full = entityById.get(entity.id) || entity;
                    this._showTraceEntityDetails(detailEl, full, trace, excerptById);
                },
                entryIds: Array.from(entryIds),
            });
            this._graph3d.loadGraph(graphData);
        };

        const initial = this._setSliderConfig(allEntities.length, renderTopN);
        renderTopN(initial);
    }

    /** Write the entity detail card (label + description + grounding
     * chunks) into `target`. Used by both graph-node clicks and
     * list-row clicks - the detail card sits above the entity list so
     * the list stays visible after a click. */
    _showTraceEntityDetails(target, entity, trace, excerptById) {
        const props = entity.properties || {};
        const desc = props.description || '';
        const chunkIds = (trace.per_entity_chunks || {})[entity.id] || [];
        const lbl = entity.label || entity.id;
        const typ = entity.type || '';

        let html = `<div style="margin-bottom:8px"><strong style="font-size:13px">${this._escapeHtml(lbl)}</strong>`;
        if (typ) html += ` <span style="color:#999;font-size:10px">(${this._escapeHtml(typ)})</span>`;
        html += '</div>';
        if (desc) {
            html += `<div style="margin-bottom:10px;color:#333;line-height:1.4">${this._escapeHtml(desc)}</div>`;
        }
        if (chunkIds.length) {
            html += '<div style="margin-top:8px;font-weight:500;color:#555;font-size:10px;text-transform:uppercase;letter-spacing:0.5px">Grounding chunks</div>';
            for (const cid of chunkIds) {
                const c = excerptById.get(cid);
                if (!c) continue;
                const sec = c.section_path || '?';
                const text = (c.text || '').slice(0, 400);
                html += `<div style="margin-top:6px;padding:6px 8px;background:#fff;border-left:3px solid #6096e5;font-size:10px;color:#333">`
                    + `<div style="font-weight:500;color:#555;margin-bottom:3px">${this._escapeHtml(sec)}</div>`
                    + `<div style="white-space:pre-wrap;line-height:1.4">${this._escapeHtml(text)}${(c.text || '').length > 400 ? '...' : ''}</div>`
                    + `</div>`;
            }
        } else {
            html += '<div style="margin-top:8px;color:#999;font-style:italic;font-size:10px">No grounding chunks attached to this entity.</div>';
        }
        target.innerHTML = html;
        // Make sure the user sees the update even when scrolled.
        try { target.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch {}
    }

    /** Build a two-section side panel for trace / question views:
     *
     *   [detail card]   <- top, updated by clicks (initially placeholder)
     *   [entity list]   <- bottom, all entities clickable (entry first)
     *
     * Returns { detailEl } so the caller can wire graph-node clicks to
     * the same detail container. */
    _buildTraceSidePanel(sidePanel, payload, excerptById) {
        sidePanel.innerHTML = '';

        const detailEl = document.createElement('div');
        detailEl.style.cssText = 'padding-bottom:10px;border-bottom:0.5px solid #e0e0e0;margin-bottom:10px;min-height:30px';
        detailEl.innerHTML = '<div style="color:#888;font-style:italic;font-size:10px">Click an entity (in the list below or in the graph) to see its description and grounding chunks.</div>';
        sidePanel.appendChild(detailEl);

        const allEntities = payload.entities || [];
        const entityById = new Map(allEntities.map(e => [e.id, e]));
        const entryIds = new Set((payload.entry_entities || []).map(e => e.id));

        // Sort: entry entities first, then the rest by rank desc.
        const sorted = [...allEntities].sort((a, b) => {
            const ra = ((a.properties || {}).rank ?? a.rank ?? 0);
            const rb = ((b.properties || {}).rank ?? b.rank ?? 0);
            return rb - ra;
        });
        const entries = sorted.filter(e => entryIds.has(e.id));
        const rest = sorted.filter(e => !entryIds.has(e.id));

        const buildRow = (e, isEntry) => {
            const row = document.createElement('div');
            row.style.cssText = 'padding:5px 8px;border-bottom:0.5px solid #f0f0f0;cursor:pointer;font-size:11px;display:flex;align-items:center;gap:6px';
            row.addEventListener('mouseenter', () => { row.style.background = '#f5f5f5'; });
            row.addEventListener('mouseleave', () => { row.style.background = ''; });
            const halo = isEntry ? '<i class="fa-solid fa-circle" style="font-size:7px;color:#ffd700;flex-shrink:0" title="Entry entity"></i>' : '<span style="width:7px;flex-shrink:0"></span>';
            row.innerHTML = `${halo}<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">`
                + `<strong>${this._escapeHtml(e.label || e.id)}</strong>`
                + ` <span style="color:#999;font-size:10px">(${this._escapeHtml(e.type || '')})</span>`
                + `</span>`;
            row.addEventListener('click', () => {
                this._showTraceEntityDetails(detailEl, e, payload, excerptById);
                if (this._graph3d?.setSelectedEntity) {
                    try { this._graph3d.setSelectedEntity(e.id); } catch {}
                }
                // In User question mode, also push the clicked term into
                // the question input so the user can refine the query
                // around that concept. The setQuestion() helper updates
                // the value AND fires the live retrieval.
                if (this._currentMode === 'question' && typeof this._setQuestion === 'function') {
                    this._setQuestion(e.label || e.id);
                }
            });
            return row;
        };

        if (entries.length) {
            const lbl = document.createElement('div');
            lbl.style.cssText = 'font-weight:500;color:#555;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px';
            lbl.textContent = `Entry entities (${entries.length})`;
            sidePanel.appendChild(lbl);
            for (const e of entries) sidePanel.appendChild(buildRow(e, true));
        }
        if (rest.length) {
            const lbl = document.createElement('div');
            lbl.style.cssText = 'font-weight:500;color:#555;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;margin-top:10px;margin-bottom:4px';
            lbl.textContent = `All entities (${rest.length}) by rank`;
            sidePanel.appendChild(lbl);
            for (const e of rest) sidePanel.appendChild(buildRow(e, false));
        }

        return { detailEl };
    }

    // ── Universal density slider ────────────────────────────────────

    /** Build the persistent density-slider DOM and append it to `target`.
     * The slider is initially hidden; modes call _setSliderConfig() to
     * surface it with view-appropriate max + callback.
     *
     * Uses a custom `kg-density-slider` class (CSS in chat-panel.css)
     * that disables the native appearance and renders a thin track + a
     * thumb sized to the track height. This keeps the thumb flush at
     * min/max positions (the native browser thumb extends visually past
     * the track edges, which the user noticed as "always some range
     * interval there"). */
    _buildSliderRow(target) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:none;align-items:center;gap:6px;padding:0 4px;border-left:0.5px solid #e0e0e0;flex-shrink:0';
        const label = document.createElement('span');
        label.style.cssText = 'font-size:10px;color:#555;min-width:80px;text-align:right;flex-shrink:0';
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '1';
        slider.max = '50';
        slider.value = String(this._densityValue);
        slider.className = 'kg-density-slider';
        slider.title = 'Number of entities to show';
        wrap.appendChild(label);
        wrap.appendChild(slider);
        target.appendChild(wrap);

        slider.addEventListener('input', () => {
            const n = parseInt(slider.value, 10);
            this._densityValue = n;
            label.textContent = `Top ${n} of ${slider.max}`;
            if (this._densityTimer) clearTimeout(this._densityTimer);
            this._densityTimer = setTimeout(() => {
                if (this._densityCallback) this._densityCallback(n);
            }, 120);
        });

        this._sliderRow = wrap;
        this._sliderEl = slider;
        this._sliderLabel = label;
    }

    /** Bind the slider to the current view: set max + reset value to
     * the new max so the user sees the FULL result by default and can
     * drag down to declutter. Pass `null`/0 to hide. Returns the value
     * (so the caller knows what to render). */
    _setSliderConfig(maxN, callback) {
        if (!this._sliderRow) return this._densityValue;
        if (!maxN || maxN < 1) {
            this._sliderRow.style.display = 'none';
            this._densityCallback = null;
            return this._densityValue;
        }
        const max = Math.max(1, maxN);
        const value = max; // start at max for each new view; user can dial down
        this._densityValue = value;
        this._densityCallback = callback || null;
        this._sliderEl.max = String(max);
        this._sliderEl.value = String(value);
        this._sliderLabel.textContent = `Top ${value} of ${max}`;
        this._sliderRow.style.display = 'flex';
        return value;
    }

    // ── Knowledge graph mode (Communities + Entity neighborhood) ────

    _buildUI(container) {
        container.style.cssText = 'display:flex;flex-direction:column;height:100%;width:100%';

        // Toolbar: mode selector + mode-specific controls + density slider
        const toolbar = document.createElement('div');
        toolbar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 10px;background:#fff;border-bottom:0.5px solid #e0e0e0;flex-shrink:0';
        container.appendChild(toolbar);

        const modeSelect = document.createElement('select');
        modeSelect.style.cssText = 'padding:5px 24px 5px 8px;font-size:11px;border:0.5px solid #c8c8c8;border-radius:4px;color:#333';
        for (const { value, label } of [
            { value: 'communities', label: 'Communities' },
            { value: 'entity', label: 'Entity neighborhood' },
            { value: 'question', label: 'User question' },
        ]) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            modeSelect.appendChild(opt);
        }
        toolbar.appendChild(modeSelect);

        const modeControls = document.createElement('div');
        modeControls.style.cssText = 'flex:1;display:flex;align-items:center;gap:8px';
        toolbar.appendChild(modeControls);

        // Universal density slider, hidden until a mode loads data.
        this._buildSliderRow(toolbar);

        const infoBar = document.createElement('div');
        infoBar.style.cssText = 'padding:3px 10px;font-size:10px;color:#888;flex-shrink:0';
        container.appendChild(infoBar);

        // Body: side panel (LEFT, sits below the search input so results
        // appear directly under what the user just typed) + 3D graph (right).
        const body = document.createElement('div');
        body.style.cssText = 'flex:1;display:flex;min-height:0';
        container.appendChild(body);

        const sidePanel = document.createElement('div');
        sidePanel.style.cssText = 'width:300px;border-right:0.5px solid #e0e0e0;padding:10px;overflow-y:auto;font-size:11px;background:#fcfcfc;flex-shrink:0';
        body.appendChild(sidePanel);

        const graphContainer = document.createElement('div');
        graphContainer.style.cssText = 'flex:1;position:relative;overflow:hidden;min-height:0';
        body.appendChild(graphContainer);

        // Right pane for LLM answers (User question mode). Hidden by
        // default; opened on demand. The splitter sits on its left and
        // lets the user drag to resize. Both are display:none until
        // _openAnswerPane() shows them.
        const answerSplitter = document.createElement('div');
        answerSplitter.className = 'kg-pane-splitter';
        answerSplitter.style.display = 'none';
        body.appendChild(answerSplitter);

        const answerPane = document.createElement('div');
        answerPane.style.cssText = 'display:none;width:350px;background:#fcfcfc;flex-shrink:0;flex-direction:column;min-height:0';
        body.appendChild(answerPane);

        // Drag-to-resize: shrink/grow the answer pane width by tracking
        // the cursor's horizontal delta. Clamped to [220, 800] so it
        // doesn't collapse or eat the whole panel.
        let dragging = false;
        let startX = 0;
        let startW = 0;
        const onMove = (e) => {
            if (!dragging) return;
            const newW = startW - (e.clientX - startX);
            answerPane.style.width = `${Math.max(220, Math.min(800, newW))}px`;
        };
        const onUp = () => {
            if (!dragging) return;
            dragging = false;
            answerSplitter.classList.remove('dragging');
            document.body.style.cursor = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        answerSplitter.addEventListener('mousedown', (e) => {
            dragging = true;
            startX = e.clientX;
            startW = answerPane.getBoundingClientRect().width;
            answerSplitter.classList.add('dragging');
            document.body.style.cursor = 'ew-resize';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            e.preventDefault();
        });

        this._modeControls = modeControls;
        this._infoBar = infoBar;
        this._graphContainer = graphContainer;
        this._sidePanel = sidePanel;
        this._answerPane = answerPane;
        this._answerSplitter = answerSplitter;

        // Initial mode: entity neighborhood when an initialEntityId was
        // passed in (e.g. trace mode's "Open full graph"); otherwise
        // communities.
        const initialMode = this._options.initialEntityId ? 'entity' : 'communities';
        modeSelect.value = initialMode;
        this._switchMode(initialMode);

        modeSelect.addEventListener('change', () => {
            this._switchMode(modeSelect.value);
        });
    }

    _switchMode(mode) {
        this._currentMode = mode;
        this._modeControls.innerHTML = '';
        this._sidePanel.innerHTML = '';
        this._infoBar.textContent = '';
        this._graph3d?.dispose();
        this._graph3d = null;
        this._graphContainer.innerHTML = '';
        // Mode-specific setup will rebind the slider; hide for now.
        this._setSliderConfig(0, null);
        // Hide the LLM answer pane and abort any in-flight stream.
        if (this._answerAbort) { this._answerAbort.abort(); this._answerAbort = null; }
        if (this._answerPane) {
            this._answerPane.style.display = 'none';
            this._answerPane.innerHTML = '';
            this._answerBody = null;
        }
        if (this._answerSplitter) this._answerSplitter.style.display = 'none';
        // Drop question-mode-only references so the entity-list row
        // click in trace / other modes doesn't try to push into a stale
        // input element from a previous question session.
        this._questionInput = null;
        this._setQuestion = null;

        if (mode === 'communities') {
            this._setupCommunitiesMode();
        } else if (mode === 'question') {
            this._setupQuestionMode();
        } else {
            this._setupEntityMode();
        }
    }

    // ── Communities mode ────────────────────────────────────────────

    async _setupCommunitiesMode() {
        const sidePanel = this._sidePanel;
        sidePanel.innerHTML = '<div style="color:#888;font-style:italic">Loading communities...</div>';
        this._infoBar.textContent = 'Loading communities...';

        try {
            const resp = await fetch(`api/graph/research/${this._resolveKbId()}/communities`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const list = (data.communities || []).slice();
            list.sort((a, b) => (b.member_count || 0) - (a.member_count || 0));

            this._infoBar.textContent = `${list.length} communities. Click one to view its members.`;
            sidePanel.innerHTML = '';
            const heading = document.createElement('div');
            heading.style.cssText = 'font-weight:500;color:#555;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;padding-bottom:4px;border-bottom:0.5px solid #e0e0e0';
            heading.textContent = 'Communities';
            sidePanel.appendChild(heading);

            for (const c of list) {
                const row = document.createElement('div');
                row.style.cssText = 'padding:6px 8px;cursor:pointer;border-bottom:0.5px solid #f0f0f0';
                row.addEventListener('mouseenter', () => { row.style.background = '#f5f5f5'; });
                row.addEventListener('mouseleave', () => { row.style.background = ''; });
                // dominant_entity_types is a list of {type, count} objects.
                // Extract the type name (with count) for the line below the
                // community heading; a bare .join would produce
                // "[object Object], [object Object], …".
                const types = (c.dominant_entity_types || [])
                    .slice(0, 3)
                    .map((t) => (typeof t === 'string' ? t : `${t.type} (${t.count})`))
                    .join(', ');
                row.innerHTML = `<div><strong>Community ${c.community_id}</strong> <span style="color:#999;font-size:10px">(${c.member_count || 0} members)</span></div>`
                    + (types ? `<div style="color:#666;font-size:10px;margin-top:2px">${this._escapeHtml(types)}</div>` : '');
                row.addEventListener('click', () => this._loadCommunityDetail(c.community_id, list));
                sidePanel.appendChild(row);
            }
        } catch (e) {
            sidePanel.innerHTML = `<div style="color:#c00">Failed to load communities: ${this._escapeHtml(e.message)}</div>`;
            this._infoBar.textContent = 'Error.';
        }
    }

    async _loadCommunityDetail(cid, fullList) {
        try {
            // Pull the actual member_count for this community from the
            // already-fetched community list, then request ALL members in
            // one shot. The slider re-slices the cached array locally, so
            // dragging never re-hits the backend.
            const meta = (fullList || []).find(c => c.community_id === cid) || {};
            const totalToFetch = Math.max(meta.member_count || 50, 5);
            const resp = await fetch(`api/graph/research/${this._resolveKbId()}/communities/${cid}?top_n=${totalToFetch}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();

            const allMembers = data.top_members || [];
            const maxN = allMembers.length;
            const initialN = Math.min(50, Math.max(5, maxN));

            const sidePanel = this._sidePanel;
            sidePanel.innerHTML = '';

            const backLink = document.createElement('button');
            backLink.className = 'rm-btn';
            backLink.style.cssText = 'padding:3px 8px;font-size:10px;margin-bottom:8px';
            backLink.innerHTML = '<i class="fa-solid fa-arrow-left" style="font-size:9px;margin-right:4px"></i>Back to communities';
            backLink.addEventListener('click', () => this._setupCommunitiesMode());
            sidePanel.appendChild(backLink);

            const head = document.createElement('div');
            head.style.cssText = 'margin-bottom:8px';
            head.innerHTML = `<strong style="font-size:13px">Community ${cid}</strong>`
                + ` <span style="color:#999;font-size:10px">(${data.member_count || 0} members)</span>`;
            sidePanel.appendChild(head);

            if (data.summary) {
                const sumDiv = document.createElement('div');
                sumDiv.style.cssText = 'margin-bottom:10px;padding:6px 8px;background:#fff;border-left:3px solid #4fa36b;color:#333;line-height:1.4;white-space:pre-wrap';
                sumDiv.textContent = data.summary;
                sidePanel.appendChild(sumDiv);
            }

            const memberListContainer = document.createElement('div');
            sidePanel.appendChild(memberListContainer);

            // Pre-import the renderer once; slider re-renders may run
            // dozens of times per drag.
            const { KnowledgeGraph3D } = await import('./KnowledgeGraph3D.js');

            const renderTopN = (n) => {
                const slice = allMembers.slice(0, n);

                memberListContainer.innerHTML = '';
                const lbl = document.createElement('div');
                lbl.style.cssText = 'margin-top:8px;font-weight:500;color:#555;font-size:10px;text-transform:uppercase;letter-spacing:0.5px';
                lbl.textContent = `Top ${n} members by rank`;
                memberListContainer.appendChild(lbl);
                for (const m of slice) {
                    const row = document.createElement('div');
                    row.style.cssText = 'padding:5px 8px;border-bottom:0.5px solid #f0f0f0;cursor:pointer;font-size:11px';
                    row.addEventListener('mouseenter', () => { row.style.background = '#f5f5f5'; });
                    row.addEventListener('mouseleave', () => { row.style.background = ''; });
                    row.innerHTML = `<div><strong>${this._escapeHtml(m.label || m.id)}</strong>`
                        + ` <span style="color:#999;font-size:10px">(${this._escapeHtml(m.type || '')})</span></div>`
                        + (m.description ? `<div style="color:#555;font-size:10px;margin-top:2px">${this._escapeHtml((m.description || '').slice(0, 200))}</div>` : '');
                    row.addEventListener('click', () => {
                        this._currentMode = 'entity';
                        this._options.initialEntityId = m.id;
                        this._setupEntityMode(m.id);
                        const select = this._modeControls.parentElement.querySelector('select');
                        if (select) select.value = 'entity';
                    });
                    memberListContainer.appendChild(row);
                }

                // 3D pane: members as nodes (no edges - member_of edges all
                // converge on the synthetic community node and would dominate).
                const entities = slice.map(m => ({
                    id: m.id,
                    label: m.label || m.id,
                    type: m.type,
                    rank: m.rank,
                    properties: { description: m.description || '' },
                }));
                const graphData = { entities, relationships: [], entity_count: entities.length, relationship_count: 0 };
                this._graph3d?.dispose();
                this._graph3d = new KnowledgeGraph3D(this._graphContainer, { onEntityClick: () => {} });
                this._graph3d.loadGraph(graphData);
                this._infoBar.textContent = `Community ${cid} - ${n} of ${maxN} members shown`;
            };

            // Bind the universal slider to this view, then render at the
            // (clamped) persisted value.
            const initial = this._setSliderConfig(maxN, renderTopN);
            renderTopN(initial);
        } catch (e) {
            this._sidePanel.innerHTML = `<div style="color:#c00">Failed to load community: ${this._escapeHtml(e.message)}</div>`;
        }
    }

    // ── Entity neighborhood mode ────────────────────────────────────

    _setupEntityMode(presetEntityId) {
        // Toolbar: search input + button
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Search entity by name...';
        searchInput.style.cssText = 'flex:1;padding:5px 10px;font-size:12px;border:0.5px solid #c8c8c8;border-radius:4px;color:#333';
        this._modeControls.appendChild(searchInput);

        const searchBtn = document.createElement('button');
        searchBtn.className = 'rm-btn';
        searchBtn.style.cssText = 'padding:5px 10px;font-size:11px';
        searchBtn.innerHTML = '<i class="fa-solid fa-search" style="font-size:10px"></i>';
        this._modeControls.appendChild(searchBtn);

        const sidePanel = this._sidePanel;
        sidePanel.innerHTML = '<div style="color:#888;font-style:italic">Search for an entity to load its neighborhood, or click a node in the graph to navigate.</div>';

        // Live search-as-you-type: debounced 200ms after the last
        // keystroke; in-flight request is aborted when the query changes
        // so stale results never overwrite newer ones. Enter still works
        // (forces an immediate search), the search button does too.
        let searchAbort = null;
        let searchTimer = null;
        const doSearch = async (force = false) => {
            const q = searchInput.value.trim();
            if (!q) {
                sidePanel.innerHTML = '<div style="color:#888;font-style:italic">Search for an entity to load its neighborhood, or click a node in the graph to navigate.</div>';
                return;
            }
            if (searchAbort) searchAbort.abort();
            searchAbort = new AbortController();
            const myAbort = searchAbort;
            sidePanel.innerHTML = `<div style="color:#888">Searching "${this._escapeHtml(q)}"...</div>`;
            try {
                const resp = await fetch(
                    `api/graph/research/${this._resolveKbId()}/entities/search?q=${encodeURIComponent(q)}&limit=20`,
                    { signal: myAbort.signal },
                );
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                if (myAbort.signal.aborted) return;
                this._renderEntitySearchResults(sidePanel, data.results || [], q);
            } catch (e) {
                if (e.name === 'AbortError') return; // newer query took over
                sidePanel.innerHTML = `<div style="color:#c00">Search failed: ${this._escapeHtml(e.message)}</div>`;
            }
        };
        const scheduleSearch = (delay) => {
            if (searchTimer) clearTimeout(searchTimer);
            searchTimer = setTimeout(() => doSearch(), delay);
        };
        searchBtn.addEventListener('click', () => doSearch(true));
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (searchTimer) clearTimeout(searchTimer);
                doSearch(true);
            }
        });
        searchInput.addEventListener('input', () => scheduleSearch(200));

        const seedId = presetEntityId || this._options.initialEntityId;
        if (seedId) {
            this._loadEntityNeighborhood(seedId);
        } else {
            this._infoBar.textContent = 'Search for an entity to start.';
        }
    }

    _renderEntitySearchResults(sidePanel, results, q) {
        sidePanel.innerHTML = '';
        const heading = document.createElement('div');
        heading.style.cssText = 'font-weight:500;color:#555;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;padding-bottom:4px;border-bottom:0.5px solid #e0e0e0';
        heading.textContent = `Search results for "${q}" (${results.length})`;
        sidePanel.appendChild(heading);
        if (!results.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color:#888;font-style:italic';
            empty.textContent = 'No matches.';
            sidePanel.appendChild(empty);
            return;
        }
        for (const r of results) {
            const row = document.createElement('div');
            row.style.cssText = 'padding:5px 8px;border-bottom:0.5px solid #f0f0f0;cursor:pointer;font-size:11px';
            row.addEventListener('mouseenter', () => { row.style.background = '#f5f5f5'; });
            row.addEventListener('mouseleave', () => { row.style.background = ''; });
            row.innerHTML = `<strong>${this._escapeHtml(r.label || r.id)}</strong>`
                + ` <span style="color:#999;font-size:10px">(${this._escapeHtml(r.type || '')})</span>`;
            row.addEventListener('click', () => this._loadEntityNeighborhood(r.id));
            sidePanel.appendChild(row);
        }
    }

    async _loadEntityNeighborhood(entityId) {
        // Fetch with a generous limit so the slider can scale up without
        // a re-fetch. Re-fetch only triggers when the slider is moved
        // beyond the cached set (handled by the slider callback).
        const fetchLimit = Math.max(this._densityValue, 200);
        await this._fetchAndRenderNeighborhood(entityId, fetchLimit);
    }

    async _fetchAndRenderNeighborhood(entityId, fetchLimit) {
        this._infoBar.textContent = `Loading neighborhood of "${entityId}"...`;
        try {
            const resp = await fetch(`api/graph/research/${this._resolveKbId()}/entity/${encodeURIComponent(entityId)}/neighborhood?hops=2&limit=${fetchLimit}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const allEntities = data.entities || [];
            const allEdges = data.edges || [];

            // Cache the full result so slider re-renders are local.
            this._neighborhoodCache = {
                entityId,
                fetchLimit,
                entities: allEntities,
                edges: allEdges,
                hops: data.hops,
            };

            const { KnowledgeGraph3D } = await import('./KnowledgeGraph3D.js');

            const renderTopN = (n) => {
                // Sort entities by rank desc; keep the seed always.
                const sorted = [...allEntities].sort((a, b) => {
                    const ra = ((a.properties || {}).rank ?? a.rank ?? 0);
                    const rb = ((b.properties || {}).rank ?? b.rank ?? 0);
                    return rb - ra;
                });
                // Ensure seed is included even if rank is low.
                const seedIdx = sorted.findIndex(e => e.id === entityId);
                let slice = sorted.slice(0, n);
                if (seedIdx >= 0 && seedIdx >= n) {
                    slice = [sorted[seedIdx], ...slice.slice(0, n - 1)];
                }
                const keepIds = new Set(slice.map(e => e.id));
                const filteredEdges = allEdges.filter(e => keepIds.has(e.source) && keepIds.has(e.target));
                const graphData = {
                    entities: slice,
                    relationships: filteredEdges.map(e => ({ source: e.source, target: e.target, type: e.type })),
                    entity_count: slice.length,
                    relationship_count: filteredEdges.length,
                };
                this._graph3d?.dispose();
                this._graph3d = new KnowledgeGraph3D(this._graphContainer, {
                    onEntityClick: (entity) => this._showEntityCard(entity, allEntities),
                    entryIds: [entityId],
                });
                this._graph3d.loadGraph(graphData);
                this._infoBar.textContent = `Seed: ${entityId} - ${slice.length} of ${allEntities.length} entities, ${filteredEdges.length} edges (${data.hops}-hop)`;
            };

            // Slider callback: if user drags beyond the fetched set, re-fetch
            // with a larger limit so they actually see more entities.
            const onSliderChange = (n) => {
                if (n > allEntities.length && fetchLimit < 1000) {
                    this._fetchAndRenderNeighborhood(entityId, Math.min(1000, n + 50));
                } else {
                    renderTopN(n);
                }
            };
            const initial = this._setSliderConfig(allEntities.length, onSliderChange);
            renderTopN(initial);

            // Side panel: seed entity card
            const seed = allEntities.find(e => e.id === entityId);
            if (seed) this._showEntityCard(seed, allEntities);
        } catch (e) {
            this._sidePanel.innerHTML = `<div style="color:#c00">Failed to load neighborhood: ${this._escapeHtml(e.message)}</div>`;
            this._infoBar.textContent = 'Error.';
        }
    }

    // ── User question mode (in-panel retrieval, no chat needed) ─────

    _setupQuestionMode() {
        // Toolbar: question input + submit button + "Ask the assistant".
        const questionInput = document.createElement('input');
        questionInput.type = 'text';
        questionInput.placeholder = 'Ask the knowledge graph...';
        questionInput.style.cssText = 'flex:1;padding:5px 10px;font-size:12px;border:0.5px solid #c8c8c8;border-radius:4px;color:#333';
        this._modeControls.appendChild(questionInput);

        const submitBtn = document.createElement('button');
        submitBtn.className = 'rm-btn';
        submitBtn.style.cssText = 'padding:5px 10px;font-size:11px';
        submitBtn.innerHTML = '<i class="fa-solid fa-share-nodes" style="font-size:10px"></i>';
        submitBtn.title = 'Run retrieval on this question';
        this._modeControls.appendChild(submitBtn);

        // Ask-the-assistant button: feeds the cached retrieve payload
        // back to the LLM via /research/synthesize/stream and opens the
        // right pane with the streamed answer. Disabled until at least
        // one retrieval has succeeded.
        const askBtn = document.createElement('button');
        askBtn.className = 'rm-btn';
        askBtn.style.cssText = 'padding:5px 10px;font-size:11px';
        askBtn.innerHTML = '<i class="fa-solid fa-comment-dots" style="font-size:10px;margin-right:4px"></i>Ask';
        askBtn.title = 'Ask the assistant to answer using the loaded subgraph (no extra retrieve)';
        askBtn.disabled = true;
        this._modeControls.appendChild(askBtn);
        askBtn.addEventListener('click', () => this._askAssistantOnLoadedQuestion());
        this._askBtn = askBtn;

        this._sidePanel.innerHTML = '<div style="color:#888;font-style:italic">Type a question and press Enter to see the entities and relationships the model would use to answer it.</div>';
        this._infoBar.textContent = 'Awaiting question...';

        // Live retrieval as the user types: debounced 350ms after the
        // last keystroke, min 8 chars to avoid firing on single words.
        // AbortController cancels stale in-flight requests so newer
        // queries always win. Enter and the submit button bypass the
        // debounce for instant fire.
        let abortCtl = null;
        let typeTimer = null;
        const submit = async () => {
            const q = questionInput.value.trim();
            if (!q) return;
            if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
            // Abort any in-flight retrieve AND any in-flight LLM synth
            // - the previous question is now stale, free its GPU/CPU.
            if (abortCtl) abortCtl.abort();
            if (this._answerAbort) { this._answerAbort.abort(); this._answerAbort = null; }
            abortCtl = new AbortController();
            const myAbort = abortCtl;
            this._sidePanel.innerHTML = `<div style="color:#888">Retrieving for "${this._escapeHtml(q)}"...</div>`;
            this._infoBar.textContent = `Retrieving for "${q}"...`;
            try {
                const resp = await fetch(`api/graph/research/${this._resolveKbId()}/retrieve`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ question: q }),
                    signal: myAbort.signal,
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const payload = await resp.json();
                if (myAbort.signal.aborted) return;
                payload.question = q;
                this._lastQuestionPayload = payload;
                this._lastQuestion = q;
                if (this._askBtn) this._askBtn.disabled = false;
                this._renderQuestionResult(payload);
                // If the answer pane is open, auto-fire the LLM synth on
                // the freshly-retrieved subgraph. The pane being open is
                // the user's signal that they want answers tracking the
                // question. Closed pane = manual Ask only.
                if (this._answerPane && this._answerPane.style.display === 'flex') {
                    this._askAssistantOnLoadedQuestion();
                }
            } catch (e) {
                if (e.name === 'AbortError') return;
                this._sidePanel.innerHTML = `<div style="color:#c00">Retrieval failed: ${this._escapeHtml(e.message)}</div>`;
                this._infoBar.textContent = 'Error.';
            }
        };
        submitBtn.addEventListener('click', submit);
        questionInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
                submit();
            }
        });
        questionInput.addEventListener('input', () => {
            if (typeTimer) clearTimeout(typeTimer);
            const q = questionInput.value.trim();
            if (q.length < 3) return;
            typeTimer = setTimeout(submit, 350);
        });

        // Expose a helper so other parts of the panel (entity-list row
        // clicks) can populate the question input + trigger a fresh
        // retrieval without duplicating the debounce/abort plumbing.
        this._questionInput = questionInput;
        this._setQuestion = (text) => {
            if (!text) return;
            questionInput.value = text;
            // Fire submit (skip the debounce since this is a deliberate
            // user action, not typing).
            submit();
        };
    }

    /** Render a /research/retrieve payload (entry_entities + entities +
     * edges + per_entity_chunks + chunk_excerpts) into the panel's 3D
     * pane and side panel, exactly the way trace mode does for chat
     * answers - just sourced from a question typed here instead. */
    async _renderQuestionResult(payload) {
        const allEntities = payload.entities || [];
        if (!allEntities.length) {
            this._sidePanel.innerHTML = '<div style="color:#888">No entities matched. Try a more specific question.</div>';
            this._infoBar.textContent = '0 entities returned.';
            this._setSliderConfig(0, null);
            return;
        }

        const entityById = new Map(allEntities.map(e => [e.id, e]));
        const excerptById = new Map((payload.chunk_excerpts || []).map(c => [c.id, c]));
        const entryIds = new Set((payload.entry_entities || []).map(e => e.id));

        // Build the shared two-section side panel (detail card + clickable list).
        const { detailEl } = this._buildTraceSidePanel(this._sidePanel, payload, excerptById);

        const { KnowledgeGraph3D } = await import('./KnowledgeGraph3D.js');

        const renderTopN = (n) => {
            const sorted = [...allEntities].sort((a, b) => {
                const ra = ((a.properties || {}).rank ?? a.rank ?? 0);
                const rb = ((b.properties || {}).rank ?? b.rank ?? 0);
                return rb - ra;
            });
            const must = sorted.filter(e => entryIds.has(e.id));
            const rest = sorted.filter(e => !entryIds.has(e.id));
            const slice = [...must, ...rest].slice(0, n);
            const keepIds = new Set(slice.map(e => e.id));
            const relationships = (payload.edges || [])
                .filter(e => keepIds.has(e.source) && keepIds.has(e.target))
                .map(e => ({ source: e.source, target: e.target, type: e.type }));
            const graphData = { entities: slice, relationships, entity_count: slice.length, relationship_count: relationships.length };
            this._graph3d?.dispose();
            this._graph3d = new KnowledgeGraph3D(this._graphContainer, {
                onEntityClick: (entity) => {
                    const full = entityById.get(entity.id) || entity;
                    this._showTraceEntityDetails(detailEl, full, payload, excerptById);
                },
                entryIds: Array.from(entryIds),
            });
            this._graph3d.loadGraph(graphData);
            this._infoBar.textContent = `Question retrieval: ${slice.length} of ${allEntities.length} entities, ${relationships.length} edges`;
        };

        const initial = this._setSliderConfig(allEntities.length, renderTopN);
        renderTopN(initial);
    }

    /** Open the right pane and stream an LLM answer using the cached
     * payload from the last User question retrieval. No second BFS - the
     * subgraph + question are POSTed straight to /research/synthesize/stream. */
    async _askAssistantOnLoadedQuestion() {
        if (!this._lastQuestionPayload || !this._lastQuestion) return;
        const payload = this._lastQuestionPayload;
        const question = this._lastQuestion;
        this._openAnswerPane(question);
        if (this._answerAbort) this._answerAbort.abort();
        this._answerAbort = new AbortController();
        const myAbort = this._answerAbort;
        try {
            const resp = await fetch('api/llm/kg_answer/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    question,
                    entities: payload.entities || [],
                    edges: payload.edges || [],
                    chunk_excerpts: payload.chunk_excerpts || [],
                }),
                signal: myAbort.signal,
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            await this._streamAnswerIntoPane(resp, myAbort);
        } catch (e) {
            if (e.name === 'AbortError') return;
            this._answerBody.innerHTML = `<div style="color:#c00">Synthesis failed: ${this._escapeHtml(e.message)}</div>`;
        }
    }

    _openAnswerPane(question) {
        const pane = this._answerPane;
        if (!pane) return;
        pane.style.display = 'flex';
        if (this._answerSplitter) this._answerSplitter.style.display = 'block';
        pane.innerHTML = '';

        const header = document.createElement('div');
        header.style.cssText = 'padding:6px 10px;font-size:11px;color:#555;background:#fff;border-bottom:0.5px solid #e0e0e0;flex-shrink:0;display:flex;align-items:center;gap:6px';
        const title = document.createElement('span');
        title.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        title.innerHTML = `<i class="fa-solid fa-comment-dots" style="font-size:10px;margin-right:4px;color:#6096e5"></i><strong>Assistant answer</strong>`;
        header.appendChild(title);
        const closeBtn = document.createElement('button');
        closeBtn.className = 'rm-btn';
        closeBtn.style.cssText = 'padding:1px 6px;font-size:10px;flex-shrink:0';
        closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        closeBtn.title = 'Close answer pane';
        closeBtn.addEventListener('click', () => {
            if (this._answerAbort) this._answerAbort.abort();
            pane.style.display = 'none';
            if (this._answerSplitter) this._answerSplitter.style.display = 'none';
            pane.innerHTML = '';
            this._answerBody = null;
        });
        header.appendChild(closeBtn);
        pane.appendChild(header);

        const qStrip = document.createElement('div');
        qStrip.style.cssText = 'padding:5px 10px;font-size:10px;color:#666;background:#fafafa;border-bottom:0.5px solid #e0e0e0;font-style:italic';
        qStrip.textContent = question;
        pane.appendChild(qStrip);

        const body = document.createElement('div');
        body.className = 'kg-answer-body';
        body.style.cssText = 'flex:1;padding:10px 12px;overflow-y:auto;font-size:12px;line-height:1.5;color:#222';
        body.innerHTML = '<div style="color:#888;font-style:italic">Streaming...</div>';
        pane.appendChild(body);
        this._answerBody = body;
    }

    async _streamAnswerIntoPane(resp, myAbort) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let raw = '';
        const body = this._answerBody;
        body.innerHTML = '';
        const renderMd = (text) => {
            // Use marked if available (it is - already loaded for chat).
            try {
                body.innerHTML = (typeof marked !== 'undefined' && marked.parse)
                    ? marked.parse(text) : this._escapeHtml(text);
                body.scrollTop = body.scrollHeight;
            } catch {
                body.textContent = text;
            }
        };
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (myAbort.signal.aborted) return;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            let evName = 'message';
            const dataParts = [];
            for (const line of lines) {
                if (line === '') {
                    if (evName === 'token' && dataParts.length) {
                        try {
                            const d = JSON.parse(dataParts.join('\n'));
                            if (typeof d.text === 'string') {
                                raw += d.text;
                                renderMd(raw);
                            }
                        } catch {}
                    } else if (evName === 'error' && dataParts.length) {
                        try {
                            const d = JSON.parse(dataParts.join('\n'));
                            body.innerHTML = `<div style="color:#c00">${this._escapeHtml(d.detail || 'Unknown error')}</div>`;
                        } catch {}
                    }
                    evName = 'message';
                    dataParts.length = 0;
                } else if (line.startsWith('event:')) {
                    evName = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                    dataParts.push(line.slice(5).replace(/^ /, ''));
                }
            }
        }
    }

    _showEntityCard(entity, allEntities) {
        const props = entity.properties || {};
        const desc = props.description || '';
        const lbl = entity.label || entity.id;
        const typ = entity.type || '';

        let html = `<div style="margin-bottom:8px"><strong style="font-size:13px">${this._escapeHtml(lbl)}</strong>`;
        if (typ) html += ` <span style="color:#999;font-size:10px">(${this._escapeHtml(typ)})</span>`;
        html += '</div>';
        if (desc) {
            html += `<div style="margin-bottom:10px;color:#333;line-height:1.4">${this._escapeHtml(desc)}</div>`;
        }
        html += `<button class="rm-btn" data-action="recenter" style="padding:4px 10px;font-size:10px;margin-top:6px">Re-center on this entity</button>`;
        this._sidePanel.innerHTML = html;
        const recenter = this._sidePanel.querySelector('[data-action="recenter"]');
        if (recenter) recenter.addEventListener('click', () => this._loadEntityNeighborhood(entity.id));
    }

    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}
