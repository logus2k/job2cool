import { KernelClient } from './KernelClient.js';
import { NotebookEditor } from './NotebookEditor.js';
import { NotebookToolbar } from './NotebookToolbar.js';
import { InfoBar } from './InfoBar.js';
import { IconBar } from './IconBar.js';
import { SidebarPanel } from './SidebarPanel.js';
import { ExplorerPanel } from './panels/ExplorerPanel.js';
import { DisplaySettingsPanel } from './panels/DisplaySettingsPanel.js';
import { NotebookResizer } from './NotebookResizer.js';
import { ChatPanel } from './ChatPanel.js';
import { ChatService } from './ChatService.js';
import { RightPanel } from './RightPanel.js';
import { TabBar } from './TabBar.js';
import { TocPanel } from './TocPanel.js';
import { DocumentViewer } from './panels/DocumentViewer.js';
import { FileEditor, setOnAskAssistant } from './FileEditor.js';
import { DocPanel } from './DocPanel.js';
import { MediaViewer } from './MediaViewer.js';
import { isMediaViewable, mediaType } from './file-icons.js';
import { notify } from './Notify.js';
import { modalForm, modalAlert } from './modal.js';
import { domainState } from './domain-state.js';
import { GitPanel } from './GitPanel.js';
import { RunManagerPanel } from './RunManagerPanel.js';
import { GitCommitViewer } from './GitCommitViewer.js';
import { DecorationService } from './services/DecorationService.js';
import { MenuBar } from './MenuBar.js';
import { ExportPanel } from './ExportPanel.js';
import { openProjectTerminal } from './ProjectTerminal.js';
import { MetricsPanel } from './MetricsPanel.js';
import { restoreWallpaper } from './wallpapers.js';
import { initStatusBar } from './app-status-bar.js';
import { initMenuCommands } from './app-menu.js';
import { initChat } from './app-chat.js';
import { initFileEditors } from './app-file-editors.js';
import { initNotebooks } from './app-notebooks.js';
import { initTabs } from './app-tabs.js';


/**
 * App - Entry point. Wires together all components.
 */
class App {
    constructor() {
        this._client = new KernelClient();
        initStatusBar(this);
        initMenuCommands(this);
        initChat(this);
        initFileEditors(this);
        initNotebooks(this);
        initTabs(this);
        /** @type {Map<string, {editor: NotebookEditor, container: HTMLElement, project: string, notebook: string, venv: object|null}>} */
        this._editors = new Map();
        this._activeEditorKey = null;
        this._lastContentKey = null; // last notebook/pyfile key; survives undocking
        this._toolbar = null;
        this._infoBar = null;
        this._iconBar = null;
        this._sidebar = null;
        this._explorerPanel = null;
        this._displaySettingsPanel = null;
        this._currentProject = null;
        this._currentNotebook = null;
        this._activeVenv = null; // { name, runtimeId, displayName } or null
        this._userName = this._generateUserName();
        this._kernelRunning = false;
        this._kernelStarting = false;
        this._chatVisible = false;
        this._documentViewer = null;
        /** @type {Map<string, object>} keyed by tab key "doc:category:name" → doc object */
        this._documentTabs = new Map();
        /** @type {Map<string, DocumentViewer>} keyed by tab key "doc:category:name".
         *  One DocumentViewer instance per open doc tab so each preserves its own
         *  scroll position + rendered PDF state across tab switches. The
         *  singleton _documentViewer above stays for shared markdown-rendering
         *  helpers used by md preview tabs and other non-doc-tab callers. */
        this._documentViewers = new Map();
        /** @type {Map<string, boolean>} per-tab edit-mode flag for buffer doc tabs.
         *  `true` while the user is editing the raw markdown source via the
         *  Edit toggle in the second top bar. Skips SSE updates that would
         *  otherwise clobber the textarea content. */
        this._documentEditMode = new Map();
        /** @type {Map<string, FileEditor>} keyed by tab key "pyfile:{projectId}:{filename}" */
        this._fileEditors = new Map();
        /** @type {Map<string, MediaViewer>} keyed by tab key "media:{projectId}:{filename}" */
        this._mediaViewers = new Map();
        /** @type {Map<string, {element:HTMLElement, title:string, render:function}>} keyed by tab key "detail:..." */
        this._detailTabs = new Map();
        this._gitPanel = null;
        this._decorationService = null;
    }

    /** Active notebook editor (null if no notebooks open) */
    get _editor() {
        const entry = this._editors.get(this._activeEditorKey);
        return entry ? entry.editor : null;
    }

