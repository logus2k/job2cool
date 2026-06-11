/**
 * app-tabs.js - Tab activation, content switching, undock/dock management.
 *
 * Handles:
 * - Icon bar click handlers (sidebar toggles, service iframes)
 * - Icon bar state sync
 * - Tab activation with content switching (notebook, file, workspace, service, etc.)
 * - Tab undocking to floating jsPanel windows
 * - Tab docking back from floating panels
 * - Service bar building for iframe tabs
 * - Workspace tab management
 *
 * Attached to the App instance via initTabs(app).
 */

import { openProjectTerminal } from './ProjectTerminal.js';
import { DocumentViewer } from './panels/DocumentViewer.js';

/**
 * Attach tab management methods to the App instance.
 * @param {object} app - The App instance
 */
export function initTabs(app) {

    app._onIconBarClick = function(key) {
        if (key === 'projects') {
            const opening = !app._sidebar.openViews.has('projects');
            app._sidebar.toggle('projects');
            if (opening) {
                app._explorerPanel.setActiveVenv(app._activeVenv ? app._activeVenv.name : null);
                app._explorerPanel.navigate({
                    currentProject: app._currentProject,
                    currentNotebook: app._currentNotebook,
                });
            }
            app._syncIconBar();
        } else if (key === 'toc') {
            app._sidebar.toggle('toc');
            app._syncIconBar();
        } else if (key === 'git') {
            const opening = !app._sidebar.openViews.has('git');
            if (opening) app._gitPanel.activate();
            app._sidebar.toggle('git');
            app._syncIconBar();
        } else if (key === 'assistant' || key === 'debug' || key === 'docs') {
            app._toggleRightPanel(key);
        } else if (key === 'mlflow' || key === 'airflow' || key === 'minio' || key === 'evidently' || key === 'arcadedb') {
            if (app._tabBar._tabs.has(key)) {
                app._tabBar.closeTab(key);
            } else {
                const title = key.charAt(0).toUpperCase() + key.slice(1);
                app._tabBar.addTab({
                    key,
                    label: title,
                    type: 'service',
                    icon: `static/images/${key}.png`,
                    closable: true,
                    undockable: true,
                });
            }
            app._syncIconBar();
        } else if (key === 'settings') {
            app._sidebar.toggle('settings');
            app._syncIconBar();
        }
    }

    /** Sync icon bar indicators with currently open tabs */
    app._syncIconBar = function() {
        if (!app._tabBar || !app._iconBar) return;
        const serviceKeys = ['mlflow', 'airflow', 'minio', 'evidently', 'arcadedb'];
        for (const k of serviceKeys) {
            app._iconBar.setTabIndicator(k, app._tabBar._tabs.has(k));
        }
        const openLeft = app._sidebar?.openViews || new Set();
        app._iconBar.setTabIndicator('projects', openLeft.has('projects'));
        app._iconBar.setTabIndicator('toc',      openLeft.has('toc'));
        app._iconBar.setTabIndicator('git',      openLeft.has('git'));
        app._iconBar.setTabIndicator('settings', openLeft.has('settings'));
        const openRight = app._chatVisible ? (app._rightPanel?.openViews || new Set()) : new Set();
        app._iconBar.setTabIndicator('assistant', openRight.has('assistant'));
        app._iconBar.setTabIndicator('debug',     openRight.has('debug'));
        app._iconBar.setTabIndicator('docs',      openRight.has('docs'));
    }

    app._onTabActivated = function(key) {
        const notebookContainer = document.getElementById('notebook-container');
        const serviceContainer = document.getElementById('service-tab-container');

        // Clear LSP context unless a pyfile tab is being activated
        if (!key || !key.startsWith('pyfile:')) {
            app._menuBar.setContext('hasLSP', false);
            app._menuBar.setContext('hasLSPNavigation', false);
            app._updateProblemsStatus([]);
        }

        // hasNotebook gates Edit-menu cell items (Cut/Copy/Paste/Delete Cell,
        // Find & Replace..., Go to Cell...). Set true when the activated tab
        // is a notebook (key startsWith 'notebook:').
        app._menuBar.setContext('hasNotebook', !!key && key.startsWith('notebook:'));
        app._menuBar.refresh();

        // Reset documentation panel — content from the previous tab no longer applies
        app._docPanel?.clear();

        // Hide all persistent service wrappers (visibility keeps iframes alive)
        for (const wrapper of serviceContainer.querySelectorAll('.service-wrapper')) {
            wrapper.style.visibility = 'hidden';
            wrapper.style.position = 'absolute';
            wrapper.style.width = '0';
            wrapper.style.height = '0';
            wrapper.style.overflow = 'hidden';
        }

        // Detach reusable elements (workspace, docs) before clearing transient content
        const wsDetail = serviceContainer.querySelector('.explorer-detail-pane');
        if (wsDetail) wsDetail.remove();
        // Stash scroll position of the outgoing doc viewer so we can
        // restore it when the tab is re-activated. Without this, removing
        // the wrapper from DOM (next line) resets scrollTop to 0 and
        // PDFs reopen at page 1 even though the per-tab viewer instance
        // preserves its PDF.js render state.
        const docViewer = serviceContainer.querySelector('.document-viewer-wrapper');
        if (docViewer) {
            const outgoingTabKey = docViewer.dataset.tabKey;
            if (outgoingTabKey) {
                app._docScrollPositions = app._docScrollPositions || {};
                app._docScrollPositions[outgoingTabKey] = docViewer.scrollTop;
            }
            docViewer.remove();
        }
        const pyfileWrapper = serviceContainer.querySelector('.file-editor-wrapper');
        if (pyfileWrapper) pyfileWrapper.remove();
        const mediaWrapper = serviceContainer.querySelector('.media-viewer-wrapper');
        if (mediaWrapper) mediaWrapper.remove();
        const gitCommitWrapper = serviceContainer.querySelector('.git-commit-viewer-wrapper');
        if (gitCommitWrapper) gitCommitWrapper.remove();
        const detailWrapper = serviceContainer.querySelector('.detail-tab-wrapper');
        if (detailWrapper) detailWrapper.remove();
        // Remove transient bars (workspace/doc bars)
        for (const bar of serviceContainer.querySelectorAll('.service-top-bar:not(.service-wrapper .service-top-bar), .service-second-bar:not(.service-wrapper .service-second-bar)')) {
            bar.remove();
        }

        // Update TOC for active content
        app._updateTocForTab(key);

        // Clear cursor info when not on a notebook tab
        if (!key || !key.startsWith('notebook:')) {
            app._updateStatusCursor(null);
        }

        if (key === null) {
            // No tabs open - hide everything, only page background visible
            notebookContainer.style.display = 'none';
            serviceContainer.style.display = 'none';
            app._activeEditorKey = null;
            // Only clear status bar if no undocked panels exist
            if (app._undockedPanels.size === 0) {
                app._updateStatusProject(null);
                app._updateStatusBranch(null);
                app._updateStatusCursor(null);
            }
        } else if (key.startsWith('notebook:')) {
            // Show the specific notebook editor, hide service container
            notebookContainer.style.display = '';
            serviceContainer.style.display = 'none';
            app._lastContentKey = key;
            app._activateEditor(key);
            // Update TOC, status bar, and git panel for active notebook
            const entry = app._editors.get(key);
            if (entry) {
                const shortName = entry.notebook.includes('/') ? entry.notebook.split('/').pop() : entry.notebook;
                app._sidebar.updateViewTitle('toc', shortName);
                app._gitPanel?.setProject(entry.project);
                app._updateStatusProject(entry.project);
                app._updateStatusBranch(entry.project);
                app._updateProblemsStatus(entry.editor.getDiagnostics?.() || []);
            }
        } else if (key === 'workspace') {
            notebookContainer.style.display = 'none';
            serviceContainer.style.display = 'flex';
            serviceContainer.appendChild(app._buildWorkspaceBars());
            serviceContainer.appendChild(app._explorerPanel.detailElement);
            // Re-apply breadcrumbs for current active node (bars were just rebuilt)
            app._explorerPanel.refreshBreadcrumbs();
        } else if (key.startsWith('pyfile:')) {
            // Show file editor
            notebookContainer.style.display = 'none';
            serviceContainer.style.display = 'flex';
            app._lastContentKey = key;
            serviceContainer.appendChild(app._buildFileBars(key));
            const editor = app._fileEditors.get(key);
            if (editor) {
                const wrapper = document.createElement('div');
                wrapper.className = 'file-editor-wrapper';
                wrapper.appendChild(editor.element);
                serviceContainer.appendChild(wrapper);
                app._menuBar.setContext('hasLSP', editor._lspEnabled);
                app._menuBar.setContext('hasLSPNavigation', editor._lspEnabled);
                app._menuBar.refresh();
                editor._emitCursorInfo();
                // Show current file's diagnostics (or clear if none)
                app._updateProblemsStatus(editor.getDiagnostics());
            }
        } else if (key.startsWith('media:')) {
            // Show media viewer
            notebookContainer.style.display = 'none';
            serviceContainer.style.display = 'flex';
            serviceContainer.appendChild(app._buildMediaBars(key));
            const viewer = app._mediaViewers.get(key);
            if (viewer) {
                const wrapper = document.createElement('div');
                wrapper.className = 'media-viewer-wrapper';
                wrapper.appendChild(viewer.element);
                serviceContainer.appendChild(wrapper);
            }
        } else if (key.startsWith('doc:')) {
            // Show document viewer. Each doc tab owns its own DocumentViewer
            // instance (kept in app._documentViewers) so PDF scroll position +
            // page state survive tab switches. Switching back to a previously-
            // viewed tab no longer reloads the doc to page 1.
            notebookContainer.style.display = 'none';
            serviceContainer.style.display = 'flex';
            // IMPORTANT: viewer must exist BEFORE the bars are built —
            // _buildDocumentBars's PDF-controls block reads
            // _documentViewers.get(key) to wire onReady / onPageChange.
            // Building bars first would leave the page input + total
            // unbound on first activation.
            const doc = app._documentTabs.get(key);
            let viewer = app._documentViewers.get(key);
            const isFirstShow = !viewer;
            if (isFirstShow) {
                viewer = new DocumentViewer();
                viewer.element.dataset.tabKey = key;  // for scroll-restore on tab switch
                app._documentViewers.set(key, viewer);
            }
            serviceContainer.appendChild(app._buildDocumentBars(key));
            serviceContainer.appendChild(viewer.element);
            // Restore scroll position from a previous activation of this
            // tab (the outgoing-cleanup block above stashed it on blur).
            const savedScroll = app._docScrollPositions?.[key];
            if (typeof savedScroll === 'number' && savedScroll > 0) {
                // Defer until layout settles; scrollTop on a freshly-appended
                // element is silently clamped to 0 if set before paint.
                requestAnimationFrame(() => {
                    viewer.element.scrollTop = savedScroll;
                });
            }
            if (isFirstShow && doc) {
                // Defer show() until the viewer is in the DOM so its
                // IntersectionObserver resolves intersections correctly.
                viewer.show(doc).then(() => {
                    if (app._tabBar.activeKey === key) {
                        app._updateTocForTab(key);
                    }
                    // Citation deep-jump: pending jump set by chat citation
                    // click before the tab opened. Apply after show resolves
                    // so pages are rendered before we scroll/highlight.
                    if (app._pendingCitationJump) {
                        const j = app._pendingCitationJump;
                        app._pendingCitationJump = null;
                        if (j.regions && j.regions.length) {
                            viewer.showBboxHighlights(j.regions);
                        } else if (j.section_path) {
                            viewer.scrollToHeading(j.section_path);
                        }
                    }
                });
            } else if (app._pendingCitationJump) {
                // Re-activated tab with a pending jump from a citation click;
                // viewer already loaded so apply jump immediately.
                const j = app._pendingCitationJump;
                app._pendingCitationJump = null;
                if (j.regions && j.regions.length) {
                    viewer.showBboxHighlights(j.regions);
                } else if (j.section_path) {
                    viewer.scrollToHeading(j.section_path);
                }
            }
        } else if (key.startsWith('detail:')) {
            // Show detail tab (run detail, data detail, etc.)
            // Skip if this tab is currently undocked
            if (app._undockedPanels.has(key)) return;
            notebookContainer.style.display = 'none';
            serviceContainer.style.display = 'flex';
            serviceContainer.appendChild(app._buildDetailBars(key));
            const detail = app._detailTabs.get(key);
            if (detail) {
                const wrapper = document.createElement('div');
                wrapper.className = 'detail-tab-wrapper';
                wrapper.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0;background:#fefefe;border-right:0.5px solid #333;border-left:0.5px solid #333';
                wrapper.appendChild(detail.element);
                serviceContainer.appendChild(wrapper);
            }
        } else if (key === 'git-commit') {
            // Show git commit diff
            notebookContainer.style.display = 'none';
            serviceContainer.style.display = 'flex';
            serviceContainer.appendChild(app._buildGitCommitBars(key));
            const wrapper = document.createElement('div');
            wrapper.className = 'git-commit-viewer-wrapper';
            wrapper.appendChild(app._gitCommitViewer.element);
            serviceContainer.appendChild(wrapper);
            // Re-show commit if switching back to this tab
            const entry = app._gitCommits?.get(key);
            if (entry) app._gitCommitViewer.show(entry.repoPath, entry.commit);
        } else if (key.startsWith('mdpreview:')) {
            // Show markdown preview tab
            notebookContainer.style.display = 'none';
            serviceContainer.style.display = 'flex';
            const previewData = app._mdPreviewTabs?.get(key);
            if (previewData) {
                // Top bar with filename
                const shortName = previewData.filename.includes('/')
                    ? previewData.filename.split('/').pop()
                    : previewData.filename;
                const topBar = document.createElement('div');
                topBar.className = 'service-top-bar';
                const title = document.createElement('span');
                title.className = 'service-top-bar-title';
                title.textContent = shortName;
                topBar.appendChild(title);
                const spacer = document.createElement('span');
                spacer.style.flex = '1';
                topBar.appendChild(spacer);
                // Undock button
                const undockBtn = document.createElement('button');
                undockBtn.className = 'info-bar-text-btn';
                undockBtn.innerHTML = '<i class="fa-solid fa-up-right-from-square" style="font-size:11px;color:#555555"></i>';
                undockBtn.title = 'Undock to floating panel';
                undockBtn.addEventListener('click', () => app._tabBar.undockTab(key));
                topBar.appendChild(undockBtn);
                // Close button
                const closeBtn = document.createElement('button');
                closeBtn.className = 'info-bar-text-btn';
                closeBtn.innerHTML = '<i class="fa-solid fa-xmark" style="font-size:11px;color:#555555"></i>';
                closeBtn.title = 'Close';
                closeBtn.addEventListener('click', () => app._tabBar.closeTab(key));
                topBar.appendChild(closeBtn);
                serviceContainer.appendChild(topBar);

                // Second bar with breadcrumbs
                const secondBar = document.createElement('div');
                secondBar.className = 'service-second-bar';
                const crumbs = previewData.filename.split('/');
                crumbs.forEach((text, i) => {
                    if (i > 0) {
                        const sep = document.createElement('span');
                        sep.className = 'breadcrumb-sep';
                        sep.textContent = ' / ';
                        secondBar.appendChild(sep);
                    }
                    const span = document.createElement('span');
                    span.className = 'breadcrumb-segment';
                    if (i === crumbs.length - 1) span.classList.add('breadcrumb-current');
                    span.textContent = text;
                    secondBar.appendChild(span);
                });
                serviceContainer.appendChild(secondBar);

                // Re-read current content from source editor for live preview
                const sourceEditor = app._fileEditors.get(previewData.sourceKey);
                const markdown = sourceEditor ? sourceEditor.getContent() : previewData.markdown;
                const imgResolver = app._buildMdImgResolver(previewData.sourceKey);
                const outer = document.createElement('div');
                outer.className = 'document-viewer-wrapper';
                const wrapper = document.createElement('div');
                wrapper.className = 'document-viewer-content document-viewer-markdown';
                wrapper.innerHTML = app._documentViewer._renderMarkdownToHtml(markdown, imgResolver);
                if (typeof hljs !== 'undefined') {
                    wrapper.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
                }
                outer.appendChild(wrapper);
                serviceContainer.appendChild(outer);

                // Auto-sync: re-render preview when source editor content changes
                if (sourceEditor) {
                    const previewWrapper = wrapper;
                    sourceEditor.onContentChange = (content) => {
                        // Only update if this preview tab still exists
                        if (!app._mdPreviewTabs?.has(key)) {
                            sourceEditor.onContentChange = null;
                            return;
                        }
                        previewWrapper.innerHTML = app._documentViewer._renderMarkdownToHtml(content, imgResolver);
                        if (typeof hljs !== 'undefined') {
                            previewWrapper.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
                        }
                    };
                }
            }
        } else {
            // Show service iframe (persistent wrapper)
            notebookContainer.style.display = 'none';
            serviceContainer.style.display = 'flex';

            // Create persistent wrapper on first use
            if (!app._serviceIframes[key]) {
                const wrapper = document.createElement('div');
                wrapper.className = 'service-wrapper';
                wrapper.dataset.serviceKey = key;
                wrapper.style.cssText = 'display:flex; flex-direction:column; flex:1; min-height:0; visibility:hidden; position:absolute; width:0; height:0; overflow:hidden;';

                wrapper.appendChild(app._buildServiceBars(key));

                const iframe = document.createElement('iframe');
                iframe.src = `/${key}`;
                // Intercept links inside service iframes to open within iframe instead of new tab
                const servicePrefixes = ['/mlflow', '/airflow', '/minio', '/evidently', '/arcadedb'];
                iframe.addEventListener('load', () => {
                    try {
                        const doc = iframe.contentDocument;
                        if (!doc) return;
                        doc.addEventListener('click', (ev) => {
                            const a = ev.target.closest('a');
                            if (!a) return;
                            const href = a.getAttribute('href');
                            if (!href) return;
                            if (a.target === '_blank' || a.target === '_new') {
                                ev.preventDefault();
                                let resolved = href;
                                let isExternal = false;
                                try {
                                    const url = new URL(href, window.location.origin);
                                    if (url.origin === window.location.origin) {
                                        resolved = url.pathname + url.hash + url.search;
                                    } else {
                                        // Check if it's an internal container URL
                                        const containerMap = {
                                            'mlflow:5000': '/mlflow',
                                            'airflow:8080': '/airflow',
                                            'minio:9001': '/minio',
                                            'evidently:8000': '/evidently',
                                            'arcadedb:2480': '/arcadedb',
                                            'host.docker.internal:2480': '/arcadedb',
                                        };
                                        let mapped = false;
                                        for (const [host, proxy] of Object.entries(containerMap)) {
                                            if (href.includes(host)) {
                                                resolved = proxy + url.pathname + url.hash + url.search;
                                                mapped = true;
                                                break;
                                            }
                                        }
                                        if (!mapped) { isExternal = true; }
                                    }
                                } catch { isExternal = true; }
                                // Check if resolved path is within our services
                                if (!isExternal && !servicePrefixes.some(p => resolved.startsWith(p))) {
                                    isExternal = true;
                                }
                                if (isExternal) {
                                    window.open(href, '_blank');
                                } else {
                                    iframe.contentWindow.location.href = resolved;
                                }
                            }
                        }, true);
                    } catch { /* cross-origin - ignore */ }
                });
                wrapper.appendChild(iframe);

                serviceContainer.appendChild(wrapper);
                app._serviceIframes[key] = wrapper;
            }

            // Show the wrapper (restore from hidden state)
            app._serviceIframes[key].style.visibility = '';
            app._serviceIframes[key].style.position = '';
            app._serviceIframes[key].style.width = '';
            app._serviceIframes[key].style.height = '';
            app._serviceIframes[key].style.overflow = '';
        }

        app._syncIconBar();
    }

    app._onUndockTab = function(key) {
        // Determine content element, label, and icon based on tab type
        let contentEl, label, icon, onDock, onClose, onCallback;

        if (key.startsWith('notebook:')) {
            const entry = app._editors.get(key);
            if (!entry) return;
            const notebookContainer = document.getElementById('notebook-container');
            const wrapperEl = entry.editor._wrapperEl;
            if (!wrapperEl) return;
            const shortName = entry.notebook.includes('/') ? entry.notebook.split('/').pop() : entry.notebook;
            const projText = entry.editor._projectLabel?.textContent || '';
            const nbText = entry.editor._notebookLabel?.textContent || shortName;
            label = projText
                ? `<span style="font-size:11px;color:#666">${projText}</span> <span style="font-size:11px;color:#aaa">/</span> <span style="font-size:12px">${nbText}</span>`
                : `<span style="font-size:12px">${nbText}</span>`;
            icon = '<i class="fa-solid fa-book" style="color:#1a73e8;margin-right:6px;font-size:11px"></i>';
            contentEl = wrapperEl;

            onCallback = (p) => {
                wrapperEl.classList.add('notebook-undocked');
                if (entry.editor._topBar) entry.editor._topBar.style.display = 'none';
                // Wrap cells in scrollable div with inner page wrapper
                const scrollDiv = document.createElement('div');
                scrollDiv.className = 'notebook-cells-scroll';
                const pageDiv = document.createElement('div');
                pageDiv.className = 'notebook-page';
                const children = [...wrapperEl.children];
                let pastSecondBar = false;
                const collected = [];
                for (const child of children) {
                    if (pastSecondBar) collected.push(child);
                    if (child.classList?.contains('notebook-second-bar')) pastSecondBar = true;
                }
                // Put all except the last add-cell-container inside the page wrapper
                const lastAddCell = collected.length > 0 && collected[collected.length - 1].classList?.contains('add-cell-container')
                    ? collected.pop() : null;
                for (const child of collected) pageDiv.appendChild(child);
                scrollDiv.appendChild(pageDiv);
                if (lastAddCell) scrollDiv.appendChild(lastAddCell);
                wrapperEl.appendChild(scrollDiv);
                wrapperEl._scrollDiv = scrollDiv;
                if (entry.editor._undockBtn) entry.editor._undockBtn.style.display = 'none';
                requestAnimationFrame(() => {
                    entry.editor._cells?.forEach(cell => cell.editor?.requestMeasure?.());
                });
            };

            onDock = () => {
                const scrollDiv = wrapperEl._scrollDiv;
                if (scrollDiv) {
                    const pageDiv = scrollDiv.querySelector('.notebook-page');
                    if (pageDiv) {
                        while (pageDiv.firstChild) wrapperEl.insertBefore(pageDiv.firstChild, scrollDiv);
                    }
                    scrollDiv.remove();
                    delete wrapperEl._scrollDiv;
                }
                wrapperEl.classList.remove('notebook-undocked');
                if (entry.editor._topBar) entry.editor._topBar.style.display = '';
                wrapperEl.style.paddingBottom = '';
                entry.editor.undocked = false;
                if (entry.editor._undockBtn) entry.editor._undockBtn.style.display = '';
                notebookContainer.appendChild(wrapperEl);
                requestAnimationFrame(() => {
                    entry.editor._cells?.forEach(cell => cell.editor?.requestMeasure?.());
                });
            };

            onClose = () => {
                // Cleanup same as dock but don't re-append
                const scrollDiv = wrapperEl._scrollDiv;
                if (scrollDiv) {
                    const pageDiv = scrollDiv.querySelector('.notebook-page');
                    if (pageDiv) {
                        while (pageDiv.firstChild) wrapperEl.insertBefore(pageDiv.firstChild, scrollDiv);
                    }
                    scrollDiv.remove();
                    delete wrapperEl._scrollDiv;
                }
                wrapperEl.classList.remove('notebook-undocked');
                if (entry.editor._topBar) entry.editor._topBar.style.display = '';
                entry.editor.undocked = false;
                if (entry.editor._undockBtn) entry.editor._undockBtn.style.display = '';
            };

        } else if (key.startsWith('pyfile:')) {
            const editor = app._fileEditors.get(key);
            if (!editor) return;
            if (!editor.element) return;
            const filename = key.split(':').slice(2).join(':');
            const shortName = filename.includes('/') ? filename.split('/').pop() : filename;
            label = `<span style="font-size:12px">${shortName}</span>`;
            icon = '<i class="fa-solid fa-file-code" style="color:#42a5f5;margin-right:6px;font-size:11px"></i>';

            // Wrap bars + editor together so they stay in the undocked panel
            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%';
            const bars = app._buildFileBars(key);
            // Replace undock button action with dock
            const undockBtns = bars.querySelectorAll?.('button') || [];
            // Hide the undock button in undocked state (handled by panel controls)
            wrapper.appendChild(bars);
            const editorWrap = document.createElement('div');
            editorWrap.style.cssText = 'flex:1;min-height:0;position:relative';
            editorWrap.appendChild(editor.element);
            wrapper.appendChild(editorWrap);
            contentEl = wrapper;

            onCallback = (p) => {
                // Hide breadcrumb bar (redundant - panel title shows filename)
                const topBar = wrapper.querySelector('.service-top-bar');
                if (topBar) topBar.style.display = 'none';
                // Remove borders from icons bar (panel provides its own frame)
                const secondBar = wrapper.querySelector('.service-second-bar');
                if (secondBar) {
                    secondBar.style.borderLeft = 'none';
                    secondBar.style.borderRight = 'none';
                }
                // Hide undock/close buttons (panel has its own controls)
                const btns = wrapper.querySelectorAll('.info-bar-text-btn');
                for (const btn of btns) {
                    if (btn.title === 'Undock to floating panel') btn.style.display = 'none';
                    if (btn.title === 'Close') btn.style.display = 'none';
                }
                // Wait for jsPanel to get its final size, then tell CodeMirror to recalculate
                const ro = new ResizeObserver(() => {
                    editor._editorView?.requestMeasure?.();
                    // Only need the first resize after undocking
                    ro.disconnect();
                });
                ro.observe(editorWrap);
            };
            onDock = () => {
                requestAnimationFrame(() => {
                    editor._editorView?.requestMeasure?.();
                    window.dispatchEvent(new Event('resize'));
                });
            };
            onClose = () => {};

        } else if (key.startsWith('media:')) {
            const viewer = app._mediaViewers.get(key);
            if (!viewer) return;
            contentEl = viewer.element;
            if (!contentEl) return;
            const filename = key.split(':').slice(2).join(':');
            const shortName = filename.includes('/') ? filename.split('/').pop() : filename;
            label = `<span style="font-size:12px">${shortName}</span>`;
            icon = '<i class="fa-solid fa-image" style="color:#66bb6a;margin-right:6px;font-size:11px"></i>';

            onCallback = () => {};
            onDock = () => {};
            onClose = () => {};

        } else if (key.startsWith('doc:')) {
            // Knowledge Base document. Split by media type:
            //   - PDF: spin up a fresh DocumentViewer so the floating panel
            //     has its own lazy-render pipeline (IntersectionObserver
            //     scoped to its own wrapper, live _pdfPage refs). Cloning
            //     the singleton's DOM is dead for PDFs - pages the user
            //     never scrolled past have no <canvas>, and the unload
            //     observer can have stripped canvases from rendered pages.
            //   - Markdown/static: keep the clone path. Static HTML clones
            //     correctly without needing a live pipeline.
            const doc = app._documentTabs.get(key);
            if (!doc) return;
            const docName = doc.category ? `${doc.category} - ${doc.name}` : doc.name;
            const docLocation = doc.location || '';
            const ext = docLocation.includes('.') ? docLocation.split('.').pop().toLowerCase() : '';
            const iconMap = { md: 'markdown', pdf: 'pdf', txt: 'file' };
            const iconKey = iconMap[ext] || 'file';
            label = `<span style="font-size:12px">${docName}</span>`;
            icon = `<img src="static/vendor/icons/${iconKey}.svg" style="width:14px;height:14px;vertical-align:middle;margin-right:6px">`;

            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%';

            if (ext === 'pdf') {
                const floatingViewer = new DocumentViewer();
                floatingViewer.element.style.cssText = 'flex:1;min-height:0;overflow:auto';
                // Build bars with the floating viewer as the override so
                // PDF page-navigation controls drive THIS viewer (not the
                // docked one). Bars first → viewer below; both children
                // of the flex column wrapper.
                wrapper.appendChild(app._buildDocumentBars(key, floatingViewer, true));
                wrapper.appendChild(floatingViewer.element);
                contentEl = wrapper;

                onCallback = () => {
                    // Call show() AFTER the wrapper is in the DOM so the
                    // IntersectionObserver inside DocumentViewer can resolve
                    // intersections against its wrapper as root. The bars'
                    // syncDisplay is wired via floatingViewer.onReady,
                    // which fires inside show() when placeholders settle.
                    floatingViewer.show(doc);
                };
                onDock = () => {
                    floatingViewer.clear();
                    if (app._documentViewer) {
                        app._documentViewer._currentDoc = null;
                    }
                };
                onClose = () => {
                    floatingViewer.clear();
                };
            } else {
                const docEl = app._documentViewer?.element;
                if (!docEl) return;
                const clonedContent = docEl.cloneNode(true);

                const copyIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" fill="#a8d8a0"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
                const checkIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22863a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
                clonedContent.querySelectorAll('pre .doc-copy-btn').forEach(btn => {
                    const code = btn.parentElement.querySelector('code');
                    if (!code) return;
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const text = code.textContent;
                        const onSuccess = () => {
                            btn.innerHTML = checkIcon + '<span style="font-size:10px;margin-left:4px;font-family:var(--font-sans);color:#22863a">Copied!</span>';
                            btn.classList.add('copied');
                            btn.onanimationend = () => {
                                btn.innerHTML = copyIcon;
                                btn.classList.remove('copied');
                                btn.onanimationend = null;
                            };
                        };
                        if (navigator.clipboard?.writeText) {
                            navigator.clipboard.writeText(text).then(onSuccess).catch(() => {
                                const ta = document.createElement('textarea');
                                ta.value = text;
                                ta.style.cssText = 'position:fixed;opacity:0';
                                document.body.appendChild(ta);
                                ta.select();
                                document.execCommand('copy');
                                ta.remove();
                                onSuccess();
                            });
                        } else {
                            const ta = document.createElement('textarea');
                            ta.value = text;
                            ta.style.cssText = 'position:fixed;opacity:0';
                            document.body.appendChild(ta);
                            ta.select();
                            document.execCommand('copy');
                            ta.remove();
                            onSuccess();
                        }
                    });
                });

                const viewerWrap = document.createElement('div');
                viewerWrap.className = 'document-viewer-wrapper';
                viewerWrap.style.cssText = 'flex:1;min-height:0;overflow:auto';
                viewerWrap.appendChild(clonedContent);
                wrapper.appendChild(viewerWrap);
                contentEl = wrapper;

                onCallback = () => {};
                onDock = () => {
                    if (app._documentViewer) {
                        app._documentViewer._currentDoc = null;
                    }
                };
                onClose = () => {};
            }

        } else if (key.startsWith('detail:')) {
            const detail = app._detailTabs.get(key);
            if (!detail) return;
            contentEl = detail.element;
            if (!contentEl) return;
            label = `<span style="font-size:12px">${detail.title}</span>`;
            icon = '<i class="fa-solid fa-circle-info" style="color:#42a5f5;margin-right:6px;font-size:11px"></i>';

            onCallback = () => {};
            onDock = () => {};
            onClose = () => {};

        } else if (key === 'mlflow' || key === 'airflow' || key === 'minio' || key === 'evidently' || key === 'arcadedb') {
            const wrapper = app._serviceIframes[key];
            if (!wrapper) return;
            const iframe = wrapper.querySelector('iframe');
            const currentUrl = iframe?.contentWindow?.location?.href || iframe?.src || `/${key}`;
            const names = { airflow: 'Apache Airflow', mlflow: 'MLflow', minio: 'MinIO', evidently: 'Evidently', arcadedb: 'ArcadeDB' };
            const icons = {
                mlflow: `<img src="static/images/mlflow.png" style="height:13px;margin-right:6px;vertical-align:top">`,
                airflow: `<img src="static/images/airflow.png" style="height:13px;margin-right:6px;vertical-align:top">`,
                minio: `<img src="static/images/minio.png" style="height:13px;margin-right:6px;vertical-align:top">`,
                evidently: `<img src="static/images/evidently.png" style="height:13px;margin-right:6px;vertical-align:top">`,
                arcadedb: `<img src="static/images/arcadedb.png" style="height:13px;margin-right:6px;vertical-align:top">`,
            };
            label = `<span style="font-size:12px">${names[key]}</span>`;
            icon = icons[key] || '';
            contentEl = wrapper;

            onCallback = (p) => {
                // Make the wrapper visible inside the panel
                wrapper.style.visibility = 'visible';
                wrapper.style.position = 'relative';
                wrapper.style.width = '100%';
                wrapper.style.height = '100%';
                wrapper.style.overflow = '';
                wrapper.style.display = 'flex';
                wrapper.style.flexDirection = 'column';
                wrapper.style.flex = '1';
                wrapper.style.minHeight = '0';
                // Hide the first bar (service-top-bar) - jsPanel header replaces it
                const topBar = wrapper.querySelector('.service-top-bar');
                if (topBar) topBar.style.display = 'none';
                // Remove side borders on second bar when undocked
                const secondBar = wrapper.querySelector('.service-second-bar');
                if (secondBar) { secondBar.style.borderLeft = 'none'; secondBar.style.borderRight = 'none'; secondBar.style.borderBottom = 'none'; }
                // Make iframe fill available space
                if (iframe) {
                    iframe.style.flex = '1';
                    iframe.style.minHeight = '0';
                }
                // Restore URL if iframe reloaded
                if (iframe && currentUrl) {
                    try { iframe.src = currentUrl; } catch {}
                }
            };
            onDock = () => {
                const serviceContainer = document.getElementById('service-tab-container');
                // Restore first bar and second bar borders
                const topBar = wrapper.querySelector('.service-top-bar');
                if (topBar) topBar.style.display = '';
                const sBar = wrapper.querySelector('.service-second-bar');
                if (sBar) { sBar.style.borderLeft = ''; sBar.style.borderRight = ''; sBar.style.borderBottom = ''; }
                // Reset iframe styles
                if (iframe) {
                    iframe.style.flex = '';
                    iframe.style.minHeight = '';
                }
                // Move wrapper back and hide
                serviceContainer.appendChild(wrapper);
                wrapper.style.cssText = 'display:flex; flex-direction:column; flex:1; min-height:0; visibility:hidden; position:absolute; width:0; height:0; overflow:hidden;';
            };
            onClose = () => {
                const topBar = wrapper.querySelector('.service-top-bar');
                if (topBar) topBar.style.display = '';
                const sBar2 = wrapper.querySelector('.service-second-bar');
                if (sBar2) { sBar2.style.borderLeft = ''; sBar2.style.borderRight = ''; sBar2.style.borderBottom = ''; }
                if (iframe) {
                    iframe.style.flex = '';
                    iframe.style.minHeight = '';
                }
                // Move wrapper back and hide
                const serviceContainer = document.getElementById('service-tab-container');
                serviceContainer.appendChild(wrapper);
                wrapper.style.visibility = 'hidden';
                wrapper.style.position = 'absolute';
                wrapper.style.width = '0';
                wrapper.style.height = '0';
                wrapper.style.overflow = 'hidden';
            };

        } else if (key.startsWith('mdpreview:')) {
            const previewData = app._mdPreviewTabs?.get(key);
            if (!previewData) return;
            const shortName = previewData.filename.includes('/')
                ? previewData.filename.split('/').pop()
                : previewData.filename;
            label = `<span style="font-size:12px">${shortName} (Preview)</span>`;
            icon = '<i class="fa-solid fa-eye" style="color:#8e44ad;margin-right:6px;font-size:11px"></i>';

            const sourceEditor = app._fileEditors.get(previewData.sourceKey);
            const markdown = sourceEditor ? sourceEditor.getContent() : previewData.markdown;

            // Build wrapper with bars + content (same structure as docked)
            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%';

            // Top bar
            const topBar = document.createElement('div');
            topBar.className = 'service-top-bar';
            const titleEl = document.createElement('span');
            titleEl.className = 'service-top-bar-title';
            titleEl.textContent = shortName;
            topBar.appendChild(titleEl);
            wrapper.appendChild(topBar);

            // Second bar with breadcrumbs
            const secondBar = document.createElement('div');
            secondBar.className = 'service-second-bar';
            previewData.filename.split('/').forEach((text, i, arr) => {
                if (i > 0) {
                    const sep = document.createElement('span');
                    sep.className = 'breadcrumb-sep';
                    sep.textContent = ' / ';
                    secondBar.appendChild(sep);
                }
                const span = document.createElement('span');
                span.className = 'breadcrumb-segment';
                if (i === arr.length - 1) span.classList.add('breadcrumb-current');
                span.textContent = text;
                secondBar.appendChild(span);
            });
            wrapper.appendChild(secondBar);

            // Markdown content
            const imgResolver = app._buildMdImgResolver(previewData.sourceKey);
            const outer = document.createElement('div');
            outer.className = 'document-viewer-wrapper';
            outer.style.flex = '1';
            const inner = document.createElement('div');
            inner.className = 'document-viewer-content document-viewer-markdown';
            inner.innerHTML = app._documentViewer._renderMarkdownToHtml(markdown, imgResolver);
            if (typeof hljs !== 'undefined') {
                inner.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
            }
            outer.appendChild(inner);
            wrapper.appendChild(outer);
            contentEl = wrapper;

            // Auto-sync in undocked panel
            if (sourceEditor) {
                sourceEditor.onContentChange = (content) => {
                    if (!app._mdPreviewTabs?.has(key)) {
                        sourceEditor.onContentChange = null;
                        return;
                    }
                    inner.innerHTML = app._documentViewer._renderMarkdownToHtml(content, imgResolver);
                    if (typeof hljs !== 'undefined') {
                        inner.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
                    }
                };
            }

            onCallback = (p) => {
                // Hide top bar (panel title replaces it), keep breadcrumbs
                topBar.style.display = 'none';
                secondBar.style.borderLeft = 'none';
                secondBar.style.borderRight = 'none';
            };
            onDock = () => {};
            onClose = () => {
                const editor = app._fileEditors.get(previewData.sourceKey);
                if (editor) editor.onContentChange = null;
            };

        } else {
            return;
        }

        const offset = app._undockedPanels.size * 25;
        const isNotebook = key.startsWith('notebook:');
        const isService = key === 'mlflow' || key === 'airflow' || key === 'minio' || key === 'evidently' || key === 'arcadedb';

        // Dock-vs-close intent tracked via closure rather than a property on
        // the jsPanel object. Property-based signaling (`p._docking = true`)
        // proved unreliable when multiple floating panels coexist — the
        // panel reference passed to `onclosed` doesn't always preserve
        // ad-hoc properties set on the same object reference earlier.
        // The closure flag is panel-local and survives whatever jsPanel
        // does internally between the click and `onclosed`.
        let dockingIntent = false;
        let onclosedHandled = false;

        const panel = jsPanel.create({
            headerTitle: `${icon}${label}`,
            theme: 'none',
            borderRadius: '5px',
            border: '1px solid var(--border-color)',
            panelSize: isNotebook || isService ? { width: '70vw', height: '70vh' } : { width: '60vw', height: '60vh' },
            position: { my: 'center', at: 'center', offsetX: offset, offsetY: offset },
            boxShadow: 3,
            headerControls: { minimize: 'remove', smallify: 'remove', normalize: 'remove', maximize: 'remove' },
            addCloseControl: 1,
            onclosed: () => {
                // jsPanel can fire onclosed more than once for a single
                // close (observed when a destroyed panel re-emits during
                // animation cleanup). Dedupe so the dock-vs-close branch
                // only runs once per panel lifecycle.
                if (onclosedHandled) return;
                onclosedHandled = true;
                app._undockedPanels.delete(key);

                if (dockingIntent) {
                    onDock();
                    app._tabBar.dockTab(key);
                } else {
                    onClose();
                    // Close the tab directly without docking first
                    const tab = app._tabBar._tabs.get(key);
                    if (tab) {
                        tab.undocked = false;
                        app._tabBar.closeTab(key);
                    }
                }
            },
            callback: (p) => {
                p.content.style.cssText = 'padding:0;overflow:auto;background:#fff;position:relative;height:100%;transition:background 0.2s;display:flex;flex-direction:column;';
                if (isNotebook) {
                    p.content.style.overflow = 'hidden';
                }
                if (isNotebook) {
                    const cs = getComputedStyle(document.body);
                    p.content.style.backgroundImage = cs.backgroundImage;
                    p.content.style.backgroundColor = cs.backgroundColor;
                    p.content.style.backgroundSize = cs.backgroundSize;
                    p.content.style.backgroundPosition = cs.backgroundPosition;
                }

                p.content.appendChild(contentEl);
                p.content.style.borderRadius = '0px 0px 5px 5px';

                // Update status bar when undocked panel gets focus
                p.addEventListener('click', () => {
                    if (key.startsWith('notebook:') || key.startsWith('pyfile:')) {
                        app._lastContentKey = key;
                    }
                    const entry = app._editors.get(key);
                    const projectId = entry?.project || app._tabBar._tabs.get(key)?.project;
                    if (projectId) {
                        app._updateStatusProject(projectId);
                        app._updateStatusBranch(projectId);
                    }
                });

                onCallback(p);

                // Refresh notebook CodeMirror after jsPanel takes focus
                // (jsPanel creation steals focus, removing .cm-focused from editors)
                requestAnimationFrame(() => {
                    const activeEntry = app._editors.get(app._activeEditorKey);
                    if (activeEntry?.editor?._cells) {
                        activeEntry.editor._cells.forEach(c => c.editor?.requestMeasure?.());
                    }
                });

                // Add dock button to jsPanel header controls (before close button)
                const controlbar = p.querySelector('.jsPanel-controlbar');
                if (controlbar) {
                    const dockBtn = document.createElement('button');
                    dockBtn.title = 'Dock back to tab bar';
                    dockBtn.style.cssText = 'cursor:pointer;background:none;border:none;padding:4px;margin:0;line-height:1;display:flex;align-items:center;';
                    dockBtn.innerHTML = '<i class="fa-solid fa-down-left-and-up-right-to-center" style="font-size:12px;color:#555555"></i>';
                    dockBtn.addEventListener('click', () => {
                        dockingIntent = true;
                        p.close();
                    });
                    const closeBtn = controlbar.querySelector('.jsPanel-btn-close');
                    if (closeBtn) {
                        controlbar.insertBefore(dockBtn, closeBtn);
                    } else {
                        controlbar.appendChild(dockBtn);
                    }
                }
            }
        });

        app._undockedPanels.set(key, panel);
    }

    app._onDockTab = function(key) {
        // Panel was closed, content already moved back in onclosed callback
        const entry = app._editors.get(key);
        if (entry) {
            // Trigger CodeMirror refresh
            requestAnimationFrame(() => {
                entry.editor._cells?.forEach(cell => cell.editor?.requestMeasure?.());
            });
        }
    }

    app._buildServiceBars = function(key) {
        const frag = document.createDocumentFragment();

        // First bar: title + undock + close
        const bar = document.createElement('div');
        bar.className = 'service-top-bar';

        const urlLabel = document.createElement('span');
        urlLabel.className = 'service-top-bar-title';
        urlLabel.style.cssText = 'flex:1;font-size:11px;color:#333333;font-family:var(--font-sans);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0';
        const names = { airflow: 'Apache Airflow', mlflow: 'MLflow', minio: 'MinIO', evidently: 'Evidently' };
        urlLabel.textContent = `/${key}`;
        bar.appendChild(urlLabel);

        // Update URL label when iframe navigates
        const updateUrl = () => {
            try {
                const wrapper = app._serviceIframes[key];
                const iframe = wrapper?.querySelector('iframe');
                const loc = iframe?.contentWindow?.location;
                if (loc) {
                    const path = loc.pathname + loc.hash;
                    urlLabel.textContent = path;
                    urlLabel.title = loc.href;
                }
            } catch { /* cross-origin */ }
        };
        // Poll on interval since iframe navigation doesn't fire events on parent
        const urlInterval = setInterval(updateUrl, 1000);
        bar._urlInterval = urlInterval;

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

        // Second bar: back/forward + connection status LED + label
        const secondBar = app._buildSecondBar();

        const navGroup = document.createElement('div');
        navGroup.style.cssText = 'display:flex;align-items:center;gap:4px;margin-left:-8px;margin-top:1px';

        const backBtn = document.createElement('button');
        backBtn.className = 'info-bar-text-btn';
        backBtn.innerHTML = '<i class="fa-regular fa-circle-left" style="font-size:13px;color:#555"></i>';
        backBtn.title = 'Back';
        backBtn.addEventListener('click', () => {
            const wrapper = app._serviceIframes[key];
            const iframe = wrapper?.querySelector('iframe');
            try { iframe?.contentWindow?.history.back(); } catch { /* cross-origin */ }
        });
        navGroup.appendChild(backBtn);

        const forwardBtn = document.createElement('button');
        forwardBtn.className = 'info-bar-text-btn';
        forwardBtn.innerHTML = '<i class="fa-regular fa-circle-right" style="font-size:13px;color:#555"></i>';
        forwardBtn.title = 'Forward';
        forwardBtn.addEventListener('click', () => {
            const wrapper = app._serviceIframes[key];
            const iframe = wrapper?.querySelector('iframe');
            try { iframe?.contentWindow?.history.forward(); } catch { /* cross-origin */ }
        });
        navGroup.appendChild(forwardBtn);

        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'info-bar-text-btn';
        refreshBtn.innerHTML = '<i class="fa-solid fa-rotate" style="font-size:11px;color:#555;margin-top:1px"></i>';
        refreshBtn.title = 'Refresh';
        refreshBtn.addEventListener('click', () => {
            const wrapper = app._serviceIframes[key];
            const iframe = wrapper?.querySelector('iframe');
            try { iframe?.contentWindow?.location.reload(); } catch { /* cross-origin */ }
        });
        navGroup.appendChild(refreshBtn);

        const homeBtn = document.createElement('button');
        homeBtn.className = 'info-bar-text-btn';
        homeBtn.innerHTML = '<i class="fa-regular fa-house" style="font-size:12px;color:#555"></i>';
        homeBtn.title = 'Home';
        homeBtn.addEventListener('click', () => {
            const wrapper = app._serviceIframes[key];
            const iframe = wrapper?.querySelector('iframe');
            try { iframe.contentWindow.location.href = `/${key}`; } catch { if (iframe) iframe.src = `/${key}`; }
        });
        navGroup.appendChild(homeBtn);

        secondBar.appendChild(navGroup);

        const statusGroup = document.createElement('div');
        statusGroup.style.cssText = 'display:flex;align-items:center;gap:6px;margin-left:auto;margin-right:8px;';

        const statusLabel = document.createElement('span');
        statusLabel.className = 'service-status-label';
        statusLabel.textContent = 'checking...';
        statusGroup.appendChild(statusLabel);

        const led = document.createElement('span');
        led.className = 'service-status-led';
        statusGroup.appendChild(led);

        secondBar.appendChild(statusGroup);

        // Check connection status
        app._checkServiceStatus(key, led, statusLabel);

        frag.appendChild(secondBar);
        return frag;
    }

    app._openWorkspaceTab = function() {
        app._tabBar.addTab({
            key: 'workspace',
            label: 'Explorer',
            type: 'workspace',
            closable: true,
            preview: true,
        });
    }

    // Menu commands extracted to app-menu.js

    // File/media editors extracted to app-file-editors.js

    /**
     * Open an explorer detail view as a proper tab (undockable).
     * @param {string} tabKey - Tab key like "detail:mlrun:3:abc123"
     * @param {string} label - Tab label
     * @param {HTMLElement} element - Pre-built detail content element
     * @param {object} [opts] - Optional { preview }
     */
}
