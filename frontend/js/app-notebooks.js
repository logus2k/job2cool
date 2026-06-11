/**
 * app-notebooks.js - Notebook lifecycle and venv management.
 *
 * Handles:
 * - Project change (closing old notebook, opening new)
 * - Creating NotebookEditor instances with all callbacks
 * - Editor activation/deactivation
 * - Notebook open/change with tab creation
 * - Venv selection, project default venv, venv cache
 * - Kernel start
 *
 * Attached to the App instance via initNotebooks(app).
 */

import { NotebookEditor } from './NotebookEditor.js';
import { notify } from './Notify.js';

/**
 * Attach notebook lifecycle methods to the App instance.
 * @param {object} app - The App instance
 */
export function initNotebooks(app) {

    app._onProjectChange = async function(projectId) {
        if (app._currentNotebook && app._editor) {
            app._editor.closeNotebook();
        }
        app._currentProject = projectId;
        app._currentNotebook = null;
        app._activeVenv = null;
        app._loadProjectVenvCache(projectId);

        app._editor?.setProject(projectId);
        app._editor?.setNotebook(null);
        app._editor?.setVenv(null, null);
    }

    /**
     * Create a new NotebookEditor for a notebook, with its own container div.
     */
    app._createNotebookEditor = function(notebookKey, projectId, notebookName) {
        const container = document.createElement('div');
        container.className = 'notebook-editor-pane';
        container.dataset.notebookKey = notebookKey;
        container.style.display = 'none';
        app._notebookContainer.appendChild(container);

        const editor = new NotebookEditor(container, app._client);
        app._wireEditorCallbacks(editor);

        const entry = { editor, container, project: projectId, notebook: notebookName, venv: null };
        app._editors.set(notebookKey, entry);
        return entry;
    }

    /**
     * Wire standard callbacks on a NotebookEditor instance.
     */
    app._wireEditorCallbacks = function(editor) {
        editor.onCellsChanged = () => {
            if (editor === app._editor) {
                editor.updateNotesBadge(app._toolbar?.countNotes() || 0);
                app._tocPanel?.refresh();
            }
        };
        editor.onEnsureKernel = () => {
            const entry = app._editors.get(app._activeEditorKey);
            const venv = entry?.venv;
            if (app._kernelRunning) return Promise.resolve(true);
            if (!venv) return Promise.resolve(false);
            // If kernel is restarting, wait for it instead of starting a new one
            if (app._kernelStarting) {
                return new Promise((resolve) => {
                    const onStatus = (data) => {
                        if (data.status === 'idle' || data.status === 'busy') {
                            app._client.off('kernel:status', onStatus);
                            resolve(true);
                        } else if (data.status === 'dead') {
                            app._client.off('kernel:status', onStatus);
                            resolve(false);
                        }
                    };
                    app._client.on('kernel:status', onStatus);
                });
            }
            return new Promise((resolve) => {
                const onStatus = (data) => {
                    if (data.status === 'idle' || data.status === 'busy') {
                        app._client.off('kernel:status', onStatus);
                        resolve(true);
                    }
                };
                app._client.on('kernel:status', onStatus);
                app._client.startKernel(venv.runtimeId, venv.name, editor.notebookKey);
            });
        };
        editor.setGetEnvs(async () => {
            try {
                const resp = await fetch('api/venvs');
                if (!resp.ok) return [];
                return await resp.json();
            } catch { return []; }
        });
        editor.setOnKernelSelect((venv) => {
            // Find the key for this editor
            let editorKey = null;
            for (const [key, entry] of app._editors) {
                if (entry.editor === editor) { editorKey = key; break; }
            }
            app._onVenvSelect(venv, editorKey);
        });
        editor.setOnCreateEnv(() => {
            app._sidebar.show('projects');
            app._openWorkspaceTab();
            app._syncIconBar();
            app._explorerPanel.navigate({
                currentProject: app._currentProject,
                currentNotebook: app._currentNotebook,
                navigateToEnvs: true,
            });
        });
        editor.setOnPostItToggle(() => app._toolbar._postItIndex.toggle());
        editor.setOnSave(() => editor.save());
        editor.setOnSaved(() => app._gitPanel?.refresh());
        editor.onDiagnosticsChange = (diags) => {
            const activeKey = app._tabBar?.activeKey;
            if (activeKey?.startsWith('notebook:')) {
                const entry = app._editors.get(activeKey);
                if (entry?.editor === editor) app._updateProblemsStatus(diags);
            }
        };
        editor.setOnRunsToggle(() => app._runManager?.toggle());
        editor._showComposePanel = () => {
            const meta = editor._notebook?.metadata?.noted;
            const selections = meta?.hydra_selections || null;
            const baselineSource = meta?.hydra_baseline_source || 'project://config/';
            const notebookUid = meta?.notebook_uid || null;
            app._explorerPanel._externalViews.openComposePanel?.(
                app._currentProject,
                selections,
                (newSelections) => editor.setHydraSelections(newSelections),
                { baselineSource, notebookUid },
            );
        };
        editor.onRunIndicatorClick = async (runId) => {
            // Navigate to the run in Experiments tree
            const tree = app._explorerPanel?._tree;
            let node = tree?.findFirst(n => n.key?.includes(runId));
            if (node) { node.setActive(true); return; }

            // Node not loaded yet. Open sidebar, expand experiments,
            // then expand each experiment until the run appears.
            app._sidebar.show('projects');
            const root = tree?.findKey('root-experiments');
            if (!root) return;
            await root.setExpanded(true);

            node = tree?.findFirst(n => n.key?.includes(runId));
            if (node) { node.setActive(true); return; }

            for (const expNode of root.children || []) {
                await expNode.setExpanded(true);
                node = tree?.findFirst(n => n.key?.includes(runId));
                if (node) { node.setActive(true); return; }
            }
            // Run not found - at least show experiments section
            root.setActive(true);
        };
        editor.setOnMetricsToggle(async () => {
            // If panel has no traces, try to recover from notebook metadata
            if (app._metricsPanel && Object.keys(app._metricsPanel._traces || {}).length === 0) {
                const lastRunId = editor._notebook?.metadata?.noted?.last_run_id;
                if (lastRunId) {
                    try {
                        const runResp = await fetch(`api/mlflow/runs/${lastRunId}`);
                        if (runResp.ok) {
                            const runData = await runResp.json();
                            const metricKeys = Object.keys(runData.metrics || {});
                            if (metricKeys.length > 0) {
                                const metricsMap = {};
                                await Promise.all(metricKeys.map(async (key) => {
                                    const resp = await fetch(`api/mlflow/runs/${lastRunId}/metrics/${encodeURIComponent(key)}`);
                                    if (resp.ok) {
                                        const data = await resp.json();
                                        metricsMap[key] = data.history || [];
                                    }
                                }));
                                // Pre-populate traces
                                app._metricsPanel._runId = lastRunId;
                                for (const [key, history] of Object.entries(metricsMap)) {
                                    app._metricsPanel._traces[key] = { x: [], y: [] };
                                    app._metricsPanel._traceOrder.push(key);
                                    for (const point of history) {
                                        app._metricsPanel._traces[key].x.push(point.step);
                                        app._metricsPanel._traces[key].y.push(point.value);
                                    }
                                }
                            }
                        }
                    } catch { /* ignore - just open empty */ }
                }
            }
            app._metricsPanel?.toggle();
        });
        editor.setOnUndock(() => {
            for (const [key, entry] of app._editors) {
                if (entry.editor === editor) {
                    editor.undocked = true;
                    app._tabBar.undockTab(key);
                    break;
                }
            }
        });
        editor.setOnDock(() => {
            for (const [key, entry] of app._editors) {
                if (entry.editor === editor) {
                    const panel = app._undockedPanels.get(key);
                    if (panel) { panel._docking = true; panel.close(); }
                    break;
                }
            }
        });
        editor.setOnClose(() => {
            for (const [key, entry] of app._editors) {
                if (entry.editor === editor) {
                    app._tabBar.closeTab(key);
                    break;
                }
            }
        });
        editor.setOnRunManagerRefresh(() => app._runManager?.refresh());
        editor.setGetActiveRunId(() => app._runManager?.activeRunId);
        editor.onSelectionChange = (anchorIndex) => {
            // Canonical hook for "current cell" - fires from
            // NotebookSelection.updateSelectionVisuals() so it covers code
            // AND markdown (rendered or editing), keyboard nav, programmatic
            // selection (e.g. scroll_to_cell from chat), and click selection.
            if (editor === app._editor || app._undockedPanels.has(editor._notebookKey)) {
                app._updateStatusCellOrdinal(anchorIndex, editor._cells?.length || 0);
            }
        };
        editor.onCursorActivity = (info) => {
            if (editor === app._editor || app._undockedPanels.has(editor._notebookKey)) app._updateStatusCursor(info);
            // Update Documentation panel for notebook cells
            if (info && info.cellIndex != null && info.lang === 'Python' && app._docPanel) {
                app._docPanel.onNotebookCursorMove(
                    editor._projectId, editor._venvName || '',
                    editor._notebookPath, info.cellIndex,
                    (info.line || 1) - 1, (info.col || 1) - 1
                );
            }
        };
    }

    /**
     * Activate a notebook editor by key, hiding all others.
     */
    app._activateEditor = function(notebookKey) {
        // Hide all editor containers
        for (const [key, entry] of app._editors) {
            entry.container.style.display = key === notebookKey ? '' : 'none';
        }
        app._activeEditorKey = notebookKey;

        // Update current project/notebook to match the active editor
        const entry = app._editors.get(notebookKey);
        if (entry) {
            app._currentProject = entry.project;
            app._currentNotebook = entry.notebook;
            app._activeVenv = entry.venv;
        }
    }

    app._onNotebookChange = async function(projectId, notebookName, { preview = false } = {}) {
        if (!projectId || !notebookName) return;

        const notebookKey = `notebook:${projectId}:${notebookName}`;

        // If this notebook is already open, just activate (and pin if it was preview)
        if (app._editors.has(notebookKey)) {
            // If undocked, bring the floating panel to front
            const undockedPanel = app._undockedPanels.get(notebookKey);
            if (undockedPanel) {
                undockedPanel.front();
                return;
            }
            if (!preview) app._tabBar.pinTab(notebookKey);
            app._activateEditor(notebookKey);
            app._tabBar.activate(notebookKey);
            app._gitPanel?.setProject(projectId);
            app._updateStatusProject(projectId);
            app._updateStatusBranch(projectId);
            return;
        }

        // Create a new editor for this notebook
        const entry = app._createNotebookEditor(notebookKey, projectId, notebookName);
        // _activateEditor will be called by _onTabActivated when addTab triggers activate

        app._currentProject = projectId;
        app._currentNotebook = notebookName;

        app._gitPanel?.setProject(projectId);
        app._updateStatusProject(projectId);
        app._updateStatusBranch(projectId);
        const displayName = `Projects/${projectId}/${notebookName}`;
        entry.editor.setProject('');
        entry.editor.setNotebook(displayName);

        const shortName = notebookName.includes('/') ? notebookName.split('/').pop() : notebookName;

        // Add closable notebook tab
        const tabOpts = {
            key: notebookKey,
            label: shortName,
            type: 'notebook',
            closable: true,
            undockable: true,
            tooltip: `${projectId}/${notebookName}`,
        };
        if (preview) tabOpts.preview = true;
        app._tabBar.addTab(tabOpts);

        app._sidebar.updateViewTitle('toc', shortName);
        entry.editor.openNotebook(projectId, notebookName, app._userName);

        // Restore venv from notebook metadata, or fall back to project default
        await entry.editor.ready;
        let savedVenv = entry.editor.getVenvMetadata();
        // Fall back to project default if notebook has no venv
        if (!savedVenv?.name) {
            const projectDefault = await app._resolveFileVenv(projectId, '');
            if (projectDefault) {
                savedVenv = { name: projectDefault.name, runtimeId: projectDefault.runtime_id };
            }
        }
        if (savedVenv?.name) {
            try {
                const resp = await fetch('api/envs');
                if (resp.ok) {
                    const envs = await resp.json();
                    const match = envs.find(v => v.name === savedVenv.name && (!savedVenv.runtimeId || v.runtime_id === savedVenv.runtimeId));
                    if (match) {
                        const dn = match.python_version ? `Python ${match.python_version}` : match.display_name;
                        entry.venv = { name: match.name, runtimeId: match.runtime_id, displayName: dn };
                        app._activeVenv = entry.venv;
                        entry.editor.setVenv(match.name, dn, match.runtime_id);
                        app._client.startKernel(match.runtime_id, match.name, entry.editor.notebookKey);
                    }
                }
            } catch { /* ignore */ }
        }

        // Update URL
        const url = new URL(window.location);
        url.searchParams.set('project', projectId);
        url.searchParams.set('notebook', notebookName);
        window.history.replaceState({}, '', url);
    }

    app._onVenvSelect = function(venv, editorKey) {
        app._activeVenv = venv;
        // Update per-editor venv state
        const targetKey = editorKey || app._activeEditorKey;
        const entry = app._editors.get(targetKey);
        if (entry) entry.venv = venv;
        if (venv) {
            const displayName = venv.pythonVersion
                ? `Python ${venv.pythonVersion}`
                : venv.displayName
                    || (venv.runtimeId ? venv.runtimeId.replace(/^(\w)/, c => c.toUpperCase()).replace('/', ' ') : null);
            venv.displayName = displayName;
            const targetEditor = entry?.editor || app._editor;
            targetEditor?.setVenv(venv.name, displayName, venv.runtimeId);
            if (entry?.notebook && targetEditor) {
                app._client.startKernel(venv.runtimeId, venv.name, targetEditor.notebookKey);
            }
        } else {
            const targetEditor = entry?.editor || app._editor;
            targetEditor?.setVenv(null);
        }
    }

    app._onProjectDefaultVenvChanged = function(projectId, venv) {
        // Update cache
        if (!app._projectVenvCache) app._projectVenvCache = {};
        if (venv) {
            app._projectVenvCache[projectId] = venv;
        } else {
            delete app._projectVenvCache[projectId];
        }
        // Update all open file editors for this project that use the project default
        if (app._fileEditors) {
            for (const [key, editor] of app._fileEditors) {
                // key: pyfile:projectId:filename
                if (!key.startsWith(`pyfile:${projectId}:`)) continue;
                editor.setEnv(venv?.name || '');
            }
        }
    }

    app._loadProjectVenvCache = async function(projectId) {
        if (!app._projectVenvCache) app._projectVenvCache = {};
        try {
            const resp = await fetch(`api/projects/${encodeURIComponent(projectId)}/settings`);
            if (resp.ok) {
                const settings = await resp.json();
                if (settings.default_venv) {
                    app._projectVenvCache[projectId] = settings.default_venv;
                }
            }
        } catch { /* ignore */ }
    }

    app._offerProjectDefaultVenv = async function(projectId, filePath, venv) {
        try {
            const resp = await fetch(`api/projects/${encodeURIComponent(projectId)}/settings`);
            const settings = resp.ok ? await resp.json() : {};
            if (settings.default_venv) {
                // Project already has a default - store as per-file override if different
                if (settings.default_venv.name !== venv.name) {
                    const overrides = settings.venv_overrides || {};
                    overrides[filePath] = { name: venv.name, runtime_id: venv.runtime_id };
                    await fetch(`api/projects/${encodeURIComponent(projectId)}/settings`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ venv_overrides: overrides }),
                    });
                }
                return;
            }
            // No default yet - ask user
            const { modalConfirm } = await import('./modal.js');
            const confirmed = await modalConfirm(
                `Set "${venv.name}" as the default environment for this project? All files and notebooks will use it unless overridden.`,
                { title: 'Set Project Default', confirmText: 'Set Default', cancelText: 'Just This File' }
            );
            if (confirmed) {
                await fetch(`api/projects/${encodeURIComponent(projectId)}/settings`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ default_venv: { name: venv.name, runtime_id: venv.runtime_id } }),
                });
            } else {
                // Per-file override
                const overrides = settings.venv_overrides || {};
                overrides[filePath] = { name: venv.name, runtime_id: venv.runtime_id };
                await fetch(`api/projects/${encodeURIComponent(projectId)}/settings`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ venv_overrides: overrides }),
                });
            }
        } catch { /* ignore */ }
    }

    app._resolveFileVenv = async function(projectId, filePath) {
        try {
            const resp = await fetch(`api/projects/${encodeURIComponent(projectId)}/settings`);
            if (!resp.ok) return null;
            const settings = await resp.json();
            // Per-file override takes priority
            const overrides = settings.venv_overrides || {};
            if (overrides[filePath]) return overrides[filePath];
            // Project default
            if (settings.default_venv) return settings.default_venv;
        } catch { /* ignore */ }
        return null;
    }

    app._onVenvDeleted = function(deletedName) {
        if (!deletedName || !app._activeVenv) return;
        if (app._activeVenv.name === deletedName) {
            if (app._editor) app._client.stopKernel(app._editor.notebookKey);
            app._activeVenv = null;
            const entry = app._editors.get(app._activeEditorKey);
            if (entry) entry.venv = null;
            app._editor?.setVenv(null);
        }
    }

    app._onStartKernel = function() {
        if (!app._activeVenv) {
            notify.warning('Select a environment first');
            return;
        }
        if (!app._editor) return;
        app._client.startKernel(app._activeVenv.runtimeId, app._activeVenv.name, app._editor.notebookKey);
    }

}