    async init() {
        // Restore wallpaper from localStorage before anything renders
        restoreWallpaper();

        // P3.3: prime the active-Domain cache once at boot. All Domain-aware fetches
        // (GraphPanel, ExplorerPanel, Domain Monitor, ...) read domainState
        // synchronously, so this needs to complete before those panels open.
        await domainState.bootstrap();

        // Make panels more opaque while dragging (default 0.8 → 0.95)
        jsPanel.defaults.dragit.opacity = 0.95;

        // Prevent wheel scroll from propagating through floating panels to content behind.
        // Also ensure panel content containers have proper overflow containment.
        const _origCreate = jsPanel.create.bind(jsPanel);
        jsPanel.create = function(options) {
            const origCallback = options.callback;
            options.callback = function(panel) {
                panel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: false });
                if (panel.content) {
                    panel.content.style.overscrollBehavior = 'contain';
                }
                if (origCallback) origCallback(panel);
            };
            return _origCreate(options);
        };

        // Initialize notebook resizer (restores saved width)
        this._notebookResizer = new NotebookResizer();

        // Initialize icon bar (left vertical strip)
        this._iconBar = new IconBar(
            document.getElementById('icon-bar'),
            {
                onIconClick: (key) => this._onIconBarClick(key),
            }
        );

        // Initialize sidebar panel (between icon bar and content area)
        this._sidebar = new SidebarPanel({
            onResize: () => this._tocPanel?.refresh(),
            onViewChange: () => this._syncIconBar(),
        });

        // Initialize unified explorer panel (projects + environments)
        this._workspaceTitleEl = null;
        this._workspaceBreadcrumbBar = null;
        this._explorerPanel = new ExplorerPanel({
            onNotebookPreview: (projectId, notebookName) => this._onNotebookChange(projectId, notebookName, { preview: true }),
            onNotebookSelect: (projectId, notebookName) => this._onNotebookChange(projectId, notebookName),
            onVenvSelect: (venv) => this._onVenvSelect(venv),
            onVenvDeleted: (deletedName) => this._onVenvDeleted(deletedName),
            onSectionChange: (section) => this._updateWorkspaceTitle(section),
            onBreadcrumbChange: (crumbs) => this._updateWorkspaceBreadcrumbs(crumbs),
            onActivate: () => this._openWorkspaceTab(),
            onClosePreview: () => this._tabBar.closePreview(),
            onCloseWorkspace: () => {
                this._tabBar.closePreview();
                this._tabBar.closeTab('workspace');
                const active = this._tabBar.activeKey;
                if (active?.startsWith('detail:')) {
                    this._tabBar.closeTab(active);
                }
            },
            onOpenKnowledgeGraph: () => this._openKnowledgeGraphTab(),
            onDocumentPreview: (doc) => this._openDocumentTab(doc, { preview: true }),
            onDocumentOpen: (doc) => this._openDocumentTab(doc),
            onSrcFilePreview: (projectId, filename, hostPath) => this._previewFileTab(projectId, filename, hostPath),
            onSrcFileSelect: (projectId, filename, hostPath) => this._openFileTab(projectId, filename, hostPath),
            onMediaFilePreview: (projectId, filename, hostPath) => this._previewMediaTab(projectId, filename, hostPath),
            onMediaFileSelect: (projectId, filename, hostPath) => this._openMediaTab(projectId, filename, hostPath),
            onProjectDefaultVenvChanged: (projectId, venv) => this._onProjectDefaultVenvChanged(projectId, venv),
            onProjectCreated: () => this._gitPanel?.refresh(),
            onProjectDeleted: () => this._gitPanel?.refresh(),
            onProjectRenamed: () => this._gitPanel?.refresh(),
            onNotebookDeleted: () => this._gitPanel?.refresh(),
            onNotebookRenamed: () => this._gitPanel?.refresh(),
            onMetricsView: (runId, runName, metricsMap) => this._metricsPanel?.loadHistory(runId, runName, metricsMap),
            onDetailTab: (tabKey, label, element, opts) => this._openDetailTab(tabKey, label, element, opts),
            onPinTab: (tabKey) => this._tabBar.pinTab(tabKey),
            getSocket: () => this._client.socket,
        });

        // Wire app reference into the explorer's shared ctx so context-menu
        // actions can call e.g. app.showKnowledgeBaseMonitor().
        if (this._explorerPanel._ctx) {
            this._explorerPanel._ctx.app = this;
        }

        // Register sidebar views — tree from ExplorerPanel
        this._sidebar.registerView('projects', {
            tabLabel: 'Explorer',
            title: 'Assets Management',
            element: this._explorerPanel.treeElement,
            titleElement: this._explorerPanel.titleElement,
        });

        // Git panel — sidebar view for per-project version control
        this._gitPanel = new GitPanel();
        this._gitCommitViewer = new GitCommitViewer();
        this._gitPanel.setOnCommitOpen((repoPath, commit) => this._openGitCommitTab(repoPath, commit));
        this._gitPanel.setOnFileDiscarded((filePaths) => this._reloadDiscardedFiles(filePaths));
        this._sidebar.registerView('git', {
            tabLabel: 'Version Control',
            title: 'Version Control',
            element: this._gitPanel.element,
            titleElement: this._gitPanel.titleElement,
            onActivate: () => this._gitPanel.activate(),
        });

        // TOC panel — lives inside the sidebar as a view
        this._tocPanel = new TocPanel(
            () => this._editor?.cells || [],
            (index) => this._editor?.selection.selectCell(index)
        );
        this._sidebar.registerView('toc', {
            tabLabel: 'Table of Contents',
            title: '',
            element: this._tocPanel.element,
            onActivate: () => this._tocPanel.activate(),
            onDeactivate: () => this._tocPanel.deactivate(),
        });

        // Settings panel - sidebar view
        this._displaySettingsPanel = new DisplaySettingsPanel();
        this._sidebar.registerView('settings', {
            tabLabel: 'Settings',
            title: 'Application Settings',
            element: this._displaySettingsPanel.element,
        });

        // Decoration service — git status dots in explorer tree
        this._decorationService = new DecorationService(() => {
            this._explorerPanel.repaintDecorations();
        });
        this._explorerPanel.setDecorationService(this._decorationService);
        this._gitPanel.setOnStatusRefreshed((repoPath, repoInfo, statusData) => {
            this._decorationService.updateRepoStatus(repoPath, repoInfo, statusData);
        });
        this._gitPanel.setOnDvcStatusRefreshed((repoPath, repoInfo, dvcData) => {
            this._decorationService.updateDvcStatus(repoPath, repoInfo, dvcData);
        });

        // Restore display toggles
        const toggleMap = {
            'show-cell-titles': 'hide-cell-titles',
            'show-cell-borders': 'hide-cell-borders',
            'show-cell-bg': 'hide-cell-bg',
            'show-code-cells': 'hide-code-cells',
            'show-line-numbers': 'hide-line-numbers',
            'show-output': 'hide-output',
            'show-table-stripes': 'hide-table-stripes',
            'show-add-cell-areas': 'hide-add-cell-areas',
            'show-bg-image': 'hide-bg-image',
            'show-bg-color': 'hide-bg-color',
        };
        for (const [key, cls] of Object.entries(toggleMap)) {
            if (localStorage.getItem(`notebook-${key}`) === '0') {
                document.body.classList.add(cls);
            }
        }

        // Forward wheel events from page margins (dead zones) to notebook container
        const notebookContainer = document.getElementById('notebook-container');
        document.addEventListener('wheel', (e) => {
            if (notebookContainer.contains(e.target)) return;
            // Don't forward if the target is inside a panel with its own scroll
            if (e.target.closest('#sidebar-panel, #right-panel, #toolbar, .service-iframe-wrapper')) return;
            notebookContainer.scrollBy(0, e.deltaY);
        }, { passive: true });

        // Notebook container (parent for all editor containers)
        this._notebookContainer = document.getElementById('notebook-container');

        // Initialize toolbar (nav icons + file actions + settings + users)
        this._toolbar = new NotebookToolbar(
            document.getElementById('toolbar'),
            this._client,
            {
                onSave: () => this._editor?.save(),
                onSettingsToggle: () => this._onIconBarClick('settings'),
                getCells: () => this._editor?.cells || [],
                onSelectCell: (index) => this._editor?.selection?.selectCell(index),
            }
        );

        // Hamburger menu button - absolutely positioned in the top-left
        // corner of #app, above the icon bar (the icon bar has margin-top:56px
        // which leaves a ~48x56 empty area we can use).
        const menuBtn = document.createElement('button');
        menuBtn.className = 'icon-bar-menu';
        menuBtn.innerHTML = '<i class="fa-solid fa-bars"></i>';
        menuBtn.title = 'Menu';
        menuBtn.addEventListener('click', () => this._onIconBarClick('menu'));
        document.getElementById('app').appendChild(menuBtn);

        // Initialize menu bar
        this._menuBar = new MenuBar('#menubar');
        this._menuBar.load('static/menu.json').then(() => {
            this._registerMenuCommands();
        });

        // Initialize info bar (decorative)
        this._infoBar = new InfoBar(document.getElementById('info-bar'));

        // Initialize tab bar (above notebook, inside center-column)
        this._serviceIframes = {};
        this._undockedPanels = new Map(); // key -> jsPanel instance
        this._tabBar = new TabBar(
            document.getElementById('center-column'),
            {
                onActivateTab: (key) => this._onTabActivated(key),
                onCloseTab: (key) => this._onTabClosed(key),
                onUndockTab: (key) => this._onUndockTab(key),
                onDockTab: (key) => this._onDockTab(key),
            }
        );

        // Note: editor callbacks are wired in _wireEditorCallbacks(), called per editor

        // Run Manager
        this._runManager = new RunManagerPanel({
            getCells: () => this._editor?._cells || [],
            getMetadata: () => this._editor?.getNotebookMetadata() || {},
            onSave: () => { this._editor?.refreshRunBadges(); this._editor?.save(); },
            onExecuteRun: (runId, runName, cells, datasets) => {
                if (!this._editor) return;
                const hydraConfig = this._editor.hydraConfig;
                this._client.executeRun(cells, runName, datasets, this._editor.notebookKey, hydraConfig);
            },
            onActiveRunChange: (runId) => {
                this._editor?.setRunManagerActiveRun(runId);
            },
            getDvcFiles: async () => {
                const pid = this._currentProject;
                if (!pid) return [];
                try {
                    const resp = await fetch('api/dvc/status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ project_id: pid })
                    });
                    if (!resp.ok) return [];
                    const data = await resp.json();
                    return data.tracked_files || [];
                } catch { return []; }
            },
            getHydraDataFile: async () => {
                // Returns { file, hash } when the current notebook has a
                // Hydra config and its cfg.data.file resolves to a DVC
                // tracked path. Otherwise returns null.
                // Used by the Run Manager to render a read-only "Data:
                // <file> (from Hydra config)" line instead of the multi-
                // select picker, so the two UIs cannot disagree about
                // which data the run consumed.
                const pid = this._currentProject;
                if (!pid) return null;
                const meta = this._editor?.getNotebookMetadata() || {};
                const noted = meta.noted || {};
                const selections = noted.hydra_selections || null;
                if (!selections) return null;
                try {
                    const resp = await fetch('api/hydra/compose', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            project_id: pid,
                            overrides: selections.overrides || null,
                            group_selections: selections.group_selections || null,
                        }),
                    });
                    if (!resp.ok) return null;
                    const composed = await resp.json();
                    const dataFile = composed?.resolved?.data?.file || null;
                    if (!dataFile) return null;
                    // Look up the DVC hash for this file
                    try {
                        const dvcResp = await fetch('api/dvc/status', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ project_id: pid }),
                        });
                        if (dvcResp.ok) {
                            const dvc = await dvcResp.json();
                            const tracked = dvc.tracked_files || [];
                            const match = tracked.find(f => f.path === dataFile);
                            if (match) return { file: dataFile, hash: match.hash, tracked: true };
                        }
                    } catch {}
                    return { file: dataFile, hash: null, tracked: false };
                } catch {
                    return null;
                }
            },
        });
        // Run manager wiring is done per-editor in _wireEditorCallbacks()

        // Live metrics panel
        this._metricsPanel = new MetricsPanel();
        this._client.on('metrics:update', (data) => {
            const activeKey = this._activeEditorKey;
            if (activeKey && (!data.notebook_key || data.notebook_key === activeKey)) {
                this._metricsPanel.onMetricUpdate(data.metric);
                // Store run_id in notebook metadata for recovery after refresh
                if (data.metric?.run_id) {
                    const entry = this._editors.get(activeKey);
                    if (entry?.editor?._notebook) {
                        if (!entry.editor._notebook.metadata) entry.editor._notebook.metadata = {};
                        if (!entry.editor._notebook.metadata.noted) entry.editor._notebook.metadata.noted = {};
                        entry.editor._notebook.metadata.noted.last_run_id = data.metric.run_id;
                    }
                    // Update active run indicator in notebook bar
                    if (entry?.editor) {
                        entry.editor.updateRunIndicator(data.metric.run_id, data.metric.run_name || data.metric.run_id?.substring(0, 8));
                    }
                }
            }
        });

        // Pipeline status updates
        this._client.on('pipeline:status', (data) => {
            if (!data?.dag_id || !data?.dag_run_id) return;
            const nodeKey = `dagrun:${data.dag_id}:${data.dag_run_id}`;
            const node = this._explorerPanel?._tree?.findKey(nodeKey);
            if (node) {
                const stateIcons = {
                    success: 'fa-solid fa-circle-check',
                    running: 'fa-solid fa-circle-play',
                    failed: 'fa-solid fa-circle-xmark',
                    queued: 'fa-solid fa-clock',
                    skipped: 'fa-solid fa-forward',
                };
                node.icon = stateIcons[data.state] || 'fa-solid fa-circle-question';
                // Update title with new state
                const title = node.title || '';
                const dash = title.indexOf(' - ');
                if (dash >= 0) {
                    node.title = title.substring(0, dash) + ' - ' + data.state;
                }
                node.update();
                // Refresh task children on terminal states
                if (['success', 'failed', 'skipped', 'upstream_failed'].includes(data.state)) {
                    if (node.isExpanded() || node.children?.length) {
                        node.resetLazy();
                        if (node.isExpanded()) node.setExpanded(true);
                    }
                }
                // Show toast on terminal states
                if (data.state === 'success') {
                    notify.success(`Pipeline ${data.dag_id} completed`);
                } else if (data.state === 'failed') {
                    notify.error(`Pipeline ${data.dag_id} failed`);
                }
            }
        });

        this._client.on('pipeline:task_status', (data) => {
            if (!data?.dag_id || !data?.dag_run_id || !data?.task_id) return;
            const runKey = `dagrun:${data.dag_id}:${data.dag_run_id}`;
            const runNode = this._explorerPanel?._tree?.findKey(runKey);
            if (runNode?.children) {
                const taskNode = runNode.children.find(c => c.key === `dagtask:${data.dag_id}:${data.dag_run_id}:${data.task_id}`);
                if (taskNode) {
                    const stateIcons = {
                        success: 'fa-solid fa-circle-check',
                        running: 'fa-solid fa-circle-play',
                        failed: 'fa-solid fa-circle-xmark',
                        queued: 'fa-solid fa-clock',
                        skipped: 'fa-solid fa-forward',
                    };
                    taskNode.icon = stateIcons[data.state] || 'fa-solid fa-circle-question';
                    // Update title with state and timing
                    const start = data.start_date ? new Date(data.start_date).toLocaleTimeString() : '';
                    const dur = data.duration != null ? ` (${data.duration.toFixed(1)}s)` : '';
                    taskNode.title = `${data.task_id} (${data.state})${start ? ' - ' + start : ''}${dur}`;
                    taskNode.update();
                }
            }
            // Update DAG graph visualization in real-time
            this._explorerPanel?._externalViews?.updateGraphTaskState?.(
                data.dag_id, data.dag_run_id, data.task_id, data.state
            );
        });

        // Export panel
        this._exportPanel = new ExportPanel({
            onExport: async (format, options) => {
                if (!this._currentProject || !this._currentNotebook) {
                    notify.warning('No notebook open');
                    return;
                }
                this._exportPanel.setStatus('Exporting...');
                try {
                    const resp = await fetch(`api/export/${format}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            project_id: this._currentProject,
                            notebook_path: this._currentNotebook,
                            ...options,
                        }),
                    });
                    if (!resp.ok) {
                        const err = await resp.json().catch(() => ({ detail: 'Export failed' }));
                        throw new Error(err.detail || 'Export failed');
                    }
                    const blob = await resp.blob();
                    const disposition = resp.headers.get('Content-Disposition') || '';
                    const match = disposition.match(/filename="?(.+?)"?$/);
                    const filename = match ? match[1] : `export.${format === 'word' ? 'docx' : format}`;
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    a.click();
                    URL.revokeObjectURL(url);
                    this._exportPanel.setStatus('Done!');
                    setTimeout(() => this._exportPanel.setStatus(''), 3000);
                } catch (e) {
                    this._exportPanel.setStatus('');
                    notify.error(e.message);
                }
            },
        });

        // Run execution events
        this._client.on('run:started', (data) => {
            notify.success(`Run "${data.run_name}" started`);
        });
        this._client.on('run:complete', (data) => {
            if (data.errored) {
                notify.error(`Run "${data.run_name}" stopped with errors`);
            } else {
                // Build summary with latest metric values from live metrics panel
                const traces = this._metricsPanel?._traces || {};
                const metricParts = Object.entries(traces).map(([key, t]) => {
                    const last = t.y?.length ? t.y[t.y.length - 1] : null;
                    if (last == null) return null;
                    const val = typeof last === 'number' ? (Number.isInteger(last) ? last : last.toFixed(4)) : last;
                    return `${key}: ${val}`;
                }).filter(Boolean).slice(0, 5);
                const summary = metricParts.length ? `\n${metricParts.join(' | ')}` : '';
                notify.success(`Run "${data.run_name}" completed${summary}`);
            }
            this._runManager.refresh();
        });

        // Listen for cell insertion requests (e.g., from Model Registry "Insert Predict Cell")
        document.addEventListener('noted:insert-cell', (e) => {
            const editor = this._editor;
            if (!editor) return;
            const code = e.detail?.code || '';
            const idx = editor._cells?.length || 0;
            editor._addCell(idx, 'code');
            const cell = editor._cells[idx];
            if (cell) cell.setSource(code);
        });

        // Initialize document viewer (for MD/PDF rendering in center pane)
        this._documentViewer = new DocumentViewer();

        // Initialize right panel (chat assistant)
        this._initRightPanel();

        // Track kernel running state
        this._client.on('kernel:status', (data) => {
            this._kernelRunning = data.status === 'idle' || data.status === 'busy';
            this._kernelStarting = data.status === 'starting';
            this._explorerPanel.setKernelRunning(this._kernelRunning);
        });

        // Connect Socket.IO
        this._client.connect();
        this._gitPanel.setSocket(this._client.socket);

        this._initialConnect = true;
        this._client.on('connected', () => {
            // Expose socket globally for debug panel events
            window._notedSocket = this._client._socket;
            if (this._initialConnect) {
                this._initialConnect = false;
                console.log('Connected to server');
                return;
            }
            console.log('Reconnected to server');
            // Re-open all notebooks that were open before disconnect
            for (const [key, entry] of this._editors) {
                entry.editor.openNotebook(entry.project, entry.notebook, this._userName);
                if (entry.venv) {
                    this._client.startKernel(entry.venv.runtimeId, entry.venv.name, entry.editor.notebookKey);
                }
            }
        });

        this._client.on('disconnected', (data) => {
            console.log('Disconnected:', data.reason);
        });

        this._client.on('error', (data) => {
            console.error('Server error:', data.message, data.code);
        });

        // PDF doc tab keyboard navigation: PageUp / PageDown step exactly
        // one PDF page (rather than the browser's default which scrolls
        // by the wrapper's clientHeight — not aligned to page boundaries
        // when zoom is below fit-height). Runs only when a PDF doc tab
        // is the active tab and no input/textarea/contenteditable has
        // focus, so it doesn't steal keys from form fields.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'PageUp' && e.key !== 'PageDown') return;
            const target = e.target;
            const tag = target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
            const activeKey = this._tabBar?.activeKey;
            if (!activeKey || !activeKey.startsWith('doc:')) return;
            const viewer = this._documentViewers.get(activeKey);
            if (!viewer || !viewer._pdfState) return;
            e.preventDefault();
            e.stopPropagation();
            viewer.pageStep(e.key === 'PageDown' ? 1 : -1);
        }, true);

        // Keyboard shortcuts (capture phase so they fire before CodeMirror)
        // Only intercept for notebook tabs; file editors handle their own navigation.
        document.addEventListener('keydown', (e) => {
            const isNotebook = notebookContainer.style.display !== 'none';
            if (!isNotebook) return;
            if ((e.ctrlKey || e.metaKey) && e.key === 'Home') {
                e.preventDefault();
                e.stopPropagation();
                notebookContainer.scrollTo({ top: 0 });
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'End') {
                e.preventDefault();
                e.stopPropagation();
                notebookContainer.scrollTo({ top: notebookContainer.scrollHeight });
            }
            if (e.key === 'PageUp') {
                e.preventDefault();
                e.stopPropagation();
                notebookContainer.scrollBy(0, -notebookContainer.clientHeight);
            }
            if (e.key === 'PageDown') {
                e.preventDefault();
                e.stopPropagation();
                notebookContainer.scrollBy(0, notebookContainer.clientHeight);
            }
            // Ctrl/Cmd+G: open the "Go to cell" modal (same as clicking
            // the status-bar cell ordinal).
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
                e.preventDefault();
                e.stopPropagation();
                this._showGoToCellModal?.();
            }
            // Ctrl/Cmd+S: save the active note-taking buffer (NOTES-2).
            // First save opens Save-As; subsequent saves reuse the bound
            // path. Only fires when a buffer tab is active so it doesn't
            // intercept Ctrl+S in unrelated contexts.
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                const activeKey = this._tabBar?.activeKey;
                if (activeKey && activeKey.startsWith('doc:__buffer__:')) {
                    e.preventDefault();
                    e.stopPropagation();
                    this._saveBuffer?.(activeKey);
                }
            }
        }, true);

        // All sidebar panels closed by default
        requestAnimationFrame(() => {
            this._syncIconBar();
        });

        // Load workspace tree data, then fetch git decorations and health badges
        await this._explorerPanel.init();
        this._decorationService.refreshAll();

        // Check URL params for auto-open
        const params = new URLSearchParams(window.location.search);
        const projectId = params.get('project');
        const notebook = params.get('notebook');
        if (projectId) {
            await this._onProjectChange(projectId);
            if (notebook) {
                this._onNotebookChange(projectId, notebook);
            }
        }

        // Expand tree to the active notebook
        this._explorerPanel.navigate({
            currentProject: this._currentProject,
            currentNotebook: this._currentNotebook,
        });

        // Populate status bar with system info, then update project/branch
        await this._initStatusBar();
        this._updateStatusProject(this._currentProject);
        this._updateStatusBranch(this._currentProject);

        // Subscribe to backend doc/workflow event stream. Drives live
        // refresh of doc viewers while background workflows (research_topic
        // etc.) write into buffers via execute_tool — those writes have
        // no per-chat-turn SSE channel to fall back on. Connection is
        // resilient: closes are auto-retried with backoff.
        this._connectBufferEventStream();
    }

    /** Open / re-open the SSE stream that carries doc_changed and
     * workflow_event payloads from the backend. Routes doc_changed events
     * through `_handleDocBuffer` (the same handler the chat path uses for
     * its inline `doc` SSE events), so live updates from a background
     * workflow refresh the same viewer in the same way. */
    _connectBufferEventStream() {
        if (this._bufferEventSource) {
            try { this._bufferEventSource.close(); } catch {}
            this._bufferEventSource = null;
        }
        let backoffMs = 1000;
        const open = () => {
            const es = new EventSource('api/buffers/events/stream');
            this._bufferEventSource = es;
            es.onopen = () => { backoffMs = 1000; };
            es.onmessage = (ev) => {
                try {
                    const payload = JSON.parse(ev.data);
                    if (payload?.type === 'doc_changed' && payload.doc) {
                        this._handleDocBuffer(payload.doc);
                    } else if (payload?.type === 'workflow_event') {
                        // Workflow lifecycle (started / suspended /
                        // completed / aborted). Forwarded to the chat
                        // panel + workflow monitor if they listen.
                        if (this._chatPanel?.onWorkflowEvent) {
                            try { this._chatPanel.onWorkflowEvent(payload); } catch {}
                        }
                    }
                } catch (err) {
                    console.warn('[BufferEventStream] bad payload', err);
                }
            };
            es.onerror = () => {
                // EventSource auto-reconnects on transient errors, but
                // we also handle hard closes by manually reopening with
                // exponential backoff (capped at 30s) so a long backend
                // restart doesn't leave us stuck.
                if (es.readyState === EventSource.CLOSED) {
                    setTimeout(open, backoffMs);
                    backoffMs = Math.min(backoffMs * 2, 30000);
                }
            };
        };
        open();
    }

    // Status bar methods extracted to app-status-bar.js

    // Notebook lifecycle extracted to app-notebooks.js

    // Tab management extracted to app-tabs.js

    /**
     * Open the GraphRAG rebuild monitor panel. Read-only / monitoring only -
     * the rebuild itself is triggered separately (admin context menu, future).
     * Safe to call any time. Lazily imports the module to keep startup small.
     */
    async showKnowledgeBaseMonitor(domainId = null) {
        if (!this._kbMonitor) {
            const { KnowledgeBaseMonitorPanel } = await import('./knowledge-graph/KnowledgeBaseMonitorPanel.js');
            this._kbMonitor = new KnowledgeBaseMonitorPanel(this._client);
        }
        this._kbMonitor.open(domainId);
    }

    /**
     * Open the Workflow Monitor jsPanel inspector. Lists tenant-scoped
     * workflows (live + on-disk snapshots) with step-by-step state, audit
     * timeline, and resume / abort / rerun actions. Subscribes to the
     * workflow Socket.io events so the list refreshes live.
     */
    async showWorkflowMonitor() {
        if (!this._workflowMonitor) {
            const { WorkflowMonitorPanel } = await import('./WorkflowMonitorPanel.js');
            this._workflowMonitor = new WorkflowMonitorPanel(this._client);
        }
        this._workflowMonitor.open();
    }

    /** Open a chat artifact (image / file content) in a floating
     * jsPanel viewer. Triggered by double-clicking an image thumbnail
     * or file chip in the chat (user-uploaded OR assistant-rendered).
     *
     * Payload:
     *   image: { kind:'image', src: <url|dataUrl>, name }
     *   file:  { kind:'file',  text: <string>, name, charLimit?, truncated? }
     *
     * Reserves space in the panel header for a future Save action
     * (Backlog CHAT-2). Currently single Close button.
     */
    _openChatArtifact(payload) {
        if (!payload) return;
        const _esc = (s) => String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const _escHTML = (s) => String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const name = payload.name || (payload.kind === 'image' ? 'image' : 'file');
        let content = '';
        let panelOpts = {};
        let panelClass = '';
        let headerTitleHtml = _escHTML(name);  // Per-kind branches may prefix an icon.

        if (payload.kind === 'image') {
            // Image viewer: full-bleed <img>, contain-fit, dark
            // background. The data URL or external URL is set directly
            // as the src; the browser handles caching.
            content = `
                <div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:#1a1a1a;overflow:auto">
                    <img src="${_esc(payload.src || '')}" alt="${_esc(name)}"
                         style="max-width:100%;max-height:100%;object-fit:contain;display:block">
                </div>
            `;
            panelOpts = { width: 720, height: 560 };
        } else if (payload.kind === 'chart') {
            // ECharts viewer with the same Copy/Save overlay buttons used
            // by the inline chat chart (ChatPanel.renderInlineChart). The
            // frame reuses .chat-message-chart-frame with a --floating
            // modifier so the inline-specific border/margin/zoom-cursor
            // are dropped — actions overlay + hover styling are inherited.
            // Useful here because the panel is resizable: getDataURL() on
            // click captures whatever the user has currently sized to.
            // Header title gets a Font Awesome chart icon matching the
            // chart_type (pie, bar, line, etc) so the panel is visually
            // distinct in a docked stack.
            const _chartIcons = {
                pie: 'fa-chart-pie',
                bar: 'fa-chart-column',
                line: 'fa-chart-line',
                area: 'fa-chart-area',
                scatter: 'fa-braille',
                histogram: 'fa-chart-simple',
                box: 'fa-chart-simple',
                heatmap: 'fa-table-cells',
            };
            const _iconClass = _chartIcons[payload.chart_type] || 'fa-chart-simple';
            // headerTitle accepts HTML (per existing KB Monitor pattern); the
            // .jsPanel-title's flex layout (display:flex; align-items:center)
            // handles the icon + text alignment.
            headerTitleHtml = `<i class="fa-solid ${_iconClass}" style="margin-right:6px;color:#888"></i>${_escHTML(name)}`;
            const containerId = `_chart_artifact_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
            const _copyIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" fill="#ffe6bd"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
            const _saveIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
            const _checkIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22863a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
            const _xIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c62828" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
            content = `
                <div class="chat-message-chart-frame chat-message-chart-frame--floating">
                    <div id="${containerId}" class="chat-message-chart"></div>
                    <div class="chat-message-chart-actions">
                        <button type="button" class="chat-chart-action" data-action="copy" title="Copy Image">${_copyIcon}</button>
                        <button type="button" class="chat-chart-action" data-action="save" title="Save As Image">${_saveIcon}</button>
                    </div>
                </div>
            `;
            panelOpts = { width: 880, height: 600 };
            panelClass = 'chart-artifact-panel';
            // Defer init until the jsPanel mounts the content into the DOM.
            queueMicrotask(() => {
                const el = document.getElementById(containerId);
                if (!el || typeof echarts === 'undefined') return;
                try {
                    const c = echarts.init(el);
                    c.setOption(payload.option || {});
                    const ro = new ResizeObserver(() => { try { c.resize(); } catch {} });
                    ro.observe(el);

                    // Wire Copy/Save handlers — same logic as the inline
                    // chart, but reading from THIS chart instance so a
                    // resized panel produces a resized capture.
                    const frame = el.parentElement;
                    const copyBtn = frame.querySelector('[data-action="copy"]');
                    const saveBtn = frame.querySelector('[data-action="save"]');
                    const safeName = ((payload.name || 'chart') + '')
                        .replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'chart';
                    const flash = (btn, replacement, restoreTitle, ms = 1200) => {
                        const origHTML = btn.innerHTML;
                        const origTitle = btn.title;
                        btn.innerHTML = replacement;
                        if (restoreTitle) btn.title = restoreTitle;
                        setTimeout(() => { btn.innerHTML = origHTML; btn.title = origTitle; }, ms);
                    };
                    copyBtn.addEventListener('click', async (ev) => {
                        ev.stopPropagation();
                        try {
                            const dataUrl = c.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
                            const blob = await (await fetch(dataUrl)).blob();
                            if (!navigator.clipboard || !window.ClipboardItem) {
                                throw new Error('Clipboard image API unavailable (needs HTTPS or localhost)');
                            }
                            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                            flash(copyBtn, _checkIcon, 'Copied');
                        } catch (err) {
                            console.warn('[app] copy chart artifact failed', err);
                            flash(copyBtn, _xIcon, 'Copy failed — try Save', 1800);
                        }
                    });
                    saveBtn.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        try {
                            const dataUrl = c.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
                            const a = document.createElement('a');
                            a.href = dataUrl;
                            a.download = safeName + '.png';
                            document.body.appendChild(a);
                            a.click();
                            a.remove();
                            flash(saveBtn, _checkIcon, 'Saved');
                        } catch (err) {
                            console.warn('[app] save chart artifact failed', err);
                            flash(saveBtn, _xIcon, 'Save failed', 1800);
                        }
                    });
                } catch (e) {
                    console.warn('[app] chart artifact render failed', e);
                }
            });
        } else if (payload.kind === 'file') {
            const trimNote = payload.truncated
                ? `<div style="padding:6px 12px;background:#3a2e1a;color:#d4a836;font-size:12px;border-bottom:1px solid #444">Trimmed to ${(payload.charLimit || 0).toLocaleString()} chars when sent to model.</div>`
                : '';
            const safeText = String(payload.text || '')
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            content = `
                <div style="display:flex;flex-direction:column;width:100%;height:100%;background:#1e1e1e;color:#ddd">
                    ${trimNote}
                    <pre style="margin:0;padding:14px 18px;flex:1;overflow:auto;font-family:var(--mono-font,'JetBrains Mono',monospace);font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word">${safeText}</pre>
                </div>
            `;
            panelOpts = { width: 760, height: 580 };
        } else {
            console.warn('[app] _openChatArtifact: unsupported kind', payload.kind);
            return;
        }

        // jsPanel quirk: `dragit:true` / `resizeit:true` (booleans)
        // crash inside jsPanel when it tries to mutate them as
        // configuration objects (`Cannot create property 'start' on
        // boolean 'true'`). Passing empty objects gives jsPanel its
        // defaults without the type clash — drag and resize are then
        // both enabled and behave like the rest of noted's panels.
        jsPanel.create({
            headerTitle: headerTitleHtml,
            // panelSize sets the TOTAL panel dimensions (header + content);
            // contentSize would set just the content area, making the real
            // panel taller than expected — and `position: 'center'` would
            // push the header above the viewport on tighter heights, clipping
            // the title bar. With panelSize, jsPanel's flex layout splits
            // header/content within the fixed total height.
            panelSize: panelOpts,
            content,
            position: 'center',
            dragit: {},
            resizeit: {},
            // Close-only header — these are simple read-only viewers.
            // (Save / Copy live as in-chart hover buttons for charts;
            // images use the browser's native context menu.)
            headerControls: 'closeonly',
            border: '1px solid var(--border-color, #444)',
            borderRadius: '6px',
            theme: 'none',
            boxShadow: 4,
            // jsPanel's `panelclass` option doesn't reliably attach the
            // class in this version; use the post-create callback to add
            // it manually (same pattern as ExplorerEnvViews terminal-panel).
            // Needed for the .jsPanel.chart-artifact-panel scoped CSS to
            // suppress the inherited content scrollbar.
            // NOTE: must be a function (not an array) — the jsPanel.create
            // wrapper above (~line 113) calls callback as a function.
            callback: panelClass
                ? (panel) => { try { panel.classList.add(panelClass); } catch {} }
                : undefined,
            onclosed: [() => {
                document.querySelectorAll('.jsPanel-modal-backdrop').forEach((el) => el.remove());
                return true;
            }],
        });
    }

    /** Dispatcher for the LLM-driven `open_file` tool. Receives the
     * payload streamed by ChatService.onOpenFile and routes to the
     * matching tab opener — same as if the user had double-clicked the
     * file in the Explorer.
     *
     * Payload: { path, kind, project_id?, domain_id? }
     * `kind` ∈ {'notebook', 'source', 'document', 'media'} (resolved
     *  server-side from the file extension).
     */
    _handleAssistantOpenFile(payload) {
        if (!payload || !payload.path) {
            console.warn('[app] open_file: empty payload', payload);
            return;
        }
        const { path, kind, project_id, domain_id } = payload;
        const projId = project_id || this._currentProject || 'Examples';
        try {
            if (kind === 'notebook') {
                if (typeof this._onNotebookChange === 'function') {
                    return this._onNotebookChange(projId, path);
                }
                return this._openFileTab(projId, path);
            }
            if (kind === 'source') {
                return this._openFileTab(projId, path);
            }
            if (kind === 'media') {
                return this._openMediaTab(projId, path);
            }
            if (kind === 'document') {
                // KB document viewer expects a doc object with category +
                // name. Without a manifest lookup here we synthesise a
                // best-effort doc — when a real lookup helper exists this
                // can be swapped in. For now this opens the doc tab with
                // the path as the name; the document viewer reads bytes
                // from the domain's sources/.
                const doc = {
                    name: path.split('/').pop(),
                    path,
                    category: domain_id || '',
                    domain_id: domain_id || null,
                };
                return this._openDocumentTab(doc);
            }
            // Unknown kind — fall back to source viewer.
            return this._openFileTab(projId, path);
        } catch (e) {
            console.warn('[app] open_file dispatch failed', e);
        }
    }

    /** Handle a doc-buffer SSE event (NOTES-1).
     *
     * Payload: {buffer_id, name, content, path}.
     * - First event for a given buffer_id opens a new document tab
     *   carrying the buffer's content as inline markdown and switches
     *   the workspace to it so the user sees the note land.
     * - Subsequent events for the same buffer_id update the stored
     *   doc.content and re-render the existing DocumentViewer in place,
     *   giving the live-preview UX as the assistant writes.
     * - Tab key prefix `doc:` keeps it inside the existing document-tab
     *   plumbing (ToC, scroll restore, close handling).
     */
    _handleDocBuffer(payload) {
        if (!payload || !payload.buffer_id) return;
        const { buffer_id, name, content, path } = payload;

        if (!this._docBufferTabKeys) {
            this._docBufferTabKeys = new Map();
        }

        let tabKey = this._docBufferTabKeys.get(buffer_id);

        if (!tabKey) {
            tabKey = `doc:__buffer__:${buffer_id}`;
            this._docBufferTabKeys.set(buffer_id, tabKey);
            const doc = {
                kind: 'buffer',
                buffer_id,
                name: name || `notes-${buffer_id.slice(0, 8)}.md`,
                content: content || '',
                path: path || null,
                category: '__buffer__',
            };
            this._documentTabs.set(tabKey, doc);
            this._tabBar.addTab({
                key: tabKey,
                label: doc.name,
                type: 'document',
                closable: true,
                undockable: true,
            });
            this._tabBar.activate(tabKey);
            return;
        }

        const doc = this._documentTabs.get(tabKey);
        if (!doc) return;
        // While the user is editing the raw markdown source, ignore live
        // assistant updates to this buffer — applying them would clobber
        // the textarea. Updates resume once the user toggles back to
        // preview mode.
        if (this._documentEditMode.get(tabKey)) return;
        doc.content = content || '';
        if (typeof name === 'string' && name) doc.name = name;
        if (typeof path === 'string') doc.path = path;

        const viewer = this._documentViewers.get(tabKey);
        if (viewer) {
            viewer.show(doc);
        }
    }

    /** Reload any open viewer / editor showing the touched on-disk path.
     *
     * Wired to the `data.file_changed` SSE event (NOTES-3) emitted from
     * /api/llm/confirm after a successful update_file / create_file (or
     * append_to_file via its update_file rewrite). Two consumers:
     *  - DocumentViewer instances open on a `doc:` tab whose stored doc
     *    path matches the touched path → call show(doc) to re-fetch.
     *  - FileEditor instances open on a `pyfile:` tab whose path matches
     *    → reload from disk via fileEditor.reloadFromDisk?.() if present,
     *    or fallback to a manual fetch.
     */
    _handleFileChanged(payload) {
        if (!payload || !payload.path) return;
        const writtenPath = payload.path;
        const projectId = payload.project_id || '';

        // Refresh DocumentViewer tabs (skip the in-memory buffer kind —
        // those mutate via data.doc events instead and have no on-disk
        // backing yet).
        if (this._documentTabs && this._documentViewers) {
            for (const [tabKey, doc] of this._documentTabs) {
                if (!doc || doc.kind === 'buffer') continue;
                const docPath = doc.path || doc.location || '';
                if (!docPath) continue;
                if (docPath === writtenPath
                        || docPath.endsWith('/' + writtenPath)
                        || writtenPath.endsWith('/' + docPath)) {
                    const viewer = this._documentViewers.get(tabKey);
                    if (viewer) {
                        try { viewer.show(doc); } catch (e) { console.warn('[file_changed] viewer reload failed', e); }
                    }
                }
            }
        }

        // Refresh open code/text file editors (pyfile: tabs) showing the
        // same path. The optimistic _applyWriteAction path already sets
        // content for the active editor, but for non-active editors a
        // fresh fetch keeps them in sync with disk.
        if (this._fileEditors) {
            for (const [tabKey, editor] of this._fileEditors) {
                if (!tabKey.startsWith('pyfile:')) continue;
                const parts = tabKey.split(':');
                const tabProject = parts[1] || '';
                const tabPath = parts.slice(2).join(':');
                if (projectId && tabProject !== projectId) continue;
                if (tabPath === writtenPath
                        || tabPath.endsWith('/' + writtenPath)
                        || writtenPath.endsWith('/' + tabPath)) {
                    if (typeof editor.reloadFromDisk === 'function') {
                        try { editor.reloadFromDisk(); } catch (e) { console.warn('[file_changed] editor reload failed', e); }
                    }
                }
            }
        }
    }

    /** Persist a note-taking buffer to disk (NOTES-2 Save flow).
     *
     * tabKey is the doc-buffer tab key `doc:__buffer__:<buffer_id>`.
     *  - First save: opens a Save-As modal to pick project + relative path,
     *    then POSTs to /api/buffers/<id>/save. On success the buffer is
     *    marked path-bound on both server and client; subsequent saves
     *    skip the modal and reuse the bound path.
     *  - Already-saved buffer: posts directly with the bound path.
     */
    async _saveBuffer(tabKey) {
        const doc = this._documentTabs.get(tabKey);
        if (!doc || doc.kind !== 'buffer' || !doc.buffer_id) return;
        const bufferId = doc.buffer_id;

        let projectId = null;
        let relPath = null;

        if (doc.path) {
            // Path is "<project_id>/<rel_path>" — split on the first slash.
            const slash = doc.path.indexOf('/');
            if (slash > 0) {
                projectId = doc.path.substring(0, slash);
                relPath = doc.path.substring(slash + 1);
            }
        }

        if (!projectId || !relPath) {
            // Save-As: ask for project + path. Fetch projects + mounts and
            // surface them as a single, undifferentiated "Projects" list —
            // the user shouldn't have to care which kind of project root
            // they're saving into. Backend resolves the right root_type
            // server-side at write time.
            let projects = [];
            try {
                const resp = await fetch('api/files/');
                if (resp.ok) {
                    const data = await resp.json();
                    const ps = (data.projects || []).map(p => ({
                        label: typeof p === 'string' ? p : (p.name || p.id || JSON.stringify(p)),
                        value: typeof p === 'string' ? p : (p.name || p.id || ''),
                    })).filter(o => o.value);
                    const ms = (data.mounts || []).map(m => ({
                        label: m.name,
                        value: m.name,
                    })).filter(o => o.value);
                    projects = [...ps, ...ms];
                }
            } catch (e) {
                console.warn('[app] _saveBuffer: failed to list projects', e);
            }
            if (projects.length === 0) {
                modalAlert('No projects available to save into.', { title: 'Save As' });
                return;
            }

            const result = await modalForm([
                {
                    key: 'project_id',
                    label: 'Project',
                    type: 'select',
                    options: projects,
                    defaultValue: projects[0].value,
                    required: true,
                },
                {
                    key: 'path',
                    label: 'Path within project (e.g. notes/report.md)',
                    type: 'text',
                    defaultValue: doc.name || 'notes.md',
                    required: true,
                },
            ], { title: 'Save As', confirmText: 'Save', width: 480 });

            if (!result) return; // cancelled
            projectId = (result.project_id || '').trim();
            relPath = (result.path || '').trim();
            if (!projectId || !relPath) {
                modalAlert('Project and path are required.', { title: 'Save As' });
                return;
            }
        }

        // If the user is currently in edit mode, ship the textarea content
        // with the save call so on-disk state matches what's on screen.
        let contentOverride = null;
        const viewer = this._documentViewers.get(tabKey);
        if (viewer?.isEditing) {
            contentOverride = viewer.getEditValue();
            if (typeof contentOverride === 'string') doc.content = contentOverride;
        }

        try {
            const resp = await fetch(`api/buffers/${encodeURIComponent(bufferId)}/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    project_id: projectId,
                    path: relPath,
                    ...(contentOverride !== null ? { content: contentOverride } : {}),
                }),
            });
            if (!resp.ok) {
                const text = await resp.text();
                modalAlert(`Save failed (${resp.status}): ${text}`, { title: 'Save error' });
                return;
            }
            const out = await resp.json();
            doc.path = out.bound_path || `${projectId}/${relPath}`;
            // Re-render the document tab's top bars so the breadcrumb and
            // Save tooltip pick up the newly-bound path. activate() short-
            // circuits if the tab is already active, so rebuild directly.
            const serviceContainer = document.getElementById('service-tab-container');
            if (serviceContainer && this._tabBar.activeKey === tabKey) {
                serviceContainer.querySelectorAll(':scope > .service-top-bar, :scope > .service-second-bar').forEach(el => el.remove());
                serviceContainer.insertBefore(this._buildDocumentBars(tabKey), serviceContainer.firstChild);
            }
            notify.success(`Saved to ${doc.path}`);
        } catch (e) {
            modalAlert(`Save failed: ${e.message || e}`, { title: 'Save error' });
        }
    }

    /** Open the Domain Manager floating panel - the single canonical surface
     * for Domain CRUD plus per-Domain document and knowledge management.
     * Replaces the legacy KnowledgeBaseManagerPanel. Lazy-imported.
     *
     * `domainId` (optional) pre-selects a Domain in the left list. */
    async showKnowledgeBaseManager(domainId = null) {
        if (!this._kbManager) {
            const { DomainManagerPanel } = await import('./knowledge-graph/DomainManagerPanel.js');
            this._kbManager = new DomainManagerPanel();
        }
        this._kbManager.open(domainId);
    }

    async _openKnowledgeGraphTab(projectId) {
        if (!projectId) {
            const activeNode = this._explorerPanel?._tree?.getActiveNode();
            if (activeNode) {
                const key = activeNode.key || '';
                if (key.startsWith('project:')) projectId = key.substring(8);
                else if (key.startsWith('mount:')) projectId = key.substring(6);
                else if (key.startsWith('pfile:') || key.startsWith('pdir:') || key.startsWith('mfile:') || key.startsWith('mdir:')) {
                    projectId = key.split(':')[1];
                }
            }
            if (!projectId) projectId = 'Examples';
        }
        const tabKey = 'detail:kb-graph';
        // Reuse existing tab if open
        if (this._tabBar._tabs.has(tabKey)) {
            this._tabBar.activate(tabKey);
            return;
        }
        const { GraphPanel } = await import('./knowledge-graph/GraphPanel.js');
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%;background:#ffffff';
        const container = document.createElement('div');
        container.className = 'kg-panel';
        wrapper.appendChild(container);
        const gp = new GraphPanel(projectId, {
            onEntityNavigate: (entity) => {
                const node = this._explorerPanel?._tree?.findFirst(n =>
                    n.key?.includes(entity.id.split(':').pop())
                );
                if (node) node.setActive(true);
            },
        });
        gp._buildUI(container);
        this._openDetailTab(tabKey, 'Knowledge Graph', wrapper, { undockable: true, preview: true });
    }

    async _openKnowledgeGraph(projectId, entityId) {
        // Determine project from active context
        if (!projectId) {
            const activeNode = this._explorerPanel?._tree?.getActiveNode();
            if (activeNode) {
                const key = activeNode.key || '';
                if (key.startsWith('project:')) projectId = key.substring(8);
                else if (key.startsWith('mount:')) projectId = key.substring(6);
                else if (key.startsWith('pfile:') || key.startsWith('pdir:') || key.startsWith('mfile:') || key.startsWith('mdir:')) {
                    const parts = key.split(':');
                    projectId = parts[1];
                }
            }
            if (!projectId) projectId = 'Examples';
        }

        const { GraphPanel } = await import('./knowledge-graph/GraphPanel.js');
        const panel = new GraphPanel(projectId, {
            initialEntityId: entityId || null,
            onEntityClick: (entity) => {
                // Don't auto-navigate - detail panel has a Navigate button
            },
            onEntityNavigate: (entity) => {
                // Called when user explicitly clicks "Navigate" in KG detail panel
                const node = this._explorerPanel?._tree?.findFirst(n =>
                    n.key?.includes(entity.id.split(':').pop())
                );
                if (node) node.setActive(true);
            },
        });
        panel.open();
    }

    _openDetailTab(tabKey, label, element, opts = {}) {
        // If undocked, bring to front
        const undocked = this._undockedPanels.get(tabKey);
        if (undocked) { undocked.front(); return; }

        // Store element
        if (!this._detailTabs.has(tabKey)) {
            this._detailTabs.set(tabKey, { element, title: label });
        }

        this._tabBar.addTab({
            key: tabKey,
            label,
            tooltip: label,
            type: 'detail',
            closable: true,
            undockable: true,
            preview: opts.preview || false,
        });
    }

    _buildDetailBars(key) {
        const detail = this._detailTabs.get(key);
        const title = detail?.title || 'Detail';
        const frag = document.createDocumentFragment();

        // First bar: breadcrumb + undock + close
        const bar = document.createElement('div');
        bar.className = 'service-top-bar';
        const titleEl = document.createElement('span');
        titleEl.className = 'service-top-bar-title';
        titleEl.textContent = title;
        bar.appendChild(titleEl);

        const spacer = document.createElement('span');
        spacer.style.cssText = 'flex:1';
        bar.appendChild(spacer);

        const undockBtn = document.createElement('button');
        undockBtn.className = 'info-bar-text-btn';
        undockBtn.innerHTML = '<i class="fa-solid fa-up-right-from-square" style="font-size:12px;color:#555555"></i>';
        undockBtn.title = 'Undock to floating panel';
        undockBtn.addEventListener('click', () => this._tabBar.undockTab(key));
        bar.appendChild(undockBtn);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'info-bar-text-btn';
        closeBtn.innerHTML = '<i class="fa-solid fa-xmark" style="font-size:12px;color:#555555"></i>';
        closeBtn.title = 'Close';
        closeBtn.addEventListener('click', () => this._tabBar.closeTab(key));
        bar.appendChild(closeBtn);

        frag.appendChild(bar);

        return frag;
    }

    _buildMediaBars(key) {
        // Parse key "media:{projectId}:{filename}" where projectId may contain ':'
        const rest = key.substring(6); // strip "media:"
        const colonIdx = rest.indexOf(':');
        const name = rest.substring(0, colonIdx);
        const filename = rest.substring(colonIdx + 1);
        const hostPath = this._explorerPanel?._mountHostPaths?.[name] || '';

        const frag = document.createDocumentFragment();

        // First bar: breadcrumbs
        const bar = document.createElement('div');
        bar.className = 'service-top-bar';
        const title = document.createElement('span');
        title.className = 'service-top-bar-title';
        const crumbParts = ['Projects', name, filename];
        crumbParts.forEach((text, i) => {
            if (i > 0) {
                const sep = document.createElement('span');
                sep.className = 'breadcrumb-sep';
                sep.textContent = ' / ';
                title.appendChild(sep);
            }
            const span = document.createElement('span');
            span.className = 'breadcrumb-segment';
            if (i === crumbParts.length - 1) span.classList.add('breadcrumb-current');
            span.textContent = text;
            title.appendChild(span);
        });
        const spacerM = document.createElement('span');
        spacerM.style.cssText = 'flex:1';
        bar.appendChild(title);
        bar.appendChild(spacerM);

        const undockBtnM = document.createElement('button');
        undockBtnM.className = 'info-bar-text-btn';
        undockBtnM.innerHTML = '<i class="fa-solid fa-up-right-from-square" style="font-size:12px;color:#555555"></i>';
        undockBtnM.title = 'Undock to floating panel';
        undockBtnM.addEventListener('click', () => this._tabBar.undockTab(key));
        bar.appendChild(undockBtnM);

        const closeBtnM = document.createElement('button');
        closeBtnM.className = 'info-bar-text-btn';
        closeBtnM.innerHTML = '<i class="fa-solid fa-xmark" style="font-size:12px;color:#555555"></i>';
        closeBtnM.title = 'Close';
        closeBtnM.addEventListener('click', () => this._tabBar.closeTab(key));
        bar.appendChild(closeBtnM);

        frag.appendChild(bar);

        // Second bar: File Details button only (no save for media)
        const secondBar = this._buildSecondBar();
        const leftGroup = document.createElement('div');
        leftGroup.className = 'service-second-bar-left';

        const detailBtn = document.createElement('button');
        detailBtn.className = 'info-bar-text-btn';
        detailBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" fill="#4a90d9"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
        detailBtn.title = 'File Details';
        detailBtn.addEventListener('click', () => {
            const treePrefix = isMount ? 'm' : 'p';
            const treeKey = `${treePrefix}file:${name}:${filename}`;
            this._tabBar.activate('workspace');
            const node = this._explorerPanel._tree?.findKey(treeKey);
            if (node) node.setActive(true);
        });
        leftGroup.appendChild(detailBtn);

        secondBar.appendChild(leftGroup);

        // PDF zoom controls — centered in the bar
        const ext = filename.split('.').pop().toLowerCase();
        if (ext === 'pdf') {
            const viewer = this._mediaViewers.get(key);

            const centerGroup = document.createElement('div');
            centerGroup.className = 'pdf-zoom-controls';

            const S = 'stroke="#555" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

            const zoomOutBtn = document.createElement('button');
            zoomOutBtn.className = 'info-bar-text-btn';
            zoomOutBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ${S}><circle cx="11" cy="11" r="8"/><line x1="7" y1="11" x2="15" y2="11"/></svg>`;
            zoomOutBtn.title = 'Zoom Out';
            zoomOutBtn.addEventListener('click', () => { if (viewer) viewer.zoomOut(); });
            centerGroup.appendChild(zoomOutBtn);

            const zoomLabel = document.createElement('span');
            zoomLabel.className = 'pdf-zoom-label';
            zoomLabel.textContent = '100%';
            centerGroup.appendChild(zoomLabel);

            const zoomInBtn = document.createElement('button');
            zoomInBtn.className = 'info-bar-text-btn';
            zoomInBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ${S}><circle cx="11" cy="11" r="8"/><line x1="7" y1="11" x2="15" y2="11"/><line x1="11" y1="7" x2="11" y2="15"/></svg>`;
            zoomInBtn.title = 'Zoom In';
            zoomInBtn.addEventListener('click', () => { if (viewer) viewer.zoomIn(); });
            centerGroup.appendChild(zoomInBtn);

            const fitBtn = document.createElement('button');
            fitBtn.className = 'info-bar-text-btn';
            fitBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ${S}><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/></svg>`;
            fitBtn.title = 'Fit to Width';
            fitBtn.addEventListener('click', () => { if (viewer) viewer.fitToWidth(); });
            centerGroup.appendChild(fitBtn);

            if (viewer) {
                viewer.onZoomChange = (pct) => { zoomLabel.textContent = pct + '%'; };
            }

            secondBar.appendChild(centerGroup);
        }

        frag.appendChild(secondBar);
        return frag;
    }

    _openDocumentTab(doc, opts = {}) {
        const tabKey = `doc:${doc.category}:${doc.name}`;
        this._documentTabs.set(tabKey, doc);
        // addTab synchronously fires the tab-activation callback, which
        // runs the 'doc:' case in app-tabs.js and calls
        // documentViewer.show(doc) + updates the TOC in its .then().
        // Do NOT call documentViewer.show(doc) again here - that would
        // race the tab handler's show() and render the PDF twice,
        // because both show() calls find _pdfState still null (the
        // first one hasn't created state yet when the second starts)
        // and so neither one cleans up the other's pageDivs.
        this._tabBar.addTab({
            key: tabKey,
            label: doc.name,
            type: 'document',
            closable: true,
            undockable: true,
            preview: !!opts.preview,
        });
    }

    _updateTocForTab(key) {
        if (!this._tocPanel) return;

        if (key && key.startsWith('notebook:')) {
            this._tocPanel.setNotebookMode();
        } else if (key && key.startsWith('doc:')) {
            // Document viewer — markdown or PDF. Per-tab viewers live in
            // the `_documentViewers` Map (keyed by tab key); the singular
            // `_documentViewer` was a legacy single-shared instance that
            // never gets populated, so reading from it always pointed at
            // an empty viewer and short-circuited to the markdown empty
            // state.
            const dv = this._documentViewers.get(key);
            if (dv && dv._pdfState && dv._pdfState.pdfDoc) {
                // PDF document
                this._tocPanel.setPdfMode(
                    dv._pdfState.pdfDoc,
                    dv._pdfState.pageDivs,
                    dv._wrapper,
                );
            } else if (dv && dv._content) {
                // Markdown document
                this._tocPanel.setMarkdownMode(dv._content, dv._wrapper);
            } else {
                this._tocPanel.clearMode();
            }
        } else if (key && key.startsWith('pyfile:')) {
            // File editor - check if markdown preview is active
            const editor = this._fileEditors.get(key);
            if (editor && editor._previewEl && editor._previewEl.style.display !== 'none') {
                this._tocPanel.setMarkdownMode(editor._previewEl, editor._el);
            } else {
                this._tocPanel.clearMode();
            }
        } else {
            this._tocPanel.clearMode();
        }
    }

    _buildWorkspaceBars() {
        const frag = document.createDocumentFragment();

        const bar = document.createElement('div');
        bar.className = 'service-top-bar';

        const title = document.createElement('span');
        title.className = 'service-top-bar-title';
        title.textContent = 'Explorer';
        this._workspaceTitleEl = title;
        bar.appendChild(title);

        const spacer = document.createElement('span');
        spacer.style.cssText = 'flex:1';
        bar.appendChild(spacer);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'info-bar-text-btn';
        closeBtn.innerHTML = '<i class="fa-solid fa-xmark" style="font-size:11px;color:#555555"></i>';
        closeBtn.title = 'Close';
        closeBtn.addEventListener('click', () => this._tabBar.closeTab('workspace'));
        bar.appendChild(closeBtn);

        frag.appendChild(bar);
        this._workspaceBreadcrumbBar = this._buildSecondBar();
        frag.appendChild(this._workspaceBreadcrumbBar);
        return frag;
    }

    _buildDocumentBars(key, viewerOverride = null, floating = false) {
        const frag = document.createDocumentFragment();

        const bar = document.createElement('div');
        bar.className = 'service-top-bar';

        // Breadcrumb path as the title.
        // - Buffer doc tabs:
        //     unsaved → ['Knowledge Base', '__buffer__', '<id>']
        //     saved   → ['Knowledge Base', <project>, ...rel_path-segments]
        // - Other doc tabs: ['Knowledge Base', <category>, <docName>] from the key.
        const parts = key.substring(4).split(':');
        const isBuffer = key.startsWith('doc:__buffer__:');
        const doc = this._documentTabs.get(key);
        let crumbs;
        if (isBuffer && doc?.path) {
            const slash = doc.path.indexOf('/');
            if (slash > 0) {
                const projectId = doc.path.substring(0, slash);
                const relPath = doc.path.substring(slash + 1);
                crumbs = ['Knowledge Base', projectId, ...relPath.split('/').filter(Boolean)];
            } else {
                crumbs = ['Knowledge Base', doc.path];
            }
        } else {
            const category = parts[0] || '';
            const docName = parts.slice(1).join(':') || '';
            crumbs = ['Knowledge Base', category, docName].filter(Boolean);
        }
        const title = document.createElement('span');
        title.className = 'service-top-bar-title';
        crumbs.forEach((text, i) => {
            if (i > 0) {
                const sep = document.createElement('span');
                sep.className = 'breadcrumb-sep';
                sep.textContent = ' / ';
                title.appendChild(sep);
            }
            const span = document.createElement('span');
            span.className = 'breadcrumb-segment';
            if (i === crumbs.length - 1) span.classList.add('breadcrumb-current');
            span.textContent = text;
            title.appendChild(span);
        });
        bar.appendChild(title);

        const spacer = document.createElement('span');
        spacer.style.flex = '1';
        bar.appendChild(spacer);

        // Undock + Close buttons. Only shown in the docked layout; the
        // floating panel has its own header controls (jsPanel's "dock"
        // and "close" icons in the title bar) that already cover both
        // actions, so showing them here too would be redundant.
        if (!floating) {
            const undockBtn = document.createElement('button');
            undockBtn.className = 'info-bar-text-btn';
            undockBtn.innerHTML = '<i class="fa-solid fa-up-right-from-square" style="font-size:11px;color:#555555"></i>';
            undockBtn.title = 'Undock to floating panel';
            undockBtn.addEventListener('click', () => this._tabBar.undockTab(key));
            bar.appendChild(undockBtn);

            const closeBtn = document.createElement('button');
            closeBtn.className = 'info-bar-text-btn';
            closeBtn.innerHTML = '<i class="fa-solid fa-xmark" style="font-size:11px;color:#555555"></i>';
            closeBtn.title = 'Close';
            closeBtn.addEventListener('click', () => this._tabBar.closeTab(key));
            bar.appendChild(closeBtn);
        }

        frag.appendChild(bar);

        // Second bar — Save + Edit/Preview toggle on the left for buffer docs
        const secondBar = this._buildSecondBar();
        if (isBuffer) {
            const left = document.createElement('span');
            left.className = 'service-second-bar-left';
            const saveBtn = document.createElement('button');
            saveBtn.className = 'info-bar-text-btn';
            saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk" style="font-size:14px;color:#4caf50"></i>';
            saveBtn.title = doc?.path ? `Save (${doc.path})` : 'Save As…';
            saveBtn.addEventListener('click', () => this._saveBuffer?.(key));
            left.appendChild(saveBtn);

            const editing = !!this._documentEditMode.get(key);
            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'info-bar-text-btn';
            toggleBtn.innerHTML = editing
                ? '<i class="fa-solid fa-eye" style="font-size:14px;color:#42a5f5"></i>'
                : '<i class="fa-solid fa-pen-to-square" style="font-size:14px;color:#f0a040"></i>';
            toggleBtn.title = editing ? 'Preview' : 'Edit markdown';
            toggleBtn.addEventListener('click', () => this._toggleBufferEdit(key));
            left.appendChild(toggleBtn);
            secondBar.appendChild(left);
        }
        // PDF document tabs: centered page-navigation controls in the
        // second bar. Detected from doc.location's extension; the
        // viewer's onReady fires after PDF placeholders are set up,
        // populating the page-input + total. onPageChange keeps the
        // input in sync as the user scrolls. Zoom controls are a
        // follow-up — page nav lands first.
        const isPdf = (doc?.location || '').toLowerCase().endsWith('.pdf');
        if (isPdf) {
            // Floating panels pass an explicit viewer (their own
            // DocumentViewer instance is independent of the docked tab's).
            // Default: look up the docked viewer by tab key.
            const viewer = viewerOverride || this._documentViewers.get(key);

            // Download button on the left — same URL the DocumentViewer
            // uses for fetching the PDF, just routed through an <a download>
            // so the browser saves it instead of streaming. Filename is
            // the source path's basename.
            const left = document.createElement('span');
            left.className = 'service-second-bar-left';
            const downloadBtn = document.createElement('button');
            downloadBtn.className = 'pdf-ctl-btn pdf-ctl-download';
            downloadBtn.innerHTML = '<span class="pdf-ctl-icon pdf-ctl-icon-download" aria-hidden="true"></span>';
            downloadBtn.title = 'Download PDF';
            downloadBtn.addEventListener('click', () => {
                const locPath = (doc?.location || '').replace(/^files\//, '');
                if (!locPath) return;
                const url = 'api/documents/files/' + locPath.split('/').map(encodeURIComponent).join('/');
                const filename = locPath.split('/').pop() || 'download.pdf';
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
            });
            left.appendChild(downloadBtn);

            const infoBtn = document.createElement('button');
            infoBtn.className = 'pdf-ctl-btn pdf-ctl-info';
            infoBtn.innerHTML = '<span class="pdf-ctl-icon pdf-ctl-icon-info" aria-hidden="true"></span>';
            infoBtn.title = 'Document information';
            infoBtn.addEventListener('click', () => this._openDocumentInfoPanel(doc, viewer));
            left.appendChild(infoBtn);

            secondBar.appendChild(left);

            const center = document.createElement('span');
            center.className = 'service-second-bar-center pdf-controls';

            const prevBtn = document.createElement('button');
            prevBtn.className = 'pdf-ctl-btn';
            prevBtn.innerHTML = '<i class="fa-solid fa-caret-left"></i>';
            prevBtn.title = 'Previous page';

            const pageInput = document.createElement('input');
            pageInput.type = 'number';
            pageInput.min = '1';
            pageInput.className = 'pdf-ctl-page-input';
            pageInput.value = '';

            const totalEl = document.createElement('span');
            totalEl.className = 'pdf-ctl-total';
            totalEl.textContent = '/ —';

            const nextBtn = document.createElement('button');
            nextBtn.className = 'pdf-ctl-btn';
            nextBtn.innerHTML = '<i class="fa-solid fa-caret-right"></i>';
            nextBtn.title = 'Next page';

            center.appendChild(prevBtn);
            center.appendChild(pageInput);
            center.appendChild(totalEl);
            center.appendChild(nextBtn);
            secondBar.appendChild(center);

            const syncDisplay = () => {
                if (!viewer) return;
                const cur = viewer.getCurrentPage();
                const total = viewer.pageCount;
                if (total > 0) {
                    pageInput.max = String(total);
                    if (document.activeElement !== pageInput) {
                        pageInput.value = String(cur || 1);
                    }
                    totalEl.textContent = `/ ${total}`;
                }
            };

            prevBtn.addEventListener('click', () => {
                if (!viewer) return;
                const cur = viewer.getCurrentPage() || 1;
                viewer.goToPage(cur - 1);
            });
            nextBtn.addEventListener('click', () => {
                if (!viewer) return;
                const cur = viewer.getCurrentPage() || 1;
                viewer.goToPage(cur + 1);
            });
            const submitPage = () => {
                if (!viewer) return;
                const n = parseInt(pageInput.value, 10);
                if (Number.isFinite(n) && n > 0) {
                    viewer.goToPage(n);
                }
            };
            pageInput.addEventListener('change', submitPage);
            pageInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); submitPage(); pageInput.blur(); }
            });

            // The viewer may already be loaded (re-activating an existing
            // doc tab) OR brand-new (first activation). Try to populate
            // immediately for the first case, AND register onReady for
            // the second. onPageChange runs for the lifetime of this bar.
            syncDisplay();
            if (viewer) {
                viewer.onReady(() => syncDisplay());
                viewer.onPageChange(() => syncDisplay());
            }

            // Right cluster of the second bar: fit-to-one-page button
            // followed by sliders/settings. Both visible in docked and
            // floating modes.
            const right = document.createElement('span');
            right.className = 'service-second-bar-right';

            // Fit-to-one-page: switches the layout to single, auto-fits
            // zoom, and re-centers the current page vertically (the
            // single-page fit can leave vertical slack when the page
            // aspect is constrained by width).
            const fitBtn = document.createElement('button');
            fitBtn.className = 'pdf-ctl-expand';
            fitBtn.innerHTML = '<span class="pdf-ctl-icon pdf-ctl-icon-expand" aria-hidden="true"></span>';
            fitBtn.title = 'Fit one page';
            fitBtn.addEventListener('click', () => {
                if (!viewer) return;
                const cur = viewer.getCurrentPage() || 1;
                viewer.setPageLayout('single');
                viewer.goToPageCentered(cur);
            });
            right.appendChild(fitBtn);

            const slidersBtn = document.createElement('button');
            slidersBtn.className = 'pdf-ctl-sliders';
            slidersBtn.innerHTML = '<span class="pdf-ctl-icon pdf-ctl-icon-sliders" aria-hidden="true"></span>';
            slidersBtn.title = 'Settings';
            slidersBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!viewer) return;
                this._openPdfSettingsPopover(slidersBtn, viewer);
            });
            right.appendChild(slidersBtn);
            secondBar.appendChild(right);
        }
        frag.appendChild(secondBar);
        return frag;
    }

    /** Build a small floating popover anchored under `anchorEl` with the
     *  PDF page-layout radios (One / Two / Custom) and a zoom slider.
     *  Toggles on second click of the same anchor; click-outside dismiss
     *  is wired with `capture: true` so it fires before the popover's
     *  internal handlers swallow the event. The viewer is the override-
     *  aware instance from the caller — drives THAT viewer, not the
     *  shared docked one. Auto-fit recomputes on resize call back into
     *  the slider via viewer.onZoomChange. */
    _openPdfSettingsPopover(anchorEl, viewer) {
        // Toggle: if already open AND anchored to the same button, close.
        if (this._pdfSettingsPopover && this._pdfSettingsPopover._anchorEl === anchorEl) {
            this._closePdfSettingsPopover();
            return;
        }
        this._closePdfSettingsPopover();

        const pop = document.createElement('div');
        pop.className = 'pdf-settings-popover';
        pop._anchorEl = anchorEl;

        const layout = viewer.getPageLayout();
        const zoomPct = Math.round(viewer.getZoom() * 100);

        const radioRow = (value, label) => {
            const checked = layout === value ? 'checked' : '';
            return `
                <label class="pdf-settings-radio">
                    <input type="radio" name="pdf-settings-layout" value="${value}" ${checked}>
                    <span>${label}</span>
                </label>`;
        };

        pop.innerHTML = `
            <div class="pdf-settings-section">
                <div class="pdf-settings-label">Page layout</div>
                ${radioRow('single', 'One page')}
                ${radioRow('dual', 'Two pages')}
                ${radioRow('custom', 'Custom')}
            </div>
            <div class="pdf-settings-section">
                <div class="pdf-settings-label">Zoom</div>
                <div class="pdf-settings-zoom-row">
                    <input type="range" class="pdf-settings-zoom-slider"
                        min="10" max="300" step="1" value="${zoomPct}">
                    <span class="pdf-settings-zoom-value">${zoomPct}%</span>
                </div>
            </div>
        `;

        // Position under the anchor, right-aligned so the popover doesn't
        // run off the breadcrumb bar. Use position: fixed so the popover
        // floats above the floating jsPanel for undocked PDFs.
        document.body.appendChild(pop);
        const rect = anchorEl.getBoundingClientRect();
        const popRect = pop.getBoundingClientRect();
        const top = rect.bottom + 4;
        let left = rect.right - popRect.width;
        if (left < 8) left = 8;
        pop.style.top = `${top}px`;
        pop.style.left = `${left}px`;

        // Wire layout radios.
        pop.querySelectorAll('input[name="pdf-settings-layout"]').forEach(r => {
            r.addEventListener('change', () => {
                if (!r.checked) return;
                const cur = viewer.getCurrentPage() || 1;
                viewer.setPageLayout(r.value);
                // Centre the current page after the layout switch — same
                // reasoning as the fit-to-one-page button (single/dual
                // mode auto-fits zoom, often leaving vertical slack).
                viewer.goToPageCentered(cur);
                const newPct = Math.round(viewer.getZoom() * 100);
                slider.value = String(newPct);
                zoomVal.textContent = `${newPct}%`;
            });
        });

        // Wire zoom slider. Slider input switches the layout to "custom"
        // (ResizeObserver-driven auto-fit would otherwise immediately
        // overwrite a user-set zoom on the next resize event for single
        // and dual modes). Mirrors docbro's behavior.
        const slider = pop.querySelector('.pdf-settings-zoom-slider');
        const zoomVal = pop.querySelector('.pdf-settings-zoom-value');
        slider.addEventListener('input', () => {
            const pct = parseInt(slider.value, 10);
            if (!Number.isFinite(pct)) return;
            zoomVal.textContent = `${pct}%`;
            // Ensure no auto-fit fights the user.
            if (viewer.getPageLayout() !== 'custom') {
                viewer.setPageLayout('custom');
                const customRadio = pop.querySelector('input[value="custom"]');
                if (customRadio) customRadio.checked = true;
            }
            viewer.setZoom(pct / 100);
        });

        // Auto-fit feedback for single + dual: keep the slider in sync
        // when the wrapper resize triggers a zoom recompute.
        viewer.onZoomChange((z) => {
            const pct = Math.round(z * 100);
            slider.value = String(pct);
            zoomVal.textContent = `${pct}%`;
        });

        // Hover-out dismiss. The popover opens on click but should close
        // as soon as the user moves the pointer away from it. Two-step:
        //   1. Wait for the mouse to actually enter the popover (so the
        //      popover doesn't close immediately when it appears under
        //      a pointer that's still on the anchor — there's a 4px gap
        //      between anchor and popover that briefly counts as "out").
        //   2. After that first enter, any mouseleave closes.
        let entered = false;
        pop.addEventListener('mouseenter', () => { entered = true; });
        pop.addEventListener('mouseleave', () => {
            if (entered) this._closePdfSettingsPopover();
        });
        // Click-outside dismiss as a fallback for the case where the
        // user clicks the anchor but never moves the pointer onto the
        // popover (mouseleave never fires). capture:true so the handler
        // fires before any inner click on the popover itself stops
        // propagation. Skip dismissal when the click lands inside the
        // popover or on the anchor (the toggle path handles re-anchor
        // clicks). Deferred to next frame so the opening click doesn't
        // immediately close.
        const onDocClick = (ev) => {
            if (pop.contains(ev.target) || anchorEl.contains(ev.target)) return;
            this._closePdfSettingsPopover();
        };
        requestAnimationFrame(() => {
            document.addEventListener('mousedown', onDocClick, true);
            pop._onDocClick = onDocClick;
        });

        this._pdfSettingsPopover = pop;
    }

    _closePdfSettingsPopover() {
        const pop = this._pdfSettingsPopover;
        if (!pop) return;
        if (pop._onDocClick) {
            document.removeEventListener('mousedown', pop._onDocClick, true);
        }
        pop.remove();
        this._pdfSettingsPopover = null;
    }

    /** Open a floating Document Information jsPanel with file stats and
     *  knowledge-base counts for a PDF doc. Two phases:
     *    1. Render immediately with locally-known fields (title, path,
     *       pages from the viewer) and "Loading…" placeholders for the
     *       fields that need a backend round-trip.
     *    2. Fetch /api/documents/info?domain=<>&path=<> in the background;
     *       fill in size, modified date, mode, chunk/section/caption
     *       counts, entity counts (per-doc + whole-domain).
     *  No panel-level cache — each open re-fetches. The endpoint is
     *  cheap so re-fetch is cheaper than tracking invalidation. */
    _openDocumentInfoPanel(doc, viewer) {
        const jp = window.jsPanel;
        if (!jp) return;
        const locPath = (doc?.location || '').replace(/^files\//, '');
        const segments = locPath.split('/');
        const domain = segments[0] || '';
        const relPath = segments.slice(1).join('/');
        const basename = relPath.split('/').pop() || locPath || 'Document';
        const pageCount = viewer && viewer.pageCount ? viewer.pageCount : null;

        const fmtBytes = (n) => {
            if (n == null) return '—';
            if (n < 1024) return `${n} B`;
            if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
            if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
            return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
        };
        const fmtDate = (iso) => {
            if (!iso) return '—';
            try { return new Date(iso).toLocaleString(); }
            catch { return iso; }
        };
        const escape = (s) => String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const row = (k, v) => `
            <div class="docinfo-row">
                <span class="docinfo-k">${k}</span>
                <span class="docinfo-v">${v}</span>
            </div>`;
        const sectionHeader = (label) => `
            <div class="docinfo-section">${label}</div>`;

        const renderBody = (info) => {
            const pages = pageCount != null ? String(pageCount) : '—';
            const size = fmtBytes(info?.size);
            const modified = fmtDate(info?.modified_at);
            const mode = info?.manifest?.mode || '—';

            const chunks = info?.chunks != null ? String(info.chunks) : '—';
            const sections = info?.sections != null ? String(info.sections) : '—';
            const picCaps = info?.picture_captions != null ? String(info.picture_captions) : '—';
            const tabCaps = info?.table_captions != null ? String(info.table_captions) : '—';
            const entDoc = info?.entities_in_doc != null ? String(info.entities_in_doc) : '—';
            const entDom = info?.entities_in_domain != null ? String(info.entities_in_domain) : '—';
            const relsDom = info?.relationships_in_domain != null ? String(info.relationships_in_domain) : '—';

            const showCaptions = info && (info.picture_captions > 0 || info.table_captions > 0);

            return `
                ${sectionHeader('Document')}
                ${row('Title', escape(basename))}
                ${row('Path', escape(locPath))}
                ${row('Pages', pages)}
                ${row('Size', size)}
                ${row('Modified', modified)}
                ${row('Ingestion mode', escape(mode))}

                ${sectionHeader('Knowledge Base')}
                ${row('Domain', escape(domain || '—'))}
                ${row('Vector chunks', chunks)}
                ${row('Sections', sections)}
                ${showCaptions ? row('Picture captions', picCaps) : ''}
                ${showCaptions ? row('Table captions', tabCaps) : ''}
                ${row('Graph entities (this doc)', entDoc)}
                ${row('Graph entities (domain)', entDom)}
                ${row('Graph relationships (domain)', relsDom)}
            `;
        };

        const panel = jp.create({
            id: `document-info-${Date.now()}`,
            headerTitle: `<i class="fa-solid fa-circle-info" style="color:#5a809c;margin-right:6px;font-size:12px"></i>Document Information`,
            theme: 'none',
            borderRadius: '5px',
            border: '1px solid var(--border-color)',
            boxShadow: 3,
            position: 'center',
            panelSize: { width: 480, height: 560 },
            headerControls: { minimize: 'remove', smallify: 'remove', normalize: 'remove', maximize: 'remove' },
            callback: (p) => {
                p.content.style.cssText = 'padding:14px 18px;font-size:12px;color:var(--text-color);overflow:auto;background:#fdfaf3;font-family:var(--font-sans)';
                p.content.innerHTML = renderBody(null);
                if (!domain || !relPath) return;
                fetch(`api/documents/info?domain=${encodeURIComponent(domain)}&path=${encodeURIComponent(relPath)}`)
                    .then((r) => r.ok ? r.json() : null)
                    .then((info) => {
                        if (info) p.content.innerHTML = renderBody(info);
                    })
                    .catch(() => {});
            },
        });
        return panel;
    }

    /** Toggle a buffer doc tab between rendered preview and raw markdown
     * editing. Captures the textarea content into doc.content on the way
     * out of edit mode so a subsequent re-render shows the user's changes,
     * and re-renders the bars to swap the toggle icon. */
    _toggleBufferEdit(key) {
        const doc = this._documentTabs.get(key);
        const viewer = this._documentViewers.get(key);
        if (!doc || !viewer) return;
        const wasEditing = !!this._documentEditMode.get(key);
        if (wasEditing) {
            const edited = viewer.getEditValue();
            if (typeof edited === 'string') doc.content = edited;
            this._documentEditMode.set(key, false);
            viewer.show(doc);
        } else {
            this._documentEditMode.set(key, true);
            viewer.showEdit(doc);
        }
        // Re-render bars to flip the toggle icon. Direct rebuild of the
        // service-top-bar pair — the tab bar isn't involved in this swap.
        const serviceContainer = document.getElementById('service-tab-container');
        if (serviceContainer) {
            serviceContainer.querySelectorAll(':scope > .service-top-bar, :scope > .service-second-bar').forEach(el => el.remove());
            serviceContainer.insertBefore(this._buildDocumentBars(key), serviceContainer.firstChild);
        }
    }

    _openGitCommitTab(repoPath, commit) {
        const tabKey = 'git-commit';
        if (!this._gitCommits) this._gitCommits = new Map();
        this._gitCommits.set(tabKey, { repoPath, commit });
        // Always update the viewer directly — activate() is a no-op when tab is already active
        this._gitCommitViewer.show(repoPath, commit);
        if (!this._tabBar._tabs.has(tabKey)) {
            this._tabBar.addTab({
                key: tabKey,
                label: 'Git History',
                type: 'git-commit',
                closable: true,
            });
        } else {
            this._tabBar.activate(tabKey);
        }
    }

    _buildGitCommitBars(_key) {
        const entry = this._gitCommits?.get('git-commit');
        const repoPath = entry?.repoPath || '';
        const repoLabel = repoPath.split('/').pop() || repoPath;
        const commit = entry?.commit;

        const frag = document.createDocumentFragment();

        // Top bar: breadcrumbs — "repoLabel | short_hash"
        const bar = document.createElement('div');
        bar.className = 'service-top-bar';
        [repoLabel, commit?.short_hash || ''].forEach((text, i) => {
            if (i > 0) {
                const sep = document.createElement('span');
                sep.className = 'breadcrumb-sep';
                sep.textContent = ' / ';
                bar.appendChild(sep);
            }
            const span = document.createElement('span');
            span.className = 'breadcrumb-segment';
            if (i === 1) span.classList.add('breadcrumb-current');
            span.textContent = text;
            bar.appendChild(span);
        });
        frag.appendChild(bar);

        // Second bar: commit message
        const secondBar = this._buildSecondBar();
        if (commit?.message) {
            const msg = document.createElement('span');
            msg.className = 'breadcrumb-segment breadcrumb-current';
            msg.textContent = commit.message;
            secondBar.appendChild(msg);
        }
        frag.appendChild(secondBar);
        return frag;
    }

    _buildSecondBar() {
        const bar = document.createElement('div');
        bar.className = 'service-second-bar';
        return bar;
    }

    _updateWorkspaceTitle(section) {
        if (this._workspaceTitleEl) {
            this._workspaceTitleEl.textContent = section;
        }
        if (this._tabBar._tabs.has('workspace')) {
            this._tabBar.setTabLabel('workspace', section);
        }
    }

    _getBreadcrumbIcons() {
        return {
            delete: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" fill="#f4a0a0"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
            rundag: '<i class="fa-solid fa-play" style="font-size:13px;color:#4caf50;-webkit-text-stroke:1px #555;paint-order:stroke fill"></i>',
            compare: '<i class="fa-solid fa-code-compare" style="font-size:13px;color:#7cb3a0;-webkit-text-stroke:1px #555;paint-order:stroke fill"></i>',
            popout: '<i class="fa-solid fa-chart-simple" style="font-size:16px;color:#42a5f5;-webkit-text-stroke:1px #555;paint-order:stroke fill"></i>',
            download: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
            newfile: '<i class="fa-solid fa-file-circle-plus" style="font-size:14px;color:#42a5f5"></i>',
            newfolder: '<i class="fa-solid fa-folder-plus" style="font-size:14px;color:#f0c040"></i>',
            importnb: '<i class="fa-solid fa-file-import" style="font-size:14px;color:#ab82d4"></i>',
            upload: '<i class="fa-solid fa-upload" style="font-size:14px;color:#f0a040"></i>',
            create: '<i class="fa-solid fa-plus" style="font-size:14px;color:#4caf50"></i>',
            clone: '<i class="fa-solid fa-code-branch" style="font-size:14px;color:#6fa374"></i>',
            addmount: '<i class="fa-solid fa-hard-drive" style="font-size:14px;color:#8fbcf0"></i>',
        };
    }

    _updateWorkspaceBreadcrumbs(info) {
        if (!this._workspaceBreadcrumbBar) return;
        this._workspaceBreadcrumbBar.innerHTML = '';
        const { crumbs, rootCount } = info;

        // Root level with actions: icons on left, count on right
        if (crumbs.length === 1 && rootCount !== undefined && info.actions?.length) {
            const section = crumbs[0];
            const singularMap = { Projects: 'Project', 'Environments': 'Environment', 'Knowledge Base': 'Document', Mounts: 'Mount' };
            const singular = singularMap[section] || section;

            const left = document.createElement('div');
            left.className = 'service-second-bar-left';
            left.style.cssText = 'display:flex;align-items:center;gap:4px';
            const ICONS = this._getBreadcrumbIcons();
            for (const action of info.actions) {
                const btn = document.createElement('button');
                btn.className = 'cell-delete-btn';
                btn.style.opacity = '1';
                btn.innerHTML = ICONS[action.icon] || '';
                btn.title = action.title || '';
                btn.addEventListener('click', action.handler);
                left.appendChild(btn);
            }

            const right = document.createElement('div');
            right.className = 'service-second-bar-right';
            const count = document.createElement('span');
            count.className = 'breadcrumb-segment';
            count.textContent = `${rootCount} ${rootCount !== 1 ? section : singular}`;
            right.appendChild(count);

            this._workspaceBreadcrumbBar.appendChild(left);
            this._workspaceBreadcrumbBar.appendChild(right);
            return;
        }

        // Root level without actions: label on left, count on right
        if (crumbs.length === 1 && rootCount !== undefined) {
            const section = crumbs[0];
            const singularMap = { Projects: 'Project', 'Environments': 'Environment', 'Knowledge Base': 'Document', Mounts: 'Mount' };
            const singular = singularMap[section] || section;
            const actionMap = { Projects: 'Create Project', 'Environments': 'Create Environment', 'Knowledge Base': 'Upload Document' };
            const actionText = actionMap[section] || `Create ${singular}`;

            const left = document.createElement('div');
            left.className = 'service-second-bar-left';
            const action = document.createElement('span');
            action.className = 'breadcrumb-segment breadcrumb-current';
            action.textContent = actionText;
            left.appendChild(action);

            const right = document.createElement('div');
            right.className = 'service-second-bar-right';
            const count = document.createElement('span');
            count.className = 'breadcrumb-segment';
            count.textContent = `${rootCount} ${rootCount !== 1 ? section : singular}`;
            right.appendChild(count);

            this._workspaceBreadcrumbBar.appendChild(left);
            this._workspaceBreadcrumbBar.appendChild(right);
            return;
        }

        // If actions are present, breadcrumbs go to top bar, icons go to second bar (left)
        if (info.actions && info.actions.length) {
            // Breadcrumbs in top bar
            if (this._workspaceTitleEl) {
                this._workspaceTitleEl.innerHTML = '';
                crumbs.forEach((text, i) => {
                    if (i > 0) {
                        const sep = document.createElement('span');
                        sep.className = 'breadcrumb-sep';
                        sep.textContent = ' / ';
                        this._workspaceTitleEl.appendChild(sep);
                    }
                    const span = document.createElement('span');
                    span.className = 'breadcrumb-segment';
                    if (i === crumbs.length - 1) span.classList.add('breadcrumb-current');
                    span.textContent = text;
                    this._workspaceTitleEl.appendChild(span);
                });
            }

            // Action icons in second bar (left-aligned)
            const left = document.createElement('div');
            left.className = 'service-second-bar-left';
            left.style.cssText = 'display:flex;align-items:center;gap:4px';
            const ICONS = this._getBreadcrumbIcons();
            for (const action of info.actions) {
                const btn = document.createElement('button');
                btn.className = 'cell-delete-btn';
                btn.style.opacity = '1';
                btn.innerHTML = ICONS[action.icon] || '';
                btn.title = action.title || '';
                btn.addEventListener('click', action.handler);
                left.appendChild(btn);
            }
            this._workspaceBreadcrumbBar.appendChild(left);
        } else {
            // Normal: breadcrumbs in second bar
            crumbs.forEach((text, i) => {
                if (i > 0) {
                    const sep = document.createElement('span');
                    sep.className = 'breadcrumb-sep';
                    sep.textContent = ' / ';
                    this._workspaceBreadcrumbBar.appendChild(sep);
                }
                const span = document.createElement('span');
                span.className = 'breadcrumb-segment';
                if (i === crumbs.length - 1) span.classList.add('breadcrumb-current');
                span.textContent = text;
                this._workspaceBreadcrumbBar.appendChild(span);
            });
        }
    }

    _checkServiceStatus(key, led, label) {
        const names = { airflow: 'Airflow', mlflow: 'MLflow', minio: 'MinIO', evidently: 'Evidently' };
        const name = names[key] || key;
        fetch(`/${key}/`)
            .then(res => {
                if (res.ok) {
                    led.classList.add('connected');
                    led.classList.remove('disconnected');
                    label.textContent = 'Connected';
                    notify.success(`${name} connected`);
                } else {
                    led.classList.add('disconnected');
                    led.classList.remove('connected');
                    label.textContent = 'unreachable';
                    notify.error(`${name} unreachable`);
                }
            })
            .catch(() => {
                led.classList.add('disconnected');
                led.classList.remove('connected');
                label.textContent = 'unreachable';
                notify.error(`${name} unreachable`);
            });
    }

    _onTabClosed(key) {
        // Clear last content key if the closed tab was our context reference
        if (this._lastContentKey === key) this._lastContentKey = null;

        // Clean up notebook editor when its tab is closed
        if (key.startsWith('notebook:')) {
            const entry = this._editors.get(key);
            if (entry) {
                // Stop kernel for this notebook if running
                if (entry.venv) {
                    this._client.stopKernel(entry.editor.notebookKey);
                }
                // Close the notebook on the server (leaves room)
                entry.editor.closeNotebook();
                // Unregister event listeners
                entry.editor.destroy?.();
                // Remove DOM container
                entry.container.remove();
                this._editors.delete(key);
            }
            // If no notebook tab is active after close, clear notebook state
            const activeKey = this._tabBar.activeKey;
            if (!activeKey || !activeKey.startsWith('notebook:')) {
                this._activeEditorKey = null;
                this._currentProject = null;
                this._currentNotebook = null;
                this._activeVenv = null;
            }
        }
        // Clean up pyfile editor when its tab is closed
        if (key.startsWith('pyfile:')) {
            const editor = this._fileEditors.get(key);
            if (editor) {
                editor.destroy();
                this._fileEditors.delete(key);
            }
        }
        // Clean up detail tab when closed (only if not undocked)
        if (key.startsWith('detail:') && !this._undockedPanels.has(key)) {
            this._detailTabs.delete(key);
        }
        // Clean up media viewer when its tab is closed
        if (key.startsWith('media:')) {
            const viewer = this._mediaViewers.get(key);
            if (viewer) {
                viewer.destroy();
                this._mediaViewers.delete(key);
            }
        }
        // Clean up document viewer when its tab is closed
        if (key.startsWith('doc:')) {
            this._documentTabs.delete(key);
            this._documentEditMode.delete(key);
            // Dispose the per-tab viewer so its PDF.js doc + rendered page
            // canvases get freed (otherwise the bitmaps leak in browser RAM).
            const perTab = this._documentViewers.get(key);
            if (perTab) {
                perTab.clear();
                this._documentViewers.delete(key);
            }
            // Singleton helper: clear if no doc tabs remain so its
            // _currentDoc state doesn't linger.
            const hasOtherDocTabs = [...this._documentTabs.keys()].length > 0;
            if (!hasOtherDocTabs && this._documentViewer) {
                this._documentViewer.clear();
            }
        }
        // Clean up markdown preview tab
        if (key.startsWith('mdpreview:')) {
            const previewData = this._mdPreviewTabs?.get(key);
            if (previewData) {
                // Remove onContentChange listener from source editor
                const sourceEditor = this._fileEditors.get(previewData.sourceKey);
                if (sourceEditor) sourceEditor.onContentChange = null;
            }
            this._mdPreviewTabs?.delete(key);
        }
        // Hide persistent service wrapper (visibility keeps iframe connections alive)
        if (this._serviceIframes[key]) {
            this._serviceIframes[key].style.visibility = 'hidden';
            this._serviceIframes[key].style.position = 'absolute';
            this._serviceIframes[key].style.width = '0';
            this._serviceIframes[key].style.height = '0';
            this._serviceIframes[key].style.overflow = 'hidden';
        }
        this._syncIconBar();
    }

    _generateUserName() {
        const adjectives = [
            'Swift', 'Bright', 'Calm', 'Dark', 'Eager',
            'Fair', 'Grand', 'Happy', 'Iron', 'Keen'
        ];
        const nouns = [
            'Fox', 'Owl', 'Bear', 'Wolf', 'Hawk',
            'Lynx', 'Crow', 'Deer', 'Hare', 'Dove'
        ];
        const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
        const noun = nouns[Math.floor(Math.random() * nouns.length)];
        return `${adj}${noun}`;
    }
}

// --- Bootstrap ---
const app = new App();
// Expose globally so leaf components (ChatPanel, popups, etc.) can
// reach app-level surfaces (current project, panels, modal helpers)
// without each caller plumbing the instance through callbacks. Matches
// the ctx.app pattern already used by ExplorerContextMenu.
window.app = app;
app.init().catch(err => console.error('App init failed:', err));
