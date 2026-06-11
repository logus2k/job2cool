import { iconPathForFile, iconPath, isTextEditable, isMediaViewable, kbDocIconForFile, FOLDER_ICON, FOLDER_OPEN_ICON } from '../file-icons.js';
import { clearActionBar, createDetailHeader } from './explorer/ExplorerHelpers.js';
import { notify } from '../Notify.js';
import { createProjectViews } from './explorer/ExplorerProjectViews.js';
import { createEnvViews } from './explorer/ExplorerEnvViews.js';
import { createExternalViews } from './explorer/ExplorerExternalViews.js';
import { createContextMenu } from './explorer/ExplorerContextMenu.js';
import { domainState } from '../domain-state.js';

/**
 * ExplorerPanel - Workspace tree (sidebar) and detail pane (center tab).
 * Root branches: Projects, Mounts, Environments, Knowledge Base.
 * Tree and detail are separate DOM elements wired together via app.js.
 *
 * This file is the orchestrator: it owns state, builds the tree, and routes
 * detail views to the extracted sub-modules via a shared `ctx` object.
 */
export class ExplorerPanel {
    /**
     * @param {object} callbacks
     *   onNotebookSelect(projectId, notebookName)
     *   onVenvSelect({ name, runtimeId, displayName })
     *   onVenvDeleted(name)
     *   onProjectDeleted(projectId)
     *   onNotebookDeleted(projectId, notebookName)
     *   onProjectRenamed(oldId, newId)
     *   onNotebookRenamed(projectId, oldName, newName)
     *   onSrcFileSelect(projectId, filename)
     */
    constructor(callbacks = {}) {
        this._callbacks = callbacks;
        this._tree = null;
        this._detailEl = null;
        this._detailRoot = null;
        this._treeRoot = null;
        this._treeEl = null;
        this._activeVenvName = null;
        this._activeVenvRuntimeId = null;
        this._kernelRunning = false;
        this._autoLoad = false;
        this._currentProject = null;
        this._currentNotebook = null;
        this._activeInstalls = {};
        this._envTerminals = {};
        this._projectsData = {};
        this._runtimes = [];
        this._docsCatalog = {};
        this._mountHostPaths = {};
        this._hydraViewEnabled = {};
        /** @type {import('../services/DecorationService.js').DecorationService|null} */
        this._decorationService = null;

        this._buildElements();
        this._buildCtx();
        this._initModules();
    }

    // ── Shared context ──────────────────────────────────────────────

    _buildCtx() {
        const self = this;
        this._ctx = {
            // DOM elements (getters for live access)
            get detailEl() { return self._detailEl; },
            get detailRoot() { return self._detailRoot; },
            get tree() { return self._tree; },

            // Callbacks
            get callbacks() { return self._callbacks; },

            // Mutable state with getters/setters
            get activeVenvName() { return self._activeVenvName; },
            set activeVenvName(v) { self._activeVenvName = v; },
            get activeVenvRuntimeId() { return self._activeVenvRuntimeId; },
            set activeVenvRuntimeId(v) { self._activeVenvRuntimeId = v; },
            get kernelRunning() { return self._kernelRunning; },
            get envTerminals() { return self._envTerminals; },
            get activeInstalls() { return self._activeInstalls; },

            // Data from API
            get runtimes() { return self._runtimes; },
            get docsCatalog() { return self._docsCatalog; },
            set docsCatalog(v) { self._docsCatalog = v; },
            get mountHostPaths() { return self._mountHostPaths; },
            get projectSources() { return self._projectSources; },
            get decorationService() { return self._decorationService; },
            get hydraViewEnabled() { return self._hydraViewEnabled; },

            // Orchestrator functions exposed to modules
            showWelcomeDetail: () => self._showWelcomeDetail(),
            getDisplayName: (id) => self._getDisplayName(id),
            parseFileKey: (key) => self._parseFileKey(key),
            loadTree: () => self._loadTree(),
            fireSectionChange: (key) => self._fireSectionChange(key),
            triggerUpload: (rootType, rootName, relPath) => self._triggerUpload(rootType, rootName, relPath),

            // Cross-module references (set after module init)
            views: null,
            contextMenu: null,

            // App instance (for context menus that need to open panels etc.)
            // Set externally after construction so the App can wire itself.
            app: null,
        };
    }

    _initModules() {
        const ctx = this._ctx;
        this._projectViews = createProjectViews(ctx);
        this._envViews = createEnvViews(ctx);
        this._externalViews = createExternalViews(ctx);
        this._contextMenuMod = createContextMenu(ctx);

        // Wire cross-module references
        ctx.views = {
            project: this._projectViews,
            env: this._envViews,
            external: this._externalViews,
        };
        ctx.contextMenu = this._contextMenuMod;
    }

    // ── Public API ──────────────────────────────────────────────────

    setDecorationService(service) {
        this._decorationService = service;
    }

    repaintDecorations() {
        if (this._tree) {
            this._tree.visit((node) => { node.update(); });
        }
    }

    setActiveVenv(name, runtimeId) {
        this._activeVenvName = name;
        if (runtimeId) this._activeVenvRuntimeId = runtimeId;
    }

    setKernelRunning(running) {
        this._kernelRunning = running;
        this._syncStatusTag();
    }

    async _loadApiEndpoints() {
        try {
            const resp = await fetch('api/serving/health');
            if (!resp.ok) return [{ title: 'Serving unavailable', key: 'api-error', icon: 'fa-solid fa-circle-exclamation' }];
            const data = await resp.json();
            // The /health payload uses `model_name`, not `model` (see
            // client/app/model_loader.py get_health). Reading `data.model`
            // here silently failed: the check `status === 'ready' && data.model`
            // never matched a live-serving state, so the tree always showed
            // the generic fallback "Status: ready" child node.
            const modelName = data.model_name;
            const nodes = [];
            if (data.status === 'ready' && modelName) {
                nodes.push({
                    title: `${modelName} v${data.version || '?'}`,
                    key: `api:serving:${modelName}`,
                    icon: 'fa-solid fa-circle-check',
                    folder: false,
                    _data: { ...data, endpoint: '/api/serving/predict', method: 'POST' },
                });
            } else if (data.status === 'idle') {
                nodes.push({ title: 'No model loaded', key: 'api-idle', icon: 'fa-solid fa-circle-info', folder: false });
            } else {
                nodes.push({ title: `Status: ${data.status}`, key: 'api-status', icon: 'fa-solid fa-spinner', folder: false });
            }
            return nodes;
        } catch {
            return [{ title: 'Serving not reachable', key: 'api-error', icon: 'fa-solid fa-circle-exclamation', folder: false }];
        }
    }

    get treeElement() { return this._treeRoot; }
    get detailElement() { return this._detailRoot; }
    get titleElement() { return this._titleBar; }
    get activeVenvName() { return this._activeVenvName; }
    get activeVenvRuntimeId() { return this._activeVenvRuntimeId; }

    refreshBreadcrumbs() {
        const active = this._tree?.getActiveNode();
        if (active) this._fireSectionChange(active.key || '');
    }

    navigate(opts = {}) {
        const { currentProject = null, currentNotebook = null, navigateToVenv = null, navigateToEnvs = false } = opts;
        this._currentProject = currentProject;
        this._currentNotebook = currentNotebook;
        this._navigateToVenvName = navigateToVenv;
        this._navigateToEnvs = navigateToEnvs;
        this._applyNavigation();
    }

    async init() {
        await this._loadTree();
        // Rebuild the tree whenever the active Domain set changes so the
        // green active indicator next to each Domain name stays in sync
        // across the Knowledge Base and Assistant subtrees. Full rebuild
        // (rather than per-node setIcon hacks) keeps state always-correct
        // per the locked design.
        if (this._unsubscribeDomainState) this._unsubscribeDomainState();
        this._unsubscribeDomainState = domainState.onChange(() => {
            this._loadTree().catch(err => console.warn('[ExplorerPanel] domain rebuild failed:', err));
        });
    }

    // ── DOM setup ───────────────────────────────────────────────────

    _buildElements() {
        // Sidebar title bar with dynamic action icons
        this._titleBar = document.createElement('div');
        this._titleBar.className = 'explorer-title-bar';
        this._titleBarLabel = document.createElement('span');
        this._titleBarLabel.className = 'explorer-title-label';
        this._titleBar.appendChild(this._titleBarLabel);
        this._titleBarActions = document.createElement('div');
        this._titleBarActions.className = 'explorer-title-actions';
        this._titleBar.appendChild(this._titleBarActions);

        this._treeRoot = document.createElement('div');
        this._treeRoot.className = 'explorer-tree-pane';

        const treeWrapper = document.createElement('div');
        treeWrapper.id = 'explorerTreeWrapper';

        this._treeEl = document.createElement('div');
        this._treeEl.id = 'explorerTree';
        treeWrapper.appendChild(this._treeEl);
        this._treeRoot.appendChild(treeWrapper);

        this._detailRoot = document.createElement('div');
        this._detailRoot.className = 'explorer-detail-pane';

        this._detailEl = document.createElement('div');
        this._detailEl.className = 'explorer-detail-content';
        this._detailRoot.appendChild(this._detailEl);

        this._showWelcomeDetail();
    }

    _showWelcomeDetail() {
        clearActionBar(this._detailRoot);
        this._detailEl.innerHTML = `
            <div class="explorer-detail-empty">
                <span>Select an item from the tree</span>
            </div>`;
    }

    // ── Status tag sync ─────────────────────────────────────────────

    _syncStatusTag() {
        if (!this._detailRoot) return;
        const tag = this._detailRoot.querySelector('.explorer-env-tag');
        if (!tag) return;
        if (this._kernelRunning) {
            tag.className = 'explorer-env-tag active';
            tag.textContent = 'ACTIVE';
        } else {
            tag.className = 'explorer-env-tag inactive';
            tag.textContent = 'INACTIVE';
        }
    }

    // ── Tree loading ────────────────────────────────────────────────

