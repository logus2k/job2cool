/**
 * marked math extension - intercepts $$...$$ and $...$ before marked processes
 * the text, so backslashes and underscores inside math are never corrupted by
 * markdown rules.  Renders directly via katex.renderToString().
 *
 * Must run once at module load time (marked.use is idempotent-safe when the
 * extension names are unique).
 */
(function _installMarkedMath() {
    if (typeof marked === 'undefined' || typeof katex === 'undefined') return;
    marked.use({
        extensions: [
            // Block math: $$...$$ (must be checked before inline $)
            {
                name: 'math_block',
                level: 'block',
                start(src) { return src.indexOf('$$'); },
                tokenizer(src) {
                    const m = src.match(/^\$\$([\s\S]+?)\$\$/);
                    if (m) return { type: 'math_block', raw: m[0], math: m[1] };
                },
                renderer(token) {
                    try {
                        return katex.renderToString(token.math.trim(), { displayMode: true, throwOnError: false });
                    } catch { return `<div>$$${token.math}$$</div>`; }
                },
            },
            // Inline math: $...$  (single-line, non-empty content)
            {
                name: 'math_inline',
                level: 'inline',
                start(src) { return src.indexOf('$'); },
                tokenizer(src) {
                    const m = src.match(/^\$([^$\n]+?)\$/);
                    if (m) return { type: 'math_inline', raw: m[0], math: m[1] };
                },
                renderer(token) {
                    try {
                        return katex.renderToString(token.math.trim(), { displayMode: false, throwOnError: false });
                    } catch { return `<span>$${token.math}$</span>`; }
                },
            },
        ],
    });
}());

/** Decide whether a graph_provenance payload has anything worth showing
 *  in the trace panel. Prevents the "Show graph" icon from appearing on
 *  conceptual / definitional questions where graph traversal returned
 *  nothing — the trace would just open to "0 entities, 0 grounded
 *  relationships" and look broken. Counts as content if any of:
 *  entities, edges, or chunk_excerpts is non-empty. */
function _traceHasContent(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const e = Array.isArray(payload.entities) ? payload.entities.length : 0;
    const r = Array.isArray(payload.edges) ? payload.edges.length : 0;
    const c = Array.isArray(payload.chunk_excerpts) ? payload.chunk_excerpts.length : 0;
    return (e + r + c) > 0;
}

/**
 * ChatPanel - Chat UI component for the assistant panel.
 * Builds header, messages area, typing indicator, and input area.
 */
export class ChatPanel {

    constructor() {
        this._onSendCallback = null;
        this._onClearCallback = null;
        this._onDebugToggle = null;
        this._onSttToggleCallback = null;
        this._onTtsToggleCallback = null;
        this._onModelChangeCallback = null;
        this._onShowGraphTrace = null;
        // Open-artifact callback — fired on double-click of any chat
        // image thumbnail or file chip (user-uploaded OR assistant-
        // rendered <img> in markdown). Wired by app-chat.js to
        // app._openChatArtifact which pops a floating viewer panel.
        this._onOpenArtifact = null;
        // Per-message trace button state. Attached as soon as the
        // graph_provenance SSE event arrives (before thinking/answer
        // streaming) so the user sees "Show graph" alongside "Show
        // reasoning" rather than only after the stream completes.
        this._traceButtonEl = null;
        this._pendingGraphTrace = null;
        // Live trace preview: when the user has the toggle on, typing
        // in the chat input fires a debounced retrieval and updates a
        // dedicated GraphPanel. State + callback wired by app-chat.js.
        this._onLiveTraceQuery = null;
        this._liveTraceTimer = null;
        this._sttActive = false;
        // Voice Settings (TTS) — current in-memory selection. Defaults
        // mirror tts_server's settings. `language: 'auto'` means keep the
        // existing per-text language detection (current behavior); a
        // specific language code disables auto-switching and pins the
        // chosen voice + speed for every TTS turn. No persistence: the
        // selection resets on browser refresh.
        this._voiceSettings = {
            language: 'auto',
            gender: 'f',
            voice: 'af_heart',
            speed: 1.1,
        };
        this._onVoiceSettingsChangeCallback = null;
        this._build();
    }

    get element() { return this._panel; }
    get titleBarElement() { return this._titleBarEl; }
    get clearButton() { return this._clearBtn; }

