/**
 * app-file-editors.js - File and media editor lifecycle management.
 *
 * Handles:
 * - Creating and managing FileEditor instances for .py, .md, and other text files
 * - Creating and managing MediaViewer instances for images, PDFs, etc.
 * - File tab preview/open/close with venv resolution and LSP connection
 * - File editor toolbar (save, details, run, venv selector, markdown preview)
 * - Cross-file go-to-definition navigation
 * - Tab tooltip generation
 *
 * Attached to the App instance via initFileEditors(app).
 */

import { FileEditor } from './FileEditor.js';
import { MediaViewer } from './MediaViewer.js';
import { DebugClient } from './DebugClient.js';
import { notify } from './Notify.js';
import { openProjectTerminal } from './ProjectTerminal.js';

/**
 * Attach file/media editor methods to the App instance.
 * @param {object} app - The App instance
 */
export function initFileEditors(app) {

    /**
     * Ensure a FileEditor exists for a tab key, creating one if needed.
     * Resolves the project venv before opening so LSP connects with the right env.
     */
    app._ensureFileEditor = function(tabKey, projectId, filename) {
        if (!app._fileEditors.has(tabKey)) {
            const editor = new FileEditor();
            editor.onDirtyChange = (dirty) => {
                const tab = app._tabBar._tabs.get(tabKey);
                if (tab) {
                    const baseName = filename.includes('/') ? filename.split('/').pop() : filename;
                    tab.label = dirty ? `${baseName} *` : baseName;
                    if (tab.preview) app._tabBar.pinTab(tabKey);
                    app._tabBar._render();
                }
            };
            editor.onCursorActivity = (info) => {
                app._updateStatusCursor(info);
                if (info && app._docPanel) {
                    app._docPanel.onCursorMove(
                        projectId, editor._envName || '', filename,
                        (info.line || 1) - 1, (info.col || 1) - 1
                    );
                }
            };
            editor.onDiagnosticsChange = (diags) => {
                if (app._tabBar?.activeKey === tabKey) app._updateProblemsStatus(diags);
            };
            editor.onCrossFileNav = (projId, targetPath, targetLine) => {
                app._openFileTab(projId, targetPath);
                const targetKey = `pyfile:${projId}:${targetPath}`;
                const tryJump = () => {
                    const targetEditor = app._fileEditors.get(targetKey);
                    if (targetEditor?._editorView) {
                        const line = targetEditor._editorView.state.doc.line(targetLine + 1);
                        targetEditor._editorView.dispatch({
                            selection: { anchor: line.from },
                            scrollIntoView: true,
                        });
                        targetEditor._editorView.focus();
                    }
                };
                requestAnimationFrame(() => requestAnimationFrame(tryJump));
            };
            const rootType = app._explorerPanel?._projectSources?.[projectId] === 'mount' ? 'mount' : 'project';
            app._resolveFileVenv(projectId, filename).then(venv => {
                if (venv) {
                    editor._envName = venv.name;
                    editor._envRuntimeId = venv.runtime_id;
                    if (!app._projectVenvCache) app._projectVenvCache = {};
                    app._projectVenvCache[projectId] = venv;
                }
            }).finally(() => {
                editor.open(projectId, filename, rootType);
                if (editor._onEnvResolved) editor._onEnvResolved();
            });
            app._fileEditors.set(tabKey, editor);
        }
    };

    /** Open a file as a preview tab (replaced by next preview). */
    app._previewFileTab = function(projectId, filename, hostPath) {
        const tabKey = `pyfile:${projectId}:${filename}`;
        const undocked = app._undockedPanels.get(tabKey);
        if (undocked) { undocked.front(); return; }
        if (hostPath) app._mountHostPaths = app._mountHostPaths || {};
        if (hostPath) app._mountHostPaths[tabKey] = hostPath;
        app._ensureFileEditor(tabKey, projectId, filename);
        const tooltip = app._buildTabTooltip(projectId, filename, hostPath);
        app._tabBar.addTab({
            key: tabKey,
            label: filename.includes('/') ? filename.split('/').pop() : filename,
            tooltip,
            type: 'pyfile',
            closable: true,
            undockable: true,
            preview: true,
        });
    };

    /** Open a file as a pinned tab. */
    app._openFileTab = function(projectId, filename, hostPath) {
        const tabKey = `pyfile:${projectId}:${filename}`;
        const undocked = app._undockedPanels.get(tabKey);
        if (undocked) { undocked.front(); return; }
        if (hostPath) app._mountHostPaths = app._mountHostPaths || {};
        if (hostPath) app._mountHostPaths[tabKey] = hostPath;
        app._ensureFileEditor(tabKey, projectId, filename);
        const tooltip = app._buildTabTooltip(projectId, filename, hostPath);
        app._tabBar.addTab({
            key: tabKey,
            label: filename.includes('/') ? filename.split('/').pop() : filename,
            tooltip,
            type: 'pyfile',
            closable: true,
            undockable: true,
        });
    };

    /**
     * Build the toolbar bars for a file editor tab.
     * Includes breadcrumbs, save/details buttons, run button (for .py),
     * venv selector, and markdown preview toggle (for .md).
     */
    app._buildFileBars = function(key) {
        const rest = key.substring(7);
        const colonIdx = rest.indexOf(':');
        const name = rest.substring(0, colonIdx);
        const filename = rest.substring(colonIdx + 1);
        const hostPath = app._explorerPanel?._mountHostPaths?.[name] || '';
        const isMount = app._explorerPanel?._projectSources?.[name] === 'mount';

        const frag = document.createDocumentFragment();

        // First bar: breadcrumbs + undock/close
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
        const spacer = document.createElement('span');
        spacer.style.cssText = 'flex:1';
        bar.appendChild(title);
        bar.appendChild(spacer);

        const undockBtn = document.createElement('button');
        undockBtn.className = 'info-bar-text-btn';
        undockBtn.innerHTML = '<i class="fa-solid fa-up-right-from-square" style="font-size:12px;color:#555555"></i>';
        undockBtn.title = 'Undock to floating panel';
        undockBtn.addEventListener('click', () => app._tabBar.undockTab(key));
        bar.appendChild(undockBtn);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'info-bar-text-btn';
        closeBtn.innerHTML = '<i class="fa-solid fa-xmark" style="font-size:14px;color:#555555"></i>';
        closeBtn.title = 'Close';
        closeBtn.addEventListener('click', () => app._tabBar.closeTab(key));
        bar.appendChild(closeBtn);

        frag.appendChild(bar);

        // Second bar: save, details, run, venv selector
        const secondBar = app._buildSecondBar();
        const leftGroup = document.createElement('div');
        leftGroup.className = 'service-second-bar-left';

        const FS = 'stroke="#555" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
        const saveBtn = document.createElement('button');
        saveBtn.className = 'info-bar-text-btn';
        saveBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ${FS}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" fill="#4caf50"/><polygon points="17 21 17 13 7 13 7 21" fill="#fff2bc"/><polyline points="7 3 7 8 15 8" fill="#cecece"/></svg>`;
        saveBtn.title = 'Save';
        saveBtn.addEventListener('click', () => {
            const editor = app._fileEditors.get(key);
            if (editor) editor.save();
        });
        leftGroup.appendChild(saveBtn);

        const detailBtn = document.createElement('button');
        detailBtn.className = 'info-bar-text-btn';
        detailBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" fill="#4a90d9"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
        detailBtn.title = 'File Details';
        detailBtn.addEventListener('click', () => {
            const treePrefix = isMount ? 'm' : 'p';
            const treeKey = `${treePrefix}file:${name}:${filename}`;
            app._tabBar.activate('workspace');
            const node = app._explorerPanel._tree?.findKey(treeKey);
            if (node) node.setActive(true);
        });
        leftGroup.appendChild(detailBtn);

        // Markdown preview button - opens rendered preview in a new tab
        const ext = filename.split('.').pop().toLowerCase();
        if (ext === 'md' || ext === 'markdown') {
            const previewBtn = document.createElement('button');
            previewBtn.className = 'info-bar-text-btn';
            previewBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#333333" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3" fill="#8e44ad"/></svg>`;
            previewBtn.title = 'Preview Markdown';
            previewBtn.addEventListener('click', () => {
                const editor = app._fileEditors.get(key);
                if (!editor) return;
                const previewKey = `mdpreview:${key}`;
                const shortName = filename.includes('/') ? filename.split('/').pop() : filename;

                // If preview already exists (docked or undocked), just activate it
                if (app._tabBar._tabs.has(previewKey)) {
                    if (app._tabBar.isUndocked(previewKey)) {
                        // Bring the undocked panel to front
                        const panel = app._undockedPanels.get(previewKey);
                        if (panel) panel.front();
                    } else {
                        app._tabBar.activate(previewKey);
                    }
                    return;
                }

                if (!app._mdPreviewTabs) app._mdPreviewTabs = new Map();
                app._mdPreviewTabs.set(previewKey, { markdown: editor.getContent(), filename, sourceKey: key });

                // addTab triggers _activateTab which handles all rendering
                app._tabBar.addTab({
                    key: previewKey,
                    label: `${shortName} (Preview)`,
                    type: 'service',
                    closable: true,
                    undockable: true,
                });
            });
            leftGroup.appendChild(previewBtn);
        }

        // Run button + venv selector (for .py, .js, and .r files)
        if (ext === 'py' || ext === 'js' || ext === 'mjs' || ext === 'ts' || ext === 'r') {
            let selectedVenv = null;
            let selectedVenvRuntimeId = null;

            const fileEditor = app._fileEditors.get(key);
            if (fileEditor?._envName) {
                selectedVenv = fileEditor._envName;
                selectedVenvRuntimeId = fileEditor._envRuntimeId || null;
            } else if (app._projectVenvCache?.[name]?.name) {
                selectedVenv = app._projectVenvCache[name].name;
                selectedVenvRuntimeId = app._projectVenvCache[name].runtime_id;
                if (fileEditor) fileEditor._envName = selectedVenv;
            }

            const activeVenv = app._explorerPanel?.activeVenvName;
            const activeRuntimeId = app._explorerPanel?.activeVenvRuntimeId;
            if (activeVenv) {
                selectedVenv = activeVenv;
                selectedVenvRuntimeId = activeRuntimeId;
            }

            let fileRunMode = 'run';

            const runBtn = document.createElement('button');
            runBtn.className = 'info-bar-text-btn';
            runBtn.innerHTML = '<i class="fa-solid fa-play" style="font-size:12px;color:#4caf50"></i>';
            runBtn.title = 'Run with selected environment';

            const doRun = () => {
                if (!selectedVenv) {
                    notify.warning('Select an environment first');
                    return;
                }
                const socket = app._client?.socket;
                if (!socket) return;
                const repoPath = isMount
                    ? `/app/mounts/${name}`
                    : `/app/data/projects/${name}`;
                const isJS = selectedVenvRuntimeId?.startsWith('javascript');
                const isR = selectedVenvRuntimeId?.startsWith('r/');
                const runCmd = isJS
                    ? `node ${filename}`
                    : isR
                        ? `/app/data/environments/${selectedVenvRuntimeId}/${selectedVenv}/bin/Rscript ${filename}`
                        : `/app/data/environments/${selectedVenvRuntimeId || 'python/3.12'}/${selectedVenv}/bin/python ${filename}`;
                const shortName = filename.split('/').pop();
                openProjectTerminal(socket, repoPath, `${shortName} (${selectedVenv})`, {
                    initialCommand: runCmd,
                    panelIcon: 'fa-play',
                    panelIconColor: '#4caf50',
                });
            };

            const doDebug = () => {
                if (!selectedVenv) {
                    notify.warning('Select an environment first');
                    return;
                }
                if (app._fileDebugStarting || app._fileDebugSessionId) return;
                app._fileDebugStarting = true;
                app._debugFile(key, name, filename, selectedVenv, selectedVenvRuntimeId, isMount, debugBar, debugStatus)
                    .finally(() => { app._fileDebugStarting = false; });
            };

            runBtn.addEventListener('click', () => {
                if (fileRunMode === 'debug') doDebug();
                else doRun();
            });
            leftGroup.appendChild(runBtn);

            // Debug chevron dropdown
            const chevron = document.createElement('button');
            chevron.innerHTML = '<span style="font-size:8px;color:#333">\u25BC</span>';
            chevron.title = 'Switch run mode';
            chevron.style.cssText = 'padding:0;margin-left:-8px;background:none;border:none;cursor:pointer';
            chevron.addEventListener('click', (e) => {
                e.stopPropagation();
                const existing = document.querySelector('.cell-run-dropdown');
                if (existing) { existing.remove(); return; }
                const dd = document.createElement('div');
                dd.className = 'cell-run-dropdown';
                const items = [
                    { mode: 'run', icon: '<span style="color:#4caf50;-webkit-text-stroke:1.5px #202020;paint-order:stroke fill">\u25B6</span>', label: 'Run File' },
                    { mode: 'debug', icon: '<i class="fa-solid fa-bug" style="color:#e53935;-webkit-text-stroke:1.5px #202020;paint-order:stroke fill"></i>', label: 'Debug File' },
                ];
                for (const item of items) {
                    const row = document.createElement('div');
                    row.className = 'cell-run-dropdown-item';
                    if (item.mode === fileRunMode) row.classList.add('active');
                    row.innerHTML = `<span class="cell-run-dropdown-icon">${item.icon}</span>${item.label}`;
                    row.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        fileRunMode = item.mode;
                        if (item.mode === 'debug') {
                            runBtn.innerHTML = '<i class="fa-solid fa-bug" style="font-size:11px;color:#e53935"></i>';
                            runBtn.title = 'Debug with selected environment';
                        } else {
                            runBtn.innerHTML = '<i class="fa-solid fa-play" style="font-size:12px;color:#4caf50"></i>';
                            runBtn.title = 'Run with selected environment';
                        }
                        dd.remove();
                    });
                    dd.appendChild(row);
                }
                const rect = chevron.getBoundingClientRect();
                dd.style.position = 'fixed';
                dd.style.left = `${rect.left}px`;
                dd.style.top = `${rect.bottom + 2}px`;
                document.body.appendChild(dd);
                const close = (ev) => {
                    if (!dd.contains(ev.target)) { dd.remove(); document.removeEventListener('mousedown', close); }
                };
                dd.addEventListener('mouseleave', () => { dd.remove(); document.removeEventListener('mousedown', close); });
                requestAnimationFrame(() => document.addEventListener('mousedown', close));
            });
            leftGroup.appendChild(chevron);

            // Venv selector
            const rightGroup = document.createElement('div');
            rightGroup.className = 'second-bar-right';

            const venvItem = document.createElement('div');
            venvItem.className = 'info-bar-kernel';

            const venvDot = document.createElement('span');
            venvDot.className = 'kernel-status-dot' + (selectedVenv ? ' idle' : ' dead');

            const venvLabelEl = document.createElement('span');
            venvLabelEl.className = 'info-bar-label';
            venvLabelEl.textContent = selectedVenv || 'Select Environment';

            venvItem.append(venvDot, venvLabelEl);

            const editorRef = app._fileEditors.get(key);
            if (editorRef) {
                editorRef._onEnvResolved = () => {
                    if (editorRef._envName && !selectedVenv) {
                        selectedVenv = editorRef._envName;
                        selectedVenvRuntimeId = editorRef._envRuntimeId;
                        venvLabelEl.textContent = selectedVenv;
                        venvDot.className = 'kernel-status-dot idle';
                    }
                };
            }

            let pickerEl = null;
            venvItem.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (pickerEl) { pickerEl.remove(); pickerEl = null; return; }

                const picker = document.createElement('div');
                picker.className = 'kernel-picker';
                pickerEl = picker;

                const rect = venvItem.getBoundingClientRect();
                picker.style.position = 'fixed';
                picker.style.top = (rect.bottom + 4) + 'px';
                picker.style.right = (window.innerWidth - rect.right) + 'px';

                picker.innerHTML = '<div class="kernel-picker-loading">Loading...</div>';
                document.body.appendChild(picker);

                let leaveTimer = null;
                const closePicker = (ev) => {
                    if (ev && picker.contains(ev.target)) return;
                    if (ev && venvItem.contains(ev.target)) return;
                    clearTimeout(leaveTimer);
                    picker.remove();
                    pickerEl = null;
                    document.removeEventListener('click', closePicker);
                };
                setTimeout(() => document.addEventListener('click', closePicker), 0);

                picker.addEventListener('mouseleave', () => {
                    leaveTimer = setTimeout(() => closePicker(), 300);
                });
                picker.addEventListener('mouseenter', () => clearTimeout(leaveTimer));
                venvItem.addEventListener('mouseenter', () => clearTimeout(leaveTimer));

                let envs = [];
                try {
                    const resp = await fetch('api/venvs');
                    if (resp.ok) envs = await resp.json();
                } catch { /* empty */ }

                if (!pickerEl) return;
                picker.innerHTML = '';

                const pickerTitle = document.createElement('div');
                pickerTitle.className = 'kernel-picker-title';
                pickerTitle.textContent = 'Select Environment';
                picker.appendChild(pickerTitle);

                if (envs.length === 0) {
                    const empty = document.createElement('div');
                    empty.className = 'kernel-picker-empty';
                    empty.textContent = 'No environments found';
                    picker.appendChild(empty);
                }

                const list = document.createElement('div');
                list.className = 'kernel-picker-list';
                for (const env of envs) {
                    const item = document.createElement('div');
                    item.className = 'kernel-picker-item';
                    if (selectedVenv === env.name) item.classList.add('active');

                    const starCol = document.createElement('span');
                    starCol.className = 'kernel-picker-star';
                    if (selectedVenv === env.name) {
                        starCol.innerHTML = '<i class="fa-solid fa-star"></i>';
                    }
                    item.appendChild(starCol);

                    const envNameEl = document.createElement('span');
                    envNameEl.className = 'kernel-picker-name';
                    envNameEl.textContent = env.name;

                    const ver = document.createElement('span');
                    ver.className = 'kernel-picker-version';
                    ver.textContent = env.python_version ? `Python ${env.python_version}` : env.display_name || '';

                    item.append(envNameEl, ver);
                    item.addEventListener('click', async (ev) => {
                        ev.stopPropagation();
                        selectedVenv = env.name;
                        selectedVenvRuntimeId = env.runtime_id;
                        venvLabelEl.textContent = env.name;
                        venvDot.className = 'kernel-status-dot idle';
                        closePicker();
                        const fe = app._fileEditors.get(key);
                        if (fe) {
                            fe.setEnv(env.name);
                            fe._envRuntimeId = env.runtime_id;
                        }
                        app._offerProjectDefaultVenv(name, filename, env);
                    });
                    list.appendChild(item);
                }
                picker.appendChild(list);

                const createRow = document.createElement('div');
                createRow.className = 'kernel-picker-footer';
                const createBtn = document.createElement('button');
                createBtn.className = 'explorer-btn primary';
                createBtn.textContent = 'Create Environment';
                createBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    closePicker();
                    app._sidebar.show('projects');
                    app._openWorkspaceTab();
                    app._syncIconBar();
                    app._explorerPanel.navigate({
                        currentProject: app._currentProject,
                        navigateToEnvs: true,
                    });
                });
                createRow.appendChild(createBtn);
                picker.appendChild(createRow);
            });

            rightGroup.appendChild(venvItem);
            secondBar.appendChild(leftGroup);
            secondBar.appendChild(rightGroup);

            frag.appendChild(secondBar);

            // Debug bar (hidden until debug session starts)
            const debugBar = document.createElement('div');
            debugBar.className = 'notebook-debug-bar';
            debugBar.style.display = 'none';

            const debugControls = document.createElement('div');
            debugControls.className = 'debug-bar-controls';
            const mkDbg = (icon, title, onClick) => {
                const btn = document.createElement('button');
                btn.className = 'debug-bar-btn';
                btn.innerHTML = icon;
                btn.title = title;
                btn.addEventListener('click', onClick);
                return btn;
            };
            debugControls.appendChild(mkDbg('<i class="fa-solid fa-circle-play" style="color:#4caf50;font-size:15px"></i>', 'Continue (F5)', () => app._fileDebugAction('continue')));
            debugControls.appendChild(mkDbg('<i class="fa-solid fa-circle-right" style="color:#1976d2;font-size:15px"></i>', 'Step Over (F10)', () => app._fileDebugAction('stepOver')));
            debugControls.appendChild(mkDbg('<i class="fa-solid fa-circle-down" style="color:#1976d2;font-size:15px"></i>', 'Step In (F11)', () => app._fileDebugAction('stepIn')));
            debugControls.appendChild(mkDbg('<i class="fa-solid fa-circle-left" style="color:#1976d2;font-size:15px"></i>', 'Step Out (Shift+F11)', () => app._fileDebugAction('stepOut')));
            debugControls.appendChild(mkDbg('<i class="fa-solid fa-circle-stop" style="color:#e53935;font-size:15px"></i>', 'Stop (Shift+F5)', () => app._fileDebugAction('stop')));
            debugBar.appendChild(debugControls);

            const debugStatus = document.createElement('span');
            debugStatus.className = 'debug-bar-status';
            debugBar.appendChild(debugStatus);

            frag.appendChild(debugBar);

            // Keyboard shortcuts for debug
            document.addEventListener('keydown', (e) => {
                if (debugBar.style.display === 'none') return;
                if (e.key === 'F5' && !e.shiftKey) { e.preventDefault(); app._fileDebugAction('continue'); }
                else if (e.key === 'F5' && e.shiftKey) { e.preventDefault(); app._fileDebugAction('stop'); }
                else if (e.key === 'F10') { e.preventDefault(); app._fileDebugAction('stepOver'); }
                else if (e.key === 'F11' && !e.shiftKey) { e.preventDefault(); app._fileDebugAction('stepIn'); }
                else if (e.key === 'F11' && e.shiftKey) { e.preventDefault(); app._fileDebugAction('stepOut'); }
            });

            return frag;
        }

        secondBar.appendChild(leftGroup);
        frag.appendChild(secondBar);
        return frag;
    };

    /** Ensure a MediaViewer exists for a tab key. */
    app._ensureMediaViewer = function(tabKey, projectId, filename) {
        if (!app._mediaViewers.has(tabKey)) {
            const rootType = app._explorerPanel?._projectSources?.[projectId] === 'mount' ? 'mount' : 'project';
            const viewer = new MediaViewer();
            viewer.open(projectId, filename, rootType);
            app._mediaViewers.set(tabKey, viewer);
        }
    };

    /** Open a media file as a preview tab. */
    app._previewMediaTab = function(projectId, filename, hostPath) {
        const tabKey = `media:${projectId}:${filename}`;
        const undocked = app._undockedPanels.get(tabKey);
        if (undocked) { undocked.front(); return; }
        if (hostPath) app._mountHostPaths = app._mountHostPaths || {};
        if (hostPath) app._mountHostPaths[tabKey] = hostPath;
        app._ensureMediaViewer(tabKey, projectId, filename);
        const tooltip = app._buildTabTooltip(projectId, filename, hostPath);
        app._tabBar.addTab({
            key: tabKey,
            label: filename.includes('/') ? filename.split('/').pop() : filename,
            tooltip,
            type: 'media',
            closable: true,
            undockable: true,
            preview: true,
        });
    };

    /** Open a media file as a pinned tab. */
    app._openMediaTab = function(projectId, filename, hostPath) {
        const tabKey = `media:${projectId}:${filename}`;
        const undocked = app._undockedPanels.get(tabKey);
        if (undocked) { undocked.front(); return; }
        if (hostPath) app._mountHostPaths = app._mountHostPaths || {};
        if (hostPath) app._mountHostPaths[tabKey] = hostPath;
        app._ensureMediaViewer(tabKey, projectId, filename);
        const tooltip = app._buildTabTooltip(projectId, filename, hostPath);
        app._tabBar.addTab({
            key: tabKey,
            label: filename.includes('/') ? filename.split('/').pop() : filename,
            tooltip,
            type: 'media',
            closable: true,
            undockable: true,
        });
    };

    /** Build a tooltip string for a file/media tab. */
    app._buildTabTooltip = function(projectId, filename, hostPath) {
        if (hostPath) return `${hostPath}/${filename}`;
        return `${projectId}/${filename}`;
    };

    // Build an image resolver for Markdown preview tabs opened from a project file.
    // sourceKey format: "pyfile:{projectId}:{filename}"
    // Returns a function (relativePath => apiUrl) suitable for _renderMarkdownToHtml.
    app._buildMdImgResolver = function(sourceKey) {
        if (!sourceKey?.startsWith('pyfile:')) return null;
        const rest = sourceKey.slice(7);
        const ci = rest.indexOf(':');
        const name = rest.substring(0, ci);
        const filename = rest.substring(ci + 1);
        const rootType = app._explorerPanel?._projectSources?.[name] === 'mount' ? 'mount' : 'project';
        const slashIdx = filename.lastIndexOf('/');
        const dir = slashIdx >= 0 ? filename.substring(0, slashIdx + 1) : '';
        return rel => `api/files/${rootType}/${name}/raw?path=${encodeURIComponent(dir + rel)}`;
    };

    // --- File Debug ---

    app._fileDebugClient = null;
    app._fileDebugKey = null;

    app._fileDebugCurrentLine = 0;
    app._fileDebugLineCount = 0;

    app._fileDebugAction = function(action) {
        const dc = app._fileDebugClient;
        if (!dc?.connected) return;
        if (action === 'continue') {
            // Check if there are more breakpoints ahead in the file
            const editor = app._fileDebugKey ? app._fileEditors.get(app._fileDebugKey) : null;
            const bps = editor?.getBreakpoints() || [];
            const hasMoreBreakpoints = bps.some(bp => bp > app._fileDebugCurrentLine);
            dc.continue_().catch(() => {});
            if (!hasMoreBreakpoints) {
                // No more breakpoints - execution will finish. Terminate now.
                app._fileDebugTerminated();
            } else {
                // More breakpoints ahead - keep session, clear current highlight
                const ds = document.querySelector('#service-tab-container .notebook-debug-bar .debug-bar-status');
                if (ds) ds.textContent = 'Running...';
                if (editor) editor.setDebugCurrentLine(0);
            }
        }
        else if (action === 'stepOver') {
            // Auto-continue + terminate on last executable line
            const editor = app._fileDebugKey ? app._fileEditors.get(app._fileDebugKey) : null;
            const content = editor?._editorView?.state.doc.toString() || '';
            const lines = content.split('\n');
            let lastExecLine = lines.length;
            for (let i = lines.length - 1; i >= 0; i--) {
                const trimmed = lines[i].trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    lastExecLine = i + 1;
                    break;
                }
            }
            if (app._fileDebugCurrentLine >= lastExecLine) {
                dc.continue_().catch(() => {});
                app._fileDebugTerminated();
            } else {
                dc.stepOver();
            }
        }
        else if (action === 'stepIn') dc.stepIn();
        else if (action === 'stepOut') dc.stepOut();
        else if (action === 'stop') {
            dc.disconnect();
            app._fileDebugTerminated();
        }
    };

    app._fileDebugTerminated = function() {
        // Idempotent - safe to call multiple times
        if (!app._fileDebugClient && !app._fileDebugKey) return;
        // Find debug bar in DOM (rebuilt on each tab activation)
        const bar = document.querySelector('#service-tab-container .notebook-debug-bar');
        if (bar) bar.style.display = 'none';
        const status = bar?.querySelector('.debug-bar-status');
        if (status) status.textContent = '';
        if (app._fileDebugKey) {
            const editor = app._fileEditors.get(app._fileDebugKey);
            if (editor) editor.setDebugCurrentLine(0);
        }
        if (app._fileDebugClient) {
            try { app._fileDebugClient.disconnect(); } catch {}
            app._fileDebugClient = null;
        }
        // Clean up backend session (stops adapter and zombie processes)
        if (app._fileDebugSessionId) {
            fetch(`api/dap/file-debug/${app._fileDebugSessionId}`, {
                method: 'DELETE'
            }).catch(() => {});
            app._fileDebugSessionId = null;
        }
        // Disable R debug output filter on all terminals
        if (window._projectTerminalRegistry) {
            for (const entry of window._projectTerminalRegistry.values()) {
                if (entry?.terminal) entry.terminal._rDebugFilter = false;
            }
        }
        app._fileDebugKey = null;
        app._fileDebugAbsPath = null;
        document.dispatchEvent(new CustomEvent('debug:terminated', { bubbles: true }));
    };

    app._debugFile = async function(tabKey, projectId, filename, venvName, runtimeId, isMount, debugBar, debugStatus) {
        const editor = app._fileEditors.get(tabKey);
        if (!editor) return;

        // Save file first
        await editor.save();

        const isJS = runtimeId?.startsWith('javascript');
        const isR = runtimeId?.startsWith('r/');
        const language = isJS ? 'javascript' : isR ? 'r' : 'python';
        const absPath = isMount
            ? `/app/mounts/${projectId}/${filename}`
            : `/app/data/projects/${projectId}/${filename}`;
        const repoPath = isMount
            ? `/app/mounts/${projectId}`
            : `/app/data/projects/${projectId}`;
        app._fileDebugAbsPath = absPath;

        try {
            const shortName = filename.split('/').pop();

            // Clean up any previous file debug session
            if (app._fileDebugClient) {
                app._fileDebugClient.disconnect();
                app._fileDebugClient = null;
            }
            if (app._fileDebugSessionId) {
                fetch(`api/dap/file-debug/${app._fileDebugSessionId}`, {
                    method: 'DELETE'
                }).catch(() => {});
                app._fileDebugSessionId = null;
            }

            // Step 1: Ask backend to prepare the debug session
            // (picks a port, builds the command, starts DAP adapter)
            const resp = await fetch('api/dap/file-debug', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_path: absPath,
                    language,
                    runtime_path: `/app/data/environments/${runtimeId || 'python/3.12'}/${venvName}`,
                    cwd: repoPath,
                }),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed to start file debug');
            }
            const { session_id, terminal_cmd, r_inject_cmd } = await resp.json();
            app._fileDebugSessionId = session_id;

            // Step 2: Run the command in a terminal (output visible there)
            const socket = app._client?.socket;
            if (socket && terminal_cmd) {
                await openProjectTerminal(socket, repoPath, `Debug: ${shortName}`, {
                    initialCommand: terminal_cmd,
                    panelIcon: 'fa-bug',
                    panelIconColor: '#e53935',
                });
            }

            // Step 2b: R debug - inject vscDebugger setup into R's
            // stdin after R is at the prompt. This is the "Option A"
            // approach: R starts clean (no profile), then we write the
            // library(vscDebugger) command to the terminal after R has
            // fully initialized (utils loaded, event loop running).
            // This avoids the R 3.6.x startup race condition where
            // R_PROFILE_USER runs before utils is on the search path.
            if (r_inject_cmd && socket) {
                // Find the terminal session for this project path
                const termEntry = window._projectTerminalRegistry?.get(repoPath);
                if (termEntry?.terminal?.sessionId) {
                    // Enable R debug output filter to suppress plumbing noise
                    termEntry.terminal._rDebugFilter = true;
                    // Wait for R to reach the prompt (1.5s is safe for
                    // R --interactive --quiet startup)
                    await new Promise(r => setTimeout(r, 1500));
                    socket.emit('terminal:input', {
                        session_id: termEntry.terminal.sessionId,
                        data: r_inject_cmd + '\n',
                    });
                }
            }

            // Step 3: Wait for the debug port to be ready
            const waitResp = await fetch(
                `api/dap/file-debug/${session_id}/wait`,
            );
            if (!waitResp.ok) {
                throw new Error('Debug process did not start in time');
            }

            // Step 4: Connect debug client to the file debug WebSocket
            if (app._fileDebugClient) app._fileDebugClient.disconnect();
            const dc = new DebugClient();
            app._fileDebugClient = dc;
            app._fileDebugKey = tabKey;

            dc.on('stopped', (body) => app._onFileDebugStopped(body));
            dc.on('output', (body) => {
                if (body.category === 'stderr' && body.output) {
                    notify.error(body.output);
                }
                // R debug: vscDebugger intercepts cat()/print() and
                // sends them as DAP output events instead of letting
                // them go to the PTY. Write stdout back to the terminal
                // so the user sees script output inline.
                if (body.category === 'stdout' && body.output && isR) {
                    const termEntry = window._projectTerminalRegistry?.get(repoPath);
                    if (termEntry?.terminal) {
                        // Prefix with \r\n so output starts on a new
                        // line instead of appending inline after the
                        // Browse prompt
                        const text = body.output.replace(/\n/g, '\r\n');
                        termEntry.terminal.write('\r\n' + text);
                    }
                }
            });
            dc.on('continued', () => {
                const ds = document.querySelector('#service-tab-container .notebook-debug-bar .debug-bar-status');
                if (ds) ds.textContent = 'Running...';
                const ed = app._fileEditors.get(tabKey);
                if (ed) ed.setDebugCurrentLine(0);
                document.dispatchEvent(new CustomEvent('debug:continued', { bubbles: true }));
            });
            dc.on('terminated', () => {
                // R debug: delay teardown slightly so final output
                // events (cat() on the last line) have time to arrive
                // and be written to the terminal before we disconnect.
                if (isR) {
                    setTimeout(() => app._fileDebugTerminated(), 500);
                } else {
                    app._fileDebugTerminated();
                }
            });
            dc.on('disconnected', () => app._fileDebugTerminated());

            // Store line count for last-line detection
            const content = editor._editorView?.state.doc.toString() || '';
            app._fileDebugLineCount = content.split('\n').length;
            app._fileDebugCurrentLine = 0;

            await dc.connect(session_id, 'dap-file');

            // Set breakpoints on the file
            const bps = editor.getBreakpoints();
            if (bps.length > 0) {
                await dc.setBreakpoints(
                    { path: absPath, name: shortName },
                    bps.map(line => ({ line }))
                );
            }

            await dc._request('configurationDone');

            // Show debug bar
            const activeBar = document.querySelector('#service-tab-container .notebook-debug-bar');
            if (activeBar) activeBar.style.display = '';
            const activeStatus = activeBar?.querySelector('.debug-bar-status');
            if (activeStatus) activeStatus.textContent = 'Running...';

            // Dispatch started event for DebugPanel
            document.dispatchEvent(new CustomEvent('debug:started', {
                bubbles: true,
                detail: {
                    debugClient: dc,
                    cells: [{
                        cellType: 'code',
                        _bpLabel: shortName,
                        _editorView: editor._editorView,
                        getBreakpoints: () => editor.getBreakpoints(),
                        source: editor._editorView?.state.doc.toString() || '',
                        element: editor._el,
                        setDebugCurrentLine: (n) => editor.setDebugCurrentLine(n),
                    }],
                },
            }));

        } catch (e) {
            notify.error(`Debug failed: ${e.message}`);
            console.error('[FileDebug]', e);
        }
    };

    app._onFileDebugStopped = function(body) {
        const dc = app._fileDebugClient;
        if (!dc) return;

        // JS file debug: auto-continue past the internal debugger; sync point
        const isJS = app._fileDebugKey && app._fileEditors.get(app._fileDebugKey)?._envRuntimeId?.startsWith('javascript');
        if (isJS && (body.reason === 'debugger_statement' ||
            (body.reason === 'pause' && body.description?.includes('debugger statement')))) {
            dc.continue_();
            return;
        }

        const debugBar = document.querySelector('#service-tab-container .notebook-debug-bar');
        const debugStatus = debugBar?.querySelector('.debug-bar-status');
        if (!debugBar) return;

        debugBar.style.display = '';
        if (debugStatus) debugStatus.textContent = `Paused: ${body.reason || 'breakpoint'}`;

        dc.stackTrace(body.threadId).then(result => {
            const frames = result.stackFrames || [];
            if (frames.length > 0) {
                const frame = frames[0];
                const line = frame.line;
                const sourcePath = frame.source?.path || '';

                // If stopped outside our file (in ipykernel/Node internals),
                // terminate the debug session to avoid IOStream flush hangs.
                // Skip this check for R: vscDebugger reports intermediate
                // frames (eval, source, base) that don't match the user's
                // file path but are still part of normal execution.
                const isR = app._fileDebugKey && app._fileEditors.get(app._fileDebugKey)?._envRuntimeId?.startsWith('r/');
                if (!isR && app._fileDebugAbsPath && !sourcePath.endsWith(app._fileDebugAbsPath.split('/').pop())) {
                    app._fileDebugTerminated();
                    return;
                }
                if (!isR && line > app._fileDebugLineCount) {
                    app._fileDebugTerminated();
                    return;
                }

                app._fileDebugCurrentLine = line;
                const ds = document.querySelector('#service-tab-container .notebook-debug-bar .debug-bar-status');
                if (ds) ds.textContent = `Paused: ${body.reason || 'breakpoint'} (line ${line})`;

                // Highlight line in the file editor
                const editor = app._fileEditors.get(app._fileDebugKey);
                if (editor) {
                    editor.setDebugCurrentLine(line);
                }

                document.dispatchEvent(new CustomEvent('debug:stopped', {
                    bubbles: true,
                    detail: { debugClient: dc, threadId: body.threadId, stackFrames: frames },
                }));
            }
        }).catch(e => console.warn('[FileDebug] stackTrace error:', e));
    };
}