    async _loadTree() {
        // The `api/documents` fetch + flat doccat tree was retired when
        // the Knowledge Base root switched to the per-Domain shape. The
        // legacy ExplorerDocsViews module still owns its own lazy fetch
        // (called from the upload modal), so dropping this prefetch only
        // saves the round-trip; nothing else regresses.
        const [rootsResp, runtimesResp, envsResp] = await Promise.all([
            fetch('api/files/'),
            fetch('api/runtimes'),
            fetch('api/envs'),
        ]);

        const roots = await rootsResp.json();
        // Merge internal projects and mounts into a single list
        const internalProjects = (roots.projects || []).map(p => ({ ...p, source: 'internal' }));
        const mountProjects = (roots.mounts || []).map(m => ({ id: m.name, name: m.name, source: 'mount', host_path: m.host_path, ...m }));
        const projects = [...internalProjects, ...mountProjects];
        this._mountHostPaths = {};
        for (const m of mountProjects) this._mountHostPaths[m.name] = m.host_path || '';
        this._runtimes = await runtimesResp.json();
        const envs = await envsResp.json();

        this._projectsData = {};
        for (const p of projects) this._projectsData[p.id] = p;

        // Group envs by runtime_id
        const envsByRuntime = {};
        for (const env of envs) {
            if (!envsByRuntime[env.runtime_id]) envsByRuntime[env.runtime_id] = [];
            envsByRuntime[env.runtime_id].push(env);
        }

        const activeEnv = this._activeVenvName
            ? envs.find(e => e.name === this._activeVenvName)
            : null;
        const activeRuntimeId = activeEnv ? activeEnv.runtime_id : null;

        // Group runtimes by language, then build language -> runtime -> env hierarchy
        const runtimesByLang = {};
        for (const rt of this._runtimes) {
            const lang = rt.runtime_id.split('/')[0] || 'other';
            if (!runtimesByLang[lang]) runtimesByLang[lang] = [];
            runtimesByLang[lang].push(rt);
        }

        const langDisplayNames = { python: 'Python', javascript: 'JavaScript' };
        const langOrder = ['python', 'javascript'];
        const sortedLangs = Object.keys(runtimesByLang).sort((a, b) => {
            const ai = langOrder.indexOf(a), bi = langOrder.indexOf(b);
            return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        });

        const runtimeNodes = sortedLangs.map(lang => ({
            title: langDisplayNames[lang] || lang.charAt(0).toUpperCase() + lang.slice(1),
            key: `lang:${lang}`,
            icon: 'fa-solid fa-circle',
            folder: true,
            expanded: runtimesByLang[lang].some(rt => rt.runtime_id === activeRuntimeId),
            children: runtimesByLang[lang]
                .slice().sort((a, b) => a.display_name.localeCompare(b.display_name))
                .map(rt => ({
                    title: rt.display_name,
                    key: `runtime:${rt.runtime_id}`,
                    icon: 'fa-solid fa-circle',
                    folder: true,
                    expanded: rt.runtime_id === activeRuntimeId,
                    children: (envsByRuntime[rt.runtime_id] || [])
                        .slice().sort((a, b) => a.name.localeCompare(b.name))
                        .map(env => ({
                            title: env.name,
                            key: `env:${env.runtime_id}:${env.name}`,
                            icon: 'fa-solid fa-cube',
                        }))
                }))
        }));

        // Per-Domain branches for both Knowledge Base and Assistant roots.
        // The legacy doccat/doc nodes (Documents categories) and the flat
        // kb-graph + assistant-skills/tools/embeddings branches were
        // replaced by Domain-aware sub-trees below.
        const domains = domainState.getDomains();
        const buildKbDomainNode = (d) => {
            const did = d.domain_id;
            const isActive = domainState.isActive(did);
            return {
                title: d.name || did,
                key: `kb-domain:${did}`,
                // Same icon as the Assistant-side per-Domain row so a Domain
                // is visually identical across both roots.
                icon: 'fa-solid fa-cube',
                folder: true,
                expanded: false,
                tooltip: d.description || '',
                _active: isActive,
                children: [
                    {
                        title: 'Vector',
                        key: `kb-domain:${did}:vector`,
                        // fa-bars-progress is unique to per-Domain Vector
                        // (no other tree node uses it), so the CSS rule
                        // matches the icon class directly without needing
                        // the data-type attribute (which doesn't survive
                        // Wunderbaum's selection-state re-renders).
                        icon: 'fa-solid fa-bars-progress',
                        folder: true,
                        lazy: true,
                    },
                    {
                        title: 'Graph',
                        key: `kb-domain:${did}:graph`,
                        icon: 'fa-solid fa-share-nodes',
                        folder: true,
                        lazy: true,
                    },
                ],
            };
        };
        const buildAsstDomainNode = (d) => {
            const did = d.domain_id;
            const isActive = domainState.isActive(did);
            return {
                title: d.name || did,
                key: `asst-domain:${did}`,
                icon: 'fa-solid fa-cube',
                folder: true,
                expanded: false,
                tooltip: d.description || '',
                _active: isActive,
                children: [
                    {
                        title: 'Skills',
                        key: `asst-domain:${did}:skills`,
                        icon: 'fa-solid fa-book-open',
                        folder: true,
                        lazy: true,
                    },
                    {
                        title: 'Tools',
                        key: `asst-domain:${did}:tools`,
                        icon: 'fa-solid fa-wrench',
                        folder: true,
                        lazy: true,
                    },
                ],
            };
        };
        const kbDomainNodes = domains.map(buildKbDomainNode);
        const asstDomainNodes = domains.map(buildAsstDomainNode);

        // Store mount host paths for later use (file operations, context)
        this._projectSources = {};
        for (const p of projects) {
            this._projectSources[p.id || p.name] = p.source;
            if (p.host_path) {
                this._mountHostPaths[p.name || p.id] = p.host_path;
            }
        }

        // Load Hydra view settings for all projects
        this._hydraViewEnabled = {};
        await Promise.all(projects.map(async (p) => {
            const pid = p.id || p.name;
            try {
                const r = await fetch(`api/hydra/view/${encodeURIComponent(pid)}`);
                if (r.ok) {
                    const data = await r.json();
                    this._hydraViewEnabled[pid] = data.enabled || false;
                }
            } catch { /* ignore */ }
        }));

        const treeData = [
            {
                title: 'Projects',
                key: 'root-projects',
                icon: 'fa-solid fa-clipboard-list',
                folder: true,
                expanded: false,
                children: projects.map(p => ({
                    title: p.id || p.name,
                    key: `project:${p.id || p.name}`,
                    icon: 'fa-solid fa-clipboard-list',
                    folder: true,
                    lazy: true,
                })),
            },
            {
                title: 'Experiments',
                key: 'root-experiments',
                icon: 'fa-solid fa-vial',
                folder: true,
                expanded: false,
                lazy: true,
            },
            {
                title: 'Data',
                key: 'root-data-parent',
                icon: 'fa-solid fa-cubes-stacked',
                folder: true,
                expanded: false,
                children: [
                    {
                        title: 'Catalog',
                        key: 'root-data',
                        icon: 'fa-solid fa-cubes-stacked',
                        folder: true,
                        expanded: false,
                        lazy: true,
                    },
                    {
                        title: 'Storage',
                        key: 'root-storage',
                        icon: 'fa-solid fa-database',
                        folder: true,
                        expanded: false,
                        lazy: true,
                    },
                ],
            },
            {
                title: 'Orchestration',
                key: 'root-pipelines',
                icon: 'fa-solid fa-diagram-project',
                folder: true,
                expanded: false,
                lazy: true,
            },
            {
                title: 'Models',
                key: 'root-models-parent',
                icon: 'fa-solid fa-brain',
                folder: true,
                expanded: false,
                children: [
                    {
                        title: 'Registry',
                        key: 'root-models',
                        icon: 'fa-solid fa-brain',
                        folder: true,
                        expanded: false,
                        lazy: true,
                    },
                    {
                        title: 'APIs',
                        key: 'root-apis',
                        icon: 'fa-solid fa-plug',
                        folder: true,
                        expanded: false,
                        lazy: true,
                    },
                ],
            },
            {
                title: 'Environments',
                key: 'root-envs',
                icon: 'fa-solid fa-layer-group',
                folder: true,
                expanded: false,
                children: runtimeNodes,
            },
            {
                title: 'Knowledge Base',
                key: 'root-docs',
                icon: 'fa-solid fa-landmark',
                folder: true,
                expanded: false,
                children: [
                    {
                        title: 'Domains',
                        key: 'kb-domains',
                        icon: 'fa-solid fa-cubes',
                        folder: true,
                        expanded: false,
                        children: kbDomainNodes,
                    },
                    {
                        title: 'Documents',
                        key: 'kb-documents',
                        icon: 'fa-solid fa-file-lines',
                        folder: true,
                        expanded: false,
                        lazy: true,
                    },
                ],
            },
            {
                title: 'Assistant',
                key: 'root-assistant',
                icon: 'fa-solid fa-robot',
                folder: true,
                expanded: false,
                children: [
                    {
                        title: 'Domains',
                        key: 'asst-domains',
                        icon: 'fa-solid fa-cubes',
                        folder: true,
                        expanded: false,
                        children: asstDomainNodes,
                    },
                ],
            },
        ];

        // Destroy previous tree instance before creating a new one
        if (this._tree) {
            try { this._tree.destroy(); } catch (_) { /* ignore */ }
            this._tree = null;
            const wrapper = this._treeRoot.querySelector('#explorerTreeWrapper');
            if (wrapper) {
                wrapper.innerHTML = '';
                this._treeEl = document.createElement('div');
                this._treeEl.id = 'explorerTree';
                wrapper.appendChild(this._treeEl);
            }
        }

        this._tree = new mar10.Wunderbaum({
            adjustHeight: false,
            element: this._treeEl,
            source: treeData,
            selectMode: 'single',
            checkbox: false,
            icon: true,
            iconMap: {
                folder: 'fa-solid fa-folder',
                folderOpen: 'fa-solid fa-folder-open',
                doc: 'fa-solid fa-file',
                expanderExpanded: 'fa-solid fa-chevron-down',
                expanderCollapsed: 'fa-solid fa-chevron-right',
            },
            render: (e) => this._onTreeRender(e),
            lazyLoad: (e) => this._onTreeLazyLoad(e),
            activate: (e) => this._onTreeActivate(e),
            click: (e) => this._onTreeClick(e),
            dblclick: (e) => this._onTreeDblClick(e),
        });

        // Chevron (expander) single-click to expand/collapse.
        // Must be a direct DOM listener because Wunderbaum's click
        // callback doesn't reliably pass through expander clicks
        // when the callback returns false for other click types.
        this._treeEl.addEventListener('click', (ev) => {
            const target = ev.target.closest('.wb-expander');
            if (!target) return;
            const node = mar10.Wunderbaum.getNode(ev);
            if (!node) return;
            ev.stopPropagation();
            if (node.isExpanded()) {
                node.setExpanded(false);
            } else {
                if (node.lazy) node.resetLazy();
                node.setExpanded(true);
            }
        }, true); // useCapture to fire before Wunderbaum's handler

        // Right-click context menu on tree nodes. setActive() below
        // triggers _onTreeActivate, which for some keys (kb-graph etc.)
        // opens a panel as a side-effect of left-click navigation. Set a
        // one-shot flag so the activate handler skips that side-effect
        // when the activation came from a right-click. The row still
        // highlights (which is what setActive is for here).
        this._treeEl.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            const node = mar10.Wunderbaum.getNode(ev);
            if (!node) return;
            this._suppressNavOnNextActivate = true;
            node.setActive(true);
            this._contextMenuMod.showContextMenu(ev, node);
        });

        // Delete key on active tree node
        this._treeEl.addEventListener('keydown', (ev) => {
            if (ev.key !== 'Delete') return;
            const node = this._tree?.getActiveNode();
            if (!node) return;
            const key = node.key || '';
            const cm = this._ctx.contextMenu;
            if (key.startsWith('pfile:') || key.startsWith('mfile:') || key.startsWith('pdir:') || key.startsWith('mdir:')) {
                const { rootType, rootName, relPath } = this._parseFileKey(key);
                cm.ctxDeleteEntry(rootType, rootName, relPath, node);
            } else if (key.startsWith('project:')) {
                cm.ctxDeleteProject(key.substring(8), node);
            } else if (key.startsWith('env:')) {
                const rest = key.substring(4);
                const lastColon = rest.lastIndexOf(':');
                const runtimeId = rest.substring(0, lastColon);
                const envName = rest.substring(lastColon + 1);
                cm.ctxDeleteEnv(envName, runtimeId, node);
            } else if (key.startsWith('mlrun:')) {
                const rest = key.substring(6);
                const idx = rest.indexOf(':');
                cm.ctxDeleteRun(rest.substring(idx + 1), rest.substring(0, idx), node);
            } else if (key.startsWith('experiment:')) {
                cm.ctxDeleteExperiment(key.substring(11), node);
            }
        });

        this._applyNavigation();
    }

    static _ICON_COLORS = {
        'root-projects': '#66bb6a', 'root-data-parent': '#8d6e63', 'root-data': '#8d6e63',
        'root-experiments': '#ab47bc', 'root-models-parent': '#ef5350', 'root-models': '#ef5350',
        'root-envs': '#42a5f5', 'root-storage': '#ffa726',
        'root-pipelines': '#26a69a', 'root-apis': '#42a5f5',
        'root-docs': '#ffffff',
        // root-assistant intentionally omitted: it gets the inline-SVG
        // robot icon from the icon-bar instead of an FA glyph + color.
        // Both Domains parents share the same color so Knowledge Base
        // and Assistant give the user a consistent visual anchor for
        // "Domains". Per-Domain leaf rows (`kb-domain:<id>` /
        // `asst-domain:<id>`) inherit this color via _recolorNode below.
        'kb-domains': '#ffcc00', 'asst-domains': '#ffcc00',
        'embeddings-empty': '#4a9eda',
    };

    _recolorVisibleRows() {
        if (!this._tree) return;
        // Walk all loaded nodes and recolor each (only renders for visible ones)
        this._tree.visit?.((node) => {
            const row = node.getRowElem?.() || node._rowElem;
            if (row) this._recolorNode(node, row);
        });
    }

    _recolorNode(node, row) {
        const key = node?.key || '';
        if (!row) {
            // Try multiple ways to find the row element
            row = node?.getRowElem?.() || node?._rowElem;
            if (!row && this._treeEl) {
                // Search DOM for the node's row by matching title text
                for (const r of this._treeEl.querySelectorAll('div.wb-row')) {
                    const span = r.querySelector('span.wb-node');
                    if (span?.dataset?.key === key) { row = r; break; }
                }
            }
        }
        if (!row) return;
        const iconEl = row.querySelector('i.wb-icon');
        if (!iconEl) return;

        // Per-Domain Vector branch (kb-domain:<id>:vector) parent and
        // chunk leaves (emb:chunk:*) keep the legacy gray. Source-doc
        // children (emb:src:*) get the same white file-icon treatment as
        // every other document leaf in the tree (kb-documents:doc:*,
        // kb-domain:*:doc:*) so docs read uniformly across views.
        // setProperty 'important' beats the class-based !important on
        // .fa-database / .fa-file-lines.
        if (/^kb-domain:[^:]+:vector$/.test(key) || key.startsWith('emb:chunk:')) {
            iconEl.style.setProperty('color', '#cfd8dc', 'important');
            return;
        }
        if (key.startsWith('emb:src:')) {
            iconEl.style.setProperty('color', '#ffffff', 'important');
            return;
        }

        // Per-Domain Graph branch + its sub-branches and leaves.
        // Graph parent uses cyan, Communities/Documents use lighter cyan.
        if (/^kb-domain:[^:]+:graph$/.test(key)) {
            iconEl.style.setProperty('color', '#4dd0e1', 'important');
            return;
        }
        if (/^kb-domain:[^:]+:graph:comm$/.test(key)
            || key.startsWith('kb-graph-comm:')) {
            iconEl.style.setProperty('color', '#4dd0e1', 'important');
            return;
        }
        if (/^kb-domain:[^:]+:graph:docs$/.test(key)
            || key.startsWith('kb-graph-doc:')) {
            iconEl.style.setProperty('color', '#80deea', 'important');
            return;
        }
        // Top-level Documents (cross-Domain) parent node only. Uses the
        // same green as the Assistant-side Skills branch for visual rhyme
        // between the "knowledge" and "capability" halves. Category folders
        // (kb-documents:cat:*) use the SVG folder icon instead, sharing the
        // visual treatment with Project folders (handled in the FOLDER_ICON
        // override below).
        if (key === 'kb-documents') {
            iconEl.style.setProperty('color', '#81c784', 'important');
            return;
        }
        // Document leaves under both the cross-Domain Documents tree and
        // the per-Domain corpus list. White fill via inline-!important so
        // it beats the class-based `.fa-file-lines { color: #b0bec5
        // !important }` rule. The data-type CSS approach didn't apply
        // (Wunderbaum's nodeElem was either a wrapper or had its data-
        // type wiped before the icon got painted).
        if (/^kb-documents:doc:/.test(key) || /^kb-domain:[^:]+:doc:/.test(key)) {
            iconEl.style.setProperty('color', '#ffffff', 'important');
            return;
        }
        // Empty-state placeholder leaves (info-circle icon) get a uniform
        // light blue so they read as "informational" regardless of which
        // branch they sit under.
        if (key.endsWith(':empty') || key === 'kb-documents:empty') {
            iconEl.style.setProperty('color', '#4a9eda', 'important');
            return;
        }
        // Per-Domain Skills / Tools branches (Assistant side).
        if (/^asst-domain:[^:]+:skills$/.test(key)) {
            iconEl.style.setProperty('color', '#81c784', 'important');
            return;
        }
        if (/^asst-domain:[^:]+:tools$/.test(key)) {
            iconEl.style.setProperty('color', '#64b5f6', 'important');
            return;
        }
        // Per-Domain root nodes (the Domain name in either tree). Use the
        // same pastel orange as the parent `Domains` row for visual
        // consistency. Active state is signalled separately via the green
        // check overlay appended in _onTreeRender.
        if (/^kb-domain:[^:]+$/.test(key) || /^asst-domain:[^:]+$/.test(key)) {
            iconEl.style.setProperty('color', '#ffcc00', 'important');
            return;
        }

        const color = ExplorerPanel._ICON_COLORS[key];
        if (color) {
            // kb-domains / asst-domains use fa-cubes which has a class-based
            // !important green; we need setProperty('important') to override.
            if (key === 'kb-domains' || key === 'asst-domains') {
                iconEl.style.setProperty('color', color, 'important');
            } else {
                iconEl.style.color = color;
            }
            return;
        }

        // Per-Domain leaf rows (kb-domain:<id> and asst-domain:<id>) share
        // the same color as their `Domains` parent for visual consistency.
        if (/^(kb|asst)-domain:[^:]+$/.test(key)) {
            iconEl.style.setProperty('color', '#ffcc00', 'important');
            return;
        }

        // Folder SVG override
        if (node.icon === FOLDER_ICON || node.icon === FOLDER_OPEN_ICON) {
            const svg = node.expanded ? 'folder_open_color' : 'folder_color';
            iconEl.style.backgroundImage = `url(static/vendor/icons/${svg}.svg)`;
            iconEl.style.backgroundSize = 'contain';
            iconEl.style.backgroundPosition = 'center';
            iconEl.style.color = 'transparent';
            iconEl.style.fontSize = '0';
            return;
        }

        // Custom SVG override for the Assistant root - reuses the same
        // inline-SVG robot used in the left icon-bar so the two surfaces
        // refer to the Assistant with one identical glyph.
        //
        // The wb-icon outer box is already 18px (--wb-icon-outer-width).
        // explorer-panel.css line 687 caps background-image icons to
        // 15x15 with !important; we override that here with a same-priority
        // inline !important so the SVG fills the 18px container, matching
        // the visual weight of the FA glyph-based root icons. Width/height
        // are intentionally NOT touched so the title position does not shift.
        if (key === 'root-assistant') {
            iconEl.style.backgroundImage = 'url(static/vendor/icons/assistant_color.svg)';
            iconEl.style.setProperty('background-size', '18px 18px', 'important');
            iconEl.style.backgroundPosition = 'center';
            iconEl.style.backgroundRepeat = 'no-repeat';
            iconEl.style.color = 'transparent';
            iconEl.style.fontSize = '0';
            return;
        }

        const langSvgMap = { 'lang:python': 'python_color', 'lang:javascript': 'javascript_color', 'lang:r': 'r_color' };
        const langSvg = langSvgMap[key] || (key.startsWith('runtime:') ? langSvgMap[`lang:${key.substring(8).split('/')[0]}`] : null);
        if (langSvg) {
            iconEl.style.backgroundImage = `url(static/vendor/icons/${langSvg}.svg)`;
            iconEl.style.backgroundSize = 'contain';
            iconEl.style.backgroundPosition = 'center';
            iconEl.style.color = 'transparent';
            iconEl.style.fontSize = '0';
            return;
        }

        if (key.startsWith('skill:')) iconEl.style.color = '#81c784';
        else if (key.startsWith('mcptool:')) iconEl.style.color = key.startsWith('mcptool:write:') ? '#ff9800' : '#64b5f6';
        else if (key.startsWith('skillref:')) iconEl.style.color = '#bcaaa4';
        // emb:src:* handled earlier with inline-!important white; no-op here.
        else if (key.startsWith('emb:chunk:')) iconEl.style.color = '#cfd8dc';
        // Logged Models (MLflow 3.x) - use Files grey. Override has to
        // beat the class-based `.fa-brain { color: #e091d0 !important }`
        // rule applied to every Models icon in the tree, so we use
        // setProperty with the 'important' flag (inline !important beats
        // class-based !important).
        else if (key.startsWith('mllm-cat:') || key.startsWith('mllm:')) {
            iconEl.style.setProperty('color', '#b0bec5', 'important');
        }
    }

    // ── Tree event handlers ─────────────────────────────────────────

    _onTreeRender(e) {
        const node = e.node;
        const row = e.nodeElem;
        if (!row) return;

        const key = node.key || '';
        let type = '';
        if (key === 'root-projects' || key === 'root-envs' || key === 'root-docs' || key === 'root-storage' || key === 'root-experiments' || key === 'root-data' || key === 'root-data-parent' || key === 'root-pipelines' || key === 'root-models' || key === 'root-models-parent' || key === 'root-apis' || key === 'root-assistant') type = 'root';
        else if (key.startsWith('lang:')) type = 'root';
        else if (key.startsWith('project:') || key.startsWith('mount:')) type = 'project';
        else if (key.startsWith('pdir:') || key.startsWith('mdir:')) type = 'dir';
        else if (key.startsWith('pfile:') || key.startsWith('mfile:')) type = 'file';
        else if (key.startsWith('runtime:')) type = 'runtime';
        else if (key.startsWith('env:')) type = 'env';
        else if (key.startsWith('doccat:')) type = 'doccat';
        else if (key.startsWith('doc:')) type = 'doc';
        else if (key.startsWith('bucket:')) type = 'bucket';
        else if (key.startsWith('s3folder:') || key.startsWith('s3obj:')) type = 's3node';
        else if (key.startsWith('experiment:')) type = 'experiment';
        else if (key.startsWith('mlrun:')) type = 'mlrun';
        else if (key.startsWith('mlart-cat:')) type = 'mlart-cat';
        else if (key.startsWith('mlart:')) type = 'artifact';
        else if (key.startsWith('mllm-cat:')) type = 'mllm-cat';
        else if (key.startsWith('mllm:')) type = 'logged-model';
        // Per-Domain tree row types - drives class-based CSS coloring
        // that survives Wunderbaum's row re-renders on selection state
        // changes. Inline color (set by _recolorNode) is wiped on
        // activate/deactivate; CSS via [data-type] persists.
        else if (key === 'kb-domains' || key === 'asst-domains') type = 'domains-parent';
        else if (key === 'kb-documents') type = 'kb-documents';
        else if (key.startsWith('kb-documents:cat:')) type = 'kb-documents-cat';
        else if (/^kb-domain:[^:]+$/.test(key)) type = 'kb-domain-row';
        else if (/^asst-domain:[^:]+$/.test(key)) type = 'asst-domain-row';
        else if (/^kb-domain:[^:]+:vector$/.test(key)) type = 'kb-domain-vector';
        else if (/^kb-domain:[^:]+:graph$/.test(key)) type = 'kb-domain-graph';
        else if (/^kb-domain:[^:]+:graph:comm:[^:]+$/.test(key)) type = 'kb-domain-comm';
        else if (/^asst-domain:[^:]+:skills$/.test(key)) type = 'asst-domain-skills';
        else if (/^asst-domain:[^:]+:tools$/.test(key)) type = 'asst-domain-tools';
        // Document leaves (both cross-Domain Documents tree and per-Domain
        // corpus list). The CSS uses these to override the default gray
        // .fa-file-lines color with white. Order matters - check the
        // longer, more-specific pattern first.
        else if (/^kb-documents:doc:/.test(key)) type = 'kb-documents-doc';
        else if (/^kb-domain:[^:]+:doc:/.test(key)) type = 'kb-domain-corpus-doc';
        row.setAttribute('data-type', type);

        this._recolorNode(node, row);
        // Icon may not be in DOM yet during render - retry after paint
        requestAnimationFrame(() => this._recolorNode(node, row));


        // Swap folder icon based on expanded state
        if (node.icon === FOLDER_ICON || node.icon === FOLDER_OPEN_ICON) {
            node.icon = node.expanded ? FOLDER_OPEN_ICON : FOLDER_ICON;
            const iconEl = row.querySelector('i.wb-icon');
            if (iconEl) iconEl.className = 'wb-icon ' + node.icon;
        }

        // F6.1 / F6.4: provenance badge for self-authored tools and skills.
        // Trailing "U" decoration — same right-edge slot pattern as the
        // git-decoration-dot, since tool/skill rows never carry git status
        // (they're not files in the working tree). Replaces the earlier
        // inline 'user' pill so the trailing-icons region stays the single
        // source of truth for "this row has a status of some kind".
        // Lookup is via _userAuthoredKeys (populated by _loadToolsTree /
        // _loadSkillsTree) rather than node.data — Wunderbaum's `data`
        // field doesn't reach the render hook reliably for lazy-loaded
        // children, but `node.key` always does.
        const isUserAuthored = !!(this._userAuthoredKeys && this._userAuthoredKeys.has(key));
        let userBadge = row.querySelector(':scope > .user-tool-badge');
        if (isUserAuthored) {
            if (!userBadge) {
                userBadge = document.createElement('span');
                userBadge.className = 'user-tool-badge';
                userBadge.textContent = 'U';
                userBadge.title = 'User-authored';
                row.appendChild(userBadge);
            }
        } else if (userBadge) {
            userBadge.remove();
        }
        // Belt-and-suspenders: clean up any stale inline pill from before
        // the trailing-badge migration (cached DOM nodes from older sessions).
        const stalePill = row.querySelector(':scope > .explorer-prov-pill');
        if (stalePill) stalePill.remove();

        // Active-Domain indicator: green check appended after the title for
        // any per-Domain row whose domain_id is in the active set. Affects
        // both `kb-domain:<id>` and `asst-domain:<id>` (the leaf-level
        // Domain rows). Sub-branches (`kb-domain:<id>:vector`, etc.) get
        // no indicator - parent is enough to communicate active state.
        const isDomainLeaf = /^(kb|asst)-domain:[^:]+$/.test(key);
        let activeBadge = row.querySelector(':scope > .domain-active-badge');
        if (isDomainLeaf) {
            const did = key.replace(/^(kb|asst)-domain:/, '');
            const isActive = domainState.isActive(did);
            if (isActive) {
                if (!activeBadge) {
                    activeBadge = document.createElement('span');
                    activeBadge.className = 'domain-active-badge';
                    // Absolute-positioned at the right edge of the row, same
                    // pattern git/dvc badges use (.git-status-badges in CSS).
                    // Margin-left would flow after title and overflow the
                    // panel's right margin on narrow widths.
                    activeBadge.style.cssText = 'position:absolute;right:10px;top:50%;transform:translateY(-50%);color:#5b9400;display:inline-flex;align-items:center;justify-content:center';
                    activeBadge.title = 'Active Domain';
                    // Inline `on-tag` SVG (frontend/images/on-tag.svg) — the
                    // ON tag icon. `stroke="currentColor"` lets the green
                    // `color` above drive the stroke; one node, no extra HTTP.
                    activeBadge.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M1 15V9a6 6 0 0 1 6-6h10a6 6 0 0 1 6 6v6a6 6 0 0 1-6 6H7a6 6 0 0 1-6-6Z"/><path d="M9 9a3 3 0 1 1 0 6a3 3 0 0 1 0-6Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M14 15V9l4 6V9"/></svg>';
                    row.appendChild(activeBadge);
                }
            } else if (activeBadge) {
                activeBadge.remove();
            }
        } else if (activeBadge) {
            activeBadge.remove();
        }

        // Git/DVC status decorations
        if (this._decorationService) {
            const deco = this._decorationService.getDecoration(key);
            const titleEl = row.querySelector('.wb-title');

            let existingDot = row.querySelector(':scope > .git-decoration-dot');
            if (deco) {
                if (!existingDot) {
                    existingDot = document.createElement('span');
                    existingDot.className = 'git-decoration-dot';
                    row.appendChild(existingDot);
                }
                existingDot.style.background = deco.color;
                existingDot.classList.toggle('ancestor', deco.ancestor);
                existingDot.classList.toggle('dvc', deco.source === 'dvc');
                existingDot.title = deco.ancestor ? '' : this._decorationService.getStatusTooltip(deco);
            } else if (existingDot) {
                existingDot.remove();
            }

            let badgeWrap = row.querySelector(':scope > .git-status-badges');
            if (deco && deco.letter && !deco.ancestor) {
                if (!badgeWrap) {
                    badgeWrap = document.createElement('span');
                    badgeWrap.className = 'git-status-badges';
                    row.appendChild(badgeWrap);
                }
                const src = deco.source === 'dvc' ? 'DVC' : 'GIT';
                const srcClass = deco.source === 'dvc' ? 'source-dvc' : 'source-git';
                const syncHtml = deco.syncIcon
                    ? `<i class="fa-solid fa-${deco.syncIcon === 'cloud-check' ? 'cloud' : 'cloud-arrow-up'}" style="font-size:9px;margin-left:4px;color:${deco.syncIcon === 'cloud-check' ? '#4caf50' : '#ff9800'}"></i>`
                    : '';
                badgeWrap.innerHTML =
                    `<span class="git-source-badge ${srcClass}">${src}</span>` +
                    `<span class="git-letter-badge" style="color:${deco.color}">${deco.letter}</span>` +
                    syncHtml;
                badgeWrap.title = this._decorationService.getStatusTooltip(deco);
            } else if (badgeWrap) {
                badgeWrap.remove();
            }

            if (titleEl) {
                titleEl.style.color = (deco && !deco.ancestor) ? deco.color : '';
            }
        }
    }

    async _onTreeLazyLoad(e) {
        const node = e.node;
        const key = node.key || '';

        // Experiments lazy loading
        if (key === 'root-experiments') return this._externalViews.loadExperiments();
        if (key.startsWith('experiment:')) return this._externalViews.loadExperimentRuns(key);
        if (key.startsWith('mlrun:')) return this._externalViews.loadRunArtifactCategories(key);
        if (key.startsWith('mlart-cat:')) return this._externalViews.loadArtifactCategory(key);
        if (key.startsWith('mlart:')) return this._externalViews.loadArtifactSubdir(key);
        if (key.startsWith('mllm-cat:')) return this._externalViews.loadLoggedModelsCategory(key);
        if (key.startsWith('mllm:')) return this._externalViews.loadLoggedModelSubdir(key);

        // Data lazy loading
        if (key === 'root-data') return this._externalViews.loadDataCollections();
        if (key.startsWith('datacol:')) return this._externalViews.loadDataFiles(key);

        // Storage lazy loading
        if (key === 'root-storage') return this._externalViews.loadStorageBuckets();
        if (key.startsWith('bucket:') || key.startsWith('s3folder:')) return this._externalViews.loadStorageObjects(key);

        // Pipelines lazy loading
        if (key === 'root-pipelines') return this._externalViews.loadPipelines();
        if (key.startsWith('dag:')) return this._externalViews.loadDagRuns(key);
        if (key.startsWith('dagrun:')) return this._externalViews.loadDagRunTasks(key);

        // Knowledge Base subtrees
        // kb-documents                   -> cross-Domain document list (read-only + read-store)
        // kb-domain:<id>:vector          -> indexed sources (per-collection)
        // kb-domain:<id>:graph:comm      -> communities (per-Domain)
        // kb-domain:<id>:graph:docs      -> graph documents (per-Domain)
        // emb:src:<b64>                  -> chunks under a Vector source
        if (key === 'kb-documents') {
            return this._loadAllDocuments();
        }
        if (/^kb-domain:[^:]+:vector$/.test(key)) {
            const did = key.split(':')[1];
            return this._loadEmbeddingsSources(did);
        }
        // Graph node lists communities directly - intermediate Communities
        // / Documents children were collapsed into one level.
        if (/^kb-domain:[^:]+:graph$/.test(key)) {
            const did = key.split(':')[1];
            return this._loadGraphCommunities(did);
        }
        if (key.startsWith('emb:src:')) {
            // Vector chunk leaves: source id is base64; Domain id is on
            // the parent's key so we can route to the right collection.
            const parent = node.parent;
            const did = (parent?.key || '').match(/^kb-domain:([^:]+):vector$/)?.[1];
            return this._loadEmbeddingsChunks(key.substring('emb:src:'.length), did);
        }

        // Per-Domain Assistant subtrees
        if (/^asst-domain:[^:]+:skills$/.test(key)) {
            const did = key.split(':')[1];
            return this._loadSkillsTree(did);
        }
        if (/^asst-domain:[^:]+:tools$/.test(key)) {
            const did = key.split(':')[1];
            return this._loadToolsTree(did);
        }

        // APIs
        if (key === 'root-apis') return this._loadApiEndpoints();

        // Models lazy loading
        if (key === 'root-models') return this._externalViews.loadModels();
        if (key.startsWith('regmodel:')) return this._externalViews.loadModelVersions(key);

        // Generic directory loading for all projects (internal + mounted)
        let rootName = null, relPath = '';
        if (key.startsWith('project:')) {
            rootName = key.substring(8);
        } else if (key.startsWith('mount:')) {
            // Legacy mount: keys - treat as project
            rootName = key.substring(6);
        } else if (key.startsWith('pdir:')) {
            const rest = key.substring(5);
            const idx = rest.indexOf(':');
            rootName = rest.substring(0, idx);
            relPath = rest.substring(idx + 1);
        } else if (key.startsWith('mdir:')) {
            // Legacy mdir: keys - treat as pdir
            const rest = key.substring(5);
            const idx = rest.indexOf(':');
            rootName = rest.substring(0, idx);
            relPath = rest.substring(idx + 1);
        }

        if (!rootName) return [];

        // Determine root_type for the file API (still uses project/mount in URLs for now)
        const source = this._projectSources?.[rootName] || 'internal';
        const rootType = source === 'mount' ? 'mount' : 'project';
        try {
            const url = `api/files/${rootType}/${encodeURIComponent(rootName)}?path=${encodeURIComponent(relPath)}`;
            const resp = await fetch(url);
            if (!resp.ok) return [];
            const entries = await resp.json();
            // Hide directories that are environment scaffolding (e.g. renv/
            // dropped in the project root by R kernels). Files like
            // renv.lock and .Rprofile remain visible because they describe
            // the environment and users may want to inspect them.
            const HIDDEN_DIRS = new Set(['renv', '__pycache__']);
            const HYDRA_DIR_NAMES = new Set(['config', 'conf', 'configs']);
            const hydraOn = !relPath && this._hydraViewEnabled?.[rootName];
            const nodes = entries
                .filter(entry => !(entry.is_dir && HIDDEN_DIRS.has(entry.name)))
                .map(entry => {
                const entryPath = entry.path;
                if (entry.is_dir) {
                    const isHydraRoot = hydraOn && HYDRA_DIR_NAMES.has(entry.name);
                    return {
                        title: entry.name,
                        key: `pdir:${rootName}:${entryPath}`,
                        icon: isHydraRoot ? 'static/vendor/icons/hydra.svg' : FOLDER_ICON,
                        folder: true,
                        lazy: true,
                    };
                } else {
                    return {
                        title: entry.name,
                        key: `pfile:${rootName}:${entryPath}`,
                        icon: iconPath(entry.icon),
                    };
                }
            });

            return nodes;
        } catch {
            return [];
        }
    }

    _onTreeActivate(e) {
        // Right-click sets the active node so the row highlights, but
        // we don't want it to trigger left-click navigation (e.g. opening
        // the Knowledge Graph panel from a right-click on the kb-graph
        // node). The contextmenu handler sets this flag right before
        // calling setActive(); we consume it here.
        if (this._suppressNavOnNextActivate) {
            this._suppressNavOnNextActivate = false;
            return;
        }
        const key = e.node.key || '';
        // Empty-state placeholder leaves are informational only; clicking
        // them must NOT open a detail tab.
        if (key.endsWith(':empty') || key.endsWith(':error')) {
            return;
        }

        // Domain document leaves: open the source file in the existing
        // DocumentViewer (renders PDF inline, markdown rendered). Reuses
        // the onDocumentPreview callback that the legacy `doc:<cat>:<name>`
        // tree used to fire. Two key shapes both resolve to the same flow:
        //   kb-documents:doc:<domain_id>:<path>  (cross-Domain Documents tree)
        //   kb-domain:<id>:doc:<path>            (per-Domain Documents tree)
        const xDomMatch = key.match(/^kb-documents:doc:([^:]+):(.+)$/);
        const perDomMatch = !xDomMatch && key.match(/^kb-domain:([^:]+):doc:(.+)$/);
        const docMatch = xDomMatch || perDomMatch;
        if (docMatch) {
            const did = docMatch[1];
            const path = docMatch[2];
            const filename = path.split('/').pop();
            // Prefer the user's display_name override for the tab title
            // (and DocumentViewer header). Falls back to filename when
            // unset. The `location` always uses the canonical path.
            const displayName = (e.node?.data?.display_name || '').trim();
            const doc = {
                name: displayName || filename,
                category: e.node?.data?.category || 'Documents',
                location: `${did}/${path}`,
            };
            if (this._callbacks.onDocumentPreview) this._callbacks.onDocumentPreview(doc);
            this._recolorVisibleRows();
            return;
        }
        const isFile = key.startsWith('pfile:') || key.startsWith('mfile:');
        const isDir = key.startsWith('pdir:') || key.startsWith('mdir:');


        // Run detail opens as its own tab
        // Experiment and run details open as undockable tabs
        if (key.startsWith('experiment:')) {
            this._openExperimentDetailTab(key, e.node);
            this._fireSectionChange(key);
            return;
        }
        if (key.startsWith('mlrun:')) {
            this._openRunDetailTab(key, e.node);
            this._fireSectionChange(key);
            return;
        }
        // DAG and DAG run details open as undockable tabs
        // (expand/collapse is handled by _onTreeClick)
        if (key.startsWith('dag:') && !key.startsWith('dagrun:') && !key.startsWith('dagtask:')) {
            this._openDagDetailTab(key, e.node);
            this._fireSectionChange(key);
            return;
        }
        // Skip informational/placeholder nodes
        if (key.startsWith('dagrun-empty:') || key.startsWith('pipe-empty') || key.startsWith('pipe-error')) {
            return;
        }
        if (key.startsWith('dagrun:')) {
            this._openDagRunDetailTab(key, e.node);
            this._fireSectionChange(key);
            return;
        }
        if (key.startsWith('dagtask:')) {
            this._openDagTaskDetailTab(key, e.node);
            this._fireSectionChange(key);
            return;
        }
        // Skip placeholder nodes
        if (key.startsWith('reg-empty') || key.startsWith('reg-error')) return;
        // Model registry - fall through to render detail (expand via dblclick)
        if (key.startsWith('regmodel:')) {
            // expand/collapse handled by dblclick
        }
        if (key.startsWith('regversion:')) {
            this._fireSectionChange(key);
        }

        if (isDir) {
            // Check if this dir is inside a Hydra-enabled config folder
            const HYDRA_DIRS = ['config', 'conf', 'configs'];
            const dirParts = key.startsWith('pdir:') ? key.substring(5) : key.startsWith('mdir:') ? key.substring(5) : '';
            const colonIdx = dirParts.indexOf(':');
            const dirRoot = colonIdx >= 0 ? dirParts.substring(0, colonIdx) : '';
            const dirRel = colonIdx >= 0 ? dirParts.substring(colonIdx + 1) : '';
            const dirSegments = dirRel.split('/');
            const isHydraDir = this._hydraViewEnabled?.[dirRoot]
                && HYDRA_DIRS.includes(dirSegments[0])
                && dirSegments.length <= 2;
            if (!isHydraDir) {
                if (this._callbacks.onClosePreview) this._callbacks.onClosePreview();
                return;
            }
            // Hydra config dirs fall through to _showDetailForNode
        }
        if (isFile) {
            // Files open in their own tabs via _onTreeClick
            clearActionBar(this._detailRoot);
            this._detailEl.innerHTML = '';
            this._fireSectionChange(key);
            return;
        }
        // Parent/root folders: no detail page, just close workspace.
        // Expand/collapse is handled by dblclick.
        const isPerDomainBranch = /^(kb|asst)-domain:[^:]+(:[a-z:]+)?$/.test(key)
            && !/^kb-domain:[^:]+:graph:comm:/.test(key); // exclude leaf community ids
        // Per-Domain corpus document leaves (kb-domain:<id>:doc:<path>)
        // are also treated as terminal "no-detail" nodes today.
        const isPerDomainCorpusDoc = /^kb-domain:[^:]+:doc:/.test(key);
        if (key === 'root-models-parent' || key === 'root-data-parent' || key === 'root-projects' || key === 'root-experiments' || key === 'root-pipelines' || key === 'root-envs' || key === 'root-assistant' || key === 'root-docs' || key === 'kb-domains' || key === 'kb-documents' || key === 'asst-domains' || key.startsWith('datacol:') || key.startsWith('kb-graph-doc:') || key.startsWith('kb-documents:cat:') || isPerDomainBranch || isPerDomainCorpusDoc) {
            // Per-Domain Graph parent: open the Knowledge Graph panel
            // scoped to that Domain (mirrors legacy `kb-graph` behaviour).
            if (/^kb-domain:[^:]+:graph$/.test(key)) {
                const did = key.split(':')[1];
                if (this._callbacks.onOpenKnowledgeGraph) {
                    this._callbacks.onOpenKnowledgeGraph(did);
                }
                this._recolorVisibleRows();
                return;
            }
            if (this._callbacks.onCloseWorkspace) this._callbacks.onCloseWorkspace();
            this._recolorVisibleRows();
            return;
        }
        // Individual community node under per-Domain Graph > Communities.
        // Key shape: kb-domain:<id>:graph:comm:<cid>
        if (/^kb-domain:[^:]+:graph:comm:/.test(key)) {
            const parts = key.split(':');
            const did = parts[1];
            const cid = parseInt(parts[parts.length - 1], 10);
            this._openCommunityDetailTab(cid, did);
            this._recolorVisibleRows();
            return;
        }
        // Legacy kb-graph-comm: keys (still produced if any old path exists)
        if (key.startsWith('kb-graph-comm:')) {
            const cid = parseInt(key.substring('kb-graph-comm:'.length), 10);
            this._openCommunityDetailTab(cid);
            this._recolorVisibleRows();
            return;
        }
        // Skill documents: open as preview tab, don't open workspace
        if (key.startsWith('skill:')) {
            this._openSkillAsDocument(key.substring(6), false);
            this._recolorVisibleRows();
            return;
        }
        this._showDetailForNode(e.node);
        this._fireSectionChange(key);
        if (this._callbacks.onActivate) this._callbacks.onActivate();

        // Reapply icon colors after Wunderbaum re-renders rows (active + previously-active)
        // Double rAF to ensure render is complete
        requestAnimationFrame(() => requestAnimationFrame(() => this._recolorVisibleRows()));

        // Auto-load notebook on activation
        if (key.startsWith('pfile:') && this._autoLoad) {
            const { rootName, relPath } = this._parseFileKey(key);
            if (relPath.endsWith('.ipynb') && this._callbacks.onNotebookSelect) {
                this._callbacks.onNotebookSelect(rootName, relPath);
            }
        }
    }

    _onTreeClick(e) {
        const node = e.node;
        const key = node.key || '';

        if (e.targetType === 'expander') {
            return true;
        }

        // Expand/collapse moved to dblclick (Windows Explorer behavior).
        // Single-click only selects the node and shows its detail page.
        // The expander arrow (chevron) still works on single click via
        // the targetType === 'expander' check above.

        // Single-click on file - open preview (transient tab)
        if ((key.startsWith('pfile:') || key.startsWith('mfile:'))) {
            const { rootType, rootName, relPath } = this._parseFileKey(key);
            const projectId = rootName;
            const hostPath = this._mountHostPaths[rootName];
            node.setActive(true);
            if (relPath.endsWith('.ipynb') && this._callbacks.onNotebookPreview) {
                this._callbacks.onNotebookPreview(projectId, relPath);
            } else if (!relPath.endsWith('.ipynb') && isTextEditable(relPath) && this._callbacks.onSrcFilePreview) {
                this._callbacks.onSrcFilePreview(projectId, relPath, hostPath);
            } else if (isMediaViewable(relPath) && this._callbacks.onMediaFilePreview) {
                this._callbacks.onMediaFilePreview(projectId, relPath, hostPath);
            }
            return false;
        }

        node.setActive(true, { retrigger: true });
        return false;
    }

    _onTreeDblClick(e) {
        const node = e.node;
        const key = node.key || '';

        // Double-click pins the workspace preview tab
        if (this._callbacks.onPinTab) this._callbacks.onPinTab('workspace');

        // Toggle expand/collapse for branch nodes (Windows Explorer behavior)
        if (node.folder || node.children?.length || node.lazy) {
            if ((key.startsWith('pdir:') || key.startsWith('mdir:')) && node.children) {
                node.folder = true;
            }
            // Generic toggle
            if (node.isExpanded()) {
                node.setExpanded(false);
            } else {
                if (node.lazy) {
                    node.resetLazy();
                }
                node.setExpanded(true);
            }
        }

        if (key.startsWith('pfile:') || key.startsWith('mfile:')) {
            const { rootName, relPath } = this._parseFileKey(key);
            const hostPath = this._mountHostPaths[rootName];
            if (relPath.endsWith('.ipynb') && this._callbacks.onNotebookSelect) {
                this._callbacks.onNotebookSelect(rootName, relPath);
            } else if (isTextEditable(relPath) && this._callbacks.onSrcFileSelect) {
                this._callbacks.onSrcFileSelect(rootName, relPath, hostPath);
            } else if (isMediaViewable(relPath) && this._callbacks.onMediaFileSelect) {
                this._callbacks.onMediaFileSelect(rootName, relPath, hostPath);
            }
        } else if (key.startsWith('experiment:') || key.startsWith('mlrun:')) {
            // Double-click on experiment/run: pin the preview tab
            if (this._callbacks.onPinTab) {
                this._callbacks.onPinTab(`detail:${key}`);
            }
        } else if (key.startsWith('env:')) {
            const parts = key.replace('env:', '').split(':');
            const runtimeId = parts[0];
            const envName = parts.slice(1).join(':');
            this._activeVenvName = envName;
            this._activeVenvRuntimeId = runtimeId;
            if (this._callbacks.onVenvSelect) {
                this._callbacks.onVenvSelect({
                    name: envName,
                    runtimeId,
                    displayName: this._getDisplayName(runtimeId),
                });
            }
            this._envViews.showEnvDetail(envName, runtimeId, this._getDisplayName(runtimeId));
        } else if (key.startsWith('skill:')) {
            this._openSkillAsDocument(key.substring(6), true);
        } else if (/^kb-domain:[^:]+:graph$/.test(key)) {
            // Per-Domain Graph: pin the KG tab keyed by Domain id.
            const did = key.split(':')[1];
            if (this._callbacks.onPinTab) this._callbacks.onPinTab(`detail:kb-graph:${did}`);
        }

        return false;
    }

    // ── Detail routing ──────────────────────────────────────────────

    _showDetailForNode(node) {
        clearActionBar(this._detailRoot);
        this._detailEl.style.overflowY = '';
        this._detailEl.style.paddingBottom = '';
        const key = node.key || '';

        // Projects & Files
        if (key === 'root-projects') {
            // No detail page for Projects root - toggle is handled
            // by the branch node block above, workspace tab closed
            // by the caller in _onTreeActivate
        } else if (key.startsWith('project:') || key.startsWith('mount:')) {
            const projName = key.startsWith('project:') ? key.substring(8) : key.substring(6);
            this._projectViews.showProjectDetail(projName);
        } else if (key.startsWith('pdir:') || key.startsWith('mdir:')) {
            const { rootType, rootName, relPath } = this._parseFileKey(key);
            // Hydra-aware detail for config directories when view is enabled
            const HYDRA_DIR_NAMES = ['config', 'conf', 'configs'];
            const pathParts = relPath.split('/');
            const isHydraOn = this._hydraViewEnabled?.[rootName];
            if (isHydraOn && HYDRA_DIR_NAMES.includes(pathParts[0])) {
                if (pathParts.length === 1) {
                    // Config root folder - show Hydra config overview
                    this._externalViews.showHydraConfigDetail(rootName);
                } else if (pathParts.length === 2) {
                    // Config group folder (e.g., config/model) - show group detail
                    this._externalViews.showHydraGroupDetail(rootName, pathParts[1]);
                } else {
                    this._projectViews.showDirDetail(rootType, rootName, relPath);
                }
            } else {
                this._projectViews.showDirDetail(rootType, rootName, relPath);
            }
        } else if (key.startsWith('pfile:') || key.startsWith('mfile:')) {
            const { rootType, rootName, relPath } = this._parseFileKey(key);
            if (relPath.endsWith('.dvc')) {
                this._projectViews.showDvcFileDetail(rootType, rootName, relPath);
            } else {
                this._projectViews.showFileDetail(rootType, rootName, relPath);
            }
        }
        // Environments
        else if (key === 'root-envs' || key.startsWith('lang:')) {
            this._envViews.showEnvsRootDetail();
        } else if (key.startsWith('runtime:')) {
            const rtId = key.substring(8);
            this._envViews.showRuntimeDetail(rtId, this._getDisplayName(rtId));
        } else if (key.startsWith('env:')) {
            const rest = key.substring(4);
            const lastColon = rest.lastIndexOf(':');
            const runtimeId = rest.substring(0, lastColon);
            const envName = rest.substring(lastColon + 1);
            this._envViews.showEnvDetail(envName, runtimeId, this._getDisplayName(runtimeId));
        }
        // Experiments
        else if (key === 'root-experiments') {
            this._externalViews.showExperimentsRootDetail();
        } else if (key.startsWith('experiment:')) {
            this._externalViews.showExperimentDetail(key.substring(11));
        } else if (key.startsWith('mlrun:')) {
            this._externalViews.showMlrunDetail(key);
        } else if (key.startsWith('mlart-cat:')) {
            this._externalViews.showArtifactCategoryDetail(key);
        } else if (key.startsWith('mlart:')) {
            this._externalViews.showArtifactDetail(key);
        } else if (key.startsWith('mllm-cat:')) {
            this._externalViews.showLoggedModelsCategoryDetail(key);
        } else if (key.startsWith('mllm:')) {
            this._externalViews.showLoggedModelDetail(key);
        }
        // Pipelines
        else if (key === 'root-pipelines') {
            this._externalViews.showPipelinesRootDetail();
        } else if (key.startsWith('dag:')) {
            this._externalViews.showDagDetail(key);
        } else if (key.startsWith('dagrun:')) {
            this._externalViews.showDagRunDetail(key);
        } else if (key.startsWith('dagtask:')) {
            this._externalViews.showDagTaskDetail(key);
        }
        // APIs
        else if (key === 'root-apis') {
            this._showApisRootDetail();
        } else if (key.startsWith('api:')) {
            this._showApiEndpointDetail(key);
        } else if (key.startsWith('api-')) {
            // api-idle / api-error / api-status placeholder nodes
            this._showApisRootDetail();
        }
        // Data
        else if (key === 'root-data') {
            this._externalViews.showDataRootDetail();
        } else if (key.startsWith('datafile:')) {
            this._externalViews.showDataFileDetail(key);
        }
        // Storage
        else if (key === 'root-storage') {
            this._externalViews.showStorageRootDetail();
        } else if (key.startsWith('bucket:')) {
            this._externalViews.showBucketDetail(key.substring(7));
        } else if (key.startsWith('s3folder:')) {
            this._externalViews.showS3FolderDetail(key);
        } else if (key.startsWith('s3obj:')) {
            this._externalViews.showS3ObjectDetail(key);
        }
        // Model Registry
        else if (key === 'root-models') {
            this._externalViews.showModelsRootDetail();
        } else if (key.startsWith('regmodel:')) {
            this._externalViews.showModelDetail(key);
        } else if (key.startsWith('regversion:')) {
            this._externalViews.showVersionDetail(key);
        }
        // Assistant
        else if (key === 'root-assistant') {
            this._showAssistantRootDetail();
        } else if (key.startsWith('emb:src:')) {
            this._showEmbeddingsSourceDetail(key.substring('emb:src:'.length));
        } else if (key.startsWith('emb:chunk:')) {
            this._showEmbeddingsChunkDetail(key.substring('emb:chunk:'.length), node);
        } else if (key.startsWith('skill:')) {
            this._openSkillAsDocument(key.substring(6), false);
        } else if (key.startsWith('skillref:')) {
            this._showSkillRefDetail(key);
        } else if (key.startsWith('mcptool:')) {
            // key shape: mcptool:<tier>:<name>
            const rest = key.substring(8);
            const colonIdx = rest.indexOf(':');
            const toolName = colonIdx >= 0 ? rest.substring(colonIdx + 1) : rest;
            this._showToolDetail(toolName);
        }
        // Knowledge Base
        else if (key === 'root-docs') {
            this._externalViews.showDocsRootDetail();
        }
        // No detail page for this node - clear stale content. (Document
        // leaves under kb-documents:doc:* and kb-domain:*:doc:* are handled
        // earlier in _onTreeActivate by opening the DocumentViewer directly.)
        else {
            clearActionBar(this._detailRoot);
            this._detailEl.innerHTML = '';
        }
    }

    // ── Navigation ──────────────────────────────────────────────────

    _applyNavigation() {
        if (this._navigateToVenvName) {
            this._navigateToVenv(this._navigateToVenvName);
        } else if (this._navigateToEnvs) {
            this._navigateToEnvsRoot();
        } else {
            this._navigateToCurrentNotebook();
        }
    }

    _navigateToEnvsRoot() {
        if (!this._tree) return;
        const envsRoot = this._tree.findKey('root-envs');
        if (envsRoot) {
            if (!envsRoot.isExpanded()) envsRoot.setExpanded(true);
            envsRoot.setActive(true, { noEvents: true });
            this._envViews.showEnvsRootDetail();
            this._fireSectionChange('root-envs');
        }
    }

    _navigateToVenv(envKey) {
        if (!this._tree) return;
        this._detailEl.style.paddingBottom = '';
        const envsRoot = this._tree.findKey('root-envs');
        if (envsRoot && !envsRoot.isExpanded()) envsRoot.setExpanded(true);
        const nodeKey = `env:${envKey}`;
        const envNode = this._tree.findKey(nodeKey);
        if (envNode) {
            const runtimeNode = envNode.parent;
            if (runtimeNode) {
                const langNode = runtimeNode.parent;
                if (langNode && !langNode.isExpanded()) langNode.setExpanded(true);
                if (!runtimeNode.isExpanded()) runtimeNode.setExpanded(true);
            }
            envNode.setActive(true, { noEvents: true });
            const lastColon = envKey.lastIndexOf(':');
            const runtimeId = envKey.substring(0, lastColon);
            const envName = envKey.substring(lastColon + 1);
            this._envViews.showEnvDetail(envName, runtimeId, this._getDisplayName(runtimeId));
            this._fireSectionChange(nodeKey);
        }
    }

    async _navigateToCurrentNotebook() {
        if (!this._tree || !this._currentProject || !this._currentNotebook) return;
        this._detailEl.style.paddingBottom = '';

        const projectNode = this._tree.findKey(`project:${this._currentProject}`);
        if (!projectNode) return;

        if (!projectNode.isExpanded()) {
            await projectNode.setExpanded(true);
        }

        const nbKey = `pfile:${this._currentProject}:${this._currentNotebook}`;
        let nbNode = this._tree.findKey(nbKey);

        if (!nbNode) {
            const parts = this._currentNotebook.split('/');
            for (let i = 0; i < parts.length - 1; i++) {
                const dirPath = parts.slice(0, i + 1).join('/');
                const dirKey = `pdir:${this._currentProject}:${dirPath}`;
                const dirNode = this._tree.findKey(dirKey);
                if (dirNode && !dirNode.isExpanded()) {
                    await dirNode.setExpanded(true);
                }
            }
            nbNode = this._tree.findKey(nbKey);
        }

        if (nbNode) {
            nbNode.setActive(true, { noEvents: true });
            this._projectViews.showFileDetail('project', this._currentProject, this._currentNotebook);
            this._fireSectionChange(nbKey);
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────

    _openExperimentDetailTab(nodeKey, node) {
        const experimentId = nodeKey.substring(11);
        const expName = node?.title || experimentId;
        const tabKey = `detail:${nodeKey}`;

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%';

        // Second bar with delete icon
        const secondBar = document.createElement('div');
        secondBar.className = 'notebook-second-bar';
        secondBar.style.cssText = 'flex-shrink:0;position:relative;top:auto;margin:0;border-left:none;border-right:none';
        const leftGroup = document.createElement('div');
        leftGroup.className = 'second-bar-left';

        const S = '-webkit-text-stroke:1px #555;paint-order:stroke fill';
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'info-bar-text-btn';
        deleteBtn.title = 'Delete experiment';
        deleteBtn.innerHTML = `<i class="fa-solid fa-trash" style="font-size:13px;color:#e08b8b;${S}"></i>`;
        deleteBtn.addEventListener('click', () => {
            const n = this._tree?.findKey(nodeKey);
            this._ctx.contextMenu.ctxDeleteExperiment(experimentId, n);
        });
        leftGroup.appendChild(deleteBtn);

        secondBar.appendChild(leftGroup);
        wrapper.appendChild(secondBar);

        // Scrollable content area
        const contentEl = document.createElement('div');
        contentEl.className = 'explorer-detail-content';
        contentEl.style.cssText = 'flex:1;overflow-y:auto;overscroll-behavior:contain;padding:12px;background:#fefefe;min-height:0';
        wrapper.appendChild(contentEl);

        // Render experiment detail
        this._externalViews.renderExperimentDetailInto(contentEl, experimentId, expName);

        if (this._callbacks.onDetailTab) {
            this._callbacks.onDetailTab(tabKey, expName, wrapper, { preview: true });
        }
    }

    _openRunDetailTab(nodeKey, node) {
        const rest = nodeKey.substring(6);
        const idx = rest.indexOf(':');
        const experimentId = rest.substring(0, idx);
        const runId = rest.substring(idx + 1);
        const runName = node?.title || runId.substring(0, 8);
        const tabKey = `detail:${nodeKey}`;

        // Build wrapper with second bar + scrollable content (same pattern as notebooks)
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%';

        // Second bar for action icons (part of the element, always visible)
        const secondBar = document.createElement('div');
        secondBar.className = 'notebook-second-bar';
        secondBar.style.cssText = 'flex-shrink:0;position:relative;top:auto;margin:0;border-left:none;border-right:none';
        const leftGroup = document.createElement('div');
        leftGroup.className = 'second-bar-left';

        const S = '-webkit-text-stroke:1px #555;paint-order:stroke fill';
        // Compare button
        const compareBtn = document.createElement('button');
        compareBtn.className = 'info-bar-text-btn';
        compareBtn.title = 'Compare with another run';
        compareBtn.innerHTML = `<i class="fa-solid fa-code-compare" style="font-size:13px;color:#7cb3a0;${S}"></i>`;
        compareBtn.addEventListener('click', () => this._externalViews.startRunComparison(runId, runName, experimentId));
        leftGroup.appendChild(compareBtn);

        // Popout metrics button
        const popoutBtn = document.createElement('button');
        popoutBtn.className = 'info-bar-text-btn';
        popoutBtn.title = 'Open in Metrics panel';
        popoutBtn.innerHTML = `<i class="fa-solid fa-chart-simple" style="font-size:13px;color:#42a5f5;${S}"></i>`;
        popoutBtn.addEventListener('click', () => this._externalViews.triggerMetricsView(runId, runName));
        leftGroup.appendChild(popoutBtn);

        // Delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'info-bar-text-btn';
        deleteBtn.title = 'Delete run';
        deleteBtn.innerHTML = `<i class="fa-solid fa-trash" style="font-size:13px;color:#e08b8b;${S}"></i>`;
        deleteBtn.addEventListener('click', () => {
            const n = this._tree?.findKey(nodeKey);
            this._ctx.contextMenu.ctxDeleteRun(runId, experimentId, n);
        });
        leftGroup.appendChild(deleteBtn);

        secondBar.appendChild(leftGroup);
        wrapper.appendChild(secondBar);

        // Scrollable content area
        const contentEl = document.createElement('div');
        contentEl.className = 'explorer-detail-content';
        contentEl.style.cssText = 'flex:1;overflow-y:auto;overscroll-behavior:contain;padding:12px;background:#fefefe;min-height:0';
        wrapper.appendChild(contentEl);

        // Render run detail into the content area
        this._externalViews.renderRunDetailInto(contentEl, experimentId, runId, runName, node);

        if (this._callbacks.onDetailTab) {
            this._callbacks.onDetailTab(tabKey, runName, wrapper, { preview: true });
        }
    }

    _openDagDetailTab(nodeKey, node) {
        const dagId = nodeKey.substring(4);
        const tabKey = `detail:${nodeKey}`;
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%';

        const S = '-webkit-text-stroke:1px #555;paint-order:stroke fill';
        const secondBar = document.createElement('div');
        secondBar.className = 'notebook-second-bar';
        secondBar.style.cssText = 'flex-shrink:0;position:relative;top:auto;margin:0;border-left:none;border-right:none';
        const leftGroup = document.createElement('div');
        leftGroup.className = 'second-bar-left';

        const triggerBtn = document.createElement('button');
        triggerBtn.className = 'info-bar-text-btn';
        triggerBtn.title = 'Trigger DAG Run';
        triggerBtn.innerHTML = `<i class="fa-solid fa-play" style="font-size:13px;color:#4caf50;${S}"></i>`;
        triggerBtn.addEventListener('click', () => this._externalViews.showTriggerPanel(dagId));
        leftGroup.appendChild(triggerBtn);

        secondBar.appendChild(leftGroup);
        wrapper.appendChild(secondBar);

        const contentEl = document.createElement('div');
        contentEl.className = 'explorer-detail-content';
        contentEl.style.cssText = 'flex:1;overflow-y:auto;overscroll-behavior:contain;padding:12px;background:#fefefe;min-height:0';
        wrapper.appendChild(contentEl);

        this._externalViews.showDagDetail(nodeKey, contentEl);

        if (this._callbacks.onDetailTab) {
            this._callbacks.onDetailTab(tabKey, dagId, wrapper, { preview: true });
        }
    }

    _openDagRunDetailTab(nodeKey, node) {
        const rest = nodeKey.substring(7);
        const idx = rest.indexOf(':');
        const dagId = rest.substring(0, idx);
        const runId = rest.substring(idx + 1);
        const title = node?.title || runId.substring(0, 16);
        const tabKey = `detail:${nodeKey}`;

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%';

        const secondBar = document.createElement('div');
        secondBar.className = 'notebook-second-bar';
        secondBar.style.cssText = 'flex-shrink:0;position:relative;top:auto;margin:0;border-left:none;border-right:none';
        wrapper.appendChild(secondBar);

        const contentEl = document.createElement('div');
        contentEl.className = 'explorer-detail-content';
        contentEl.style.cssText = 'flex:1;overflow-y:auto;overscroll-behavior:contain;padding:12px;background:#fefefe;min-height:0';
        wrapper.appendChild(contentEl);

        this._externalViews.showDagRunDetail(nodeKey, contentEl);

        if (this._callbacks.onDetailTab) {
            this._callbacks.onDetailTab(tabKey, title, wrapper, { preview: true });
        }
    }

    _openDagTaskDetailTab(nodeKey, node) {
        const rest = nodeKey.substring(8);
        const lastColon = rest.lastIndexOf(':');
        const taskId = rest.substring(lastColon + 1);
        const title = node?.title || taskId;
        const tabKey = `detail:${nodeKey}`;

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%';

        const secondBar = document.createElement('div');
        secondBar.className = 'notebook-second-bar';
        secondBar.style.cssText = 'flex-shrink:0;position:relative;top:auto;margin:0;border-left:none;border-right:none';
        wrapper.appendChild(secondBar);

        const contentEl = document.createElement('div');
        contentEl.className = 'explorer-detail-content';
        contentEl.style.cssText = 'flex:1;overflow-y:auto;overscroll-behavior:contain;padding:12px;background:#fefefe;min-height:0';
        wrapper.appendChild(contentEl);

        this._externalViews.showDagTaskDetail(nodeKey, contentEl);

        if (this._callbacks.onDetailTab) {
            this._callbacks.onDetailTab(tabKey, title, wrapper, { preview: true });
        }
    }

    _parseFileKey(key) {
        const prefix = key.substring(0, key.indexOf(':'));
        const rest = key.substring(prefix.length + 1);
        const idx = rest.indexOf(':');
        const rootName = rest.substring(0, idx);
        const relPath = rest.substring(idx + 1);
        // Determine root type from project source registry
        const source = this._projectSources?.[rootName] || 'internal';
        const rootType = source === 'mount' ? 'mount' : 'project';
        return { rootType, rootName, relPath };
    }

    _getDisplayName(runtimeId) {
        const rt = (this._runtimes || []).find(r => r.runtime_id === runtimeId);
        return rt ? rt.display_name : runtimeId;
    }

    /** Trigger a file picker for notebook import (no detail page needed). */
    _triggerImportNotebook(projectId) {
        const errorProxy = { set textContent(msg) { if (msg) import('../modal.js').then(({ modalError }) => modalError(msg)); } };
        this._projectViews.importNotebook(projectId, errorProxy);
    }

    /** Upload file to a project or mount directory. */
    async _triggerUpload(rootType, rootName, relPath = '') {
        // Check terminal secret
        let secret = sessionStorage.getItem('terminal_secret');
        const needsAuth = !secret;
        if (needsAuth) {
            const dest = relPath ? `${rootName}/${relPath}` : rootName;
            const { modalPrompt } = await import('../modal.js');
            secret = await modalPrompt(`Enter access key to upload to "${dest}"`, { title: 'Upload Authentication', password: true });
            if (!secret) return;
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.addEventListener('change', async () => {
            const files = input.files;
            if (!files || files.length === 0) return;

            const { modalError } = await import('../modal.js');
            let uploadedCount = 0;

            for (const file of files) {
                const form = new FormData();
                form.append('file', file);
                form.append('path', relPath);

                try {
                    const resp = await fetch(`api/files/upload/${rootType}/${encodeURIComponent(rootName)}`, {
                        method: 'POST',
                        headers: { 'X-Terminal-Secret': secret },
                        body: form,
                    });
                    if (resp.status === 401) {
                        sessionStorage.removeItem('terminal_secret');
                        modalError('Invalid access key');
                        return;
                    }
                    if (!resp.ok) {
                        const err = await resp.json();
                        modalError(err.detail || 'Upload failed');
                        return;
                    }
                    uploadedCount++;
                } catch (err) {
                    modalError(err.message || 'Upload failed');
                    return;
                }
            }

            if (uploadedCount > 0) {
                // Cache secret on success
                sessionStorage.setItem('terminal_secret', secret);
                notify.success(`Uploaded ${uploadedCount} file${uploadedCount > 1 ? 's' : ''}`);
                // Refresh tree - find the project/mount node and reload it
                const node = this._tree?.getActiveNode();
                let target = node;
                while (target && !target.key?.startsWith('project:') && !target.key?.startsWith('mount:')) {
                    target = target.parent;
                }
                if (target) {
                    target.setExpanded(false);
                    target.resetLazy();
                    target.setExpanded(true);
                }
            }
        });
        input.click();
    }

    _fireSectionChange(nodeKey) {
        const info = this._buildBreadcrumbs(nodeKey);
        if (this._callbacks.onSectionChange) {
            this._callbacks.onSectionChange(info.crumbs[0] || 'Explorer');
        }
        if (this._callbacks.onBreadcrumbChange) {
            this._callbacks.onBreadcrumbChange(info);
        }
        // Update sidebar title bar label and actions
        if (this._titleBarLabel) {
            // Only show file path for file nodes, not for runs/experiments/etc.
            const isFileNode = nodeKey.startsWith('pfile:') || nodeKey.startsWith('mfile:');
            this._titleBarLabel.textContent = isFileNode && info.crumbs.length > 1 ? info.crumbs.slice(1).join(' / ') : '';
            this._titleBarLabel.title = info.crumbs.join(' / ');
        }
        this._updateTitleBarActions(info.actions || []);
    }

    _updateTitleBarActions(actions) {
        if (!this._titleBarActions) return;
        this._titleBarActions.innerHTML = '';
        const S = '-webkit-text-stroke:1px #555;paint-order:stroke fill';
        const ICONS = {
            newfile: `<i class="fa-solid fa-file-circle-plus" style="font-size:13px;color:#42a5f5;${S}"></i>`,
            newfolder: `<i class="fa-solid fa-folder-plus" style="font-size:13px;color:#f0c040;${S}"></i>`,
            importnb: `<i class="fa-solid fa-file-import" style="font-size:13px;color:#ab82d4;${S}"></i>`,
            create: `<i class="fa-solid fa-plus" style="font-size:13px;color:#4caf50;${S}"></i>`,
            clone: `<i class="fa-solid fa-code-branch" style="font-size:13px;color:#6fa374;${S}"></i>`,
            addmount: `<i class="fa-solid fa-hard-drive" style="font-size:13px;color:#8fbcf0;${S}"></i>`,
            rundag: `<i class="fa-solid fa-play" style="font-size:12px;color:#4caf50;${S}"></i>`,
            compare: `<i class="fa-solid fa-code-compare" style="font-size:12px;color:#7cb3a0;${S}"></i>`,
            popout: `<i class="fa-solid fa-chart-simple" style="font-size:13px;color:#42a5f5;${S}"></i>`,
            delete: `<i class="fa-solid fa-trash" style="font-size:13px;color:#e08b8b;${S}"></i>`,
            download: `<i class="fa-solid fa-download" style="font-size:13px;color:#42a5f5;${S}"></i>`,
            upload: `<i class="fa-solid fa-upload" style="font-size:13px;color:#f0a040;${S}"></i>`,
        };
        for (const action of actions) {
            const btn = document.createElement('button');
            btn.className = 'explorer-title-action-btn';
            btn.innerHTML = ICONS[action.icon] || '';
            btn.title = action.title || '';
            btn.addEventListener('click', action.handler);
            this._titleBarActions.appendChild(btn);
        }
    }

    _buildBreadcrumbs(nodeKey) {
        const cm = this._ctx.contextMenu;
        const pv = this._projectViews;

        if (nodeKey === 'root-projects') {
            const n = this._tree?.findKey('root-projects')?.children?.length || 0;
            return {
                crumbs: ['Projects'],
                rootCount: n,
                actions: [
                    { icon: 'create', title: 'Create Project', handler: async () => {
                        const { modalPrompt, modalError } = await import('../modal.js');
                        const name = await modalPrompt('Project name', { title: 'Create Project' });
                        if (!name) return;
                        try {
                            const resp = await fetch('api/projects', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ project_id: name }),
                            });
                            if (!resp.ok) { const err = await resp.json(); throw new Error(err.detail || 'Failed'); }
                            const rootNode = this._tree?.findKey('root-projects');
                            if (rootNode) {
                                rootNode.addChildren([{
                                    title: name,
                                    key: `project:${name}`,
                                    icon: 'fa-solid fa-clipboard-list',
                                    folder: true,
                                    lazy: true,
                                }]);
                                rootNode.setExpanded(true);
                            }
                            notify.success(`Project "${name}" created`);
                            if (this._callbacks.onProjectCreated) this._callbacks.onProjectCreated();
                        } catch (err) { modalError(err.message); }
                    }},
                    { icon: 'clone', title: 'Clone from GitHub', handler: async () => {
                        const { modalForm, modalError } = await import('../modal.js');
                        const result = await modalForm([
                            { key: 'url', label: 'Repository URL', placeholder: 'https://github.com/user/repo' },
                            { key: 'name', label: 'Project name', placeholder: 'my-project' },
                            { key: 'pat', label: 'Personal Access Token (optional)', type: 'password', required: false },
                        ], { title: 'Clone Repository', confirmText: 'Clone' });
                        if (!result) return;
                        try {
                            const resp = await fetch('api/projects', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ project_id: result.name, clone_url: result.url, pat: result.pat || undefined }),
                            });
                            if (!resp.ok) { const err = await resp.json(); throw new Error(err.detail || 'Failed'); }
                            const rootNode = this._tree?.findKey('root-projects');
                            if (rootNode) {
                                rootNode.addChildren([{
                                    title: result.name,
                                    key: `project:${result.name}`,
                                    icon: 'fa-solid fa-clipboard-list',
                                    folder: true,
                                    lazy: true,
                                }]);
                                rootNode.setExpanded(true);
                            }
                            notify.success(`Cloned "${result.name}"`);
                            if (this._callbacks.onProjectCreated) this._callbacks.onProjectCreated();
                        } catch (err) { modalError(err.message); }
                    }},
                ],
            };
        }
        if (nodeKey === 'root-envs') {
            const n = this._tree?.findKey('root-envs')?.children?.length || 0;
            return { crumbs: ['Environments'], rootCount: n };
        }
        if (nodeKey.startsWith('lang:')) {
            const lang = nodeKey.substring(5);
            const displayName = { python: 'Python', javascript: 'JavaScript' }[lang] || lang;
            return { crumbs: ['Environments', displayName] };
        }
        if (nodeKey.startsWith('project:')) {
            const projectId = nodeKey.substring(8);
            const node = this._tree?.findKey(nodeKey);
            const source = this._projectSources?.[projectId] || 'internal';
            const rootType = source === 'mount' ? 'mount' : 'project';
            return {
                crumbs: ['Projects', projectId],
                actions: [
                    { icon: 'newfile', title: 'New File', handler: () => cm.ctxCreateEntry(rootType, projectId, '', false, node) },
                    { icon: 'newfolder', title: 'New Folder', handler: () => cm.ctxCreateEntry(rootType, projectId, '', true, node) },
                    { icon: 'importnb', title: 'Import Notebook', handler: () => this._triggerImportNotebook(projectId) },
                    { icon: 'upload', title: 'Upload File', handler: () => this._triggerUpload(rootType, projectId) },
                ],
            };
        }
        if (nodeKey.startsWith('mount:')) {
            const mountName = nodeKey.substring(6);
            const node = this._tree?.findKey(nodeKey);
            return {
                crumbs: ['Mounts', mountName],
                actions: [
                    { icon: 'newfile', title: 'New File', handler: () => cm.ctxCreateEntry('mount', mountName, '', false, node) },
                    { icon: 'newfolder', title: 'New Folder', handler: () => cm.ctxCreateEntry('mount', mountName, '', true, node) },
                    { icon: 'importnb', title: 'Import Notebook', handler: () => this._triggerImportNotebook(mountName) },
                    { icon: 'upload', title: 'Upload File', handler: () => this._triggerUpload('mount', mountName) },
                ],
            };
        }
        if (nodeKey.startsWith('pdir:')) {
            const { rootName, relPath } = this._parseFileKey(nodeKey);
            const node = this._tree?.findKey(nodeKey);
            const parts = relPath.split('/');
            return {
                crumbs: ['Projects', rootName, ...parts],
                actions: [
                    { icon: 'newfile', title: 'New File', handler: () => cm.ctxCreateEntry('project', rootName, relPath, false, node) },
                    { icon: 'newfolder', title: 'New Folder', handler: () => cm.ctxCreateEntry('project', rootName, relPath, true, node) },
                    { icon: 'upload', title: 'Upload File', handler: () => this._triggerUpload('project', rootName, relPath) },
                ],
            };
        }
        if (nodeKey.startsWith('pfile:')) {
            const { rootName, relPath } = this._parseFileKey(nodeKey);
            const parts = relPath.split('/');
            return { crumbs: ['Projects', rootName, ...parts] };
        }
        if (nodeKey.startsWith('mdir:')) {
            const { rootName, relPath } = this._parseFileKey(nodeKey);
            const node = this._tree?.findKey(nodeKey);
            const parts = relPath.split('/');
            return {
                crumbs: ['Mounts', rootName, ...parts],
                actions: [
                    { icon: 'newfile', title: 'New File', handler: () => cm.ctxCreateEntry('mount', rootName, relPath, false, node) },
                    { icon: 'newfolder', title: 'New Folder', handler: () => cm.ctxCreateEntry('mount', rootName, relPath, true, node) },
                    { icon: 'upload', title: 'Upload File', handler: () => this._triggerUpload('mount', rootName, relPath) },
                ],
            };
        }
        if (nodeKey.startsWith('mfile:')) {
            const { rootName, relPath } = this._parseFileKey(nodeKey);
            const parts = relPath.split('/');
            return { crumbs: ['Mounts', rootName, ...parts] };
        }
        if (nodeKey.startsWith('runtime:')) {
            const runtimeId = nodeKey.substring(8);
            const lang = runtimeId.split('/')[0];
            const langName = { python: 'Python', javascript: 'JavaScript' }[lang] || lang;
            return { crumbs: ['Environments', langName, this._getDisplayName(runtimeId)] };
        }
        if (nodeKey.startsWith('env:')) {
            const rest = nodeKey.substring(4);
            const lastColon = rest.lastIndexOf(':');
            const runtimeId = rest.substring(0, lastColon);
            const envName = rest.substring(lastColon + 1);
            const lang = runtimeId.split('/')[0];
            const langName = { python: 'Python', javascript: 'JavaScript' }[lang] || lang;
            return { crumbs: ['Environments', langName, this._getDisplayName(runtimeId), envName] };
        }
        if (nodeKey === 'root-experiments') {
            return { crumbs: ['Experiments'] };
        }
        if (nodeKey.startsWith('experiment:')) {
            const expId = nodeKey.substring(11);
            const node = this._tree?.findKey(nodeKey);
            const name = node?.title || expId;
            return {
                crumbs: ['Experiments', name],
                actions: [
                    { icon: 'delete', title: 'Delete experiment', handler: () => {
                        const n = this._tree?.findKey(nodeKey);
                        this._ctx.contextMenu.ctxDeleteExperiment(expId, n);
                    }},
                ],
            };
        }
        if (nodeKey.startsWith('mlrun:')) {
            const rest = nodeKey.substring(6);
            const idx = rest.indexOf(':');
            const expId = rest.substring(0, idx);
            const runId = rest.substring(idx + 1);
            const expNode = this._tree?.findKey(`experiment:${expId}`);
            const expName = expNode?.title || expId;
            const runNode = this._tree?.findKey(nodeKey);
            const runName = runNode?.title || runId.substring(0, 8);
            return {
                crumbs: ['Experiments', expName, runName, runId.substring(0, 8)],
                actions: [
                    { icon: 'compare', title: 'Compare with another run', handler: () => {
                        this._externalViews.startRunComparison(runId, runName, expId);
                    }},
                    { icon: 'popout', title: 'Open in Metrics panel', handler: () => {
                        this._externalViews.triggerMetricsView(runId, runName);
                    }},
                    { icon: 'delete', title: 'Delete run', handler: () => {
                        const node = this._tree?.findKey(nodeKey);
                        this._ctx.contextMenu.ctxDeleteRun(runId, expId, node);
                    }},
                ],
            };
        }
        if (nodeKey.startsWith('mlart-cat:')) {
            // mlart-cat:{runId}:{category}
            const rest = nodeKey.substring(10);
            const idx = rest.indexOf(':');
            const runId = rest.substring(0, idx);
            const category = rest.substring(idx + 1);
            const catNames = { models: 'Models', images: 'Images', charts: 'Charts', files: 'Files' };
            // Find parent run node to get breadcrumb context
            const runNode = this._tree?.findKey(nodeKey)?.parent;
            const runName = runNode?.title || runId.substring(0, 8);
            const expNode = runNode?.parent;
            const expName = expNode?.title || '';
            return { crumbs: ['Experiments', expName, runName, 'Artifacts', catNames[category] || category] };
        }
        if (nodeKey.startsWith('mlart:')) {
            const rest = nodeKey.substring(6);
            const idx = rest.indexOf(':');
            const runId = rest.substring(0, idx);
            const artifactPath = rest.substring(idx + 1);
            const fileName = artifactPath.split('/').pop();
            const node = this._tree?.findKey(nodeKey);
            const catNode = node?.parent;
            const catName = catNode?.title || 'Artifacts';
            const runNode = catNode?.parent;
            const runName = runNode?.title || '';
            const expNode = runNode?.parent;
            const expName = expNode?.title || '';
            const isDir = !!(node?.folder || node?.lazy || node?.children?.length);
            const actions = [];
            if (!isDir) {
                const downloadUrl = `api/mlflow/runs/${encodeURIComponent(runId)}/artifacts/download?path=${encodeURIComponent(artifactPath)}`;
                const dlName = fileName === 'MLmodel' ? 'MLmodel.yaml' : fileName;
                actions.push({ icon: 'download', title: 'Download artifact', handler: () => {
                    const a = document.createElement('a');
                    a.href = downloadUrl;
                    a.download = dlName;
                    a.click();
                }});
            }
            return {
                crumbs: ['Experiments', expName, runName, catName, fileName],
                actions,
            };
        }
        if (nodeKey.startsWith('mllm-cat:')) {
            // mllm-cat:{runId}
            const runId = nodeKey.substring(9);
            const runNode = this._tree?.findKey(nodeKey)?.parent;
            const runName = runNode?.title || runId.substring(0, 8);
            const expNode = runNode?.parent;
            const expName = expNode?.title || '';
            return { crumbs: ['Experiments', expName, runName, 'Artifacts', 'Logged Models'] };
        }
        if (nodeKey.startsWith('mllm:')) {
            // mllm:{runId}:{modelId}:{relPath}
            const rest = nodeKey.substring(5);
            const i1 = rest.indexOf(':');
            const runId = rest.substring(0, i1);
            const afterRun = rest.substring(i1 + 1);
            const i2 = afterRun.indexOf(':');
            const modelId = afterRun.substring(0, i2);
            const relPath = afterRun.substring(i2 + 1);
            const leaf = relPath ? relPath.split('/').pop() : modelId.substring(0, 16);
            const node = this._tree?.findKey(nodeKey);
            const isDir = !!(node?.folder || node?.lazy || node?.children?.length);
            // Walk up parents for breadcrumb context.
            let cat = node?.parent;
            while (cat && !cat.key?.startsWith('mllm-cat:')) cat = cat?.parent;
            const runNode = cat?.parent;
            const runName = runNode?.title || runId.substring(0, 8);
            const expNode = runNode?.parent;
            const expName = expNode?.title || '';
            const actions = [];
            if (!isDir) {
                // Need experiment_id from cache (added to the logged_models
                // response body); fall back to scanning via the tree.
                actions.push({ icon: 'download', title: 'Download file', handler: () => {
                    const detailEl = this._ctx?.detailEl;
                    const link = detailEl?.querySelector('a.rm-btn[download]');
                    if (link) link.click();
                }});
            }
            return {
                crumbs: ['Experiments', expName, runName, 'Artifacts', 'Logged Models', leaf],
                actions,
            };
        }
        if (nodeKey === 'root-pipelines') {
            return { crumbs: ['Orchestration'] };
        }
        if (nodeKey.startsWith('dag:')) {
            const dagId = nodeKey.substring(4);
            return {
                crumbs: ['Orchestration', dagId],
                actions: [
                    { icon: 'rundag', title: 'Run DAG', handler: () => {
                        this._externalViews.showTriggerPanel(dagId);
                    }},
                ],
            };
        }
        if (nodeKey.startsWith('dagrun:')) {
            const rest = nodeKey.substring(7);
            const idx = rest.indexOf(':');
            const dagId = rest.substring(0, idx);
            const runId = rest.substring(idx + 1);
            return { crumbs: ['Orchestration', dagId, runId] };
        }
        if (nodeKey.startsWith('dagtask:')) {
            const rest = nodeKey.substring(8);
            const firstColon = rest.indexOf(':');
            const lastColon = rest.lastIndexOf(':');
            const dagId = rest.substring(0, firstColon);
            const taskId = rest.substring(lastColon + 1);
            return { crumbs: ['Orchestration', dagId, taskId] };
        }
        if (nodeKey === 'root-data-parent') {
            return { crumbs: ['Data'] };
        }
        if (nodeKey === 'root-data') {
            return { crumbs: ['Data', 'Catalog'] };
        }
        if (nodeKey.startsWith('datacol:')) {
            // datacol:{rootType}:{rootName} - show only the project/mount name.
            const rest = nodeKey.substring(8);
            const firstColon = rest.indexOf(':');
            const rootName = rest.substring(firstColon + 1);
            return { crumbs: ['Data', 'Catalog', rootName] };
        }
        if (nodeKey.startsWith('datafile:')) {
            // datafile:{rootType}:{rootName}:{filePath}
            const rest = nodeKey.substring(9);
            const firstColon = rest.indexOf(':');
            const secondColon = rest.indexOf(':', firstColon + 1);
            const rootName = rest.substring(firstColon + 1, secondColon);
            const filePath = rest.substring(secondColon + 1);
            return { crumbs: ['Data', 'Catalog', rootName, filePath] };
        }
        if (nodeKey === 'root-storage') {
            return { crumbs: ['Data', 'Storage'] };
        }
        if (nodeKey.startsWith('bucket:')) {
            return { crumbs: ['Data', 'Storage', nodeKey.substring(7)] };
        }
        if (nodeKey.startsWith('s3folder:')) {
            const rest = nodeKey.substring(9);
            const idx = rest.indexOf(':');
            const bucket = rest.substring(0, idx);
            const prefix = rest.substring(idx + 1).replace(/\/$/, '');
            const parts = prefix.split('/');
            return { crumbs: ['Data', 'Storage', bucket, ...parts] };
        }
        if (nodeKey.startsWith('s3obj:')) {
            const rest = nodeKey.substring(6);
            const idx = rest.indexOf(':');
            const bucket = rest.substring(0, idx);
            const objKey = rest.substring(idx + 1);
            const parts = objKey.split('/');
            return { crumbs: ['Data', 'Storage', bucket, ...parts] };
        }
        if (nodeKey === 'root-docs') {
            const n = domainState.getDomains().length;
            return { crumbs: ['Knowledge Base'], rootCount: n };
        }
        if (nodeKey === 'kb-domains') {
            return { crumbs: ['Knowledge Base', 'Domains'] };
        }
        if (nodeKey === 'asst-domains') {
            return { crumbs: ['Assistant', 'Domains'] };
        }
        // Per-Domain key shapes (KB tree):
        //   kb-domain:<id>
        //   kb-domain:<id>:docs | :vector | :graph
        //   kb-domain:<id>:graph:comm | :graph:docs
        //   kb-domain:<id>:graph:comm:<cid>
        //   kb-domain:<id>:doc:<path>   (corpus list leaf; path may contain ':')
        if (nodeKey.startsWith('kb-domain:')) {
            // Extract the doc:<path> tail explicitly so colons inside the
            // file path don't confuse the breadcrumb split.
            const docMatch = nodeKey.match(/^kb-domain:([^:]+):doc:(.+)$/);
            if (docMatch) {
                const did = docMatch[1];
                const path = docMatch[2];
                const d = domainState.getDomain(did);
                const dName = d?.name || did;
                return { crumbs: ['Knowledge Base', 'Domains', dName, 'Documents', path.split('/').pop()] };
            }
            const parts = nodeKey.split(':');
            const did = parts[1];
            const d = domainState.getDomain(did);
            const dName = d?.name || did;
            const tail = parts.slice(2);
            const SEG = { docs: 'Documents', vector: 'Vector', graph: 'Graph', comm: 'Communities' };
            // Special case: kb-domain:<id>:graph:docs -> "Documents" (graph side)
            // Special case: kb-domain:<id>:graph:comm:<cid> -> "Community <cid>"
            const niceTail = [];
            for (let i = 0; i < tail.length; i++) {
                const seg = tail[i];
                if (seg === 'docs' && tail[i - 1] === 'graph') niceTail.push('Documents');
                else if (tail[i - 1] === 'comm' && tail[i - 2] === 'graph') niceTail.push(`Community ${seg}`);
                else niceTail.push(SEG[seg] || seg);
            }
            return { crumbs: ['Knowledge Base', 'Domains', dName, ...niceTail] };
        }
        // Per-Domain Assistant key shapes:
        //   asst-domain:<id>
        //   asst-domain:<id>:skills | :tools
        if (nodeKey.startsWith('asst-domain:')) {
            const parts = nodeKey.split(':');
            const did = parts[1];
            const d = domainState.getDomain(did);
            const dName = d?.name || did;
            const tail = parts.slice(2);
            const SEG = { skills: 'Skills', tools: 'Tools' };
            const niceTail = tail.map((seg) => SEG[seg] || seg);
            return { crumbs: ['Assistant', 'Domains', dName, ...niceTail] };
        }
        if (nodeKey === 'root-assistant') {
            return { crumbs: ['Assistant'] };
        }
        if (nodeKey.startsWith('emb:src:')) {
            // Vector source leaf - parent breadcrumb climbs to Domain.
            const node = this._tree?.findKey?.(nodeKey);
            const parentKey = node?.parent?.key || '';
            const did = parentKey.match(/^kb-domain:([^:]+):vector$/)?.[1];
            const d = did ? domainState.getDomain(did) : null;
            const dName = d?.name || did || '?';
            return { crumbs: ['Knowledge Base', 'Domains', dName, 'Vector', node?.title || '...'] };
        }
        if (nodeKey.startsWith('emb:chunk:')) {
            const node = this._tree?.findKey?.(nodeKey);
            const parent = node?.parent;            // emb:src:* node
            const grand = parent?.parent;           // kb-domain:<id>:vector
            const did = (grand?.key || '').match(/^kb-domain:([^:]+):vector$/)?.[1];
            const d = did ? domainState.getDomain(did) : null;
            const dName = d?.name || did || '?';
            const sourceTitle = parent?.title || '';
            const title = node?.title || '...';
            return sourceTitle
                ? { crumbs: ['Knowledge Base', 'Domains', dName, 'Vector', sourceTitle, title] }
                : { crumbs: ['Knowledge Base', 'Domains', dName, 'Vector', title] };
        }
        if (nodeKey.startsWith('skill:')) {
            // Per-Domain skill leaf - parent is asst-domain:<id>:skills.
            const node = this._tree?.findKey?.(nodeKey);
            const parentKey = node?.parent?.key || '';
            const did = parentKey.match(/^asst-domain:([^:]+):skills$/)?.[1];
            if (did) {
                const d = domainState.getDomain(did);
                const dName = d?.name || did;
                return { crumbs: ['Assistant', 'Domains', dName, 'Skills', nodeKey.substring(6)] };
            }
            return { crumbs: ['Assistant', 'Skills', nodeKey.substring(6)] };
        }
        if (nodeKey.startsWith('mcptool:')) {
            // Per-Domain tool leaf - parent is asst-domain:<id>:tools.
            const node = this._tree?.findKey?.(nodeKey);
            const parentKey = node?.parent?.key || '';
            const did = parentKey.match(/^asst-domain:([^:]+):tools$/)?.[1];
            const rest = nodeKey.substring(8);
            const colonIdx = rest.indexOf(':');
            const toolName = colonIdx >= 0 ? rest.substring(colonIdx + 1) : rest;
            if (did) {
                const d = domainState.getDomain(did);
                const dName = d?.name || did;
                return { crumbs: ['Assistant', 'Domains', dName, 'Tools', toolName] };
            }
            return { crumbs: ['Assistant', 'Tools', toolName] };
        }
        // Per-Domain corpus document leaf (kb-graph-doc:<path>) - the
        // parent path tells us which Domain the corpus belongs to.
        if (nodeKey.startsWith('kb-graph-doc:')) {
            const node = this._tree?.findKey?.(nodeKey);
            const parentKey = node?.parent?.key || '';
            const did = parentKey.match(/^kb-domain:([^:]+):graph:docs$/)?.[1];
            const path = nodeKey.substring('kb-graph-doc:'.length);
            const basename = path.split('/').pop();
            if (did) {
                const d = domainState.getDomain(did);
                const dName = d?.name || did;
                return { crumbs: ['Knowledge Base', 'Domains', dName, 'Graph', 'Documents', basename] };
            }
            return { crumbs: ['Knowledge Base', basename] };
        }
        if (nodeKey.startsWith('kb-graph-comm:')) {
            // Legacy fallback - per-Domain key handled in the kb-domain:
            // branch above.
            const cid = nodeKey.substring('kb-graph-comm:'.length);
            return { crumbs: ['Knowledge Base', 'Communities', `Community ${cid}`] };
        }
        if (nodeKey === 'root-models-parent') {
            return { crumbs: ['Models'] };
        }
        if (nodeKey === 'root-models') {
            return { crumbs: ['Registry'] };
        }
        if (nodeKey.startsWith('regmodel:')) {
            return { crumbs: ['Registry', nodeKey.substring(9)] };
        }
        if (nodeKey.startsWith('regversion:')) {
            const rest = nodeKey.substring(11);
            const lastColon = rest.lastIndexOf(':');
            const modelName = lastColon >= 0 ? rest.substring(0, lastColon) : rest;
            const version = lastColon >= 0 ? rest.substring(lastColon + 1) : '';
            return { crumbs: ['Registry', modelName, `v${version}`] };
        }
        if (nodeKey === 'root-apis') {
            return { crumbs: ['Models', 'APIs'] };
        }
        if (nodeKey.startsWith('api:serving:')) {
            const modelName = nodeKey.substring('api:serving:'.length);
            return { crumbs: ['Models', 'APIs', modelName] };
        }
        if (nodeKey.startsWith('api-')) {
            // api-idle / api-error / api-status placeholders
            return { crumbs: ['Models', 'APIs'] };
        }
        return { crumbs: ['Explorer'] };
    }

    // ── API Endpoints Detail ────────────────────────────────────

    /**
     * APIs root overview. Shows a quick summary of which model (if any)
     * is currently deployed and points at the per-endpoint child node
     * for full developer documentation (schema, request examples, curl).
     */
    async _showApisRootDetail() {
        clearActionBar(this._detailRoot);
        this._detailEl.innerHTML = '';

        const h = document.createElement('div');
        h.style.cssText = 'font-weight:600;font-size:13px;padding:12px;color:#333';
        h.innerHTML = '<i class="fa-solid fa-plug" style="margin-right:6px;color:#42a5f5"></i>API Endpoints';
        this._detailEl.appendChild(h);

        const desc = document.createElement('div');
        desc.style.cssText = 'padding:0 12px 12px 12px;font-size:12px;color:#666;line-height:1.5';
        desc.textContent = 'Live REST endpoints for the noted-serving container. Deploy any registered model from the Model Registry to expose it here. Click the child node for the full developer reference: schema, example request body, and ready-to-copy curl command.';
        this._detailEl.appendChild(desc);

        const statusCard = document.createElement('div');
        statusCard.className = 's3-object-card';
        statusCard.style.margin = '0 12px';
        statusCard.innerHTML = '<div class="s3-object-loading">Checking serving status...</div>';
        this._detailEl.appendChild(statusCard);

        try {
            const resp = await fetch('api/serving/health');
            if (!resp.ok) {
                statusCard.innerHTML = '<div class="s3-object-loading" style="color:#c00">Serving service unavailable</div>';
                return;
            }
            const data = await resp.json();
            statusCard.innerHTML = '';

            const modelName = data.model_name;
            const isReady = data.status === 'ready' && modelName;
            const dotColor = isReady ? '#4caf50' : (data.status === 'idle' ? '#bbb' : '#f0a040');

            const headerRow = document.createElement('div');
            headerRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #eee;font-weight:600;color:#333';
            headerRow.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotColor}"></span>Serving: <span style="font-weight:500;color:#666">${isReady ? modelName : (data.status || 'unknown')}</span>`;
            statusCard.appendChild(headerRow);

            if (isReady) {
                const addRow = (label, value) => {
                    const row = document.createElement('div');
                    row.className = 's3-meta-row';
                    row.innerHTML = `<span class="s3-meta-label">${label}</span><span class="s3-meta-value">${value}</span>`;
                    statusCard.appendChild(row);
                };
                addRow('Model', modelName);
                if (data.version) addRow('Version', data.version);
                if (data.framework) addRow('Framework', data.framework);

                const hint = document.createElement('div');
                hint.style.cssText = 'padding:10px 12px;font-size:11px;color:#888;border-top:1px solid #eee;font-style:italic';
                hint.textContent = `Click "${modelName}" in the tree for the full API reference (schema, request examples, curl command).`;
                statusCard.appendChild(hint);
            } else if (data.status === 'idle') {
                const empty = document.createElement('div');
                empty.style.cssText = 'padding:16px 12px;color:#888;font-size:12px';
                empty.textContent = 'No model is currently deployed. Open the Model Registry, pick a version, and click Deploy to expose it here.';
                statusCard.appendChild(empty);
            } else {
                const row = document.createElement('div');
                row.style.cssText = 'padding:16px 12px;color:#c8870a;font-size:12px';
                row.textContent = `Serving status: ${data.status || 'unknown'}`;
                statusCard.appendChild(row);
            }
        } catch (e) {
            statusCard.innerHTML = `<div class="s3-object-loading" style="color:#c00">Failed to fetch serving status: ${e.message}</div>`;
        }
    }

    /**
     * Developer-facing API reference for a specific deployed model. Shown
     * when the user clicks the child node under the APIs root (for
     * example `api:serving:Jena Weather Forecaster`). Generic across all
     * models - every card is built from the live /health + /schema
     * responses so no per-model code is required. Contents:
     *
     *   - Current model metadata (name, version, alias, framework,
     *     parameter count, run ID, load time)
     *   - REST endpoint list with HTTP method badges
     *   - Input/output schema as hljs-highlighted JSON (raw from the
     *     /schema endpoint so developers see exactly what the server
     *     exposes)
     *   - Example request body as hljs-highlighted JSON, built from the
     *     schema with sensible placeholder values
     *   - Example curl command as hljs-highlighted bash, with a Copy
     *     button that writes the full command to the clipboard
     *
     * Reuses the page-level `hljs` global that noted already loads for
     * Markdown code blocks (see DocumentViewer._postProcessMarkdown).
     */
    async _showApiEndpointDetail(key) {
        clearActionBar(this._detailRoot);
        this._detailEl.innerHTML = '';

        const title = document.createElement('div');
        title.style.cssText = 'font-weight:600;font-size:13px;padding:12px;color:#333';
        title.innerHTML = '<i class="fa-solid fa-plug" style="margin-right:6px;color:#42a5f5"></i>API Reference';
        this._detailEl.appendChild(title);

        const desc = document.createElement('div');
        desc.style.cssText = 'padding:0 12px 12px 12px;font-size:12px;color:#666;line-height:1.5';
        desc.textContent = 'Developer reference for the currently-deployed model. The schema, example request body, and curl command below are generated from the model\'s own MLflow signature and refresh whenever a new model is deployed.';
        this._detailEl.appendChild(desc);

        const container = document.createElement('div');
        container.style.cssText = 'padding:0 12px';
        container.innerHTML = '<div class="s3-object-card"><div class="s3-object-loading">Fetching model schema...</div></div>';
        this._detailEl.appendChild(container);

        try {
            const [healthResp, schemaResp] = await Promise.all([
                fetch('api/serving/health'),
                fetch('api/serving/schema').catch(() => null),
            ]);

            if (!healthResp.ok) {
                container.innerHTML = '<div class="s3-object-card"><div class="s3-object-loading" style="color:#c00">Serving service unavailable</div></div>';
                return;
            }
            const health = await healthResp.json();
            const schema = schemaResp && schemaResp.ok ? await schemaResp.json() : null;

            container.innerHTML = '';

            const modelName = health.model_name;
            const isReady = health.status === 'ready' && modelName;

            if (!isReady) {
                const emptyCard = document.createElement('div');
                emptyCard.className = 's3-object-card';
                const empty = document.createElement('div');
                empty.style.cssText = 'padding:16px 12px;color:#888;font-size:12px';
                empty.textContent = 'This endpoint is only populated while a model is actively deployed. Deploy a model from the Model Registry to see its full API reference.';
                emptyCard.appendChild(empty);
                container.appendChild(emptyCard);
                return;
            }

            // ── Current model metadata ──
            const statusCard = document.createElement('div');
            statusCard.className = 's3-object-card';
            statusCard.style.marginBottom = '12px';
            const headerRow = document.createElement('div');
            headerRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #eee;font-weight:600;color:#333';
            headerRow.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#4caf50"></span>Serving: <span style="font-weight:500;color:#666">${modelName}</span>`;
            statusCard.appendChild(headerRow);
            const addRow = (parent, k, v) => {
                const row = document.createElement('div');
                row.className = 's3-meta-row';
                row.innerHTML = `<span class="s3-meta-label">${k}</span><span class="s3-meta-value">${v}</span>`;
                parent.appendChild(row);
            };
            addRow(statusCard, 'Model', modelName);
            if (health.version) addRow(statusCard, 'Version', health.version);
            if (health.alias) addRow(statusCard, 'Alias', `@${health.alias}`);
            if (health.framework) addRow(statusCard, 'Framework', health.framework);
            if (health.num_parameters) addRow(statusCard, 'Parameters', health.num_parameters.toLocaleString());
            if (health.run_id) addRow(statusCard, 'Run ID', `<span class="mono">${health.run_id.substring(0, 8)}</span>`);
            if (health.load_time != null) addRow(statusCard, 'Load time', `${health.load_time.toFixed(2)}s`);
            container.appendChild(statusCard);

            // ── REST endpoint reference ──
            const endpointCard = document.createElement('div');
            endpointCard.className = 's3-object-card';
            endpointCard.style.marginBottom = '12px';
            const endpointHeader = document.createElement('div');
            endpointHeader.style.cssText = 'padding:10px 12px;border-bottom:1px solid #eee;font-weight:600;color:#333;font-size:12px';
            endpointHeader.textContent = 'REST Endpoints';
            endpointCard.appendChild(endpointHeader);
            const METHOD_COLORS = { GET: '#4caf50', POST: '#2196f3', DELETE: '#f44336', PATCH: '#ff9800' };
            const renderEndpoint = (method, path, d) => {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:flex-start;gap:10px;padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:12px';
                const color = METHOD_COLORS[method] || '#666';
                row.innerHTML =
                    `<span style="flex:0 0 48px;font-family:var(--font-mono,monospace);font-weight:700;font-size:10px;color:#fff;background:${color};padding:2px 0;text-align:center;border-radius:3px">${method}</span>` +
                    `<span style="flex:1;font-family:var(--font-mono,monospace);color:#1a7f9b">${path}</span>` +
                    `<span style="flex:2;color:#888">${d}</span>`;
                endpointCard.appendChild(row);
            };
            renderEndpoint('GET', '/api/serving/health', 'Live serving state (model, load time, framework)');
            renderEndpoint('GET', '/api/serving/schema', 'Input/output signature for the deployed model');
            renderEndpoint('POST', '/api/serving/load', 'Deploy a registered model (streaming NDJSON)');
            renderEndpoint('POST', '/api/serving/predict', 'Run inference against the deployed model');
            renderEndpoint('POST', '/api/serving/unload', 'Drop the current model from memory');
            container.appendChild(endpointCard);

            if (!schema) return;

            // ── Code-block helper (hljs-highlighted, with Copy button) ──
            const addCodeBlock = (blockTitle, language, code) => {
                const card = document.createElement('div');
                card.className = 's3-object-card';
                card.style.marginBottom = '12px';
                const header = document.createElement('div');
                header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #eee;font-weight:600;color:#333;font-size:12px';
                const copyBtn = document.createElement('button');
                copyBtn.textContent = 'Copy';
                copyBtn.style.cssText = 'font-size:10px;padding:2px 10px;border:1px solid #ccc;border-radius:3px;background:#fff;cursor:pointer;color:#555';
                copyBtn.addEventListener('click', () => {
                    navigator.clipboard.writeText(code).then(() => {
                        copyBtn.textContent = 'Copied!';
                        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
                    });
                });
                const titleSpan = document.createElement('span');
                titleSpan.textContent = blockTitle;
                header.appendChild(titleSpan);
                header.appendChild(copyBtn);
                card.appendChild(header);
                const pre = document.createElement('pre');
                pre.style.cssText = 'margin:0;padding:12px;font-size:11px;font-family:var(--font-mono,monospace);color:#333;overflow-x:auto;white-space:pre';
                const codeEl = document.createElement('code');
                codeEl.className = `language-${language}`;
                codeEl.textContent = code;
                pre.appendChild(codeEl);
                card.appendChild(pre);
                container.appendChild(card);
                if (typeof hljs !== 'undefined') {
                    try { delete codeEl.dataset.highlighted; hljs.highlightElement(codeEl); } catch {}
                }
            };

            // ── Input schema (raw JSON from /schema, hljs-highlighted) ──
            const inputSchema = {
                input_format: schema.input_format,
                input_shape: schema.input_shape,
                inputs: schema.inputs,
            };
            addCodeBlock('Input Schema', 'json', JSON.stringify(inputSchema, null, 2));

            // ── Output schema ──
            const outputSchema = {
                output_format: schema.output_format,
                output_visualization: schema.output_visualization,
                outputs: schema.outputs,
                class_labels: schema.class_labels,
            };
            addCodeBlock('Output Schema', 'json', JSON.stringify(outputSchema, null, 2));

            // ── Example request body + curl command ──
            const exampleBody = this._buildExampleRequestBody(schema);
            addCodeBlock('Example Request Body (JSON)', 'json', JSON.stringify(exampleBody, null, 2));
            const curlCmd =
                `curl -X POST http://localhost:8123/api/serving/predict \\\n` +
                `  -H "Content-Type: application/json" \\\n` +
                `  -d '${JSON.stringify(exampleBody)}'`;
            addCodeBlock('Example curl Command', 'bash', curlCmd);
        } catch (e) {
            container.innerHTML = `<div class="s3-object-card"><div class="s3-object-loading" style="color:#c00">Failed to fetch serving state: ${e.message}</div></div>`;
        }
    }

    /**
     * Build a minimal valid request body from the model's schema, suitable
     * for pasting into a curl command or client SDK. Handles the three
     * input formats noted-serving currently supports:
     *   - tensor  → {data: [[[...0.0...]]]}
     *   - columnar → {data: {columns: [...], data: [[...]]}}
     *   - dict → {data: {col1: val, col2: val, ...}}
     * Shape dimensions of -1 (batch) are replaced with 1 for the example.
     */
    _buildExampleRequestBody(schema) {
        const format = schema.input_format || 'tensor';
        if (format === 'tensor') {
            const shape = (schema.input_shape || schema.inputs?.[0]?.shape || [1])
                .map(d => (d < 0 ? 1 : d));
            const makeTensor = (dims) => {
                if (dims.length === 0) return 0.0;
                const len = dims[0];
                const rest = dims.slice(1);
                return Array.from({ length: len }, () => makeTensor(rest));
            };
            return { data: makeTensor(shape) };
        }
        if (format === 'columnar') {
            const cols = (schema.inputs || []).map(i => i.name || 'col');
            return { data: { columns: cols, data: [cols.map(() => 0.0)] } };
        }
        // Dict / dataframe-row input
        const row = {};
        for (const inp of schema.inputs || []) {
            row[inp.name || 'col'] = 0.0;
        }
        return { data: row };
    }

    // ── Assistant / Skills ────────────────────────────────────────

    /** Per-Domain skill list loader. The /api/llm/skills endpoint returns
     *  every registered skill with its `domain_id`; we filter client-side
     *  so each Domain branch shows only its own skills. */
    async _loadSkillsTree(domainId = null) {
        try {
            const resp = await fetch('api/llm/skills');
            if (!resp.ok) throw new Error(`${resp.status}`);
            const data = await resp.json();
            const skills = (data.skills || []).filter(s => domainId ? s.domain_id === domainId : true);
            if (!skills.length) {
                return [{ title: 'No skills bound to this Domain', key: `asst-domain:${domainId}:skills:empty`, icon: 'fa-solid fa-info-circle' }];
            }
            // Side map for _onTreeRender, keyed by the same key the renderer
            // uses. Wunderbaum's per-node `data` doesn't reach the hook
            // reliably for lazy-loaded children.
            this._userAuthoredKeys = this._userAuthoredKeys || new Set();
            for (const s of skills) {
                if (s.provenance === 'user') {
                    this._userAuthoredKeys.add(`skill:${s.name}`);
                }
            }
            return skills.map(s => {
                // F6.4: pill is injected post-render via _onTreeRender (see
                // tool-tree comment for why HTML can't sit in `title`).
                const isUser = s.provenance === 'user';
                return {
                    title: s.name,
                    key: `skill:${s.name}`,
                    icon: 'fa-solid fa-scroll',
                    folder: s.has_references,
                    lazy: s.has_references,
                    children: s.has_references ? undefined : undefined,
                    tooltip: (isUser ? '[self-authored] ' : '') + (s.description || ''),
                };
            });
        } catch (e) {
            return [{ title: `Error: ${e.message}`, key: 'skill-error', icon: 'fa-solid fa-exclamation-triangle' }];
        }
    }

    async _showAssistantRootDetail() {
        this._detailEl.innerHTML = '';
        const header = createDetailHeader('Assistant', 'fa-solid fa-robot');
        const icon = header.querySelector('i');
        if (icon) icon.style.color = '#ff7043';
        this._detailEl.appendChild(header);

        const desc = document.createElement('p');
        desc.style.cssText = 'font-size:12px;color:#555;padding:8px 12px;line-height:1.5';

        // Get model from chat selector, skills count from API
        const modelSelect = document.querySelector('.chat-model-select');
        const modelName = modelSelect?.selectedOptions?.[0]?.textContent || modelSelect?.value || 'not configured';
        let skillCount = 0;
        let toolCount = 0;
        try {
            const resp = await fetch('api/llm/skills');
            if (resp.ok) {
                const data = await resp.json();
                skillCount = (data.skills || []).length;
            }
        } catch {}
        try {
            const data = await this._fetchMcpTools();
            toolCount = (data.tools || []).length;
        } catch {}

        desc.innerHTML = `<b>Model:</b> ${modelName}<br>`
            + `<b>Skills:</b> ${skillCount} knowledge file${skillCount !== 1 ? 's' : ''} available<br>`
            + `<b>Tools:</b> ${toolCount} MCP tool${toolCount !== 1 ? 's' : ''} (also exposed at <span class="mono">/mcp</span> for external clients)<br>`
            + `<b>Embeddings:</b> Vector embeddings for semantic search (coming soon)`;
        this._detailEl.appendChild(desc);
    }

    // ── Per-Domain Knowledge Base + Assistant tree loaders ──────────

    /** Open a detail tab showing a community's summary + top-N members.
     *  `domainId` is required for per-Domain accuracy; when omitted (legacy
     *  callers) we fall back to the first active knowledge Domain. */
    async _openCommunityDetailTab(cid, domainId = null) {
        const did = domainId || domainState.getFirstKnowledgeDomain();
        const tabKey = `detail:kb-domain:${did}:graph:comm:${cid}`;
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-color);color:var(--text-color);overflow:auto';
        const container = document.createElement('div');
        container.style.cssText = 'padding:18px 22px;max-width:900px;font-size:13px';
        container.innerHTML = `<div style="color:var(--text-secondary)">Loading community ${cid}...</div>`;
        wrapper.appendChild(container);
        if (this._callbacks.onDetailTab) {
            this._callbacks.onDetailTab(tabKey, `Community ${cid}`, wrapper, { undockable: true, preview: true });
        }
        try {
            const resp = await fetch(`api/graph/research/${did}/communities/${cid}`);
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${resp.status}`);
            }
            const data = await resp.json();
            container.innerHTML = this._renderCommunityDetail(data);
        } catch (e) {
            container.innerHTML = `<div style="color:var(--error-fg, #e57373)">Failed to load community ${cid}: ${this._escapeHtmlSafe(e.message)}</div>`;
        }
    }

    _escapeHtmlSafe(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    _renderCommunityDetail(data) {
        const esc = (s) => this._escapeHtmlSafe(s);
        const cid = data.community_id;
        const count = data.member_count || 0;
        const dom = (data.dominant_entity_types || []).map(d => `<span style="display:inline-block;padding:2px 8px;margin-right:6px;border-radius:10px;background:rgba(77,208,225,0.15);color:#4dd0e1;font-size:11px">${esc(d.type)} &times; ${d.count}</span>`).join('');
        const summary = data.summary
            ? `<div style="margin:14px 0 20px 0;padding:12px 14px;background:rgba(77,208,225,0.06);border-left:3px solid #4dd0e1;border-radius:2px;line-height:1.55">${esc(data.summary)}</div>`
            : `<div style="margin:14px 0 20px 0;padding:12px 14px;background:rgba(255,183,77,0.08);border-left:3px solid #ffb74d;border-radius:2px;color:var(--text-secondary);font-style:italic">No Gemma summary for this community yet (either fewer than 2 thematic members, or the summarization step was skipped).</div>`;
        const members = (data.top_members || []).map(m => {
            const rank = typeof m.rank === 'number' ? m.rank.toFixed(5) : '&mdash;';
            const desc = m.description ? `<div style="color:var(--text-secondary);font-size:11px;margin-top:2px">${esc(m.description.slice(0, 200))}</div>` : '';
            return `<div style="padding:8px 10px;border-bottom:1px solid var(--border-color);font-size:12px">
                <span style="font-weight:600">${esc(m.label || m.id)}</span>
                <span style="color:var(--text-secondary);font-size:11px;margin-left:8px">${esc(m.type)}</span>
                <span style="float:right;color:var(--text-secondary);font-family:monospace;font-size:11px">rank ${rank}</span>
                ${desc}
            </div>`;
        }).join('');
        return `
            <div style="font-size:20px;font-weight:600;margin-bottom:4px">
                <i class="fa-solid fa-circle-nodes" style="color:#4dd0e1;margin-right:8px"></i>Community ${cid}
            </div>
            <div style="color:var(--text-secondary);font-size:12px;margin-bottom:12px">${count} member${count !== 1 ? 's' : ''}</div>
            <div>${dom || '<span style="color:var(--text-secondary);font-size:11px">No dominant type data</span>'}</div>
            <h3 style="font-size:14px;margin:22px 0 6px 0;font-weight:600">Summary</h3>
            ${summary}
            <h3 style="font-size:14px;margin:22px 0 10px 0;font-weight:600">Top members by PageRank (${(data.top_members || []).length})</h3>
            <div style="border:1px solid var(--border-color);border-radius:4px;overflow:hidden">
                ${members || '<div style="padding:12px;color:var(--text-secondary);font-style:italic">No members returned</div>'}
            </div>
        `;
    }

    /** Per-Domain Graph > Communities loader. `domainId` is required - the
     *  caller (lazy-loader) parses it from the node key. Domains with no
     *  knowledge half (general) get an explicit empty leaf so the user
     *  understands the branch is intentionally empty. */
    async _loadGraphCommunities(domainId) {
        const d = domainId ? domainState.getDomain(domainId) : null;
        if (d && d.has_knowledge === false) {
            return [{ title: 'No communities', key: `kb-domain:${domainId}:graph:comm:empty`, icon: 'fa-solid fa-info-circle' }];
        }
        try {
            const did = domainId || domainState.getFirstKnowledgeDomain();
            const resp = await fetch(`api/graph/research/${did}/communities`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const communities = data.communities || [];
            if (!communities.length) {
                return [{ title: 'No communities', key: `kb-domain:${did}:graph:comm:empty`, icon: 'fa-solid fa-info-circle' }];
            }
            return communities.map(c => {
                const cid = c.community_id;
                const dom = (c.dominant_entity_types || []).map(x => `${x.type}:${x.count}`).join(', ');
                return {
                    title: `Community ${cid} (${c.member_count} members)`,
                    key: `kb-domain:${did}:graph:comm:${cid}`,
                    icon: 'fa-solid fa-circle-nodes',
                    tooltip: dom ? `Dominant types: ${dom}` : '',
                };
            });
        } catch (e) {
            return [{ title: `Error: ${e.message}`, key: `kb-domain:${domainId}:graph:comm:error`, icon: 'fa-solid fa-exclamation-triangle' }];
        }
    }

    /** Per-Domain Graph > Documents loader. Returns the entities of type
     *  markdown_doc that the graph extracted from this Domain's corpus. */
    async _loadGraphDocuments(domainId) {
        const d = domainId ? domainState.getDomain(domainId) : null;
        if (d && d.has_knowledge === false) {
            return [{ title: 'No graph documents', key: `kb-domain:${domainId}:graph:docs:empty`, icon: 'fa-solid fa-info-circle' }];
        }
        try {
            const did = domainId || domainState.getFirstKnowledgeDomain();
            const resp = await fetch(`api/graph/research/${did}/corpus`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const docs = data.documents || [];
            if (!docs.length) {
                return [{ title: 'No graph documents', key: `kb-domain:${did}:graph:docs:empty`, icon: 'fa-solid fa-info-circle' }];
            }
            return docs.map(x => ({
                title: x.basename + (x.uploaded ? ' (uploaded)' : ''),
                // kb-graph-doc:<path> kept as the leaf-key shape so the
                // existing context-menu handler (deleteGraphCorpusDocument)
                // works without modification. The parent node carries the
                // Domain id when the menu needs it.
                key: `kb-graph-doc:${x.path}`,
                icon: x.exists ? 'fa-solid fa-file-lines' : 'fa-solid fa-file-circle-exclamation',
                tooltip: x.path + (x.exists ? '' : '  [missing on disk]'),
                data: { path: x.path, uploaded: x.uploaded, exists: x.exists, domain_id: did },
            }));
        } catch (e) {
            return [{ title: `Error: ${e.message}`, key: `kb-domain:${domainId}:graph:docs:error`, icon: 'fa-solid fa-exclamation-triangle' }];
        }
    }

    /** Per-Domain corpus document loader (kb-domain:<id>:docs). Lists the
     *  raw inventory rows from the unified corpus endpoint - same shape
     *  used by the Knowledge Base Manager. Documents with `mode=read_only`
     *  are visible but not indexed in the vector + graph subtrees. */
    /** Cross-Domain Documents loader. Fetches the corpus list from EVERY
     *  knowledge Domain in parallel, merges, then groups by folder path
     *  when any file has one (Unfiled bucket holds the rest). Each file
     *  carries its owning Domain in the title badge + tooltip. */
    async _loadAllDocuments() {
        const knowledgeDomains = domainState.getDomains().filter(d => d.has_knowledge);
        if (!knowledgeDomains.length) {
            return [{ title: 'No documents', key: 'kb-documents:empty', icon: 'fa-solid fa-info-circle' }];
        }
        // Fan out per-Domain corpus fetches in parallel.
        const allDocs = [];
        const fetches = knowledgeDomains.map(async (d) => {
            try {
                const r = await fetch(`api/graph/research/${d.domain_id}/corpus`);
                if (!r.ok) return;
                const data = await r.json();
                for (const x of (data.documents || [])) {
                    allDocs.push({ ...x, domain_id: d.domain_id, domain_name: d.name || d.domain_id });
                }
            } catch { /* silently skip unreachable Domain */ }
        });
        await Promise.all(fetches);
        if (!allDocs.length) {
            return [{ title: 'No documents', key: 'kb-documents:empty', icon: 'fa-solid fa-info-circle' }];
        }
        const _docNode = (x) => {
            const modeBadge = x.mode === 'read_only' ? ' [read-only]' : '';
            // Display name override: user-set free-text title that the
            // tree shows instead of the physical filename. Empty falls
            // back to basename(path). The actual `path` stays as the
            // canonical id for backend operations. Domain info is in
            // the tooltip (and the data field), not in the title.
            const baseTitle = (x.display_name || '').trim()
                || x.basename || (x.path || '').split('/').pop();
            return {
                title: baseTitle + modeBadge,
                key: `kb-documents:doc:${x.domain_id}:${x.path}`,
                icon: x.exists === false ? 'fa-solid fa-file-circle-exclamation' : kbDocIconForFile(x.path),
                tooltip: `${x.path}\nDomain: ${x.domain_name}` + (x.exists === false ? '  [missing on disk]' : '') + (x.category ? `\nFolder: ${x.category}` : ''),
                data: { path: x.path, mode: x.mode, exists: x.exists, added_at: x.added_at, category: x.category || '', display_name: x.display_name || '', domain_id: x.domain_id, domain_name: x.domain_name },
            };
        };
        // Group by category when ANY file has one; otherwise flat list.
        const hasAnyCategory = allDocs.some(x => (x.category || '').trim());
        if (!hasAnyCategory) {
            return allDocs.map(_docNode);
        }
        // Hierarchical category paths: a category like "Manuals/Technical/noted"
        // becomes nested folder nodes Manuals > Technical > noted. Empty
        // segments (from `a//b` or trailing slashes) are skipped. Categories
        // without a `/` behave exactly as before (single-level folders).
        // Folder keys carry the cumulative path so the existing
        // `key.startsWith('kb-documents:cat:')` checks (no detail page on
        // click) keep matching at every nesting level.
        const root = { children: new Map(), docs: [] };
        for (const x of allDocs) {
            const raw = (x.category || '').trim();
            const segments = raw
                ? raw.split('/').map((s) => s.trim()).filter(Boolean)
                : ['Unfiled'];
            let cursor = root;
            for (const seg of segments) {
                if (!cursor.children.has(seg)) {
                    cursor.children.set(seg, { children: new Map(), docs: [] });
                }
                cursor = cursor.children.get(seg);
            }
            cursor.docs.push(x);
        }
        const buildNode = (name, node, parentPath) => {
            const path = parentPath ? `${parentPath}/${name}` : name;
            // Folders alphabetically first; doc leaves after, alphabetically.
            const childFolders = Array.from(node.children.keys()).sort()
                .map((sub) => buildNode(sub, node.children.get(sub), path));
            const docNodes = node.docs
                .slice()
                .sort((a, b) => {
                    const ta = (a.display_name || a.basename || a.path || '').toLowerCase();
                    const tb = (b.display_name || b.basename || b.path || '').toLowerCase();
                    return ta.localeCompare(tb);
                })
                .map(_docNode);
            return {
                title: name,
                key: `kb-documents:cat:${path}`,
                icon: FOLDER_ICON,
                folder: true,
                // Default collapsed. Previously `expanded: true` here
                // caused the entire Documents subtree to auto-expand
                // recursively (every category + sub-category opened
                // when the user clicked Documents). The user only
                // wants to see the level they clicked.
                children: [...childFolders, ...docNodes],
            };
        };
        return Array.from(root.children.keys()).sort()
            .map((name) => buildNode(name, root.children.get(name), ''));
    }

    /** Per-Domain Vector loader. Threads the `<id>__corpus` collection
     *  parameter through to the rag index endpoint so each Domain lists
     *  ITS OWN indexed sources. Domains with no knowledge half show an
     *  explicit empty leaf. */
    async _loadEmbeddingsSources(domainId = null) {
        const d = domainId ? domainState.getDomain(domainId) : null;
        if (d && d.has_knowledge === false) {
            return [{ title: 'No vector chunks', key: `kb-domain:${domainId}:vector:empty`, icon: 'fa-solid fa-info-circle' }];
        }
        try {
            const url = domainId
                ? `api/rag/index/sources?collection=${encodeURIComponent(domainId)}__corpus`
                : 'api/rag/index/sources';
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const sources = data.sources || [];
            if (!sources.length) {
                return [{ title: 'No vector chunks', key: domainId ? `kb-domain:${domainId}:vector:empty` : 'emb-empty', icon: 'fa-solid fa-info-circle' }];
            }
            return sources.map(s => ({
                title: s.name,
                key: `emb:src:${s.id}`,
                icon: 'fa-solid fa-file-lines',
                folder: true,
                lazy: true,
                tooltip: `${s.source_path}\n${s.chunk_count} chunk${s.chunk_count !== 1 ? 's' : ''} • ${s.doc_type}`,
                // Stash server-side metadata for the detail renderer so we
                // don't need a second round-trip just to show the summary.
                data: {
                    source_path: s.source_path,
                    chunk_count: s.chunk_count,
                    doc_type: s.doc_type,
                    last_modified_utc: s.last_modified_utc,
                    domain_id: domainId,
                },
            }));
        } catch (e) {
            return [{ title: `Error: ${e.message}`, key: 'emb-error', icon: 'fa-solid fa-exclamation-triangle' }];
        }
    }

    async _loadEmbeddingsChunks(sourceB64, domainId = null) {
        try {
            const url = domainId
                ? `api/rag/index/sources/${encodeURIComponent(sourceB64)}/chunks?collection=${encodeURIComponent(domainId)}__corpus`
                : `api/rag/index/sources/${encodeURIComponent(sourceB64)}/chunks`;
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const chunks = data.chunks || [];
            if (!chunks.length) {
                return [{ title: 'No chunks', key: `emb-empty:${sourceB64}`, icon: 'fa-solid fa-info-circle' }];
            }
            return chunks.map(c => ({
                title: c.section_path || c.title || c.chunk_id,
                key: `emb:chunk:${c.id}`,
                icon: 'fa-solid fa-bookmark',
                tooltip: `${c.title || c.section_path}\n${c.doc_type}`,
                data: { domain_id: domainId },
            }));
        } catch (e) {
            return [{ title: `Error: ${e.message}`, key: `emb-err:${sourceB64}`, icon: 'fa-solid fa-exclamation-triangle' }];
        }
    }

    // ── Assistant / Embeddings - detail panes ─────────────────────────

    async _showEmbeddingsSourceDetail(sourceB64) {
        this._detailEl.innerHTML = '';
        const node = this._tree?.findKey?.(`emb:src:${sourceB64}`);
        const meta = node?.data || {};
        const header = createDetailHeader(node?.title || 'Source', 'fa-solid fa-file-lines');
        const icon = header.querySelector('i');
        if (icon) icon.style.color = '#cfd8dc';
        this._detailEl.appendChild(header);

        const summary = document.createElement('p');
        summary.style.cssText = 'font-size:12px;color:#555;padding:8px 12px;line-height:1.5';
        const lastMod = meta.last_modified_utc
            ? new Date(meta.last_modified_utc).toLocaleString() : 'unknown';
        summary.innerHTML = `<b>Source path:</b> <span class="mono">${meta.source_path || '?'}</span><br>`
            + `<b>Doc type:</b> ${meta.doc_type || '?'}<br>`
            + `<b>Chunks:</b> ${meta.chunk_count ?? '?'}<br>`
            + `<b>Last modified:</b> ${lastMod}`;
        this._detailEl.appendChild(summary);
    }

    async _showEmbeddingsChunkDetail(chunkB64, clickedNode = null) {
        this._detailEl.innerHTML = '';
        const header = createDetailHeader('Chunk', 'fa-solid fa-bookmark');
        const icon = header.querySelector('i');
        if (icon) icon.style.color = '#cfd8dc';
        this._detailEl.appendChild(header);

        const body = document.createElement('div');
        body.style.cssText = 'padding:8px 12px;font-size:12px;line-height:1.5;color:#444';
        body.textContent = 'Loading chunk...';
        this._detailEl.appendChild(body);

        // Scope the lookup to the right per-Domain collection. Without
        // `?collection=...`, noted-rag falls back to the legacy
        // `noted_corpus` name (no longer exists) and returns
        // {status: "unavailable"} - which renders as "?" fields.
        // Domain id resolution priority:
        //   1. `clickedNode.data.domain_id` (set by _loadEmbeddingsChunks)
        //   2. Walk up to the nearest `kb-domain:<id>:vector` ancestor,
        //      which always exists when the chunk lives inside the
        //      per-Domain Vector tree (covers cases where Wunderbaum
        //      hasn't preserved the leaf's `data` field).
        let domainId = clickedNode?.data?.domain_id;
        if (!domainId && clickedNode) {
            let n = clickedNode.parent;
            while (n) {
                const m = (n.key || '').match(/^kb-domain:([^:]+):vector$/);
                if (m) { domainId = m[1]; break; }
                n = n.parent;
            }
        }
        const url = domainId
            ? `api/rag/index/chunks/${encodeURIComponent(chunkB64)}?collection=${encodeURIComponent(domainId)}__corpus`
            : `api/rag/index/chunks/${encodeURIComponent(chunkB64)}`;

        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const lastMod = data.last_modified_utc
                ? new Date(data.last_modified_utc).toLocaleString() : 'unknown';
            body.innerHTML = `<b>Section:</b> ${data.section_path || '?'}<br>`
                + `<b>Source:</b> <span class="mono">${data.source_path || '?'}</span><br>`
                + `<b>Doc type:</b> ${data.doc_type || '?'}<br>`
                + `<b>Tokens (approx):</b> ${data.token_count ?? '?'}<br>`
                + `<b>Last modified:</b> ${lastMod}<br><br>`
                + `<b>Text:</b>`;
            // Render the chunk as markdown using the same class that powers
            // the Knowledge Base document viewer. Reusing that class keeps
            // heading hierarchy, links, code blocks, and tables styled
            // identically across the app. Corpus is trusted.
            const md = document.createElement('div');
            md.className = 'document-viewer-markdown';
            if (typeof marked !== 'undefined' && marked?.parse) {
                md.innerHTML = marked.parse(data.text || '');
            } else {
                const pre = document.createElement('pre');
                pre.style.cssText = 'white-space:pre-wrap;margin:0';
                pre.textContent = data.text || '';
                md.appendChild(pre);
            }
            body.appendChild(md);
        } catch (e) {
            body.textContent = `Unable to load chunk: ${e.message}`;
        }
    }

    async _openSkillAsDocument(skillName, pin = false) {
        try {
            const resp = await fetch(`api/llm/skills/${encodeURIComponent(skillName)}`);
            if (!resp.ok) return;
            const data = await resp.json();
            const doc = {
                name: data.name || skillName,
                category: 'Skills',
                content: data.content || '',
            };
            if (pin) {
                if (this._callbacks.onDocumentOpen) this._callbacks.onDocumentOpen(doc);
            } else {
                if (this._callbacks.onDocumentPreview) this._callbacks.onDocumentPreview(doc);
            }
        } catch {}
    }

    async _showSkillDetail(skillName) {
        this._detailEl.innerHTML = '';
        const header = createDetailHeader(skillName, 'fa-solid fa-scroll');
        const icon = header.querySelector('i');
        if (icon) {
            icon.style.color = '#43a047';
            icon.style.webkitTextStroke = '1.5px #666666';
            icon.style.paintOrder = 'stroke fill';
        }
        this._detailEl.appendChild(header);

        try {
            const resp = await fetch(`api/llm/skills/${encodeURIComponent(skillName)}`);
            if (!resp.ok) throw new Error(`${resp.status}`);
            const data = await resp.json();

            // Metadata
            const meta = document.createElement('div');
            meta.style.cssText = 'padding:8px 12px;font-size:11px;color:#555';
            const isUser = data.provenance === 'user';
            const fields = [];
            if (isUser) {
                fields.push('<span title="Self-authored via the workflow framework" style="display:inline-block;font-family:var(--font-mono,monospace);font-weight:700;font-size:10px;color:#fff;background:#7e57c2;padding:1px 6px;border-radius:3px;margin-bottom:4px">USER</span>');
            }
            if (data.description) fields.push(`<b>Description:</b> ${data.description}`);
            if (data.triggers) fields.push(`<b>Triggers:</b> ${(data.triggers || []).join(', ')}`);
            if (data.priority) fields.push(`<b>Priority:</b> ${data.priority}`);
            if (data.max_tokens) fields.push(`<b>Max tokens:</b> ${data.max_tokens}`);
            meta.innerHTML = fields.join('<br>');
            this._detailEl.appendChild(meta);

            // F6.4: provenance card with click-through to source workflow.
            const sw = data.source_workflow;
            if (isUser && sw && sw.workflow_id) {
                const provCard = document.createElement('div');
                provCard.style.cssText = 'margin:12px;padding:10px 12px;border:1px solid #e0d4f5;background:#f7f3fc;border-radius:4px;font-size:11px;color:#444;line-height:1.7';
                const wfId = String(sw.workflow_id);
                const wfType = String(sw.type || 'workflow');
                const linkId = `skill-prov-wf-${wfId}`;
                provCard.innerHTML =
                    `<div style="font-weight:600;color:#5b3a99;margin-bottom:4px">Provenance</div>` +
                    `<div><span style="color:#888">Created by</span> <code>${this._escapeHtmlSafe(data.created_by || '')}</code> ` +
                    `<span style="color:#888">at</span> <code>${this._escapeHtmlSafe(data.created_at || '')}</code></div>` +
                    `<div style="margin-top:4px"><span style="color:#888">Source workflow</span> ` +
                    `<code>${this._escapeHtmlSafe(wfType)}</code> ` +
                    `<a href="#" id="${linkId}" style="color:#1a7f9b;margin-left:8px">` +
                    `<i class="fa-solid fa-diagram-project" style="margin-right:4px"></i>open in Workflow Monitor</a></div>`;
                this._detailEl.appendChild(provCard);
                const link = provCard.querySelector(`#${linkId}`);
                if (link) {
                    link.addEventListener('click', (ev) => {
                        ev.preventDefault();
                        const app = this._ctx?.app || window.app;
                        if (app && typeof app.showWorkflowMonitor === 'function') {
                            app.showWorkflowMonitor(wfId);
                        }
                    });
                }
            }

            // ── Delete affordance for user-authored skills (gated on the
            //     same access key as the Terminal). User-authored skills
            //     are always paired with a tool of the same name (the
            //     publish_skill step canonicalises this), so deleting the
            //     skill removes the pair via the same /user-tool/{name}/delete
            //     endpoint. Same UX as the tool-detail Delete button. ──
            if (isUser) {
                const actionsRow = document.createElement('div');
                actionsRow.style.cssText = 'padding:8px 12px;display:flex;justify-content:flex-end;gap:8px;border-top:1px solid #eee;margin-top:6px';
                const delBtn = document.createElement('button');
                delBtn.style.cssText = 'padding:5px 12px;border:1px solid #d28a8a;background:#fff;color:#8a3838;border-radius:4px;font-size:12px;cursor:pointer';
                delBtn.innerHTML = '<i class="fa-solid fa-trash" style="margin-right:4px"></i>Delete skill + paired tool';
                delBtn.title = 'Archive this skill and its paired tool (requires access key)';
                delBtn.addEventListener('click', async () => {
                    const confirmed = confirm(
                        `Delete skill "${skillName}" and its paired tool?\n\n` +
                        `Both will be archived under _archive/. ` +
                        `You'll be asked for the noted access key.`
                    );
                    if (!confirmed) return;
                    const { getVerifiedSecret } = await import('../SecretPrompt.js');
                    const verify = async (secret) => {
                        try {
                            const r = await fetch('api/llm/access-key/verify', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ secret }),
                            });
                            return r.ok;
                        } catch { return false; }
                    };
                    const secret = await getVerifiedSecret(verify, {
                        title: `Delete ${skillName}`,
                        body: 'Enter the noted access key to delete this skill and its paired tool.',
                        confirmLabel: 'Delete',
                    });
                    if (!secret) return;
                    delBtn.disabled = true;
                    delBtn.textContent = 'Deleting…';
                    try {
                        const r = await fetch(`api/llm/user-tool/${encodeURIComponent(skillName)}/delete`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ secret }),
                        });
                        const data = await r.json().catch(() => ({}));
                        if (!r.ok) {
                            alert(`Delete failed: HTTP ${r.status} ${data.detail || ''}`);
                            delBtn.disabled = false;
                            delBtn.innerHTML = '<i class="fa-solid fa-trash" style="margin-right:4px"></i>Delete skill + paired tool';
                            return;
                        }
                        // Refresh the skills + tools trees + clear detail.
                        this._mcpToolsCache = null;
                        if (this._tree) {
                            this._tree.visit((n) => {
                                const k = n.key || '';
                                if (/^asst-domain:[^:]+:(skills|tools)$/.test(k) && typeof n.load === 'function') {
                                    n.load(true);
                                }
                            });
                        }
                        this._detailEl.innerHTML = `<div style="padding:14px;color:#555;font-size:13px">` +
                            `Deleted <code>${skillName}</code> via workflow <code>${data.workflow_id}</code>.</div>`;
                    } catch (e) {
                        alert(`Delete error: ${e.message}`);
                        delBtn.disabled = false;
                        delBtn.innerHTML = '<i class="fa-solid fa-trash" style="margin-right:4px"></i>Delete skill + paired tool';
                    }
                });
                actionsRow.appendChild(delBtn);
                this._detailEl.appendChild(actionsRow);
            }

            // Content
            if (data.content) {
                const pre = document.createElement('pre');
                pre.style.cssText = 'padding:8px 12px;font-size:11px;white-space:pre-wrap;word-wrap:break-word;border-top:1px solid #eee;margin-top:8px;line-height:1.5;color:#333';
                pre.textContent = data.content;
                this._detailEl.appendChild(pre);
            }
        } catch (e) {
            const err = document.createElement('div');
            err.style.cssText = 'padding:12px;color:#c62828;font-size:12px';
            err.textContent = `Failed to load skill: ${e.message}`;
            this._detailEl.appendChild(err);
        }
    }

    _showSkillRefDetail(key) {
        // Placeholder for reference file detail
        this._detailEl.innerHTML = '';
        const refPath = key.substring(9); // strip 'skillref:'
        const header = createDetailHeader(refPath.split('/').pop(), 'fa-solid fa-file-lines');
        this._detailEl.appendChild(header);
    }

    // ────────────────────────────────────────────────────────────────────
    // Assistant > Tools (MCP)
    // ────────────────────────────────────────────────────────────────────

    /** Per-Domain MCP tools loader. The /api/llm/mcp-tools endpoint does
     *  not yet emit a `domain_id` field for tools, so the per-Domain
     *  branch currently shows the FULL tool surface for every Domain.
     *  When the backend adds a tool->Domain binding (mirroring skills),
     *  swap the unconditional `true` filter below for `t.domain_id === domainId`. */
    async _loadToolsTree(domainId = null) {
        try {
            const data = await this._fetchMcpTools();
            const tools = (data.tools || []).filter(t => domainId ? (t.domain_id ? t.domain_id === domainId : true) : true);
            if (!tools.length) {
                return [{ title: 'No tools available', key: `asst-domain:${domainId}:tools:empty`, icon: 'fa-solid fa-info-circle' }];
            }
            // Read tier first (alphabetical), then write tier (alphabetical).
            // Mirrors the conceptual hierarchy: read is safe-by-default, write
            // is the privileged subset. User-authored tools sort alongside
            // native ones — provenance is a badge, not an ordering axis.
            tools.sort((a, b) => {
                const aRead = a.tier !== 'write';
                const bRead = b.tier !== 'write';
                if (aRead !== bRead) return aRead ? -1 : 1;
                return (a.name || '').localeCompare(b.name || '');
            });
            // Sync lookup map for _onTreeRender. Wunderbaum's `data` field
            // wasn't reaching the render hook reliably (lazy-load path);
            // a side map keyed by the same key the renderer sees is robust.
            this._userAuthoredKeys = this._userAuthoredKeys || new Set();
            for (const t of tools) {
                if (t.provenance === 'user') {
                    this._userAuthoredKeys.add(`mcptool:${t.tier}:${t.name}`);
                }
            }
            // Tree node key shape: mcptool:<tier>:<name>
            return tools.map(t => {
                const isUser = t.provenance === 'user';
                // F6.1: pill is injected post-render via _onTreeRender (Wunderbaum
                // escapes title strings, so HTML in title literally renders as text).
                const provTip = isUser ? ' [self-authored]' : '';
                return {
                    title: t.name,
                    key: `mcptool:${t.tier}:${t.name}`,
                    icon: 'fa-solid fa-wrench',
                    tooltip: `${t.tier === 'write' ? 'WRITE' : 'READ'}${provTip} - ${t.description || ''}`,
                };
            });
        } catch (e) {
            return [{ title: `Error: ${e.message}`, key: 'mcptool-error', icon: 'fa-solid fa-exclamation-triangle' }];
        }
    }

    async _fetchMcpTools(force = false) {
        if (!force && this._mcpToolsCache) return this._mcpToolsCache;
        const resp = await fetch('api/llm/mcp-tools');
        if (!resp.ok) throw new Error(`${resp.status}`);
        this._mcpToolsCache = await resp.json();
        return this._mcpToolsCache;
    }

    async _showToolDetail(toolName) {
        clearActionBar(this._detailRoot);
        this._detailEl.innerHTML = '';

        const title = document.createElement('div');
        title.style.cssText = 'font-weight:600;font-size:13px;padding:12px;color:#333;display:flex;align-items:center;gap:8px';
        title.innerHTML = `<i class="fa-solid fa-wrench" style="color:#1976d2"></i><span>${toolName}</span>`;
        this._detailEl.appendChild(title);

        const container = document.createElement('div');
        container.style.cssText = 'padding:0 12px';
        container.innerHTML = '<div class="s3-object-card"><div class="s3-object-loading">Fetching tool details...</div></div>';
        this._detailEl.appendChild(container);

        let tool;
        try {
            const data = await this._fetchMcpTools();
            tool = (data.tools || []).find(t => t.name === toolName);
        } catch (e) {
            container.innerHTML = `<div class="s3-object-card"><div class="s3-object-loading" style="color:#c00">Failed to load tools: ${e.message}</div></div>`;
            return;
        }
        if (!tool) {
            container.innerHTML = `<div class="s3-object-card"><div class="s3-object-loading">Tool '${toolName}' not found.</div></div>`;
            return;
        }

        container.innerHTML = '';

        // ── Tier badge + description ──
        const headerCard = document.createElement('div');
        headerCard.className = 's3-object-card';
        headerCard.style.marginBottom = '12px';
        const tierColor = tool.tier === 'write' ? '#ff9800' : '#4caf50';
        const tierLabel = tool.tier === 'write' ? 'WRITE' : 'READ';
        const tierTooltip = tool.tier === 'write'
            ? 'Modifies project state. When invoked from inside noted, the user is shown a confirmation dialog before execution.'
            : 'Read-only. Auto-executed when the assistant invokes it.';
        const headerRow = document.createElement('div');
        headerRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #eee;font-weight:600;color:#333';
        const isUser = tool.provenance === 'user';
        const provBadge = isUser
            ? `<span title="Self-authored via the workflow framework" style="display:inline-block;font-family:var(--font-mono,monospace);font-weight:700;font-size:10px;color:#fff;background:#7e57c2;padding:2px 8px;border-radius:3px">USER</span>`
            : '';
        headerRow.innerHTML =
            `<span title="${tierTooltip}" style="display:inline-block;font-family:var(--font-mono,monospace);font-weight:700;font-size:10px;color:#fff;background:${tierColor};padding:2px 8px;border-radius:3px">${tierLabel}</span>` +
            provBadge +
            `<span style="font-family:var(--font-mono,monospace);color:#1a7f9b">${tool.name}</span>`;
        headerCard.appendChild(headerRow);
        if (tool.description) {
            const descRow = document.createElement('div');
            descRow.style.cssText = 'padding:10px 12px;font-size:12px;color:#555;line-height:1.5';
            descRow.textContent = tool.description;
            headerCard.appendChild(descRow);
        }
        container.appendChild(headerCard);

        // ── Delete affordance for user-authored tools (gated on the same
        //     access key as the Terminal). Reuses the SecretPrompt module
        //     so the UX is identical to opening a shell. The endpoint
        //     internally runs the remove_tool workflow, archiving both
        //     the tool dir and the paired skill folder. ──
        if (isUser) {
            const actionsRow = document.createElement('div');
            actionsRow.style.cssText = 'padding:8px 12px;border-bottom:1px solid #eee;display:flex;justify-content:flex-end;gap:8px';
            const delBtn = document.createElement('button');
            delBtn.style.cssText = 'padding:5px 12px;border:1px solid #d28a8a;background:#fff;color:#8a3838;border-radius:4px;font-size:12px;cursor:pointer';
            delBtn.innerHTML = '<i class="fa-solid fa-trash" style="margin-right:4px"></i>Delete';
            delBtn.title = 'Archive this tool and its paired skill (requires access key)';
            delBtn.addEventListener('click', async () => {
                const confirmed = confirm(
                    `Delete tool "${tool.name}"?\n\n` +
                    `Both the tool and its paired skill will be archived under _archive/. ` +
                    `You'll be asked for the noted access key.`
                );
                if (!confirmed) return;
                const { getVerifiedSecret } = await import('../SecretPrompt.js');
                const verify = async (secret) => {
                    try {
                        const r = await fetch('api/llm/access-key/verify', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ secret }),
                        });
                        return r.ok;
                    } catch { return false; }
                };
                const secret = await getVerifiedSecret(verify, {
                    title: `Delete ${tool.name}`,
                    body: 'Enter the noted access key to delete this user-authored tool and its paired skill.',
                    confirmLabel: 'Delete',
                });
                if (!secret) return;
                delBtn.disabled = true;
                delBtn.textContent = 'Deleting…';
                try {
                    const r = await fetch(`api/llm/user-tool/${encodeURIComponent(tool.name)}/delete`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ secret }),
                    });
                    const data = await r.json().catch(() => ({}));
                    if (!r.ok) {
                        alert(`Delete failed: HTTP ${r.status} ${data.detail || ''}`);
                        delBtn.disabled = false;
                        delBtn.innerHTML = '<i class="fa-solid fa-trash" style="margin-right:4px"></i>Delete';
                        return;
                    }
                    // Refresh the tools tree + clear the detail pane.
                    this._mcpToolsCache = null;
                    if (this._tree) {
                        // Reload all asst-domain:*:tools branches so the
                        // deleted tool drops out regardless of which
                        // domain the user was inspecting it under.
                        this._tree.visit((n) => {
                            const k = n.key || '';
                            if (/^asst-domain:[^:]+:tools$/.test(k) && typeof n.load === 'function') {
                                n.load(true);
                            }
                        });
                    }
                    this._detailEl.innerHTML = `<div style="padding:14px;color:#555;font-size:13px">` +
                        `Deleted <code>${tool.name}</code> via workflow <code>${data.workflow_id}</code>.</div>`;
                } catch (e) {
                    alert(`Delete error: ${e.message}`);
                    delBtn.disabled = false;
                    delBtn.innerHTML = '<i class="fa-solid fa-trash" style="margin-right:4px"></i>Delete';
                }
            });
            actionsRow.appendChild(delBtn);
            headerCard.appendChild(actionsRow);
        }

        // ── F6.5: source-workflow click-through (user-authored tools only) ──
        const meta = tool._meta || {};
        const srcWf = meta.source_workflow || null;
        if (isUser && srcWf && srcWf.workflow_id) {
            const provCard = document.createElement('div');
            provCard.className = 's3-object-card';
            provCard.style.marginBottom = '12px';
            const provHeader = document.createElement('div');
            provHeader.style.cssText = 'padding:10px 12px;border-bottom:1px solid #eee;font-weight:600;color:#333;font-size:12px';
            provHeader.textContent = 'Provenance';
            provCard.appendChild(provHeader);
            const created = meta.created_at || '';
            const createdBy = meta.created_by || 'system';
            const version = meta.version != null ? meta.version : '?';
            const language = meta.language || '?';
            const wfId = String(srcWf.workflow_id);
            const wfType = String(srcWf.type || 'workflow');
            const linkId = `prov-wf-link-${wfId}`;
            const provBody = document.createElement('div');
            provBody.style.cssText = 'padding:10px 12px;font-size:12px;color:#555;line-height:1.7';
            provBody.innerHTML =
                `<div><span style="color:#888">Created by</span> <code>${this._escapeHtmlSafe(createdBy)}</code> ` +
                `<span style="color:#888">at</span> <code>${this._escapeHtmlSafe(created)}</code></div>` +
                `<div><span style="color:#888">Version</span> ${version} ` +
                `&middot; <span style="color:#888">Language</span> ${this._escapeHtmlSafe(language)}</div>` +
                `<div style="margin-top:6px"><span style="color:#888">Source workflow</span> ` +
                `<code>${this._escapeHtmlSafe(wfType)}</code> ` +
                `<a href="#" id="${linkId}" style="color:#1a7f9b;margin-left:8px">` +
                `<i class="fa-solid fa-diagram-project" style="margin-right:4px"></i>open in Workflow Monitor</a></div>`;
            provCard.appendChild(provBody);
            container.appendChild(provCard);
            // Click handler — open WorkflowMonitor and select this workflow.
            const link = provBody.querySelector(`#${linkId}`);
            if (link) {
                link.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    const app = this._ctx?.app || window.app;
                    if (app && typeof app.showWorkflowMonitor === 'function') {
                        app.showWorkflowMonitor(wfId);
                    }
                });
            }
        }

        // ── MCP server card (mirrors APIs "Serving" status card) ──
        const serverCard = document.createElement('div');
        serverCard.className = 's3-object-card';
        serverCard.style.marginBottom = '12px';
        const serverHeader = document.createElement('div');
        serverHeader.style.cssText = 'padding:10px 12px;border-bottom:1px solid #eee;font-weight:600;color:#333;font-size:12px';
        serverHeader.textContent = 'MCP Server';
        serverCard.appendChild(serverHeader);
        const addRow = (parent, k, v) => {
            const row = document.createElement('div');
            row.className = 's3-meta-row';
            row.innerHTML = `<span class="s3-meta-label">${k}</span><span class="s3-meta-value">${v}</span>`;
            parent.appendChild(row);
        };
        const mcpUrl = `${window.location.origin}/mcp`;
        addRow(serverCard, 'Endpoint', `<span class="mono">${mcpUrl}</span>`);
        addRow(serverCard, 'Transport', 'Streamable HTTP (MCP)');
        addRow(serverCard, 'Method', `<span class="mono">tools/call</span> (JSON-RPC 2.0)`);
        const note = document.createElement('div');
        note.style.cssText = 'padding:8px 12px;font-size:11px;color:#888;line-height:1.5;border-top:1px solid #f0f0f0';
        note.innerHTML = 'An MCP <span class="mono">initialize</span> handshake is required before <span class="mono">tools/call</span>. Standard MCP client libraries (Python <span class="mono">mcp</span> SDK, TypeScript <span class="mono">@modelcontextprotocol/sdk</span>, Claude Desktop, etc.) handle this for you.';
        serverCard.appendChild(note);
        container.appendChild(serverCard);

        // ── Parameters table ──
        const inputSchema = tool.input_schema || {};
        const properties = inputSchema.properties || {};
        const required = new Set(inputSchema.required || []);
        const propNames = Object.keys(properties);
        if (propNames.length > 0) {
            const paramsCard = document.createElement('div');
            paramsCard.className = 's3-object-card';
            paramsCard.style.marginBottom = '12px';
            const paramsHeader = document.createElement('div');
            paramsHeader.style.cssText = 'padding:10px 12px;border-bottom:1px solid #eee;font-weight:600;color:#333;font-size:12px';
            paramsHeader.textContent = `Parameters (${propNames.length})`;
            paramsCard.appendChild(paramsHeader);
            const table = document.createElement('table');
            table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px';
            table.innerHTML =
                '<thead><tr style="background:#fafafa;color:#555;text-align:left">' +
                '<th style="padding:6px 12px;font-weight:600;font-size:11px;border-bottom:1px solid #eee">Name</th>' +
                '<th style="padding:6px 12px;font-weight:600;font-size:11px;border-bottom:1px solid #eee">Type</th>' +
                '<th style="padding:6px 12px;font-weight:600;font-size:11px;border-bottom:1px solid #eee">Required</th>' +
                '<th style="padding:6px 12px;font-weight:600;font-size:11px;border-bottom:1px solid #eee">Description</th>' +
                '</tr></thead>';
            const tbody = document.createElement('tbody');
            for (const pn of propNames) {
                const p = properties[pn] || {};
                const tr = document.createElement('tr');
                const typeStr = Array.isArray(p.type) ? p.type.join(' | ') : (p.type || 'any');
                const reqMark = required.has(pn)
                    ? '<span style="color:#c62828;font-weight:600">required</span>'
                    : '<span style="color:#888">optional</span>';
                tr.innerHTML =
                    `<td style="padding:6px 12px;border-bottom:1px solid #f5f5f5;font-family:var(--font-mono,monospace);color:#1a7f9b">${pn}</td>` +
                    `<td style="padding:6px 12px;border-bottom:1px solid #f5f5f5;font-family:var(--font-mono,monospace);color:#666">${typeStr}</td>` +
                    `<td style="padding:6px 12px;border-bottom:1px solid #f5f5f5">${reqMark}</td>` +
                    `<td style="padding:6px 12px;border-bottom:1px solid #f5f5f5;color:#555">${p.description || ''}</td>`;
                tbody.appendChild(tr);
            }
            table.appendChild(tbody);
            paramsCard.appendChild(table);
            container.appendChild(paramsCard);
        }

        // ── Code-block helper (hljs-highlighted, with Copy button) ──
        const addCodeBlock = (blockTitle, language, code) => {
            const card = document.createElement('div');
            card.className = 's3-object-card';
            card.style.marginBottom = '12px';
            const header = document.createElement('div');
            header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #eee;font-weight:600;color:#333;font-size:12px';
            const copyBtn = document.createElement('button');
            copyBtn.textContent = 'Copy';
            copyBtn.style.cssText = 'font-size:10px;padding:2px 10px;border:1px solid #ccc;border-radius:3px;background:#fff;cursor:pointer;color:#555';
            copyBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(code).then(() => {
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
                });
            });
            const titleSpan = document.createElement('span');
            titleSpan.textContent = blockTitle;
            header.appendChild(titleSpan);
            header.appendChild(copyBtn);
            card.appendChild(header);
            const pre = document.createElement('pre');
            pre.style.cssText = 'margin:0;padding:12px;font-size:11px;font-family:var(--font-mono,monospace);color:#333;overflow-x:auto;white-space:pre';
            const codeEl = document.createElement('code');
            codeEl.className = `language-${language}`;
            codeEl.textContent = code;
            pre.appendChild(codeEl);
            card.appendChild(pre);
            container.appendChild(card);
            if (typeof hljs !== 'undefined') {
                try { delete codeEl.dataset.highlighted; hljs.highlightElement(codeEl); } catch {}
            }
        };

        // ── Input Schema (raw JSON Schema) ──
        addCodeBlock('Input Schema (JSON Schema)', 'json', JSON.stringify(inputSchema, null, 2));

        // ── Example tools/call body ──
        // Build a placeholder value for each property based on its JSON Schema.
        const placeholder = (p, name) => {
            if (p.default !== undefined) return p.default;
            if (p.enum && p.enum.length) return p.enum[0];
            const t = Array.isArray(p.type) ? p.type[0] : p.type;
            switch (t) {
                case 'string':  return `<${name}>`;
                case 'integer': return 0;
                case 'number':  return 0;
                case 'boolean': return false;
                case 'array':   return [];
                case 'object':  return {};
                default:        return null;
            }
        };
        const exampleArgs = {};
        for (const name of propNames) {
            const p = properties[name] || {};
            // Always include required params; include up to 3 optional params for context.
            if (required.has(name) || Object.keys(exampleArgs).length < 3) {
                exampleArgs[name] = placeholder(p, name);
            }
        }
        const exampleBody = {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: tool.name, arguments: exampleArgs },
        };
        addCodeBlock('Example tools/call request body', 'json', JSON.stringify(exampleBody, null, 2));
    }
}