    _build() {
        const panel = document.createElement('div');
        panel.className = 'chat-panel';

        // Title bar element (placed in RightPanel's title area)
        this._titleBarEl = document.createElement('div');
        this._titleBarEl.className = 'chat-title-bar-content';

        // Model selector (leftmost)
        this._modelSelect = document.createElement('select');
        this._modelSelect.className = 'chat-model-select';
        this._modelSelect.title = 'Active model';
        this._lastConfirmedModel = null;
        this._modelSelectHandler = () => {
            if (this._onModelChangeCallback) this._onModelChangeCallback(this._modelSelect.value);
        };
        this._modelSelect.addEventListener('change', this._modelSelectHandler);
        this._titleBarEl.appendChild(this._modelSelect);

        // Think checkbox
        this._thinkEnabled = true;
        const thinkLabel = document.createElement('label');
        thinkLabel.className = 'chat-think-label';
        this._thinkCheckbox = document.createElement('input');
        this._thinkCheckbox.type = 'checkbox';
        this._thinkCheckbox.checked = true;
        this._thinkCheckbox.className = 'chat-think-checkbox';
        this._thinkCheckbox.addEventListener('change', () => {
            this._thinkEnabled = this._thinkCheckbox.checked;
        });
        thinkLabel.appendChild(this._thinkCheckbox);
        const thinkText = document.createElement('span');
        thinkText.textContent = 'Extended Thinking';
        thinkLabel.appendChild(thinkText);
        this._titleBarEl.appendChild(thinkLabel);

        // Debug checkbox
        this._debugEnabled = false;
        const debugLabel = document.createElement('label');
        debugLabel.className = 'chat-think-label';
        this._debugCheckbox = document.createElement('input');
        this._debugCheckbox.type = 'checkbox';
        this._debugCheckbox.checked = false;
        this._debugCheckbox.className = 'chat-think-checkbox';
        this._debugCheckbox.addEventListener('change', () => {
            this._debugEnabled = this._debugCheckbox.checked;
            if (this._onDebugToggle) this._onDebugToggle(this._debugEnabled);
        });
        debugLabel.appendChild(this._debugCheckbox);
        const debugText = document.createElement('span');
        debugText.textContent = 'Debug';
        debugLabel.appendChild(debugText);
        this._titleBarEl.appendChild(debugLabel);

        // Live trace preview checkbox - when on, typing in the chat
        // textarea fires a debounced graph_provenance retrieval and
        // updates a dedicated GraphPanel in trace mode in real time.
        this._liveTraceEnabled = false;
        const liveTraceLabel = document.createElement('label');
        liveTraceLabel.className = 'chat-think-label';
        this._liveTraceCheckbox = document.createElement('input');
        this._liveTraceCheckbox.type = 'checkbox';
        this._liveTraceCheckbox.checked = false;
        this._liveTraceCheckbox.className = 'chat-think-checkbox';
        this._liveTraceCheckbox.addEventListener('change', () => {
            this._liveTraceEnabled = this._liveTraceCheckbox.checked;
            // When the toggle is turned off, cancel any pending live fire.
            if (!this._liveTraceEnabled && this._liveTraceTimer) {
                clearTimeout(this._liveTraceTimer);
                this._liveTraceTimer = null;
            }
        });
        liveTraceLabel.title = 'When on, typing in the chat fires a live KG trace preview as you type';
        liveTraceLabel.appendChild(this._liveTraceCheckbox);
        const liveTraceText = document.createElement('span');
        liveTraceText.textContent = 'Live trace';
        liveTraceLabel.appendChild(liveTraceText);
        this._titleBarEl.appendChild(liveTraceLabel);

        // Vector RAG checkbox — when off, the LLM's tool list excludes
        // search_docs (and graph_and_vector_search, which needs both
        // halves), so the model won't fire vector retrieval this turn.
        this._vectorRagEnabled = true;
        const vectorLabel = document.createElement('label');
        vectorLabel.className = 'chat-think-label';
        this._vectorRagCheckbox = document.createElement('input');
        this._vectorRagCheckbox.type = 'checkbox';
        this._vectorRagCheckbox.checked = true;
        this._vectorRagCheckbox.className = 'chat-think-checkbox';
        this._vectorRagCheckbox.addEventListener('change', () => {
            this._vectorRagEnabled = this._vectorRagCheckbox.checked;
        });
        vectorLabel.title = 'Disable to suppress vector RAG retrieval (search_docs + graph_and_vector_search) for the next turn.';
        vectorLabel.appendChild(this._vectorRagCheckbox);
        const vectorText = document.createElement('span');
        vectorText.textContent = 'Vector RAG';
        vectorLabel.appendChild(vectorText);
        this._titleBarEl.appendChild(vectorLabel);

        // GraphRAG checkbox — when off, the LLM's tool list excludes
        // research_topic, query_knowledge_graph, and graph_and_vector_search.
        this._graphRagEnabled = true;
        const graphLabel = document.createElement('label');
        graphLabel.className = 'chat-think-label';
        this._graphRagCheckbox = document.createElement('input');
        this._graphRagCheckbox.type = 'checkbox';
        this._graphRagCheckbox.checked = true;
        this._graphRagCheckbox.className = 'chat-think-checkbox';
        this._graphRagCheckbox.addEventListener('change', () => {
            this._graphRagEnabled = this._graphRagCheckbox.checked;
        });
        graphLabel.title = 'Disable to suppress GraphRAG retrieval (research_topic, query_knowledge_graph, graph_and_vector_search) for the next turn.';
        graphLabel.appendChild(this._graphRagCheckbox);
        const graphText = document.createElement('span');
        graphText.textContent = 'GraphRAG';
        graphLabel.appendChild(graphText);
        this._titleBarEl.appendChild(graphLabel);

        // Clear button
        this._clearBtn = document.createElement('button');
        this._clearBtn.className = 'chat-clear-btn';
        this._clearBtn.title = 'Clear chat';
        this._clearBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" fill="#f4a0a0"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
        this._clearBtn.addEventListener('click', () => {
            if (this._onClearCallback) this._onClearCallback();
        });

        // Messages area
        this._messagesArea = document.createElement('div');
        this._messagesArea.className = 'chat-messages';
        // Delegated handler: chat-citation badges (rendered by
        // _renderCitations) carry their tag in data-citation-tag on the
        // surrounding wrap, so clicking either the icon or the number
        // both fire the same handler. Either selector resolves to the
        // wrap; the anchor inside keeps its tag for keyboard nav.
        this._messagesArea.addEventListener('click', (e) => {
            const wrap = e.target.closest('.chat-citation-wrap');
            if (wrap && this._onCitationClick) {
                e.preventDefault();
                const tag = wrap.dataset.citationTag
                    || wrap.querySelector('a.chat-citation')?.dataset.citationTag;
                if (tag) this._onCitationClick(tag, wrap);
            }
        });
        panel.appendChild(this._messagesArea);

        // Typing indicator
        this._typingIndicator = document.createElement('div');
        this._typingIndicator.className = 'chat-typing-indicator';
        this._typingIndicator.innerHTML = '<span></span><span></span><span></span>';
        this._typingIndicator.style.display = 'none';
        this._messagesArea.appendChild(this._typingIndicator);

        // Input area
        const inputArea = document.createElement('div');
        inputArea.className = 'chat-input-area';

        // "+" attachments / new-content menu. Anchors the left edge of the
        // input area. Opens a dropdown with: Document (KB upload), Notebook
        // (create in current/selected project), Image (upload to project
        // assets), Audio (upload to project assets). Whitelist + size cap
        // enforced server-side via /api/files/upload-asset
        // (NOTED_MAX_UPLOAD_MB env var). The mic and speaker buttons sit on
        // the right of the text input, alongside Send.
        this._attachBtn = document.createElement('button');
        this._attachBtn.className = 'chat-attach-btn';
        this._attachBtn.title = 'Attach / new';
        this._attachBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" fill="#fbe5b4"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>';
        this._attachBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleAttachMenu();
        });
        inputArea.appendChild(this._attachBtn);

        // Dropdown menu — built lazily on first open, anchored above
        // the + button via fixed positioning so it floats over the
        // chat layout instead of pushing it.
        this._attachMenu = null;

        // Text input
        this._input = document.createElement('textarea');
        this._input.className = 'chat-input';
        this._input.placeholder = 'Type a message...';
        this._input.rows = 1;
        this._input.spellcheck = false;
        this._input.addEventListener('input', () => {
            this._autoGrow();
            this._scheduleLiveTrace();
        });
        this._input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this._handleSend();
            }
        });
        inputArea.appendChild(this._input);

        // Send button
        const sendBtn = document.createElement('button');
        sendBtn.className = 'chat-send-btn';
        sendBtn.title = 'Send message';
        sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 2 15 22 11 13 2 9" fill="#b4e4b4"/><line x1="22" y1="2" x2="11" y2="13"/></svg>';
        sendBtn.addEventListener('click', () => this._handleSend());
        inputArea.appendChild(sendBtn);

        // STT (mic) button — placed between Send and TTS on the right side
        // of the input. Icons are inline SVG (Carbon-style) from
        // frontend/images/. fill="currentColor" lets CSS drive the colour.
        //
        //   OFF: mic-off-32-filled — bold solid silhouette in mid-grey.
        //   ON:  STACK of two SVGs to get Send-style two-tone treatment —
        //          1) mic-32-filled (pastel red fill, bottom layer)
        //          2) mic-32-regular (dark outline, top layer)
        //        The regular path traces the outline + lower stem; layered
        //        over the filled body it produces an outline-on-fill look
        //        equivalent to the Send arrow's stroke-on-polygon style.
        //   ON + listening (VAD speech-start): .listening pulses the pill.
        this._sttBtn = document.createElement('button');
        this._sttBtn.className = 'chat-stt-btn';
        this._sttBtn.title = 'Voice input';
        this._sttIconOn = '<span class="chat-icon-stack">'
            + '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" class="chat-icon-fill"><path fill="currentColor" d="M16 2a6 6 0 0 0-6 6v8a6 6 0 0 0 12 0V8a6 6 0 0 0-6-6M7 15a1 1 0 0 1 1 1a8 8 0 1 0 16 0a1 1 0 1 1 2 0c0 5.186-3.947 9.45-9.001 9.95L17 26v3a1 1 0 1 1-2 0v-3l.001-.05C9.947 25.45 6 21.187 6 16a1 1 0 0 1 1-1"/></svg>'
            + '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" class="chat-icon-outline"><path fill="currentColor" d="M16 2a6 6 0 0 0-6 6v8a6 6 0 0 0 12 0V8a6 6 0 0 0-6-6m4 14a4 4 0 0 1-8 0V8a4 4 0 0 1 8 0zM7 15a1 1 0 0 1 1 1a8 8 0 1 0 16 0a1 1 0 1 1 2 0c0 5.186-3.947 9.45-9.001 9.95L17 26v3a1 1 0 1 1-2 0v-3l.001-.05C9.947 25.45 6 21.187 6 16a1 1 0 0 1 1-1"/></svg>'
            + '</span>';
        this._sttIconOff = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 32 32" fill="currentColor"><path d="M10 11.415V16a6 6 0 0 0 9.477 4.89l1.429 1.43A8 8 0 0 1 8 16a1 1 0 1 0-2 0c0 5.186 3.948 9.45 9.002 9.95L15 26v3a1 1 0 1 0 2 0v-3.05a9.95 9.95 0 0 0 5.329-2.207l5.964 5.964a1 1 0 0 0 1.414-1.414l-26-26a1 1 0 0 0-1.414 1.414zm13.143 8.193l1.473 1.472A9.95 9.95 0 0 0 26 16a1 1 0 1 0-2 0a8 8 0 0 1-.857 3.608M10.159 6.624l11.467 11.467A6 6 0 0 0 22 16V8a6 6 0 0 0-11.84-1.376"/></svg>';
        this._sttBtn.innerHTML = this._sttIconOff;
        // Insert a half-icon gap between Send and Mic so users don't
        // fat-finger Mic when reaching for Send.
        this._sttBtn.style.marginLeft = '15px';
        this._sttBtn.addEventListener('click', () => {
            this._sttActive = !this._sttActive;
            this._sttBtn.classList.toggle('active', this._sttActive);
            this._sttBtn.innerHTML = this._sttActive ? this._sttIconOn : this._sttIconOff;
            // Drop any leftover listening pulse when the user toggles off.
            if (!this._sttActive) this._sttBtn.classList.remove('listening');
            if (this._onSttToggleCallback) this._onSttToggleCallback(this._sttActive);
        });
        inputArea.appendChild(this._sttBtn);

        // TTS (speaker) button — same two-tone stack pattern as the mic.
        //   OFF: speaker-mute-32-filled — solid silhouette with the X.
        //   ON:  STACK of two SVGs:
        //          1) speaker-2-32-filled (pastel green fill, bottom)
        //          2) speaker-2-32-regular (dark outline, top)
        this._ttsBtn = document.createElement('button');
        this._ttsBtn.className = 'chat-tts-btn';
        this._ttsBtn.title = 'Text to speech';
        this._ttsIconOff = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 32 32" fill="currentColor"><path d="M18 5.604c0-1.114-1.346-1.672-2.134-.884l-4.694 4.694A2 2 0 0 1 9.757 10H6a4 4 0 0 0-4 4v4a4 4 0 0 0 4 4h3.757a2 2 0 0 1 1.415.586l4.694 4.694c.788.788 2.134.23 2.134-.884zm3.293 6.689a1 1 0 0 1 1.414 0L25 14.586l2.293-2.293a1 1 0 0 1 1.414 1.414L26.414 16l2.293 2.293a1 1 0 0 1-1.414 1.414L25 17.414l-2.293 2.293a1 1 0 0 1-1.414-1.414L23.586 16l-2.293-2.293a1 1 0 0 1 0-1.414"/></svg>';
        this._ttsIconOn = '<span class="chat-icon-stack">'
            + '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" class="chat-icon-fill"><path fill="currentColor" d="M18 5.433c0-1.398-1.742-2.036-2.645-.97l-4.086 4.83A2 2 0 0 1 9.743 10H6a4 4 0 0 0-4 4v4a4 4 0 0 0 4 4h3.743a2 2 0 0 1 1.526.708l4.086 4.829c.902 1.066 2.645.428 2.645-.97zm3.433 3.743a1 1 0 0 1 1.391.258c1.465 2.13 2.238 4.324 2.238 6.566s-.773 4.436-2.238 6.567a1 1 0 1 1-1.648-1.133c1.285-1.87 1.887-3.676 1.887-5.434s-.602-3.564-1.887-5.433a1 1 0 0 1 .258-1.39m4.257-3.9a1 1 0 0 0-1.38 1.448c2.387 2.273 3.628 5.739 3.628 9.276s-1.241 7.003-3.628 9.276a1 1 0 0 0 1.38 1.448c2.863-2.727 4.247-6.761 4.247-10.724S28.554 8.003 25.69 5.276"/></svg>'
            + '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" class="chat-icon-outline"><path fill="currentColor" d="M18 5.604c0-1.114-1.346-1.671-2.134-.884l-4.694 4.695A2 2 0 0 1 9.757 10H6a4 4 0 0 0-4 4v4a4 4 0 0 0 4 4h3.757a2 2 0 0 1 1.415.585l4.694 4.695c.788.787 2.134.23 2.134-.884zm-5.414 5.225L16 7.415v17.171l-3.414-3.414A4 4 0 0 0 9.757 20H6a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h3.757a4 4 0 0 0 2.829-1.171m10.238-1.395a1 1 0 1 0-1.648 1.133c1.285 1.87 1.887 3.676 1.887 5.433c0 1.758-.602 3.565-1.887 5.434a1 1 0 1 0 1.648 1.133c1.465-2.13 2.238-4.324 2.238-6.567c0-2.242-.773-4.435-2.238-6.566m2.866-4.158a1 1 0 0 0-1.38 1.449c2.387 2.273 3.628 5.738 3.628 9.275s-1.241 7.003-3.628 9.276a1 1 0 1 0 1.38 1.449c2.863-2.727 4.247-6.762 4.247-10.725S28.554 8.003 25.69 5.276"/></svg>'
            + '</span>';
        this._ttsBtn.innerHTML = this._ttsIconOff;
        this._ttsActive = false;
        this._ttsBtn.addEventListener('click', () => {
            this._ttsActive = !this._ttsActive;
            this._ttsBtn.classList.toggle('active', this._ttsActive);
            this._ttsBtn.innerHTML = this._ttsActive ? this._ttsIconOn : this._ttsIconOff;
            if (this._onTtsToggleCallback) this._onTtsToggleCallback();
        });
        inputArea.appendChild(this._ttsBtn);

        // Voice Settings button — opens a modal to choose language, gender,
        // voice, and speed. Sits to the right of the Speaker, follows the
        // same Fluent-style icon + cream pill resting/hover treatment. Not
        // a toggle: every click opens the modal. The icon is an equalizer
        // (three horizontal sliders with knobs) — semantically "tune the
        // voice", visually distinct from Mic / Speaker.
        this._voiceSettingsBtn = document.createElement('button');
        this._voiceSettingsBtn.className = 'chat-voice-settings-btn';
        this._voiceSettingsBtn.title = 'Voice settings';
        this._voiceSettingsBtn.innerHTML =
            '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 32 32" fill="currentColor">'
            + '<path d="M3 8a1 1 0 0 1 1-1h6.05a3.5 3.5 0 0 1 6.9 0H28a1 1 0 1 1 0 2H16.95a3.5 3.5 0 0 1-6.9 0H4a1 1 0 0 1-1-1m10.5 1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M3 16a1 1 0 0 1 1-1h14.05a3.5 3.5 0 0 1 6.9 0H28a1 1 0 1 1 0 2h-3.05a3.5 3.5 0 0 1-6.9 0H4a1 1 0 0 1-1-1m18.5 1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M3 24a1 1 0 0 1 1-1h2.05a3.5 3.5 0 0 1 6.9 0H28a1 1 0 1 1 0 2H12.95a3.5 3.5 0 0 1-6.9 0H4a1 1 0 0 1-1-1m6.5 1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3"/>'
            + '</svg>';
        this._voiceSettingsBtn.style.marginRight = '10px';
        this._voiceSettingsBtn.addEventListener('click', async () => {
            const { modalVoiceSettings } = await import('./modal.js');
            const result = await modalVoiceSettings(this._voiceSettings);
            if (!result) return;  // cancelled
            this._voiceSettings = result;
            if (this._onVoiceSettingsChangeCallback) {
                this._onVoiceSettingsChangeCallback(result);
            }
        });
        inputArea.appendChild(this._voiceSettingsBtn);

        panel.appendChild(inputArea);

        // Bottom bar (token count)
        const bottomBar = document.createElement('div');
        bottomBar.className = 'chat-bottom-bar';

        // Token counter
        this._tokenCounter = document.createElement('div');
        this._tokenCounter.className = 'chat-token-counter';
        this._tokenCounter.title = 'Estimated token usage';
        bottomBar.appendChild(this._tokenCounter);

        panel.appendChild(bottomBar);

        this._panel = panel;
    }

    // ── Attach / new menu ─────────────────────────────────────────────
    // Lazy-built dropdown anchored above the + button. Each option
    // closes the menu before invoking the action so the action's own
    // modal can take over without UI overlap.

    _toggleAttachMenu() {
        if (this._attachMenu && this._attachMenu.style.display !== 'none') {
            this._closeAttachMenu();
        } else {
            this._openAttachMenu();
        }
    }

    _openAttachMenu() {
        if (!this._attachMenu) this._buildAttachMenu();
        const menu = this._attachMenu;
        // Position above the + button. Fixed positioning so the menu
        // floats over surrounding panels rather than shifting layout.
        const r = this._attachBtn.getBoundingClientRect();
        document.body.appendChild(menu);
        menu.style.display = 'block';
        // Measure after display:block to get real height.
        const mh = menu.offsetHeight || 0;
        const mw = menu.offsetWidth || 200;
        const top = Math.max(8, r.top - mh - 6);
        const left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;
        // Click-outside-to-close: register on next tick so this open
        // click doesn't immediately fire it.
        setTimeout(() => {
            this._attachOutsideHandler = (ev) => {
                if (!menu.contains(ev.target) && ev.target !== this._attachBtn) {
                    this._closeAttachMenu();
                }
            };
            document.addEventListener('click', this._attachOutsideHandler);
            this._attachEscHandler = (ev) => {
                if (ev.key === 'Escape') this._closeAttachMenu();
            };
            document.addEventListener('keydown', this._attachEscHandler);
        }, 0);
    }

    _closeAttachMenu() {
        if (this._attachMenu) this._attachMenu.style.display = 'none';
        if (this._attachOutsideHandler) {
            document.removeEventListener('click', this._attachOutsideHandler);
            this._attachOutsideHandler = null;
        }
        if (this._attachEscHandler) {
            document.removeEventListener('keydown', this._attachEscHandler);
            this._attachEscHandler = null;
        }
    }

    _buildAttachMenu() {
        const menu = document.createElement('div');
        menu.className = 'chat-attach-menu';
        // Icon palette matches the Explorer convention: colored fills
        // for the body shape + a dark stroke for the outline. Each
        // option's tint hints at the file family (KB-green for File,
        // tools-blue for Image, music-pink for Audio).
        const items = [
            {
                key: 'file',
                label: 'File',
                hint: 'Attach file content to your next message',
                iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="#81c784" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8" fill="none"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>',
                action: () => this._actionAttachContextFile(),
            },
            {
                key: 'image',
                label: 'Image',
                hint: 'Attach image to your next message',
                iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="#64b5f6" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="#fff8e9"/><polyline points="21 15 16 10 5 21" fill="none"/></svg>',
                action: () => this._actionUploadAsset('image'),
            },
            {
                key: 'audio',
                label: 'Audio',
                hint: 'Attach audio (on hold)',
                iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="#ba68c8" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13" fill="none"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
                action: () => this._actionUploadAsset('audio'),
            },
        ];
        for (const it of items) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'chat-attach-menu-item';
            row.innerHTML = `
                <span class="chat-attach-menu-icon">${it.iconSvg}</span>
                <span class="chat-attach-menu-text">
                    <span class="chat-attach-menu-label">${it.label}</span>
                    <span class="chat-attach-menu-hint">${it.hint}</span>
                </span>`;
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                this._closeAttachMenu();
                try { it.action(); } catch (err) { console.error('[chat-attach]', it.key, err); }
            });
            menu.appendChild(row);
        }
        menu.style.display = 'none';
        this._attachMenu = menu;
    }

    // ── Attach-menu actions ──────────────────────────────────────────
    // Each action delegates to existing app surfaces where possible
    // (KB upload, notebook create) and falls back to file-picker +
    // /api/files/upload-asset for raw asset types (image, audio).

    async _actionAttachContextFile() {
        // Pick a file → run it through the chat-context extractor
        // registry → hold the extracted text as a pending attachment.
        // The next message Send will inline the text into the wire
        // payload (NOT to the KB). PDF/DOCX support is added by
        // registering new strategies in ChatContextExtractors.js.
        const cfg = await this._getUploadConfig();
        if (!cfg) {
            this._notifyError('Could not load upload config.');
            return;
        }
        // Single-attachment policy: image OR file, never both. Picking a
        // new attachment replaces whatever was held.
        if (this._pendingAttachment) this._clearAttachment();

        const { chatContextExtractors } = await import('./ChatContextExtractors.js');
        const accept = (cfg.chat_context_text_extensions || []).join(',');
        const input = document.createElement('input');
        input.type = 'file';
        if (accept) input.accept = accept;
        input.style.display = 'none';
        document.body.appendChild(input);
        const file = await new Promise((resolve) => {
            input.addEventListener('change', () => resolve(input.files?.[0] || null), { once: true });
            input.click();
        });
        input.remove();
        if (!file) return;

        // Pre-read size cap (uses the existing NOTED_MAX_UPLOAD_MB).
        const maxBytes = (cfg.max_size_mb || 20) * 1024 * 1024;
        if (file.size > maxBytes) {
            this._notifyError(`"${file.name}" is too large (${(file.size / (1024*1024)).toFixed(1)} MB > ${cfg.max_size_mb} MB cap).`);
            return;
        }

        const extractor = chatContextExtractors.findFor(file, cfg);
        if (!extractor) {
            const ext = file.name.includes('.') ? '.' + file.name.split('.').pop().toLowerCase() : '(none)';
            this._notifyError(`No extractor for ${ext} — supported: ${(cfg.chat_context_text_extensions || []).join(', ')}`);
            return;
        }

        let result;
        try {
            result = await extractor.extract(file, cfg);
        } catch (e) {
            this._notifyError(`Could not read "${file.name}": ${e?.message || e}`);
            return;
        }

        this._pendingAttachment = {
            kind: 'file-context',
            extractorKind: extractor.kind,
            name: result.name,
            text: result.text,
            charsRead: result.charsRead,
            charLimit: result.charLimit,
            truncated: result.truncated,
            size: file.size,
        };
        this._renderAttachmentChip();
    }

    async _actionUploadAsset(kind) {
        // Image: hold-as-pending-attachment pattern. The picked file is
        // NOT uploaded to a project asset folder; it's encoded in-place
        // and attached to the next chat message as an OpenAI-style
        // multimodal content block (image_url with a data: URL). The
        // chat HTTP path already forwards multimodal content through
        // noted backend → agent_server → llama-server → gemma-4 (which
        // has mmproj loaded and reports `vision: true`).
        //
        // Audio is on hold per project decisions (see attach-menu hint
        // text); fall through to a stub for now.
        if (kind !== 'image') {
            this._notifyError('Audio attachment is on hold.');
            return;
        }

        // Single attachment at a time. Picking a new image while one is
        // already pending replaces it (with a quick visual confirm).
        const cfg = await this._getUploadConfig();
        if (!cfg) {
            this._notifyError('Could not load upload configuration from the server.');
            return;
        }
        const accept = cfg.image_extensions.join(',');
        const maxBytes = cfg.max_size_mb * 1024 * 1024;

        // Transient file input — the OS picker is the right UX for
        // "pick an image to attach". Removed after use.
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.style.display = 'none';
        document.body.appendChild(input);
        const file = await new Promise((resolve) => {
            input.addEventListener('change', () => resolve(input.files?.[0] || null), { once: true });
            input.addEventListener('cancel', () => resolve(null), { once: true });
            input.click();
        });
        document.body.removeChild(input);
        if (!file) return;

        // Client-side guards mirror the server-side whitelist + size cap
        // so the user gets immediate feedback rather than waiting for
        // the round trip to fail. (The send path is HTTP chat, not
        // upload-asset, so the server doesn't actually validate the
        // image bytes — these checks are the only enforcement.)
        if (file.size > maxBytes) {
            this._notifyError(`"${file.name}" is too large (${(file.size / (1024*1024)).toFixed(1)} MB > ${cfg.max_size_mb} MB cap).`);
            return;
        }
        const ext = file.name.includes('.') ? '.' + file.name.split('.').pop().toLowerCase() : '';
        const allowed = cfg.image_extensions.map(e => e.toLowerCase());
        if (!allowed.includes(ext)) {
            this._notifyError(`"${file.name}": extension ${ext || '(none)'} not allowed. Allowed: ${allowed.join(', ')}`);
            return;
        }

        // Read as data URL for both the chip thumbnail AND the eventual
        // multimodal content block. One read, two uses.
        let dataUrl;
        try {
            dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(reader.error || new Error('FileReader error'));
                reader.readAsDataURL(file);
            });
        } catch (err) {
            this._notifyError(`Could not read image: ${err.message || err}`);
            return;
        }

        this._pendingAttachment = {
            kind: 'image',
            name: file.name,
            type: file.type || 'image/*',
            size: file.size,
            dataUrl,
        };
        this._renderAttachmentChip();
        // Focus the input so the user can immediately type a prompt.
        try { this._input.focus(); } catch (_e) {}
    }

    _renderAttachmentChip() {
        // Strip any existing chip first (replace-on-pick semantics).
        if (this._attachmentChipEl) {
            this._attachmentChipEl.remove();
            this._attachmentChipEl = null;
        }
        if (!this._pendingAttachment) return;
        const att = this._pendingAttachment;
        const isFileContext = att.kind === 'file-context';
        const chip = document.createElement('div');
        chip.className = 'chat-attachment-chip';

        if (isFileContext) {
            // File-context chip: paperclip glyph instead of a thumbnail
            // (no preview makes sense for arbitrary text content).
            const icon = document.createElement('div');
            icon.className = 'chat-attachment-chip-thumb';
            icon.style.display = 'flex';
            icon.style.alignItems = 'center';
            icon.style.justifyContent = 'center';
            icon.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="#81c784" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8" fill="none"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>';
            chip.appendChild(icon);
        } else {
            const thumb = document.createElement('img');
            thumb.className = 'chat-attachment-chip-thumb';
            thumb.src = att.dataUrl;
            thumb.alt = att.name;
            chip.appendChild(thumb);
        }

        const meta = document.createElement('div');
        meta.className = 'chat-attachment-chip-meta';
        const nameEl = document.createElement('div');
        nameEl.className = 'chat-attachment-chip-name';
        nameEl.textContent = att.name;
        nameEl.title = att.name;
        const sizeEl = document.createElement('div');
        sizeEl.className = 'chat-attachment-chip-size';
        if (isFileContext) {
            const chars = att.charsRead.toLocaleString();
            sizeEl.textContent = att.truncated
                ? `${chars} chars · trimmed to limit (${att.charLimit.toLocaleString()})`
                : `${chars} chars · file`;
        } else {
            const kb = att.size / 1024;
            sizeEl.textContent = kb >= 1024
                ? `${(kb / 1024).toFixed(1)} MB · image`
                : `${kb.toFixed(0)} KB · image`;
        }
        meta.appendChild(nameEl);
        meta.appendChild(sizeEl);
        chip.appendChild(meta);

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'chat-attachment-chip-remove';
        removeBtn.title = 'Remove attachment';
        removeBtn.innerHTML = '&times;';
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._clearAttachment();
        });
        chip.appendChild(removeBtn);

        // Place the chip immediately above the input area so it reads
        // as "this is attached to the next message I'll send."
        const inputArea = this._input?.parentElement;
        if (inputArea?.parentElement) {
            inputArea.parentElement.insertBefore(chip, inputArea);
        }
        this._attachmentChipEl = chip;
    }

    _clearAttachment() {
        this._pendingAttachment = null;
        if (this._attachmentChipEl) {
            this._attachmentChipEl.remove();
            this._attachmentChipEl = null;
        }
    }

    async _getUploadConfig() {
        if (this._uploadConfigCache) return this._uploadConfigCache;
        try {
            const r = await fetch('api/files/upload-config');
            if (!r.ok) return null;
            this._uploadConfigCache = await r.json();
            return this._uploadConfigCache;
        } catch (_e) {
            return null;
        }
    }

    _notifyError(msg) {
        // Lazy-load to avoid a hard import at the top of this file
        // (matches the pattern already used by other ChatPanel methods
        // that use modal/notify imports on demand).
        import('./Notify.js').then(({ notify }) => notify.error(msg));
    }

    _autoGrow() {
        this._input.style.height = 'auto';
        this._input.style.height = Math.min(this._input.scrollHeight, 120) + 'px';
    }

    get thinkEnabled() { return this._thinkEnabled; }
    get vectorRagEnabled() { return this._vectorRagEnabled; }
    get graphRagEnabled() { return this._graphRagEnabled; }

    /** Populate the model dropdown. Called after health check. */
    setModels(models, activeModel) {
        const prev = this._modelSelect.value;
        this._modelSelect.innerHTML = '';
        for (const m of models) {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.display_name || m.id;
            if (m.id === activeModel) opt.selected = true;
            this._modelSelect.appendChild(opt);
        }
        if (!activeModel && prev) {
            this._modelSelect.value = prev;
        }
        this._lastConfirmedModel = this._modelSelect.value;
    }

    /** Legacy: called from onModelInfo path. Adds a single option if empty. */
    setModelName(name) {
        if (!name || this._modelSelect.options.length > 0) return;
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        this._modelSelect.appendChild(opt);
    }

    onModelChange(cb) { this._onModelChangeCallback = cb; }

    /** Register a click handler for citation badges. The callback receives
     * the tag (e.g. `markdown_chunk:abc123def4`) and the anchor element. */
    onCitationClick(cb) { this._onCitationClick = cb; }

    /** Async-upgrade a chunk-citation's icon to fa-image / fa-table when
     * the chunk is a picture/table caption. The badge is rendered with
     * the default fa-file-lines first; this fetch resolves the chunk's
     * `kind` from the existing /api/citations resolver and swaps classes
     * if needed. Per-tag cache prevents duplicate fetches when several
     * citations point at the same chunk. Failures are silent — the
     * default icon stays. */
    _upgradeCitationIcon(tag, wrap, icon) {
        if (!this._citationKindCache) this._citationKindCache = new Map();
        const cached = this._citationKindCache.get(tag);
        const apply = (kind) => {
            if (kind === 'picture_caption') {
                wrap.classList.remove('cite-family-doc');
                wrap.classList.add('cite-family-picture');
                icon.classList.remove('fa-file-lines');
                icon.classList.add('fa-image');
            } else if (kind === 'table_caption') {
                wrap.classList.remove('cite-family-doc');
                wrap.classList.add('cite-family-table');
                icon.classList.remove('fa-file-lines');
                icon.classList.add('fa-table');
            }
        };
        if (cached !== undefined) {
            apply(cached);
            return;
        }
        // Mark in-flight so concurrent renders for the same tag don't all
        // queue fetches; they wait for the first promise instead.
        if (this._citationKindInFlight && this._citationKindInFlight.has(tag)) {
            this._citationKindInFlight.get(tag).then((kind) => apply(kind));
            return;
        }
        if (!this._citationKindInFlight) this._citationKindInFlight = new Map();
        const promise = (async () => {
            try {
                const r = await fetch(`api/citations/${encodeURIComponent(tag)}`);
                if (!r.ok) return 'text';
                const meta = await r.json();
                const kind = meta && meta.kind ? meta.kind : 'text';
                this._citationKindCache.set(tag, kind);
                return kind;
            } catch {
                return 'text';
            } finally {
                this._citationKindInFlight.delete(tag);
            }
        })();
        this._citationKindInFlight.set(tag, promise);
        promise.then((kind) => apply(kind));
    }

    /** Revert the dropdown to the previously confirmed model without firing the change event. */
    revertModelSelect() {
        if (this._lastConfirmedModel) {
            this._modelSelect.removeEventListener('change', this._modelSelectHandler);
            this._modelSelect.value = this._lastConfirmedModel;
            this._modelSelect.addEventListener('change', this._modelSelectHandler);
        }
    }

    _handleSend() {
        const rawText = this._input.value.trim();
        const att = this._pendingAttachment;

        // Empty text + no attachment = nothing to send.
        if (!rawText && !att) return;

        // Default prompts when the user only attached without typing.
        let text = rawText;
        if (att && !rawText) {
            text = att.kind === 'file-context'
                ? `Please review the attached file "${att.name}".`
                : 'Describe this image.';
        }

        // Cancel any pending live-trace fire - the real chat flow takes
        // over and will emit the actual graph_provenance event.
        if (this._liveTraceTimer) {
            clearTimeout(this._liveTraceTimer);
            this._liveTraceTimer = null;
        }

        // Build the message payload. Three shapes today:
        //   - plain text (no attachment):  string
        //   - image attached: OpenAI-style content list
        //       [{type:"text",...}, {type:"image_url",...}]
        //   - file-context attached: content list where the file
        //     contents are inlined as a separate text block, framed
        //     with <file name="..."> markers so the model can find
        //     them. The displayPayload uses a `file_excerpt` block
        //     instead so addMessage can render a small chip in the
        //     user bubble (NOT dump 50k chars of file content).
        // agent_server's openai_compat.ChatMessage.content already
        // accepts Union[str, list[dict]] and the noted backend
        // forwards unchanged. Unknown block types in displayPayload
        // never reach the wire.
        let wirePayload;
        let displayPayload;
        if (att && att.kind === 'file-context') {
            const fileText = `<file name="${att.name}">\n${att.text}\n</file>`;
            wirePayload = [
                { type: 'text', text: fileText },
                { type: 'text', text },
            ];
            displayPayload = [
                {
                    type: 'file_excerpt',
                    name: att.name,
                    charsRead: att.charsRead,
                    charLimit: att.charLimit,
                    truncated: att.truncated,
                    // Stash the raw text on the display block so the
                    // bubble's chip can be double-clicked later to open
                    // the full content in a floating viewer panel. The
                    // wire payload doesn't include this field; only the
                    // local UI render branch reads it.
                    text: att.text,
                },
                { type: 'text', text },
            ];
        } else if (att) {
            wirePayload = displayPayload = [
                { type: 'text', text },
                { type: 'image_url', image_url: { url: att.dataUrl } },
            ];
        } else {
            wirePayload = displayPayload = text;
        }

        // Render the user bubble with the display shape (chip for
        // file-context). Send the wire shape so the model sees the
        // file content inline.
        this.addMessage('user', displayPayload);
        this._input.value = '';
        this._input.style.height = 'auto';
        this._clearAttachment();

        if (this._onSendCallback) {
            this._onSendCallback(wirePayload);
        }
    }

    /** Register a callback for live trace previews. Receives the typed
     * question text whenever the user pauses typing (debounced) and the
     * "Live trace" checkbox is on. */
    onLiveTraceQuery(callback) {
        this._onLiveTraceQuery = callback;
    }

    /** Schedule a live trace fire after the user pauses typing. Skipped
     * when: toggle is off, callback unset, input too short (< 8 chars),
     * or a streaming message is already in flight (the real chat flow
     * is currently producing an answer). 350ms debounce keeps the
     * noted-rag GPU embed queue manageable even for fast typists. */
    _scheduleLiveTrace() {
        if (this._liveTraceTimer) {
            clearTimeout(this._liveTraceTimer);
            this._liveTraceTimer = null;
        }
        if (!this._liveTraceEnabled || !this._onLiveTraceQuery) return;
        if (this._streamingMsg) return; // chat flow already producing an answer
        const text = (this._input.value || '').trim();
        if (text.length < 8) return;
        this._liveTraceTimer = setTimeout(() => {
            this._liveTraceTimer = null;
            try { this._onLiveTraceQuery(text); } catch {}
        }, 350);
    }

    addMessage(role, text, thinkingContent = null, actionLabel = null) {
        const msg = document.createElement('div');
        msg.className = `chat-message chat-message-${role}`;

        // Multimodal user bubbles. When `text` arrives as an OpenAI-style
        // content list (text + image_url blocks from a chat-input image
        // attachment), render thumbnails INLINE alongside the text. The
        // assistant branch never receives this shape — model output is
        // always plain text from our streaming pipeline.
        if (role === 'user' && Array.isArray(text)) {
            const textParts = text.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n').trim();
            const imageParts = text.filter(b => b && b.type === 'image_url' && b.image_url?.url);
            const fileParts = text.filter(b => b && b.type === 'file_excerpt');
            if (actionLabel) {
                const badge = document.createElement('span');
                badge.className = 'chat-action-badge';
                badge.textContent = actionLabel;
                msg.appendChild(badge);
            }
            if (imageParts.length) {
                const stripe = document.createElement('div');
                stripe.className = 'chat-message-attachments';
                for (const block of imageParts) {
                    const img = document.createElement('img');
                    img.className = 'chat-message-attachment-thumb';
                    img.src = block.image_url.url;
                    img.alt = 'attached image';
                    img.style.cursor = 'zoom-in';
                    img.title = 'Double-click to open in a floating viewer';
                    img.addEventListener('dblclick', (e) => {
                        e.stopPropagation();
                        if (this._onOpenArtifact) {
                            this._onOpenArtifact({
                                kind: 'image',
                                src: block.image_url.url,
                                name: 'attached_image',
                            });
                        }
                    });
                    stripe.appendChild(img);
                }
                msg.appendChild(stripe);
            }
            if (fileParts.length) {
                // Render a compact chip for each attached file (the
                // wire payload carries the actual content; this is just
                // the visible marker in the bubble so a 50k-char dump
                // doesn't drown the chat history).
                const stripe = document.createElement('div');
                stripe.className = 'chat-message-attachments';
                for (const block of fileParts) {
                    const chip = document.createElement('span');
                    chip.className = 'chat-message-file-chip';
                    const chars = (block.charsRead || 0).toLocaleString();
                    const trimNote = block.truncated ? ` · trimmed to ${(block.charLimit || 0).toLocaleString()}` : '';
                    chip.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="#81c784" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8" fill="none"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>';
                    const label = document.createElement('span');
                    label.textContent = `${block.name || 'file'} · ${chars} chars${trimNote}`;
                    chip.appendChild(label);
                    if (typeof block.text === 'string' && block.text.length) {
                        chip.style.cursor = 'pointer';
                        chip.title = 'Double-click to open in a floating viewer';
                        chip.addEventListener('dblclick', (e) => {
                            e.stopPropagation();
                            if (this._onOpenArtifact) {
                                this._onOpenArtifact({
                                    kind: 'file',
                                    name: block.name || 'file',
                                    text: block.text,
                                    charLimit: block.charLimit,
                                    truncated: block.truncated,
                                });
                            }
                        });
                    }
                    stripe.appendChild(chip);
                }
                msg.appendChild(stripe);
            }
            if (textParts) {
                const userDiv = document.createElement('div');
                userDiv.innerHTML = this._renderMarkdown(textParts);
                userDiv.querySelectorAll('pre code[class*="language-"]').forEach((block) => {
                    hljs.highlightElement(block);
                });
                this._renderMath(userDiv);
                msg.appendChild(userDiv);
            }
            this._messagesArea.insertBefore(msg, this._typingIndicator);
            this._messagesArea.scrollTop = this._messagesArea.scrollHeight;
            return;
        }

        if (role === 'assistant') {
            // Check if this is an error message
            if (text.startsWith('Error:')) {
                const errorDiv = document.createElement('div');
                errorDiv.className = 'chat-error';
                errorDiv.textContent = text;
                msg.appendChild(errorDiv);
            } else {
                // Optional collapsible reasoning section. Reuse the
                // streamed-message builder so history-restored thinking
                // gets markdown rendering + citation badges, same as
                // freshly-streamed messages.
                if (thinkingContent && thinkingContent.trim()) {
                    msg.appendChild(this._buildThinkingDetails(thinkingContent.trim()));
                }

                const answerDiv = document.createElement('div');
                answerDiv.innerHTML = this._renderMarkdown(text);
                answerDiv.querySelectorAll('pre code[class*="language-"]').forEach((block) => {
                    hljs.highlightElement(block);
                });
                this._renderMath(answerDiv);
                this._addCopyButtons(answerDiv);
                this._wireImageOpenHandlers(answerDiv);
                // History-restored messages must run the citation transform too;
                // finalizeStreamingMessage handles fresh streams, this handles
                // anything reloaded from server-side memory. Without this call
                // the bracket tags (`[markdown_chunk:hex]`, `[E:..]`, etc.)
                // appear as raw text on page reload.
                this._renderCitations(answerDiv);
                msg.appendChild(answerDiv);
                // Stash raw text so the top-right action bar's Copy and
                // Copy-All buttons can copy the original tagged text rather
                // than the rendered DOM (rendered badges have textContent
                // = ordinal "1", "2", etc., which is useless when copied).
                msg._answerRaw = text || '';
                msg._thinkingRaw = (thinkingContent || '').trim();
                this._createMessageActions(msg);
            }
        } else {
            // Action badge for assistant menu actions
            if (actionLabel) {
                const badge = document.createElement('span');
                badge.className = 'chat-action-badge';
                badge.textContent = actionLabel;
                msg.appendChild(badge);
            }
            // User messages: render markdown for code blocks
            const userDiv = document.createElement('div');
            userDiv.innerHTML = this._renderMarkdown(text);
            userDiv.querySelectorAll('pre code[class*="language-"]').forEach((block) => {
                hljs.highlightElement(block);
            });
            this._renderMath(userDiv);
            msg.appendChild(userDiv);
        }

        // Insert before typing indicator
        this._messagesArea.insertBefore(msg, this._typingIndicator);
        this._messagesArea.scrollTop = this._messagesArea.scrollHeight;
    }

    /**
     * Render a system-side notice in the chat thread. Used to surface
     * workflow lifecycle events (completed / failed / suspended) so the
     * user sees the outcome inline without polling, and the next user
     * turn carries the notice into LLM context (the persistence is the
     * caller's job, via onSystemNotice).
     *
     * @param {('completed'|'failed'|'suspended')} kind - terminal status flavor
     * @param {object} info - { workflow_id, workflow_type?, outcomes?, error?, reason?, suspend_reason? }
     */
    notifyWorkflowTerminal(kind, info = {}) {
        const wfId = info.workflow_id || '';
        const wfType = info.workflow_type || info.type || 'workflow';

        // System-notice copy is FACTUAL ONLY — what happened, with what
        // outcomes / reason. Any "try asking again", "resume via the
        // Workflow Monitor", or other user-facing call to action belongs
        // to the assistant's reaction (the synthetic chat turn fired
        // through onSystemNotice handles that), not to the system bubble.
        let icon, label, body;
        if (kind === 'completed') {
            icon = '✓'; label = 'Capability ready';
            const outcomes = (info.outcomes || []).join(', ');
            body = outcomes
                ? `${wfType} ${wfId} completed (${outcomes}).`
                : `${wfType} ${wfId} completed.`;
        } else if (kind === 'failed') {
            icon = '✗'; label = 'Workflow failed';
            const reason = info.error || info.reason || 'unknown error';
            body = `${wfType} ${wfId} ended in failure: ${reason}`;
        } else if (kind === 'suspended') {
            icon = '⚠'; label = 'Workflow paused';
            const reason = info.suspend_reason || info.reason || 'awaiting decision';
            body = `${wfType} ${wfId} is suspended: ${reason}`;
        } else {
            return;
        }

        const msg = document.createElement('div');
        msg.className = `chat-message chat-message-system chat-message-system-${kind}`;
        const head = document.createElement('div');
        head.className = 'chat-system-head';
        head.textContent = `${icon} ${label}`;
        msg.appendChild(head);
        const para = document.createElement('div');
        para.className = 'chat-system-body';
        para.textContent = body;
        msg.appendChild(para);

        this._messagesArea.insertBefore(msg, this._typingIndicator);
        this._messagesArea.scrollTop = this._messagesArea.scrollHeight;

        if (this._onSystemNotice) {
            // Also persist into chat history so the LLM sees the notice on
            // the next user turn. The caller (app-chat.js) attaches
            // client_id + project_id and POSTs to /api/llm/system-notice.
            this._onSystemNotice({
                kind,
                workflow_id: wfId,
                workflow_type: wfType,
                reason: info.suspend_reason || info.reason || null,
                content: `${label}: ${body}`,
            });
        }
    }

    /** Set callback invoked with the notice payload when a system notice
     *  bubble is rendered. Caller uses this to persist the notice into
     *  the per-(client,project) chat history. */
    onSystemNotice(cb) { this._onSystemNotice = cb; }

    /** Start a new streaming assistant message. Returns nothing - tokens go to appendToken(). */
    startStreamingMessage() {
        this._streamingMsg = document.createElement('div');
        this._streamingMsg.className = 'chat-message chat-message-assistant';
        this._streamingToolBar = document.createElement('div');
        this._streamingToolBar.className = 'chat-tool-bar';
        this._streamingMsg.appendChild(this._streamingToolBar);
        this._streamingContent = document.createElement('div');
        this._streamingContent.className = 'chat-streaming-content';
        this._streamingMsg.appendChild(this._streamingContent);
        this._streamingRaw = '';
        this._messagesArea.insertBefore(this._streamingMsg, this._typingIndicator);
        // Top-right action bar (Copy All / Copy answer) — created immediately
        // so a Show graph icon can be lazily attached when graph_provenance
        // arrives. Raw text is empty until finalizeStreamingMessage stashes it.
        this._streamingMsg._answerRaw = '';
        this._streamingMsg._thinkingRaw = '';
        this._createMessageActions(this._streamingMsg);
    }

    /** Show skill badges for statically injected skills. */
    showSkillBadges(skillNames) {
        if (!skillNames || !skillNames.length) return;
        if (!this._streamingMsg) this.startStreamingMessage();
        for (const name of skillNames) {
            const badge = document.createElement('span');
            badge.className = 'chat-skill-badge';
            // Icon matches Explorer's Skills folder (fa-book-open).
            badge.innerHTML = `<i class="fa-solid fa-book-open"></i> ${name}`;
            badge.title = `Skill: ${name} (auto-injected)`;
            this._streamingToolBar.appendChild(badge);
        }
        this._messagesArea.scrollTop = this._messagesArea.scrollHeight;
    }

    /** Append a tool call badge to the tool bar (persistent, not overwritten by markdown). */
    appendToolBadge(toolInfo) {
        if (!this._streamingMsg) this.startStreamingMessage();
        const badge = document.createElement('span');
        badge.className = 'chat-tool-badge';
        const name = toolInfo?.name || 'tool';
        const args = toolInfo?.args ? JSON.stringify(toolInfo.args, null, 2) : '';
        // F6.2: provenance pill on user-authored tools. Source is the
        // mcp-tools cache populated lazily on first call - cheap because
        // it lands once per page load and stays for the session.
        const isUser = ChatPanel._isUserTool(name);
        const provHtml = isUser ? ' <span class="chat-tool-prov-pill">user</span>' : '';
        // Icon matches Explorer's Tools folder (fa-wrench).
        badge.innerHTML = `<i class="fa-solid fa-wrench"></i> ${name}${provHtml}`;
        const provNote = isUser ? ' [self-authored]' : '';
        badge.title = (args ? `${name}(${args})` : name) + provNote;
        this._streamingToolBar.appendChild(badge);
        this._messagesArea.scrollTop = this._messagesArea.scrollHeight;
    }

    /** F6.2: lazy lookup of tool provenance (returns true for user tools).
     * Caches the mcp-tools list per page load; refreshes once on first call.
     * Misses (name not in list) are treated as native (the safe default).
     * `notify_invalidate()` from outside (e.g., when a workflow publishes a
     * new tool) re-fetches on next call. */
    static _isUserTool(name) {
        const cache = ChatPanel._provCache;
        if (cache && cache.byName && cache.byName.has(name)) {
            return cache.byName.get(name) === 'user';
        }
        if (!ChatPanel._provFetchInFlight) {
            ChatPanel._provFetchInFlight = true;
            fetch('api/llm/mcp-tools')
                .then(r => r.ok ? r.json() : null)
                .then(d => {
                    if (!d || !Array.isArray(d.tools)) return;
                    const byName = new Map();
                    for (const t of d.tools) {
                        if (t && t.name) byName.set(t.name, t.provenance || 'native');
                    }
                    ChatPanel._provCache = { byName, ts: Date.now() };
                })
                .catch(() => { /* silent */ })
                .finally(() => { ChatPanel._provFetchInFlight = false; });
        }
        return false;  // first-call answer: assume native; subsequent calls hit cache
    }

    static notifyToolListChanged() {
        ChatPanel._provCache = null;
    }

    /** Append a token to the current streaming message. */
    appendToken(token) {
        if (!this._streamingMsg) this.startStreamingMessage();
        // Deferred-collapse hand-off: if reasoning finished but the
        // collapse was held back waiting for the answer to start, do it
        // on the first non-empty answer token. Skip empty/whitespace-
        // only tokens so a stray "\n" doesn't fire the collapse early.
        if (this._liveThinkingPendingCollapse && this._liveThinkingDetails && token && token.trim()) {
            this._liveThinkingDetails.open = false;
            // Drop the live class so the summary label loses its italic —
            // CSS gates `font-style: italic` to .chat-thinking-live only.
            this._liveThinkingDetails.classList.remove('chat-thinking-live');
            const label = this._liveThinkingDetails._summaryLabel;
            if (label) label.textContent = 'Thinking';
            this._liveThinkingPendingCollapse = false;
        }
        this._recordStreamingChars(token);
        this._streamingRaw += token;
        // Re-render markdown on each token (marked.js is fast enough for this)
        this._streamingContent.innerHTML = this._renderMarkdown(this._streamingRaw);
        // Transform citation tags into badges live as they stream in.
        // Cheap (TreeWalker over text nodes only) and gives the user
        // immediate visual feedback instead of seeing raw `[markdown_chunk:hex]`
        // brackets until finalize.
        this._renderCitations(this._streamingContent);
        this._messagesArea.scrollTop = this._messagesArea.scrollHeight;
    }

    /** Finalize the streaming message - apply syntax highlighting and optional thinking section.
     *
     * @param {string|null} thinkingContent - reasoning text, if any
     * @param {object|null} graphProvenance - per-answer KG payload from
     *        graph_and_vector_search, when the model used that tool.
     *        Triggers a "Show graph trace" button next to the reasoning section.
     */
    finalizeStreamingMessage(thinkingContent = null, graphProvenance = null) {
        if (!this._streamingMsg) return;

        // Insert thinking collapsible before the content (skip if empty/
        // whitespace, OR if a live thinking section already exists from
        // streaming - which is the normal path now).
        const thinkingDetails = (thinkingContent && thinkingContent.trim() && !this._liveThinkingDetails)
            ? this._buildThinkingDetails(thinkingContent.trim())
            : this._liveThinkingDetails;
        if (thinkingDetails && !thinkingDetails.parentNode) {
            this._streamingMsg.insertBefore(thinkingDetails, this._streamingContent);
        }
        // Belt-and-braces: if the deferred-collapse path never fired (no
        // answer tokens streamed, finalize arrived directly), the live
        // class would still linger and keep the italic. Drop it here too.
        if (thinkingDetails) thinkingDetails.classList.remove('chat-thinking-live');
        // Defense-in-depth: re-run citation transform on the (possibly
        // streamed) thinking body. setLiveThinkingContent calls this at
        // thinking_end, but if the thinking_end signal was missed or
        // short-circuited, the live body would still hold raw `[tag]`
        // text. _renderCitations only mutates matching text nodes, so
        // a second pass over already-badged content is a no-op.
        if (thinkingDetails && this._liveThinkingBody) {
            this._renderCitations(this._liveThinkingBody);
        }

        // Trace button: normally attached early via setPendingGraphTrace
        // when the graph_provenance SSE event arrives (before answer
        // streaming starts). If for some reason that didn't happen but
        // the payload still made it to finalize, attach now as a fallback.
        // Same content gate as the early path — no point surfacing the
        // icon when the trace would open empty.
        const traceData = graphProvenance || this._pendingGraphTrace;
        if (traceData && !this._traceButtonEl && this._onShowGraphTrace
                && this._graphRagEnabled && _traceHasContent(traceData)) {
            this._traceButtonEl = this._attachTraceButton(thinkingDetails, traceData);
        }

        // Reset per-message state for the next message
        this._traceButtonEl = null;
        this._pendingGraphTrace = null;
        this._liveThinkingDetails = null;
        this._liveThinkingBody = null;
        this._liveThinkingSummary = null;
        this._liveThinkingRaw = '';
        this._liveThinkingComplete = false;

        // Final render with syntax highlighting
        this._streamingContent.innerHTML = this._renderMarkdown(this._streamingRaw);
        this._streamingContent.querySelectorAll('pre code[class*="language-"]').forEach((block) => {
            hljs.highlightElement(block);
        });
        this._renderMath(this._streamingContent);
        this._addCopyButtons(this._streamingContent);
        this._renderCitations(this._streamingContent);
        this._wireImageOpenHandlers(this._streamingContent);
        this._streamingContent.classList.remove('chat-streaming-content');

        // Stash the raw text on the message element so the action bar's
        // Copy and Copy-All buttons read original tagged text rather than
        // the rendered DOM (which has badge ordinals, not chunk ids).
        this._streamingMsg._answerRaw = this._streamingRaw || '';
        this._streamingMsg._thinkingRaw = (thinkingContent || '').trim();

        this._streamingMsg = null;
        this._streamingContent = null;
        this._streamingRaw = '';
    }

    /** Defang any `[citation_tag]:` line that would otherwise be parsed by
     * marked as a markdown reference-link definition. The model often
     * lists chunks like:
     *
     *     [markdown_chunk:abc123]:
     *     Defines layer normalization as ...
     *
     * Marked sees `[label]:\n<paragraph>` and CONSUMES the bracket as a
     * link-ref definition, so the tag never reaches `_renderCitations`
     * and no badge is rendered. We insert a zero-width space between
     * `]` and `:` for any bracketed token whose content matches our
     * citation forms. The colon is still visible to the reader; the
     * ZWSP is invisible; marked no longer recognizes the definition;
     * the bracket survives for badge rendering.
     */
    _defuseCitationRefDefs(text) {
        if (!text) return text;
        // Mirror the citation forms from _renderCitations. Any bracket
        // whose body matches one of these followed immediately by `]:`
        // gets a ZWSP injected.
        return text.replace(
            /(\[(?:markdown_chunk:[0-9a-f]{8,16}|[0-9a-f]{8,16}|E:[^,\]]+|R:[^,\]]+|C\d+)\]):/g,
            '$1​:',
        );
    }

    _renderMarkdown(text) {
        return marked.parse(this._defuseCitationRefDefs(text || ''));
    }

    /** Replace citation tags in the rendered message with clickable badges.
     * Per-message dedup: same tag → same number. Skips text inside
     * <pre>/<code>. Click dispatched via delegated handler on `_messagesArea`.
     *
     * Four tag forms (Phase 1A + Phase 2):
     *   `[markdown_chunk:hex]` / `[hex]`   - chunk (green badge)
     *   `[E:entity_id]`                    - entity (blue badge)
     *   `[R:src>type>tgt]`                 - relationship (orange badge)
     *   `[Cn]`                             - community (purple badge)
     * Comma-joined inside one bracket is supported for any combination.
     * Bare hex is normalized to `markdown_chunk:hex` for the data-tag.
     */
    _renderCitations(rootEl) {
        if (!rootEl) return;
        // Each tag part. Note R: uses `[^,\]]+` (no comma/bracket) so
        // comma-separated groups parse correctly; the model's R-form
        // always includes `>` separators inside the body.
        const _PART = [
            'markdown_chunk:[0-9a-f]{8,16}',
            '[0-9a-f]{8,16}',          // bare-hex chunk (model often abbreviates)
            'E:[^,\\]]+',
            'R:[^,\\]]+',
            'C\\d+',
        ].join('|');
        const GROUP_RE = new RegExp(`\\[((?:${_PART})(?:\\s*,\\s*(?:${_PART}))*)\\]`, 'g');
        // Stateless clone (no /g) for the walker's yes/no acceptNode test.
        // Using GROUP_RE.test() here is a JS gotcha: /g-flag .test() advances
        // lastIndex between calls, so when the walker visits multiple text
        // nodes that each contain a tag, every subsequent .test() resumes
        // from the previous lastIndex and returns false if the new node's
        // text is shorter than that index — silently rejecting valid nodes
        // and stranding their tags as raw bracket text.
        const TEST_RE = new RegExp(`\\[((?:${_PART})(?:\\s*,\\s*(?:${_PART}))*)\\]`);
        const TAG_RE = new RegExp(_PART, 'g');
        const numbering = new Map(); // canonical tag -> ordinal
        const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                if (node.parentElement && node.parentElement.closest('pre, code')) {
                    return NodeFilter.FILTER_REJECT;
                }
                return TEST_RE.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            },
        });
        const targets = [];
        let n;
        while ((n = walker.nextNode())) targets.push(n);
        for (const textNode of targets) {
            GROUP_RE.lastIndex = 0;
            const text = textNode.nodeValue;
            const frag = document.createDocumentFragment();
            let lastIdx = 0;
            let m;
            while ((m = GROUP_RE.exec(text)) !== null) {
                if (m.index > lastIdx) {
                    frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
                }
                const parts = m[1].match(TAG_RE) || [];
                parts.forEach((rawTag) => {
                    // Normalize + classify into family + sub-type. Family
                    // determines the leading icon (fa-file-lines for
                    // document, fa-share-nodes for graph) so a reader can
                    // tell at a glance which kind of citation this is;
                    // hue inside the badge keeps carrying the graph
                    // sub-distinction.
                    let tag = rawTag.trim();
                    let typeClass;
                    let title;
                    let isGraph = false;
                    if (tag.startsWith('E:')) {
                        typeClass = 'cite-entity';
                        title = 'Open entity in graph trace';
                        isGraph = true;
                    } else if (tag.startsWith('R:')) {
                        typeClass = 'cite-edge';
                        title = 'Open relationship in graph trace';
                        isGraph = true;
                    } else if (/^C\d+$/.test(tag)) {
                        typeClass = 'cite-community';
                        title = 'Open community summary';
                        isGraph = true;
                    } else {
                        // chunk: normalize bare hex to canonical
                        if (/^[0-9a-f]{8,16}$/.test(tag)) tag = `markdown_chunk:${tag}`;
                        typeClass = 'cite-chunk';
                        title = 'Open source document';
                    }
                    if (!numbering.has(tag)) numbering.set(tag, numbering.size + 1);
                    const ord = numbering.get(tag);

                    // inline-flex wrapper keeps icon + pill paired across
                    // wraps (so the icon never gets stranded on a previous
                    // line away from its number).
                    const wrap = document.createElement('span');
                    wrap.className = `chat-citation-wrap ${isGraph ? 'cite-family-graph' : 'cite-family-doc'}`;
                    // Make the whole wrap (icon + anchor) the click target —
                    // the delegate at the messages-area level reads tag from
                    // here. Also lets CSS apply cursor:pointer to the icon.
                    wrap.dataset.citationTag = tag;
                    wrap.title = title;

                    const icon = document.createElement('i');
                    // File icon uses the regular (outline) variant; graph
                    // share-nodes stays solid (no regular variant in FA free).
                    icon.className = isGraph
                        ? 'fa-solid fa-share-nodes chat-citation-icon'
                        : 'fa-regular fa-file-lines chat-citation-icon';
                    icon.setAttribute('aria-hidden', 'true');
                    wrap.appendChild(icon);

                    // For chunk citations, async-resolve the chunk's `kind`
                    // and upgrade the icon family for picture/table caption
                    // chunks. The default fa-file-lines stays put for
                    // ordinary prose chunks. Cached per-tag so multiple
                    // citations to the same chunk make at most one fetch.
                    if (!isGraph && /^markdown_chunk:[0-9a-f]{8,16}$/.test(tag)) {
                        this._upgradeCitationIcon(tag, wrap, icon);
                    }

                    const a = document.createElement('a');
                    a.className = `chat-citation ${typeClass}`;
                    a.href = 'javascript:void(0)';
                    a.dataset.citationTag = tag;
                    a.title = title;
                    a.textContent = String(ord);
                    wrap.appendChild(a);

                    frag.appendChild(wrap);
                });
                lastIdx = m.index + m[0].length;
            }
            if (lastIdx < text.length) {
                frag.appendChild(document.createTextNode(text.slice(lastIdx)));
            }
            textNode.parentNode.replaceChild(frag, textNode);
        }
    }

    /** Build a `<details class="chat-thinking">` element for finalized
     * (non-streaming) reasoning. Used when the live thinking section
     * never opened (e.g. think_enabled was off but the model emitted
     * a thinking block anyway). */
    _buildThinkingDetails(thinkingText) {
        const details = document.createElement('details');
        details.className = 'chat-thinking';
        const summary = document.createElement('summary');
        // Same label-span pattern as the live section so a sibling trace
        // button inside <summary> doesn't get clobbered on toggle.
        const labelEl = document.createElement('span');
        labelEl.className = 'chat-thinking-summary-label';
        labelEl.textContent = 'Thinking';
        summary.appendChild(labelEl);
        details.addEventListener('toggle', () => {
            labelEl.textContent = 'Thinking';
        });
        details.appendChild(summary);
        details._summaryLabel = labelEl;
        const thinkBody = document.createElement('div');
        thinkBody.className = 'chat-thinking-body';
        // Render the reasoning as markdown so lists/code/bold land
        // formatted, same as the answer body. Models often write
        // numbered plans + inline `code` here.
        thinkBody.innerHTML = this._renderMarkdown(thinkingText || '');
        thinkBody.querySelectorAll('pre code[class*="language-"]').forEach((block) => {
            try { hljs.highlightElement(block); } catch (_) { /* noop */ }
        });
        // Transform any valid citation tags in the reasoning into badges,
        // same as the answer body.
        this._renderCitations(thinkBody);
        details.appendChild(thinkBody);
        return details;
    }

    /** Place a "Show graph" affordance next to the reasoning section
     * (or just above the answer if no reasoning exists). Uses a <span> with
     * role="button" rather than a real <button> so it inherits the inline
     * baseline of the adjacent <summary> and avoids the native button's
     * pressed-down effect. Click invokes the registered onShowGraphTrace
     * callback with the payload so the app can open the GraphPanel in
     * trace mode. */
    _attachTraceButton(thinkingDetails, payload) {
        const btn = document.createElement('button');
        btn.className = 'chat-msg-action-btn chat-trace-btn-icon';
        btn.type = 'button';
        btn.title = 'Show Graph';
        // Inline SVG (not FontAwesome) so the stroke thickness matches
        // the sibling copy icon (both use stroke-width 1.5).
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3" fill="#a8d8a0"/><circle cx="6" cy="12" r="3" fill="#a8d8a0"/><circle cx="18" cy="19" r="3" fill="#a8d8a0"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Pass the button as second arg so the handler can track a
            // per-button GraphPanel ref and reuse it instead of opening a
            // duplicate panel on every click of the same icon.
            if (this._onShowGraphTrace) this._onShowGraphTrace(payload, btn);
        });
        // Insert at the START of the message-level action bar (top-right).
        // Falls back to placing next to the streaming content if the bar
        // isn't there yet (defensive — startStreamingMessage normally
        // creates it before this method ever runs).
        const msg = this._streamingMsg
            || (thinkingDetails && thinkingDetails.closest('.chat-message-assistant'));
        const bar = msg && msg._actionsBar;
        if (bar) {
            bar.insertBefore(btn, bar.firstChild);
        } else if (this._streamingMsg && this._streamingContent) {
            this._streamingMsg.insertBefore(btn, this._streamingContent);
        }
        return btn;
    }

    /** Called by ChatService as soon as the `graph_provenance` SSE event
     * arrives (which happens RIGHT AFTER the tool dispatch, well before
     * thinking and answer tokens stream in). Bootstraps the streaming
     * message bubble if needed and attaches the "Show graph" button now,
     * so the user sees the affordance early instead of only at finalize. */
    setPendingGraphTrace(payload) {
        this._pendingGraphTrace = payload;
        if (this._traceButtonEl) return; // already attached this turn
        // If the user disabled GraphRAG for this turn, suppress the
        // "Show graph" affordance even if a provenance event happens to
        // arrive — defense in depth so the UI honors the toggle.
        if (!this._graphRagEnabled) return;
        // Don't surface the trace icon when there's nothing meaningful
        // to display. Definitional / conceptual questions ground in
        // chunks only — entry-point entity extraction yields nothing,
        // graph traversal returns empty, and the trace panel would
        // open to a blank "0 entities, 0 grounded relationships" view
        // that looks broken. Show the icon only when at least one of
        // entities / edges / chunk_excerpts has content.
        if (!_traceHasContent(payload)) return;
        if (!this._streamingMsg) this.startStreamingMessage();
        this._traceButtonEl = this._attachTraceButton(this._liveThinkingDetails, payload);
    }

    /** Register a callback invoked when the user clicks "Show graph trace"
     * on an assistant message. Receives the graph_provenance payload. */
    onShowGraphTrace(callback) {
        this._onShowGraphTrace = callback;
    }

    /** Register a callback invoked when the user double-clicks a chat
     * image thumbnail or file chip (their own uploads OR assistant
     * markdown-rendered <img>). Receives a payload with `kind` and
     * either `src` (image) or `text` (file). */
    onOpenArtifact(callback) {
        this._onOpenArtifact = callback;
    }

    /** Render an ECharts chart inline in the assistant bubble. Called
     * from ChatService when a `data.chart` SSE event arrives (the
     * `chart` tool's render pipeline). Payload shape:
     *   { option: ECharts option dict, title: str, chart_type: str }
     *
     * Appends to the in-flight streaming bubble if one exists; falls
     * back to the most recent assistant bubble otherwise. Each chart
     * gets a 380px-tall container; double-click opens a larger
     * floating viewer via the same _openChatArtifact path images use.
     */
    renderInlineChart(payload) {
        if (!payload || !payload.option) return;
        if (typeof echarts === 'undefined') {
            console.warn('[ChatPanel] echarts global not loaded — dropping chart');
            return;
        }
        // Find the bubble to append to. Streaming bubble takes priority;
        // otherwise the last assistant bubble in the messages area.
        let host = this._streamingMsg
            || this._messagesArea.querySelector('.chat-message-assistant:last-of-type');
        if (!host) {
            // No assistant bubble exists yet — create a minimal one to host the chart.
            host = document.createElement('div');
            host.className = 'chat-message chat-message-assistant';
            this._messagesArea.insertBefore(host, this._typingIndicator);
        }
        // Frame is the positioned parent. Light background so default
        // ECharts text/axis colors (dark) contrast properly. Charts in
        // noted intentionally break from the surrounding dark theme —
        // readability beats consistency.
        const frame = document.createElement('div');
        frame.className = 'chat-message-chart-frame';
        frame.title = 'Double-click to open in a floating viewer';

        const wrapper = document.createElement('div');
        wrapper.className = 'chat-message-chart';
        frame.appendChild(wrapper);

        // Hover-revealed action buttons (Copy / Save). Inline SVG icons
        // matching noted's stroke-width:1.5 style. The Copy icon is the
        // same two-document affordance used by the per-message Copy
        // Answer button (see _createMessageActions).
        const _copyIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" fill="#ffe6bd"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
        const _saveIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
        const _checkIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22863a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        const _xIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c62828" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

        const actions = document.createElement('div');
        actions.className = 'chat-message-chart-actions';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'chat-chart-action';
        copyBtn.title = 'Copy Image';
        copyBtn.innerHTML = _copyIcon;
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'chat-chart-action';
        saveBtn.title = 'Save As Image';
        saveBtn.innerHTML = _saveIcon;
        actions.appendChild(copyBtn);
        actions.appendChild(saveBtn);
        frame.appendChild(actions);

        host.appendChild(frame);
        let chart = null;
        try {
            chart = echarts.init(wrapper);
            chart.setOption(payload.option);
        } catch (e) {
            console.warn('[ChatPanel] echarts.setOption failed', e);
            wrapper.textContent = `Chart render failed: ${e?.message || e}`;
            return;
        }

        const _safeName = ((payload.title || payload.chart_type || 'chart') + '')
            .replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'chart';
        const _flash = (btn, replacement, restoreTitle, ms = 1200) => {
            const origHTML = btn.innerHTML;
            const origTitle = btn.title;
            btn.innerHTML = replacement;
            if (restoreTitle) btn.title = restoreTitle;
            setTimeout(() => { btn.innerHTML = origHTML; btn.title = origTitle; }, ms);
        };

        copyBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                const dataUrl = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
                const blob = await (await fetch(dataUrl)).blob();
                if (!navigator.clipboard || !window.ClipboardItem) {
                    throw new Error('Clipboard image API unavailable (needs HTTPS or localhost)');
                }
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                _flash(copyBtn, _checkIcon, 'Copied');
            } catch (err) {
                console.warn('[ChatPanel] copy chart failed', err);
                _flash(copyBtn, _xIcon, 'Copy failed — try Save', 1800);
            }
        });

        saveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            try {
                const dataUrl = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
                const a = document.createElement('a');
                a.href = dataUrl;
                a.download = _safeName + '.png';
                document.body.appendChild(a);
                a.click();
                a.remove();
                _flash(saveBtn, _checkIcon, 'Saved');
            } catch (err) {
                console.warn('[ChatPanel] save chart failed', err);
                _flash(saveBtn, _xIcon, 'Save failed', 1800);
            }
        });

        // Double-click → open in floating viewer with the same option.
        // Lives on the frame so the action buttons (which stop propagation)
        // don't accidentally trigger the viewer.
        frame.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            if (this._onOpenArtifact) {
                this._onOpenArtifact({
                    kind: 'chart',
                    name: payload.title || payload.chart_type || 'chart',
                    option: payload.option,
                });
            }
        });
        // Resize-on-window-resize so the chart adapts to panel changes.
        const ro = new ResizeObserver(() => { try { chart.resize(); } catch {} });
        ro.observe(wrapper);
        this._messagesArea.scrollTop = this._messagesArea.scrollHeight;
    }

    /** Attach double-click "open in floating viewer" handlers to every
     * <img> in the given container. Used for assistant bubbles where
     * markdown rendering produces <img> tags from external URLs or
     * data URLs that the user might want to enlarge or save. */
    _wireImageOpenHandlers(container) {
        if (!container) return;
        container.querySelectorAll('img').forEach((img) => {
            // Skip images we've already wired (defensive when the same
            // bubble gets re-rendered, e.g. citation pass).
            if (img.dataset.dblWired === '1') return;
            img.dataset.dblWired = '1';
            img.style.cursor = img.style.cursor || 'zoom-in';
            img.title = img.title || 'Double-click to open in a floating viewer';
            img.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                if (this._onOpenArtifact) {
                    this._onOpenArtifact({
                        kind: 'image',
                        src: img.src,
                        name: img.alt || 'image',
                    });
                }
            });
        });
    }

    setThinkingIndicator(visible) {
        if (visible) {
            this._typingIndicator.style.display = 'flex';
            this._typingIndicator.setAttribute('data-label', 'Reasoning...');
        } else {
            this._typingIndicator.style.display = 'none';
            this._typingIndicator.removeAttribute('data-label');
        }
        this._messagesArea.scrollTop = this._messagesArea.scrollHeight;
    }

    /** Start a live reasoning section ABOVE the answer-streaming area.
     * Returns silently if a streaming message isn't started yet (defensive).
     * Creates a <details open> element so the reasoning is visible while it
     * streams; endLiveThinkingSection() collapses it once thinking is done.
     */
    startLiveThinkingSection() {
        // Auto-create the streaming message bubble if it doesn't exist yet.
        // Badge rendering paths used to do this implicitly; they're gone now,
        // so the reasoning panel needs its own bootstrap or it never attaches
        // to anything and the live stream silently disappears.
        if (!this._streamingMsg) this.startStreamingMessage();
        if (this._liveThinkingDetails) return;
        const details = document.createElement('details');
        details.className = 'chat-thinking chat-thinking-live';
        details.open = true;
        const summary = document.createElement('summary');
        // Keep the label as its own span so we can update its text
        // without nuking sibling children (e.g. the "Show graph" trace
        // button that gets appended into <summary>). textContent on the
        // <summary> itself would clobber every child element.
        const labelEl = document.createElement('span');
        labelEl.className = 'chat-thinking-summary-label';
        labelEl.textContent = 'Thinking...';
        summary.appendChild(labelEl);
        // Per-instance "thinking finished" flag captured by the toggle
        // closure. We CANNOT rely on `this._liveThinkingComplete` here
        // because that's panel-level state - reset to false at every
        // finalizeStreamingMessage(), which would then mute the toggle
        // handlers of all earlier finalized messages.
        let completedForThisMessage = false;
        details.addEventListener('toggle', () => {
            if (completedForThisMessage) {
                labelEl.textContent = 'Thinking';
            }
        });
        // Stash a setter so endLiveThinkingSection can flip the per-message
        // flag without reaching into this closure.
        details._markThinkingComplete = () => { completedForThisMessage = true; };
        // Stash the label for endLiveThinkingSection's text update.
        details._summaryLabel = labelEl;
        details.appendChild(summary);
        const body = document.createElement('div');
        body.className = 'chat-thinking-body';
        details.appendChild(body);
        // If the trace button was attached BEFORE the thinking section
        // (because graph_provenance arrived before thinking_start), it
        // sits at "before _streamingContent". Inserting thinking at the
        // same position pushes the button after thinking, but only if we
        // insert thinking BEFORE the button. The simplest fix: insert
        // thinking before the trace button if the button exists, else
        // before the streaming content.
        const insertionAnchor = (this._traceButtonEl && this._traceButtonEl.parentNode === this._streamingMsg)
            ? this._traceButtonEl
            : this._streamingContent;
        this._streamingMsg.insertBefore(details, insertionAnchor);
        this._liveThinkingDetails = details;
        this._liveThinkingBody = body;
        this._liveThinkingSummary = summary;
        this._liveThinkingRaw = '';
        this._liveThinkingComplete = false;
    }

    /** Append streamed reasoning content to the live thinking body. */
    appendLiveThinkingToken(token) {
        if (!this._liveThinkingBody || !token) return;
        this._recordStreamingChars(token);
        this._liveThinkingRaw += token;
        // Coalesce per-token re-renders into ONE per animation frame.
        // Without this, fast-streaming reasoning (often 100+ tokens/sec)
        // triggers a full innerHTML replacement of the markdown body on
        // every token. Each replacement re-parses the whole markdown,
        // rebuilds the DOM subtree, and resets any in-progress paint -
        // visually the section appears to "restart" or flash on each
        // chunk. RAF coalescing batches all tokens within the same frame
        // into a single render, eliminating the flash and dropping CPU
        // load by ~95% during reasoning streams. Keep _liveThinkingRaw
        // append-on-every-token (cheap string concat) so the next render
        // sees the full accumulated content.
        if (!this._liveThinkingRenderPending) {
            this._liveThinkingRenderPending = true;
            requestAnimationFrame(() => {
                this._liveThinkingRenderPending = false;
                if (!this._liveThinkingBody) return;
                // Strip leading whitespace at display time only - models often
                // emit one or two blank lines at the start of <think>, which
                // pre-wrap renders as visible empty paragraphs at the top of
                // every reasoning block. Keep the raw buffer intact in case
                // the sync at thinking_end depends on exact byte parity.
                this._liveThinkingBody.innerHTML = this._renderMarkdown(
                    this._liveThinkingRaw.replace(/^\s+/, '')
                );
                // Render citation tags as badges on every reasoning frame,
                // same as appendToken does for the answer body. Without
                // this, the thinking body only gets a citation pass at
                // thinking_end / finalize - and since this rAF render is
                // deferred, the last streaming frame can fire AFTER
                // setLiveThinkingContent and clobber its badges back to
                // raw `[markdown_chunk:hex]` text. _renderCitations is
                // idempotent and node-scoped, so a re-pass is cheap.
                this._renderCitations(this._liveThinkingBody);
                this._updateLiveThinkingLabel();
                this._messagesArea.scrollTop = this._messagesArea.scrollHeight;
            });
        }
    }

    /** While the thinking block is streaming, surface the most recent
     * level-1 markdown heading (`# Title`) as the summary label so the
     * user sees the model's current step instead of a static "Thinking...".
     * Falls back to "Thinking..." until the first heading arrives. Skips
     * `#` lines inside fenced code blocks. Reverts to the standard
     * Show/Hide labels at endLiveThinkingSection. */
    _updateLiveThinkingLabel() {
        const labelEl = this._liveThinkingDetails && this._liveThinkingDetails._summaryLabel;
        if (!labelEl) return;
        let lastHeading = null;
        let inCode = false;
        for (const line of this._liveThinkingRaw.split('\n')) {
            if (line.trimStart().startsWith('```')) {
                inCode = !inCode;
                continue;
            }
            if (inCode) continue;
            const m = line.match(/^#\s+(.+?)\s*$/);
            if (m) lastHeading = m[1];
        }
        labelEl.textContent = lastHeading || 'Thinking...';
    }

    /** Replace the live thinking body content with the provided text.
     * Used at thinking_end to sync the live body with the parser's
     * fully captured thinkingBuffer in case any chunk-boundary slice
     * was missed (the chunk carrying </think> may have also carried the
     * tail of the body that the parser appended but didn't emit). */
    setLiveThinkingContent(text) {
        if (!this._liveThinkingBody) return;
        this._liveThinkingRaw = text || '';
        this._liveThinkingBody.innerHTML = this._renderMarkdown(
            this._liveThinkingRaw.replace(/^\s+/, '')
        );
        // Apply syntax highlighting once the body is finalized.
        this._liveThinkingBody.querySelectorAll('pre code[class*="language-"]').forEach((block) => {
            try { hljs.highlightElement(block); } catch (_) { /* noop */ }
        });
        // Transform any valid citation tags in the reasoning into badges,
        // same as the answer body. Done at finalize (not per token) so we
        // pay the regex pass once. Invalid tags stay as raw text — that
        // matches the answer-body behavior and is a visible signal of
        // model fabrication.
        this._renderCitations(this._liveThinkingBody);
    }

    /** Mark the reasoning section complete. The auto-collapse is
     * DEFERRED until the first answer token arrives in appendToken(),
     * so the user keeps seeing the reasoning content while the model is
     * still preparing the answer (tool execution + synthesis prefill).
     * Collapsing immediately at thinking_end leaves the user staring at
     * a blank space until the answer starts streaming. */
    endLiveThinkingSection() {
        if (!this._liveThinkingDetails) return;
        this._liveThinkingComplete = true;
        if (this._liveThinkingDetails._markThinkingComplete) {
            this._liveThinkingDetails._markThinkingComplete();
        }
        // Revert the summary label from the live "current heading" form
        // back to the standard Show/Hide labels reflecting the section's
        // current open state. Without this, the last-heading text would
        // remain visible after the model finished thinking.
        if (this._liveThinkingDetails._summaryLabel) {
            this._liveThinkingDetails._summaryLabel.textContent = 'Thinking';
        }
        // Arm the deferred collapse — appendToken will trigger it when
        // the first non-empty answer token actually arrives.
        this._liveThinkingPendingCollapse = true;
    }

    clearMessages() {
        const messages = this._messagesArea.querySelectorAll('.chat-message');
        messages.forEach(m => m.remove());
    }

    /** Render LaTeX math expressions in a container using KaTeX auto-render. */
    _renderMath(container) {
        if (typeof renderMathInElement !== 'undefined') {
            renderMathInElement(container, {
                delimiters: [
                    { left: '$$', right: '$$', display: true },
                    { left: '$', right: '$', display: false },
                    { left: '\\(', right: '\\)', display: false },
                    { left: '\\[', right: '\\]', display: true },
                ],
                throwOnError: false,
            });
        }
    }

    /** Create the top-right action bar for an assistant message bubble.
     * Holds (left → right): Show graph icon (lazy-attached when
     * graph_provenance arrives), Copy All (thinking + answer). The Copy
     * button reads the raw text stashed on the message element by
     * addMessage / finalizeStreamingMessage — copying from the rendered
     * DOM would lose the citation tags (badges have textContent = ordinal
     * number) so the stashed raw is the source of truth. */
    _createMessageActions(messageEl) {
        const bar = document.createElement('div');
        bar.className = 'chat-msg-actions';

        // Two-square icon (a back document + a front document) for "Copy All"
        // — the classic "copy multiple" affordance.
        const copyAllIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" fill="#ffe6bd"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
        const checkIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22863a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

        const copyAll = document.createElement('button');
        copyAll.className = 'chat-msg-action-btn';
        copyAll.type = 'button';
        copyAll.title = 'Copy Answer';
        copyAll.innerHTML = copyAllIcon;
        copyAll.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const t = messageEl._thinkingRaw || '';
            const a = messageEl._answerRaw || '';
            const text = t ? (t.trim() + '\n\n---\n\n' + a.trim()) : a.trim();
            if (!text) return;
            navigator.clipboard.writeText(text).then(() => {
                copyAll.innerHTML = checkIcon;
                setTimeout(() => { copyAll.innerHTML = copyAllIcon; }, 1200);
            }).catch(() => { /* swallow */ });
        });

        // Order in DOM: trace (lazy, prepended later) | Copy All.
        bar.appendChild(copyAll);
        messageEl.appendChild(bar);
        messageEl._actionsBar = bar;
        return bar;
    }

    /** Add copy buttons to all <pre> blocks in a container. */
    _addCopyButtons(container) {
        container.querySelectorAll('pre').forEach((pre) => {
            if (pre.querySelector('.chat-copy-btn')) return; // already added
            const code = pre.querySelector('code');
            if (!code || !code.textContent.trim()) return; // skip empty blocks
            const btn = document.createElement('button');
            btn.className = 'chat-copy-btn';
            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" fill="#a8d8a0"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
            btn.title = 'Copy to clipboard';
            const copyIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" fill="#a8d8a0"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
            const checkIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22863a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
            btn.addEventListener('click', () => {
                navigator.clipboard.writeText(code.textContent).then(() => {
                    btn.innerHTML = checkIcon;
                    btn.classList.add('copied');
                    btn.onanimationend = () => {
                        btn.innerHTML = copyIcon;
                        btn.classList.remove('copied');
                        btn.onanimationend = null;
                    };
                });
            });
            pre.style.position = 'relative';
            pre.appendChild(btn);
        });
    }

    /** Update token usage display.
     *
     * Also caches input + budget so the live streaming accumulator
     * (_recordStreamingChars) can refresh the bar with running output
     * estimates without waiting for the authoritative end-of-turn
     * usage event. The backend now emits an EARLY usage event with
     * input_tokens populated before tokens stream, so the cache is
     * primed by the time the first token arrives.
     */
    updateTokenUsage(usage) {
        if (!usage || !this._tokenCounter) return;
        this._lastUsageInput = usage.input_tokens || 0;
        this._lastUsageBudget = usage.context_budget || 131072;
        // A real usage event resets the streaming-output accumulator —
        // its output_tokens supersede whatever we estimated locally.
        this._streamingOutputChars = 0;
        this._renderUsageBar(usage.input_tokens, usage.output_tokens, this._lastUsageBudget);
    }

    /** Render the bar text from explicit numbers. */
    _renderUsageBar(inputTokens, outputTokens, budget) {
        if (!this._tokenCounter) return;
        const total = (inputTokens || 0) + (outputTokens || 0);
        const pct = Math.round((total / budget) * 100);
        const inputK = ((inputTokens || 0) / 1024).toFixed(1);
        const outputK = ((outputTokens || 0) / 1024).toFixed(1);
        this._tokenCounter.textContent = `${inputK}K in / ${outputK}K out (${pct}%)`;
        this._tokenCounter.title = `Input: ~${inputTokens} tokens, Output: ~${outputTokens} tokens, Budget: ${budget} tokens`;
        if (pct > 75) this._tokenCounter.style.color = '#d32f2f';
        else if (pct > 50) this._tokenCounter.style.color = '#e65100';
        else this._tokenCounter.style.color = '#666';
    }

    /** Accumulate streamed chars and refresh the bar at most once per
     * animation frame. Called from appendToken AND appendLiveThinkingToken
     * so reasoning + answer both contribute (matches what the backend's
     * end-of-turn usage event reports). */
    _recordStreamingChars(token) {
        if (!token || !this._tokenCounter) return;
        if (this._streamingOutputChars === undefined) this._streamingOutputChars = 0;
        this._streamingOutputChars += token.length;
        if (this._barUpdateScheduled) return;
        this._barUpdateScheduled = true;
        requestAnimationFrame(() => {
            this._barUpdateScheduled = false;
            const outTok = Math.floor((this._streamingOutputChars || 0) / 4);
            this._renderUsageBar(
                this._lastUsageInput || 0,
                outTok,
                this._lastUsageBudget || 131072,
            );
        });
    }

    onClear(callback) {
        this._onClearCallback = callback;
    }

    /** Remove transient error messages and orphaned streaming bubbles left by failed requests. */
    clearTransientErrors() {
        const msgs = this._messagesArea.querySelectorAll('.chat-message-assistant');
        for (const msg of msgs) {
            // Error-only bubbles (contain a .chat-error and nothing else meaningful)
            if (msg.querySelector('.chat-error') && !msg.querySelector('.chat-streaming-content, .chat-thinking')) {
                msg.remove();
                continue;
            }
            // Orphaned streaming bubbles: still have .chat-streaming-content (never finalized)
            // This happens when a request fails mid-stream
            if (msg.querySelector('.chat-streaming-content')) {
                msg.remove();
                if (msg === this._streamingMsg) {
                    this._streamingMsg = null;
                    this._streamingContent = null;
                    this._streamingRaw = '';
                }
                continue;
            }
            // Empty bubbles (streaming started but nothing emitted before error)
            if (!msg.textContent.trim() && !msg.querySelector('.chat-tool-bar')?.childElementCount) {
                msg.remove();
            }
        }
    }

    setLoading(loading) {
        this._typingIndicator.style.display = loading ? 'flex' : 'none';
        if (loading) {
            this._messagesArea.scrollTop = this._messagesArea.scrollHeight;
        }
    }

    onSend(callback) {
        this._onSendCallback = callback;
    }

    onSttToggle(callback) {
        this._onSttToggleCallback = callback;
    }

    onTtsToggle(callback) {
        this._onTtsToggleCallback = callback;
    }

    /** Subscribe to Voice Settings changes. Callback receives the new
     *  settings object: {language, gender, voice, speed}.
     *  language === 'auto' means: use existing per-text language detection. */
    onVoiceSettingsChange(callback) {
        this._onVoiceSettingsChangeCallback = callback;
    }

    /** Read current voice settings (used by ChatService at init). */
    getVoiceSettings() {
        return { ...this._voiceSettings };
    }

    /** STT dictation: render a "composing" user message bubble in the
     *  messages area that updates live as Parakeet emits partials.
     *  Looks like the user is typing-via-voice. The input textarea is
     *  reserved for typed messages — never touched by STT.
     *
     *  Behaviour:
     *   - First call creates a fresh user bubble with `.chat-message--composing`
     *     styling (italic + faded) and stashes a reference.
     *   - Subsequent calls update that same bubble's text content.
     *   - commitComposingUserMessage() removes the composing styling so
     *     it becomes a normal historical user message; ChatService then
     *     fires sendMessage(text, {showUserMessage: false}) to trigger
     *     the LLM without creating a duplicate bubble. */
    setComposingUserMessage(text) {
        const safe = (text || '').toString();
        if (!this._composingUserBubbleEl) {
            const msg = document.createElement('div');
            // The composing bubble is visually IDENTICAL to a committed
            // user message — no styling difference. The class is kept as
            // an internal marker so commitComposingUserMessage knows
            // which element to "promote".
            msg.className = 'chat-message chat-message-user chat-message--composing';
            const body = document.createElement('span');
            body.className = 'chat-message-composing-body';
            msg.appendChild(body);
            this._messagesArea.insertBefore(msg, this._typingIndicator);
            this._composingUserBubbleEl = msg;
            this._composingUserBubbleBodyEl = body;
        }
        this._composingUserBubbleBodyEl.textContent = safe;
        this._messagesArea.scrollTop = this._messagesArea.scrollHeight;
    }

    /** Drop the composing marker class — the bubble becomes a normal
     *  user message. Returns the final committed text (or '') so
     *  ChatService can pass it to sendMessage without re-rendering.
     *  Idempotent. */
    commitComposingUserMessage() {
        if (!this._composingUserBubbleEl) return '';
        const text = (this._composingUserBubbleBodyEl?.textContent || '').trim();
        this._composingUserBubbleEl.classList.remove('chat-message--composing');
        this._composingUserBubbleEl = null;
        this._composingUserBubbleBodyEl = null;
        return text;
    }

    /** Drop the composing bubble entirely (no commit). Used if STT is
     *  cancelled before any final fires. */
    discardComposingUserMessage() {
        if (this._composingUserBubbleEl?.parentNode) {
            this._composingUserBubbleEl.parentNode.removeChild(this._composingUserBubbleEl);
        }
        this._composingUserBubbleEl = null;
        this._composingUserBubbleBodyEl = null;
    }

    setTtsActive(active) {
        this._ttsActive = active;
        this._ttsBtn.classList.toggle('active', active);
        this._ttsBtn.innerHTML = active ? this._ttsIconOn : this._ttsIconOff;
    }

    /** Toggle the mic's "listening now" pulse (the .listening CSS class
     * adds a pulsing red pill around the icon). Wired from ChatService's
     * VAD onSpeechStart / onSpeechEnd handlers so users get an explicit
     * "I hear you" cue when speaking. No-op when STT is toggled off so
     * we never pulse without the user knowing the mic is hot. */
    setMicListening(active) {
        if (!this._sttBtn) return;
        if (active && !this._sttActive) return;
        this._sttBtn.classList.toggle('listening', !!active);
    }
}
