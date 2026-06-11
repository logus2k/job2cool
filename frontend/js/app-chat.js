/**
 * app-chat.js - Right panel, LLM chat, and write action handling.
 *
 * Manages:
 * - Right panel initialization (Assistant, Embeddings, Documentation tabs)
 * - Chat service connection and event wiring
 * - Chat undocking to floating jsPanel
 * - LLM context building (notebook cells or file content)
 * - Write action application (update_cell, insert_cell, update_file from LLM)
 * - Right panel toggle/hide
 * - File/notebook reload after git discard
 *
 * Attached to the App instance via initChat(app).
 * Requires: ChatPanel, ChatService, DocPanel, RightPanel, FileEditor (setOnAskAssistant)
 */

import { ChatPanel } from './ChatPanel.js';
import { ChatService } from './ChatService.js';
import { DebugPanel } from './DebugPanel.js';
import { DocPanel } from './DocPanel.js';
import { setOnAskAssistant } from './FileEditor.js';
import { RightPanel } from './RightPanel.js';
import { notify } from './Notify.js';
import { domainState } from './domain-state.js';

/**
 * Attach right panel and chat methods to the App instance.
 * @param {object} app - The App instance
 */
export function initChat(app) {

    /**
     * Initialize the right panel with Assistant, Embeddings, and Documentation tabs.
     * Connects the chat service and wires all event handlers.
     */
    app._initRightPanel = function() {
        const rightPanel = document.getElementById('right-panel');
        app._rightPanel = new RightPanel(rightPanel);

        // Assistant tab
        app._chatPanel = new ChatPanel();
        app._rightPanel.registerView('assistant', {
            tabLabel: 'Assistant',
            titleElement: app._chatPanel.titleBarElement,
            titleButtons: [app._chatPanel.clearButton],
            element: app._chatPanel.element,
            undockable: true,
        });
        app._chatUndocked = null;
        app._rightPanel.onUndock((viewKey) => {
            if (viewKey === 'assistant') app._undockChat();
        });

        // Documentation tab
        app._docPanel = new DocPanel();
        app._rightPanel.registerView('docs', {
            tabLabel: 'Documentation',
            title: 'Documentation',
            element: app._docPanel.element,
        });

        // Debug tab (hidden until debug session starts)
        app._debugPanel = new DebugPanel();
        app._rightPanel.registerView('debug', {
            tabLabel: 'Debug',
            title: 'Debug',
            element: app._debugPanel.element,
        });

        // Debug lifecycle events (bubble from NotebookEditor containers)
        document.addEventListener('debug:started', (e) => {
            app._debugPanel.attach(e.detail.debugClient, e.detail.cells);
            app._rightPanel.show('debug');
            const panel = document.getElementById('right-panel');
            if (panel.style.display === 'none') {
                panel.style.display = 'flex';
                app._chatVisible = true;
            }
        });
        document.addEventListener('debug:stopped', (e) => {
            app._debugPanel.onStopped(e.detail.threadId, e.detail.stackFrames);
        });
        document.addEventListener('debug:continued', () => {
            app._debugPanel.onContinued();
        });
        document.addEventListener('debug:terminated', () => {
            app._debugPanel.detach();
        });
        document.addEventListener('debug:breakpoints-changed', (e) => {
            const d = e.detail || {};
            if (d.cells) {
                app._debugPanel.refreshBreakpoints(d.cells);
            } else if (d.fileEditor) {
                // File breakpoint change - wrap as a cell-like adapter
                const fe = d.fileEditor;
                const adapter = {
                    cellType: 'code',
                    _editorView: fe._editorView,
                    getBreakpoints: () => fe.getBreakpoints(),
                    element: fe._el,
                    setDebugCurrentLine: (n) => fe.setDebugCurrentLine(n),
                };
                const name = (fe._filename || '').split('/').pop() || 'file';
                adapter._bpLabel = name;
                // Merge with existing cells or set as sole source
                if (!app._debugPanel._cells || app._debugPanel._cells === d.cells) {
                    app._debugPanel.refreshBreakpoints([adapter]);
                } else {
                    app._debugPanel.refreshBreakpoints();
                }
            }
        });

        // Navigate to source from debug call stack
        app._debugPanel.onNavigate = (sourcePath, line) => {
            // Check if it's a cell temp file (/tmp/ipykernel_PID/HASH.py)
            if (sourcePath.includes('/ipykernel_')) return;
            // Real file - find project and relative path
            // sourcePath is absolute in the container, e.g. /app/data/projects/MyProject/src/utils.py
            const match = sourcePath.match(/\/(?:projects|mounts)\/([^/]+)\/(.+)$/);
            if (match) {
                const [, projectId, relPath] = match;
                app._openFileTab(projectId, relPath);
                const tabKey = `pyfile:${projectId}:${relPath}`;
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    const editor = app._fileEditors?.get(tabKey);
                    if (editor?._editorView) {
                        const docLine = editor._editorView.state.doc.line(line);
                        editor._editorView.dispatch({
                            selection: { anchor: docLine.from },
                            scrollIntoView: true,
                        });
                    }
                }));
            }
        };

        app._rightPanel.onClose = () => app._hideRightPanel();

        // Views are registered but not opened at startup (clean startup).
        // Each view opens on demand when its icon bar button is clicked.

        app._chatService = new ChatService(app._chatPanel);
        app._chatService.setContextProvider(() => app._buildLLMContext());

        // Wire lint "Ask Assistant" to send a message to the chat
        setOnAskAssistant((message) => {
            app._rightPanel.show('assistant');
            app._chatService.sendMessage(message);
        });
        app._chatService.onWriteAction((action) => app._applyWriteAction(action));
        app._chatService.onNavigate((cellIndex) => app._editor?.scrollToCell(cellIndex));
        // open_file tool — LLM-driven Explorer-double-click equivalent.
        // Dispatch by kind to the matching tab opener already on `app`.
        app._chatService.onOpenFile((p) => app._handleAssistantOpenFile?.(p));
        // create_doc / append_to_doc / replace_doc tools (NOTES-1) — open
        // an in-memory note-taking buffer in the document viewer or update
        // an existing one with new content.
        app._chatService.onDoc((p) => app._handleDocBuffer?.(p));
        // update_file / create_file / append_to_file (NOTES-3) — refresh any
        // open viewer/editor that is showing the touched path.
        app._chatService.onFileChanged((p) => app._handleFileChanged?.(p));
        // Double-click on chat thumbnails / file chips / assistant <img>
        // opens the artifact in a floating jsPanel viewer.
        app._chatPanel.onOpenArtifact((p) => app._openChatArtifact?.(p));

        // Voice Settings (TTS) — when the user saves the modal, push the
        // new {language, gender, voice, speed} into ChatService so the
        // next TTS turn applies it. Also seed ChatService with the panel's
        // initial defaults so the two stay in sync at startup.
        app._chatService.setVoiceSettings(app._chatPanel.getVoiceSettings());
        app._chatPanel.onVoiceSettingsChange((settings) => {
            app._chatService.setVoiceSettings(settings);
        });

        // Workflow lifecycle notices in chat. Subscribe the chat panel to
        // the same Socket.io events the Workflow Monitor listens to, so
        // when a request_new_tool-dispatched workflow finishes (or fails /
        // suspends), a system bubble appears in the chat thread and the
        // notice is persisted to chat history (so the next user turn
        // carries it into the LLM's context). Without this, the assistant
        // anchors on its turn-1 "I'm building it" reply forever and never
        // knows the workflow's outcome.
        if (app._client && typeof app._client.on === 'function') {
            const route = (kind) => (data) => {
                try { app._chatPanel.notifyWorkflowTerminal(kind, data || {}); }
                catch (e) { console.warn('[chat-nudge] render failed:', e); }
            };
            app._client.on('workflow_completed', route('completed'));
            app._client.on('workflow_failed', route('failed'));
            app._client.on('workflow_suspended', route('suspended'));
        }
        // When a workflow terminal event is rendered as a system bubble,
        // ALSO trigger a synthetic chat turn so the assistant generates a
        // real response (streaming + TTS) and the user gets a natural
        // acknowledgement — not just a silent notice. The synthetic user
        // message is hidden (showUserMessage:false), thinking + RAG are
        // disabled (the assistant just acknowledges; no retrieval needed),
        // and tool-calls are suppressed by the prompt itself.
        app._chatPanel.onSystemNotice(async ({ kind, content, workflow_id, workflow_type, reason }) => {
            if (!app._chatService) return;
            // Research-topic user-review pauses get a different synthetic
            // message: the supervisor (this LLM) actively reads the doc,
            // decides accept/iterate, OR escalates to the user. Tool calls
            // are ALLOWED here (unlike other suspend notices) because the
            // supervisor must read the doc and submit the decision.
            const isResearchReview = (
                kind === 'suspended'
                && (reason || '').startsWith('research_user_review')
            );
            let synthetic;
            if (isResearchReview) {
                // Detect cap_reached suspend reason — iterate is disabled
                // server-side at that point, so the prompt MUST NOT offer
                // it as an option. Otherwise Gemma will pick iterate
                // anyway and the handler will keep re-suspending.
                const isCapReached = (reason || '').includes('cap_reached');

                // Mandatory tool-call-first phrasing. Gemma will narrate
                // "I am submitting the decision" instead of actually
                // calling the tool if the prompt reads as a description.
                // Imperatives + explicit ordering keep the tool call from
                // being skipped (per the prior "stops at narration" bug).
                synthetic = (
                    `[system notice] ${content}\n\n`
                    + `You are the supervisor for this paused research workflow. Take action IN THIS ORDER:\n\n`
                    + `STEP 1 (MANDATORY): Call read_doc with the workflow's buffer_id (find it in your earlier chat messages from when you called request_new_research) to see the current document state. Do this even if you remember what you wrote.\n\n`
                    + `STEP 2 (MANDATORY): Decide your verdict and IMMEDIATELY call submit_research_decision. Do not narrate the decision first — make the tool call, then talk.\n`
                    + (isCapReached
                        ? `  The workflow has reached the global iteration cap. ITERATE IS REFUSED. Only two options remain:\n`
                          + `  - submit_research_decision({"workflow_id":"<id from notice>","decision":"accept"}) when the Findings are good enough to call this done.\n`
                          + `  - submit_research_decision({"workflow_id":"<id from notice>","decision":"stop"}) when the doc is partial but the user is satisfied to end the loop.\n`
                          + `  Do NOT call iterate — it will be refused and the workflow will re-suspend.\n\n`
                          + `  Recommended: present the current doc state to the user (1-3 sentences), ask whether they want to accept or stop, then call submit_research_decision with their choice.\n\n`
                        : `  Three valid options:\n`
                          + `  - submit_research_decision({"workflow_id":"<id from notice>","decision":"accept"}) when the Findings satisfy the Goal and the Acceptance Criteria.\n`
                          + `  - submit_research_decision({"workflow_id":"<id from notice>","decision":"iterate"}) when gaps remain. BEFORE making this call, you MUST have written your specific concerns into the doc's ## Review Notes section via replace_doc (read_doc first, append a new ### Iteration N+1 block to Review Notes, then replace_doc with the full updated content).\n`
                          + `  - submit_research_decision({"workflow_id":"<id from notice>","decision":"stop"}) when the user wants to end the loop with the doc in its current state, OR when the reviewer marked a criterion unreachable across multiple iterations.\n\n`
                          + `  ESCALATION RULE: If the doc's Review Notes already shows 2 or more iterations, you MUST escalate to the user rather than auto-iterating again. Summarise the doc state and ask "Accept, iterate further, or stop?". After the user replies, call submit_research_decision with their choice.\n\n`)
                    + `STEP 3 (only after the tool call returned): Tell the user in 1-2 sentences what you decided and why. Do NOT promise to do something — your tool call has already done it.\n\n`
                    + `Note: the user can also abort this workflow immediately at any time via the Workflow Monitor's Abort button — mention this if the user expresses frustration with the loop or asks how to terminate.`
                );
            } else {
                synthetic = (
                    `[system notice] ${content} `
                    + `Briefly acknowledge this to the user in 1–2 short sentences `
                    + `as if the system just informed you. `
                    + (kind === 'completed'
                        ? `Mention the new capability is now ready to use, and invite them to ask for it.`
                        : kind === 'failed'
                            ? `State the failure plainly and point them to the Workflow Monitor.`
                            : `Note it is paused and tell them they can resume or abort via the Workflow Monitor.`)
                    + ` Do NOT call any tools — just speak.`
                );
            }
            try {
                await app._chatService.sendMessage(synthetic, {
                    showUserMessage: false,
                    overrides: {
                        // Research review needs reasoning to weigh
                        // criteria against findings; other notices just
                        // need a sentence of acknowledgement.
                        thinkEnabled: isResearchReview,
                        vectorRagEnabled: false,
                        graphRagEnabled: false,
                    },
                });
            } catch (e) {
                console.warn('[chat-nudge] proactive turn failed:', e);
            }
        });
        // Per-answer KG trace: clicking the trace button on an assistant
        // message opens the GraphPanel in trace mode with the subgraph the
        // model actually used to ground that answer.
        app._chatPanel.onShowGraphTrace(async (payload, btn) => {
            // Per-button panel reuse. If the SAME trace icon was already
            // clicked and its panel is still open, just bring it to front
            // (jsPanel.front()) instead of spawning a duplicate. The panel
            // ref is stashed on the button element; cleared on close so
            // the next click opens a fresh panel.
            const existing = btn && btn._tracePanel;
            if (existing && existing._panel && document.body.contains(existing._panel)) {
                if (typeof existing._panel.front === 'function') {
                    existing._panel.front();
                }
                return;
            }
            const { GraphPanel } = await import('./knowledge-graph/GraphPanel.js');
            const panel = new GraphPanel(null, {
                traceData: payload,
                onClose: () => { if (btn) btn._tracePanel = null; },
            });
            panel.open();
            // jsPanel exposes events via `.options.onclosed`, but our
            // GraphPanel doesn't expose a public hook. Watch for DOM removal
            // as a fallback so reopening works after manual close.
            if (btn) {
                btn._tracePanel = panel;
                if (panel._panel && typeof panel._panel.addEventListener === 'function') {
                    panel._panel.addEventListener('jspanelclosed', () => {
                        btn._tracePanel = null;
                    });
                }
            }
        });

        // Citation badge click: resolve via the citation API and dispatch
        // by type:
        //   chunk      → open the source document + deep-jump to page+bbox
        //   entity     → open GraphPanel in trace mode focused on entity
        //   relationship → open GraphPanel showing both endpoints + edge
        //   community  → open GraphPanel with the community subgraph
        app._chatPanel.onCitationClick(async (tag, badgeEl) => {
            try {
                const resp = await fetch(`api/citations/${encodeURIComponent(tag)}`);
                if (!resp.ok) {
                    badgeEl.title = 'Citation source unavailable';
                    return;
                }
                const meta = await resp.json();

                if (meta.type === 'chunk' && meta.source_path) {
                    const basename = meta.source_path.split('/').pop() || meta.source_path;
                    const tabKey = `doc:Documents:${basename}`;
                    const doc = {
                        name: basename,
                        category: 'Documents',
                        location: `${meta.domain_id}/${meta.source_path}`,
                    };
                    // `regions` is the multi-page bbox list. The resolver
                    // synthesizes a single-entry list from page_no/bbox
                    // for chunks ingested before the multi-region change
                    // so this is always populated for chunks with prov.
                    const jump = {
                        regions: meta.regions || [],
                        section_path: meta.section_path,
                    };
                    // If the document tab is already active AND showing
                    // this same document, the tab handler won't fire
                    // (TabBar.activate early-returns when activeKey is
                    // unchanged). Apply the jump directly instead. Now
                    // checks the per-tab viewer in app._documentViewers
                    // (since the singleton _documentViewer is no longer the
                    // primary doc-tab renderer post-PDF-state-preservation
                    // fix).
                    const sameTabActive = app._tabBar?.activeKey === tabKey;
                    const activeViewer = app._documentViewers?.get(tabKey);
                    const sameDocLoaded = !!activeViewer?._currentDoc &&
                        (activeViewer._currentDoc.location === doc.location);
                    if (sameTabActive && sameDocLoaded) {
                        if (jump.regions && jump.regions.length) {
                            activeViewer.showBboxHighlights(jump.regions);
                        } else if (jump.section_path) {
                            activeViewer.scrollToHeading(jump.section_path);
                        }
                        return;
                    }
                    // Otherwise stash and let the tab handler run on activation.
                    app._pendingCitationJump = jump;
                    app._openDocumentTab(doc);
                    return;
                }

                if (meta.type === 'entity' || meta.type === 'relationship' || meta.type === 'community') {
                    // All three reuse the GraphPanel trace view. The trace
                    // payload shape (entities + edges + seed_entity_id) is
                    // already what GraphPanel expects via traceData.
                    const { GraphPanel } = await import('./knowledge-graph/GraphPanel.js');
                    let traceData;
                    if (meta.type === 'community') {
                        // Community: synthesize a minimal trace from the
                        // member list. GraphPanel will visualize members
                        // as the seed cluster.
                        const members = meta.members || [];
                        traceData = {
                            seed_entity_id: members[0]?.id || `C${meta.community_id}`,
                            entities: members.map(m => ({
                                id: m.id,
                                label: m.label || m.id,
                                type: m.type || 'concept',
                                properties: m.properties || {},
                            })),
                            edges: [],
                            community_summary: meta.summary || '',
                        };
                    } else {
                        traceData = meta.trace || { entities: [], edges: [] };
                    }
                    const panel = new GraphPanel(null, { traceData });
                    panel.open();
                    return;
                }

                badgeEl.title = `Citation type not yet supported: ${meta.type}`;
            } catch (err) {
                console.warn('Citation resolve failed:', err);
                badgeEl.title = 'Citation resolve failed';
            }
        });

        // Live trace preview: when the chat panel's "Live trace" toggle
        // is on, typing in the input fires this callback with the typed
        // question. We hit the same retrieval the chat tool uses and
        // update a single dedicated preview panel in real time. The
        // panel is reused across keystrokes; if the user closes it the
        // next typing pause re-opens it.
        let livePreviewPanel = null;
        let livePreviewAbort = null;
        app._chatPanel.onLiveTraceQuery(async (question) => {
            if (livePreviewAbort) livePreviewAbort.abort();
            livePreviewAbort = new AbortController();
            const myAbort = livePreviewAbort;
            try {
                const resp = await fetch(`api/graph/research/${domainState.getFirstKnowledgeDomain()}/retrieve`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ question }),
                    signal: myAbort.signal,
                });
                if (!resp.ok || myAbort.signal.aborted) return;
                const payload = await resp.json();
                payload.question = question;
                if (!livePreviewPanel || livePreviewPanel._disposed) {
                    const { GraphPanel } = await import('./knowledge-graph/GraphPanel.js');
                    livePreviewPanel = new GraphPanel(null, { traceData: payload, livePreview: true });
                    livePreviewPanel.open();
                } else {
                    livePreviewPanel.updateTraceData(payload);
                }
            } catch (e) {
                if (e.name !== 'AbortError') console.warn('Live trace preview failed:', e);
            }
        });
        app._chatService.onStatusChange((status) => {
            app._rightPanel.setStatusLed(status);
            if (app._chatUndockedLed) {
                app._chatUndockedLed.className = `right-panel-status-led ${status === 'connected' ? 'connected' : ''}`;
            }
            if (app._chatUndockedLabel) {
                app._chatUndockedLabel.textContent = status === 'connected' ? 'Connected' : 'Disconnected';
            }
            if (status === 'connected') notify.success('Assistant connected');
            else if (status === 'disconnected') notify.error('Assistant disconnected');
        });
        app._chatService.connect().catch(err => {
            console.error('Chat service connection failed:', err);
            app._rightPanel.setStatusLed('disconnected');
        });

        // Global "Ask Assistant" event
        document.addEventListener('ask-assistant', (e) => {
            const msg = e.detail?.message;
            if (!msg) return;
            // Open the right panel if it is currently hidden
            if (!app._chatVisible) {
                const panel = document.getElementById('right-panel');
                app._chatVisible = true;
                panel.style.display = 'flex';
                app._syncIconBar();
            }
            app._rightPanel.show('assistant');
            app._chatPanel._input?.focus();
            const action = e.detail.action || null;
            const displayMsg = e.detail.displayMessage || msg;
            app._chatPanel.addMessage('user', displayMsg, null, action);
            app._chatService.sendMessage(msg, { showUserMessage: false });
        });
    };

    /** Undock the Assistant chat to a floating jsPanel window. */
    app._undockChat = function() {
        if (app._chatUndocked) return;

        const chatEl = app._chatPanel.element;
        const parentContainer = chatEl.parentElement;
        const titleBarEl = app._chatPanel.titleBarElement;

        app._rightPanel.close('assistant');

        const statusLabel = app._rightPanel._statusLabel.textContent;
        const statusClass = app._rightPanel._statusLed.className;

        const panel = jsPanel.create({
            headerTitle: '<i class="fa-solid fa-comment" style="font-size:12px;margin-right:6px;color:#4caf50"></i> Assistant',
            theme: 'none',
            borderRadius: '5px',
            border: '1px solid var(--border-color)',
            panelSize: { width: '800px', height: '42vh' },
            position: { my: 'center', at: 'center' },
            boxShadow: 3,
            headerControls: { minimize: 'remove', smallify: 'remove', normalize: 'remove', maximize: 'remove' },
            addCloseControl: 1,
            onclosed: (p) => {
                parentContainer.appendChild(chatEl);
                chatEl.style.display = '';
                app._chatUndocked = null;
                app._chatUndockedLed = null;
                app._chatUndockedLabel = null;

                app._rightPanel.show('assistant');
                const rightPanelEl = document.getElementById('right-panel');
                if (rightPanelEl) rightPanelEl.style.display = 'flex';
                app._chatVisible = true;
                app._syncIconBar();
            },
            callback: (p) => {
                p.content.style.cssText = 'padding:0;overflow:hidden;background:#fdfaf3;display:flex;flex-direction:column;height:100%;';

                const barWrapper = document.createElement('div');
                barWrapper.className = 'right-panel-title-bar';
                barWrapper.style.cssText = 'flex-shrink:0;border-radius:0;border-left:none;border-top:none;background:#fff9e3;';
                barWrapper.appendChild(titleBarEl);

                const spacer = document.createElement('span');
                spacer.style.flex = '1';
                barWrapper.appendChild(spacer);

                const clearBtn = app._chatPanel.clearButton.cloneNode(true);
                clearBtn.className = 'sidebar-close-btn';
                clearBtn.title = 'Clear chat';
                clearBtn.addEventListener('click', () => {
                    if (app._chatService) app._chatService.clearHistory();
                });
                barWrapper.appendChild(clearBtn);

                const ledLabel = document.createElement('span');
                ledLabel.className = 'right-panel-status-label';
                ledLabel.textContent = statusLabel;
                barWrapper.appendChild(ledLabel);

                const led = document.createElement('span');
                led.className = statusClass;
                led.style.cssText = 'margin-left:4px;margin-right:4px;';
                barWrapper.appendChild(led);

                p.content.appendChild(barWrapper);
                p.content.appendChild(chatEl);
                chatEl.style.display = 'flex';

                const controlbar = p.querySelector('.jsPanel-controlbar');
                if (controlbar) {
                    const dockBtn = document.createElement('button');
                    dockBtn.className = 'sidebar-close-btn';
                    dockBtn.title = 'Dock back to panel';
                    dockBtn.style.cssText = 'cursor:pointer;background:none;border:none;padding:4px;margin:0;line-height:1;display:flex;align-items:center;';
                    dockBtn.innerHTML = '<i class="fa-solid fa-down-left-and-up-right-to-center" style="font-size:12px;color:#555"></i>';
                    dockBtn.addEventListener('click', () => p.close());
                    const closeBtn = controlbar.querySelector('.jsPanel-btn-close');
                    controlbar.insertBefore(dockBtn, closeBtn);
                }

                app._chatUndockedLed = led;
                app._chatUndockedLabel = ledLabel;
            },
        });

        app._chatUndocked = panel;
    };

    /**
     * Build the context object sent with each LLM chat message.
     * Includes project ID, file/notebook path, cell contents, selected cells, etc.
     */
    app._buildLLMContext = function() {
        const activeKey = app._tabBar?.activeKey;
        const contextKey = (activeKey && (activeKey.startsWith('pyfile:') || activeKey.startsWith('notebook:')))
            ? activeKey
            : app._lastContentKey;

        // File context
        if (contextKey && contextKey.startsWith('pyfile:')) {
            const rest = contextKey.substring(7);
            const colonIdx = rest.indexOf(':');
            let projectId = rest.substring(0, colonIdx);
            let filename = rest.substring(colonIdx + 1);
            const fileEditor = app._fileEditors?.get(contextKey);
            const content = fileEditor?.getContent?.() || '';
            return {
                project_id: projectId || null,
                file_path: filename || null,
                file_content: content || null,
                notebook_path: null,
                selected_cell_indices: [],
                active_run_id: null,
                hydra_config_hash: null,
            };
        }

        // Notebook context
        const editor = (contextKey && contextKey.startsWith('notebook:'))
            ? app._editors.get(contextKey)?.editor
            : app._editor;
        if (!editor) return null;

        const selected = editor.selectedCellIndices;
        const selectedIndices = selected.length > 0 ? selected : (
            editor.lastFocusedCellIndex !== null ? [editor.lastFocusedCellIndex] : []
        );

        const activeRunId = app._metricsPanel?._runId || editor.lastMlflowRunId || null;

        const notebookCells = (editor.cells || []).map(c => ({
            cell_type: c.cellType,
            source: c.source,
        }));

        return {
            project_id: editor.projectId || null,
            notebook_path: editor.notebookPath || null,
            notebook_cells: notebookCells,
            selected_cell_indices: selectedIndices,
            active_run_id: activeRunId,
            hydra_config_hash: editor.hydraConfig?.hash || null,
        };
    };

    /**
     * Apply a write action from the LLM (update_cell, insert_cell, update_file).
     * Called after user approves the change in the confirmation panel.
     */
    app._applyWriteAction = function(action) {
        if (action.tool === 'update_cell' || action.tool === 'insert_cell') {
            // Find editor by action's project/notebook, falling back to active editor key
            let editor = null;
            const actionProject = action.project_id;
            const actionNotebook = action.notebook_path;
            if (actionProject && actionNotebook) {
                for (const [key, entry] of app._editors) {
                    if (entry.project === actionProject && entry.notebook === actionNotebook) {
                        editor = entry.editor;
                        break;
                    }
                }
            }
            if (!editor) {
                const contextKey = (app._activeEditorKey && app._activeEditorKey.startsWith('notebook:'))
                    ? app._activeEditorKey
                    : app._lastContentKey;
                editor = (contextKey && contextKey.startsWith('notebook:'))
                    ? app._editors.get(contextKey)?.editor
                    : app._editor;
            }
            if (!editor) return;

            if (action.tool === 'update_cell') {
                const cellIndex = action.args.cell_index;
                const newContent = action.args.new_content || '';
                const cell = editor.cells?.[cellIndex];
                console.log('[WriteAction] update_cell:', {
                    cellIndex, hasEditor: !!editor, cellCount: editor.cells?.length,
                    hasCell: !!cell, hasEditorView: !!cell?._editorView,
                    contentLen: newContent.length
                });
                if (cell) {
                    cell.setSource(newContent);
                    // Re-render markdown overlay if the cell is currently showing rendered markdown
                    if (cell._markdownRendered && cell._showMarkdownRendered) {
                        cell._showMarkdownRendered();
                    }
                    app._client.updateCell(cellIndex, newContent, editor._notebookKey);
                }
            } else if (action.tool === 'insert_cell') {
                const afterIndex = action.args.after_cell_index;
                const cellType = action.args.cell_type || 'code';
                const content = action.args.content || '';
                editor._addCell(afterIndex + 1, cellType);
                const newCell = editor.cells[afterIndex + 1];
                if (newCell && content) {
                    newCell.setSource(content);
                    app._client.updateCell(afterIndex + 1, content, editor._notebookKey);
                }
            }
            editor.save();
        } else if (action.tool === 'update_file') {
            const activeKey = app._tabBar?.activeKey;
            const contextKey = (activeKey && activeKey.startsWith('pyfile:'))
                ? activeKey
                : (app._lastContentKey?.startsWith('pyfile:') ? app._lastContentKey : null);
            if (contextKey && app._fileEditors?.has(contextKey)) {
                const fileEditor = app._fileEditors.get(contextKey);
                fileEditor.setContent(action.args.new_content || '');
            }
        }
    };

    /** Toggle a view in the right panel and update visibility. */
    app._toggleRightPanel = function(view) {
        const panel = document.getElementById('right-panel');
        app._rightPanel.toggle(view);
        app._chatVisible = app._rightPanel.openViews.size > 0;
        panel.style.display = app._chatVisible ? 'flex' : 'none';
        app._syncIconBar();
    };

    /**
     * Reload open file/notebook editors after git discard.
     * Files use editor.reload(), notebooks re-fetch via REST and relint.
     */
    app._reloadDiscardedFiles = function(filePaths) {
        if (app._fileEditors) {
            for (const [key, editor] of app._fileEditors) {
                for (const fp of filePaths) {
                    if (key.endsWith(':' + fp)) {
                        editor.reload();
                        break;
                    }
                }
            }
        }
        for (const [key, entry] of app._editors) {
            for (const fp of filePaths) {
                if (key.endsWith(':' + fp)) {
                    const rootType = app._explorerPanel?._projectSources?.[entry.project] === 'mount' ? 'mount' : 'project';
                    fetch(`api/files/${rootType}/${encodeURIComponent(entry.project)}/read?path=${encodeURIComponent(entry.notebook)}`)
                        .then(r => r.json())
                        .then(data => {
                            if (data.content) {
                                entry.editor.loadNotebook(data.content);
                                app._client.socket.emit('notebook:relint', {
                                    notebook_key: entry.editor._notebookKey,
                                });
                            }
                        })
                        .catch(() => {});
                    break;
                }
            }
        }
    };

    /** Hide the right panel completely. */
    app._hideRightPanel = function() {
        const panel = document.getElementById('right-panel');
        app._chatVisible = false;
        panel.style.display = 'none';
        app._syncIconBar();
    };
}
