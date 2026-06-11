import { AgentClient } from './AgentClient.js';
import { AudioResampler } from './AudioResampler.js';
// Client-side VAD: @ricky0123/vad-web (Silero v4 model + ONNX Runtime
// Web). Used for two things: (1) detect user speech start mid-TTS to
// trigger barge-in (stop the assistant), (2) gate the STT-streaming
// pipe so TTS audio bleeding into the mic can't be transcribed (kills
// the "Thank you" / "Okay" Whisper hallucination feedback loop).
// vad-web is a UMD bundle that needs window.ort + window.vad globals,
// loaded via <script> tags in index.html (vendor/onnxruntime-web/ +
// vendor/vad/). MIT + ISC licensed.

const AGENT_URL = 'https://logus2k.com/llm';
const STT_URL = 'https://logus2k.com/stt';
const STT_PATH = '/stt/socket.io';
const TTS_URL = 'https://logus2k.com/tts';
const TTS_PATH = '/tts/socket.io';
const AGENT_NAME = 'noted';

// Voice TTS fallback — when the chat model fails to emit a <voice>...</voice>
// block, we still want speech to play. Strategy: clean the answer body
// (strip markdown / citations / whitespace), then if the cleaned length
// is at most VOICE_FALLBACK_MAX_CHARS, speak it verbatim; otherwise call
// the backend voice_summary preset for a one-shot short summary and speak
// that. Configurable here. See _voiceFallback() below.
const VOICE_FALLBACK_MAX_CHARS = 150;

// ───────────────────────────────────────────────────────────────────────
// TTS voice auto-switch (Kokoro multilingual)
// ───────────────────────────────────────────────────────────────────────
// Kokoro server has all 9 language KPipelines pre-loaded at startup
// (American/British English, Japanese, Mandarin, Spanish, French, Hindi,
// Italian, Brazilian Portuguese). What was missing was upstream voice
// switching — we sent the same default `af_heart` regardless of what
// language Gemma actually responded in.
//
// Pattern: detect the language of each `<voice>` block as it arrives,
// look up the preferred voice for that language, fire `tts_configure_client`
// to the TTS server if it differs from the currently selected voice. The
// language pipeline is then routed correctly when the chunk goes out.
//
// Kokoro language codes:
//   a = American English   b = British English   j = Japanese
//   z = Mandarin Chinese   e = Spanish           f = French
//   h = Hindi              i = Italian           p = Brazilian Portuguese
//
// Voice selections below: female-default (Diana persona consistency),
// highest grade Kokoro provides per language. Edit + rebuild noted to
// change. (Future: promote to a config file under noted/data/ if you
// want hot-reload.)
const TTS_LANGUAGE_VOICE_MAP = {
    'a': 'af_heart',     // American English  — Grade A
    'b': 'bf_emma',      // British English   — Grade B-
    'j': 'jf_alpha',     // Japanese          — Grade C+
    'z': 'zf_xiaoxiao',  // Mandarin Chinese  — all Grade D, female
    'e': 'ef_dora',      // Spanish           — only female option
    'f': 'ff_siwis',     // French            — Grade B-, only voice available
    'h': 'hf_alpha',     // Hindi             — Grade C
    'i': 'if_sara',      // Italian           — Grade C
    'p': 'pf_dora',      // Brazilian Portuguese — only female option
};
const TTS_DEFAULT_VOICE = TTS_LANGUAGE_VOICE_MAP['a'];

// Lightweight language detector for the 9 Kokoro languages. Two stages:
//   1. Unicode script majority → resolves CJK / Hiragana-Katakana /
//      Devanagari / Hangul cleanly.
//   2. Latin-only fallback uses distinctive characters first (ñ ã õ ç),
//      then a small stop-word lexicon to disambiguate the four Latin
//      target languages we care about (en/es/pt/fr/it).
// Returns a Kokoro language code ('a' = American English default for
// Latin-without-strong-signal). Never throws.
function detectKokoroLanguage(text) {
    if (!text || typeof text !== 'string') return 'a';
    const t = text.trim();
    if (t.length < 3) return 'a';

    // ── Stage 1: Unicode script majority ──
    let cjk = 0, hiragana = 0, katakana = 0, hangul = 0, devanagari = 0, latin = 0;
    for (const ch of t) {
        const cp = ch.codePointAt(0);
        if ((cp >= 0x4E00 && cp <= 0x9FFF) ||  // CJK Unified
            (cp >= 0x3400 && cp <= 0x4DBF)) {  // CJK Ext A
            cjk++;
        } else if (cp >= 0x3040 && cp <= 0x309F) {
            hiragana++;
        } else if (cp >= 0x30A0 && cp <= 0x30FF) {
            katakana++;
        } else if (cp >= 0xAC00 && cp <= 0xD7AF) {
            hangul++;
        } else if (cp >= 0x0900 && cp <= 0x097F) {
            devanagari++;
        } else if ((cp >= 0x0041 && cp <= 0x007A) ||         // basic Latin A-Za-z
                   (cp >= 0x00C0 && cp <= 0x024F)) {         // Latin-1 + Latin Ext A/B
            latin++;
        }
    }
    if (hiragana + katakana > 0) return 'j';     // any kana → Japanese
    if (hangul > 0) return 'a';                  // Korean isn't supported by Kokoro
    if (devanagari > 0) return 'h';              // Hindi
    if (cjk > 0 && hiragana + katakana === 0) return 'z'; // Chinese (CJK without kana)

    // ── Stage 2: Latin disambiguation ──
    // Distinctive characters first (cheap and decisive).
    if (/[ñ¿¡]/i.test(t)) return 'e';   // Spanish-only chars
    if (/[ãõ]/i.test(t)) return 'p';    // Portuguese-only chars (incl Brazilian)
    // ç + é/è without ã/õ → French (Portuguese also uses ç but with ã/õ caught above)
    if (/ç/i.test(t) && /[éèê]/i.test(t)) return 'f';

    // Stop-word scoring for Latin disambiguation. Each language gets a
    // tiny set of high-frequency words that rarely appear in the others.
    // Score = number of matched tokens. Highest score wins; ties go to
    // English (the platform default).
    const words = t.toLowerCase().match(/\b[a-zà-ÿ']+\b/g) || [];
    if (!words.length) return 'a';
    const wordSet = new Set(words);
    const score = (lex) => lex.reduce((acc, w) => acc + (wordSet.has(w) ? 1 : 0), 0);
    const scores = {
        a: score(['the', 'and', 'is', 'of', 'to', 'in', 'for', 'with', 'this', 'that', 'are', 'you', 'have', 'not', 'but']),
        e: score(['el', 'la', 'los', 'las', 'es', 'en', 'para', 'con', 'que', 'por', 'una', 'del', 'pero', 'muy', 'esto']),
        p: score(['o', 'os', 'as', 'um', 'uma', 'para', 'com', 'que', 'do', 'da', 'dos', 'das', 'mas', 'ser', 'isso']),
        f: score(['le', 'la', 'les', 'des', 'et', 'est', 'pour', 'avec', 'que', 'dans', 'sur', 'pas', 'ce', 'son', 'ne']),
        i: score(['il', 'la', 'gli', 'le', 'di', 'per', 'con', 'che', 'del', 'della', 'una', 'sono', 'ma', 'questo', 'non']),
    };
    let bestLang = 'a', bestScore = scores.a;
    for (const lang of ['e', 'p', 'f', 'i']) {
        if (scores[lang] > bestScore) { bestLang = lang; bestScore = scores[lang]; }
    }
    return bestLang;
}

// Random welcome messages shown when chat opens with no prior history.
// Static (no LLM call) to avoid a race with the user's first message:
// a dynamic welcome streams tokens into ChatPanel's single _streamingMsg
// slot, and a fast user-send before that stream completes makes turn-2
// tokens append to the welcome bubble.
const WELCOME_MESSAGES = [
    "Hi, what can I help you with?",
    "Hi, what are we working on today?",
    "Hey, what can I do for you?",
    "Hi, I'm here to help. What do you need?",
    "Hi there, what's on your plate?",
    "Hello, where would you like to start?",
    "Hi, ask me anything.",
    "Hey, ready when you are.",
    "Hi, what's on your mind?",
    "Hello, how can I help?",
    "Hi, what would you like to do?",
    "Ready when you are. What's first?",
    "Hi, what's the question?",
    "Hi, let me know what you need.",
    "Hey, what can I look into for you?",
    "Hi, where shall we start?",
    "Hi, fire away.",
    "Hello, I'm listening.",
    "Hi, what can I look up or help with?",
    "Hey, what's the task?",
];

// Write tools whose `tool_badge` SSE event should NOT render a chip in the
// chat. The `pending_action(s)` event that follows renders a better-labeled
// chip ("3 cell changes" vs. raw "batch_update_cells"), and the tool_badge
// event is still visible to the harness (which reads the SSE stream, not
// the DOM). Keep in sync with backend/app/managers/llm_tools.py::WRITE_TOOLS.
const WRITE_TOOLS_UI = [
    'update_cell',
    'insert_cell',
    'batch_update_cells',
    'find_replace_in_cells',
    'update_file',
    'create_file',
    'fix_lint_issues',
];

/**
 * ChatService - Wires ChatPanel to AgentClient with STT and TTS support.
 * Supports two chat paths:
 *   1. Direct AgentClient (Socket.IO) - for simple chat, STT/TTS voice
 *   2. Context-enriched via /api/llm/chat (SSE) - for MLOps-aware queries
 */
function _uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export class ChatService {

    constructor(chatPanel) {
        this.chatPanel = chatPanel;
        this.agentClient = null;
        this.clientId = _uuid();
        this.threadId = _uuid();
        this._streamBuffer = '';

        // Status callback
        this._onStatusChange = null;

        // Context provider - set via setContextProvider()
        this._contextProvider = null;

        // Write action callback - called when user approves a cell edit
        this._onWriteAction = null;

        // Navigate callback - called when LLM requests scroll_to_cell
        this._onNavigate = null;

        // Open-file callback - called when LLM requests open_file
        // (notebook / source / document / media). Payload shape:
        //   {path, kind, project_id?, domain_id?}
        // Wire from app.js to dispatch to _openNotebookTab / _openFileTab /
        // _openDocumentTab / _openMediaTab based on `kind`.
        this._onOpenFile = null;

        // Doc-buffer SSE callback (NOTES-1). Wire from app.js to drive the
        // document viewer's buffer rendering. Payload: {buffer_id, name,
        // content, path}. Same callback fires for create_doc/append_to_doc/
        // replace_doc - the consumer reconciles by buffer_id.
        this._onDoc = null;

        // File-changed SSE callback (NOTES-3). Wire from app.js. Payload:
        // {path, project_id}. Fires after a successful update_file /
        // create_file / append_to_file disk write so any open viewer for
        // the touched path can refresh from disk.
        this._onFileChanged = null;

        // Voice state
        this.voiceActive = false;
        this._audioContext = null;
        this._mediaStream = null;
        this._workletNode = null;
        this._resampler = null;
        this._sttSocket = null;

        // TTS state
        this._ttsSocket = null;
        this._ttsAudioContext = null;
        this._ttsPlayQueue = Promise.resolve();
        // Currently-active Kokoro voice for THIS browser session. Used
        // by the language auto-switch path: when a `<voice>` block is
        // detected to be in a different Kokoro language than this voice
        // belongs to, _sendVoiceToTTS fires `tts_configure_client` to
        // swap voices BEFORE the chunk goes out.
        this._currentTtsVoice = TTS_DEFAULT_VOICE;
        // Currently-applied speed (per-session, mirrors what was last
        // sent to tts_configure_client). null = never overridden, server
        // uses its own default_speed.
        this._currentTtsSpeed = null;
        // User Voice Settings — set by ChatPanel via setVoiceSettings.
        // {language: 'auto'|<code>, gender: 'f'|'m', voice: <id>, speed: <num>}
        this._voiceSettings = { language: 'auto', gender: 'f', voice: TTS_DEFAULT_VOICE, speed: 1.1 };
        this.ttsEnabled = false;

        // The static greeting shown at chat-open (when there's no prior
        // history). Stashed so a late TTS-enable can replay it as voice.
        this._welcomeText = '';

        this._userMessagesSent = 0;

        // Tracks the AbortController of the in-flight chat request so a
        // new sendMessage can cancel the previous one. Conversational
        // interruption: when the user fires a new message before the
        // current answer finishes, we abort the old SSE stream + drop
        // its queued TTS so the two turns never overlap in the chat.
        this._activeAbortController = null;

        // Client VAD + barge-in / echo-loop prevention. vad-web manages
        // its own internal AudioContext + worklet on the MediaStream we
        // hand it; we just register the speech-start callback that fires
        // _bargeIn() when the user starts talking during TTS playback.
        this._vad = null;
        // Flips true when at least one TTS audio chunk is queued or
        // playing. While true, mic audio is NOT forwarded to STT
        // (echo prevention).
        this._ttsActive = false;
        this._ttsActiveCount = 0;     // queued + playing chunk count
        this._currentTtsSource = null; // most recent AudioBufferSourceNode
        // Set true on barge-in; chunks arriving from the cancelled turn
        // are dropped until the next _sendVoiceToTTS call clears it.
        this._ttsBargedIn = false;

        this._wirePanel();
    }

    /**
     * Set a function that returns context descriptor from the app.
     * Called before each context-enriched chat request.
     * @param {Function} provider - () => { projectId, notebookPath, selectedCellIndex, activeRunId, ... }
     */
    setContextProvider(provider) {
        this._contextProvider = provider;
    }

    _wirePanel() {
        // ChatPanel hands us either a plain string OR an OpenAI-style
        // content list (when an image attachment is pending). The shape
        // is forwarded unchanged through sendMessage → _sendWithContext
        // → POST /api/llm/chat → noted backend → agent_server (whose
        // ChatMessage.content already accepts Union[str, list[dict]]).
        this.chatPanel.onSend((content) => this.sendMessage(content, { showUserMessage: false }));
        this.chatPanel.onSttToggle((active) => {
            if (active) this.startVoice();
            else this.stopVoice();
        });
        this.chatPanel.onTtsToggle(() => {
            if (this.ttsEnabled) this.disableTTS();
            else this.enableTTS();
        });
        this.chatPanel.onClear(() => this.clearHistory());
        this.chatPanel._onDebugToggle = (enabled) => this._toggleDebug(enabled);
    }

    _toggleDebug(enabled) {
        fetch('api/llm/debug', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
        });
        if (enabled) {
            this._openDebugPanel();
        } else if (this._debugPanel) {
            this._debugPanel.close();
            this._debugPanel = null;
        }
    }

    _openDebugPanel() {
        if (this._debugPanel) return;

        this._debugPanel = jsPanel.create({
            headerTitle: '<i class="fa-solid fa-bug" style="margin-right:6px;font-size:11px;color:#e67e22"></i>LLM Debug',
            theme: '#fff9e3 filled',
            borderRadius: '5px',
            contentSize: { width: Math.min(700, window.innerWidth - 100), height: Math.min(400, window.innerHeight - 100) },
            position: { my: 'right-bottom', at: 'right-bottom', offsetX: -20, offsetY: -40 },
            headerControls: 'closeonly',
            content: `<div class="llm-debug-log" style="height:100%;overflow:auto;font-size:12px;background:#fff;padding:0"></div>`,
            onclosed: () => {
                this._debugPanel = null;
                this.chatPanel._debugCheckbox.checked = false;
                this.chatPanel._debugEnabled = false;
                fetch('api/llm/debug', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: false }),
                });
                if (this._debugHandler && window._notedSocket) {
                    window._notedSocket.off('llm:debug_event', this._debugHandler);
                }
            },
        });

        this._debugHandler = (event) => this._addDebugEvent(event);
        if (window._notedSocket) {
            window._notedSocket.on('llm:debug_event', this._debugHandler);
        }

        // Reset turn-grouping state and clear previous events
        this._debugTurns = null;
        fetch('api/llm/debug/events', { method: 'DELETE' });
    }

    _addDebugEvent(event) {
        const logEl = this._debugPanel?.content?.querySelector('.llm-debug-log');
        if (!logEl) return;

        // ── Turn grouping state (initialized once per panel session) ──
        // Each turn = one user question -> answer. The boundary is the
        // `context.sent` event (carries `user_message`). Skill loads
        // arrive BEFORE that boundary; they buffer until context.sent
        // opens the new turn group.
        if (!this._debugTurns) {
            this._debugTurns = { count: 0, current: null, currentBody: null,
                currentCounts: null, pending: [] };
        }
        const turns = this._debugTurns;

        // Detect turn boundary
        const isTurnStart = (event.category === 'context' && event.action === 'sent');
        const isTurnEnd = (event.category === 'llm' && event.action === 'stream_end');

        if (isTurnStart) {
            turns.count += 1;
            const userMsg = event.detail?.user_message || '(no message)';
            const turnEl = document.createElement('details');
            turnEl.open = true;  // newest turn auto-expanded
            turnEl.style.cssText = 'border-bottom:2px solid #d0d0d0;background:#fff';
            const turnSummary = document.createElement('summary');
            turnSummary.style.cssText = 'padding:8px 10px;cursor:pointer;background:#fff9e3;font-size:12px;font-weight:600;display:flex;gap:10px;align-items:center';
            const counts = { skills: 0, tools: 0, api_calls: 0, started: Date.now() };
            turns.currentCounts = counts;
            // Counter spans get updated in-place as events stream in
            const countsSpan = document.createElement('span');
            countsSpan.className = 'turn-counts';
            countsSpan.style.cssText = 'color:#888;font-weight:400;font-size:11px;margin-left:auto';
            countsSpan.textContent = '0 skills · 0 tools';
            turnSummary.innerHTML = `
                <span style="color:#999">Turn ${turns.count}</span>
                <span style="color:#333;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._esc(userMsg)}</span>
            `;
            turnSummary.appendChild(countsSpan);
            turnEl.appendChild(turnSummary);
            const body = document.createElement('div');
            body.className = 'turn-body';
            turnEl.appendChild(body);
            logEl.appendChild(turnEl);

            // Collapse the previous turn so the new one is the focus
            if (turns.current) turns.current.open = false;

            turns.current = turnEl;
            turns.currentBody = body;
            turns.currentCountsEl = countsSpan;

            // Drain any pre-context skill events into this new turn
            if (turns.pending.length) {
                for (const e of turns.pending) this._appendEventLine(e, body, counts, countsSpan);
                turns.pending = [];
            }
        }

        // If no turn open yet (first events of session before context.sent),
        // buffer them; they'll flush when the next context.sent arrives.
        if (!turns.current) {
            turns.pending.push(event);
            return;
        }

        // Append event into current turn body + bump counters
        this._appendEventLine(event, turns.currentBody, turns.currentCounts, turns.currentCountsEl);

        if (isTurnEnd) {
            // Stamp duration into the counts span
            const elapsed = ((Date.now() - turns.currentCounts.started) / 1000).toFixed(1);
            const counts = turns.currentCounts;
            turns.currentCountsEl.textContent =
                `${counts.skills} skills · ${counts.tools} tools · ${counts.api_calls} api · ${elapsed}s`;
        }

        logEl.scrollTop = logEl.scrollHeight;
    }

    _appendEventLine(event, container, counts, countsEl) {
        const catColors = {
            api: '#4a9eda', tool: '#f9a825', skill: '#66bb6a',
            file: '#ce93d8', llm: '#ff7043', context: '#78909c',
        };
        const catIcons = {
            api: 'fa-satellite-dish', tool: 'fa-wrench', skill: 'fa-book',
            file: 'fa-file-code', llm: 'fa-robot', context: 'fa-cube',
        };
        const color = catColors[event.category] || '#888';
        const icon = catIcons[event.category] || 'fa-circle';
        const details = event.detail || {};
        const hasDetails = Object.keys(details).length > 0;

        // Bump turn counters
        if (counts) {
            if (event.category === 'skill' && event.action === 'load') counts.skills += 1;
            else if (event.category === 'tool' && event.action === 'call') counts.tools += 1;
            else if (event.category === 'api' && event.action === 'call') counts.api_calls += 1;
            if (countsEl) {
                countsEl.textContent =
                    `${counts.skills} skills · ${counts.tools} tools · ${counts.api_calls} api`;
            }
        }

        // Summary string
        let summary = event.action;
        if (details.name) summary += `: ${details.name}`;
        if (details.model) summary += ` (${details.model})`;
        if (details.messages) summary += ` - ${details.messages} msgs`;
        if (details.input_tokens_est) summary += `, ~${details.input_tokens_est} tokens`;
        if (details.result_chars) summary += ` - ${details.result_chars} chars`;
        if (details.tokens_in) summary += ` - in:${details.tokens_in} out:${details.tokens_out}`;
        if (details.path) summary += `: ${details.path}`;
        if (details.user_message) summary += `: "${details.user_message}"`;
        if (details.auto_injected) summary += ' (auto)';

        const item = document.createElement('details');
        item.style.cssText = 'border-bottom:1px solid #f5f5f5';

        const summaryEl = document.createElement('summary');
        summaryEl.style.cssText = 'padding:4px 10px 4px 22px;cursor:pointer;display:flex;align-items:center;gap:8px;font-size:12px';
        summaryEl.addEventListener('mouseenter', () => { summaryEl.style.background = '#f5f5f5'; });
        summaryEl.addEventListener('mouseleave', () => { summaryEl.style.background = ''; });

        const time = event.ts ? event.ts.split(' ')[1] : '';
        summaryEl.innerHTML = `
            <span style="color:#999;font-size:10px;min-width:56px">${time}</span>
            <i class="fa-solid ${icon}" style="color:${color};font-size:10px;min-width:14px"></i>
            <span style="color:${color};font-weight:600;min-width:50px;font-size:11px">${event.category}</span>
            <span style="flex:1;color:#333">${this._esc(summary)}</span>
        `;
        item.appendChild(summaryEl);

        if (hasDetails) {
            const detailEl = document.createElement('div');
            detailEl.style.cssText = 'padding:4px 10px 8px 100px;font-family:var(--font-mono,monospace);font-size:11px;color:#555;background:#fafafa';
            for (const [k, v] of Object.entries(details)) {
                const row = document.createElement('div');
                row.style.cssText = 'padding:1px 0';
                row.innerHTML = `<span style="color:#888">${k}:</span> <span style="color:#333">${this._esc(String(v).substring(0, 500))}</span>`;
                detailEl.appendChild(row);
            }
            item.appendChild(detailEl);
        }

        container.appendChild(item);
    }

    _esc(str) {
        const d = document.createElement('div');
        d.textContent = str || '';
        return d.innerHTML;
    }

    /** Load chat history from backend and replay into the panel. Returns true if history was found. */
    async loadHistory() {
        const ctx = this._contextProvider?.();
        const projectId = ctx?.project_id || 'default';
        try {
            const resp = await fetch(`api/llm/history/${this.clientId}/${projectId}`);
            if (!resp.ok) return false;
            const data = await resp.json();
            const messages = data.messages || [];
            if (messages.length === 0) return false;

            for (const msg of messages) {
                this.chatPanel.addMessage(msg.role, msg.content);
            }
            return true;
        } catch (err) {
            console.warn('[ChatService] Failed to load history:', err);
            return false;
        }
    }

    /** Clear chat history on both frontend and backend. */
    async clearHistory() {
        this.chatPanel.clearMessages();
        const ctx = this._contextProvider?.();
        const projectId = ctx?.project_id || 'default';
        try {
            await fetch(`api/llm/history/${this.clientId}/${projectId}`, { method: 'DELETE' });
        } catch (err) {
            console.warn('[ChatService] Failed to clear history:', err);
        }
    }

    onStatusChange(callback) {
        this._onStatusChange = callback;
    }

    _emitStatus(status) {
        if (this._onStatusChange) this._onStatusChange(status);
    }

    /** Check LLM health via HTTP, update status LED and model dropdown. */
    async _checkHealth() {
        try {
            const resp = await fetch('api/llm/health');
            if (resp.ok) {
                const data = await resp.json();
                const ok = data.status === 'ok';
                this._emitStatus(ok ? 'connected' : 'disconnected');
                if (data.models && data.models.length > 0) {
                    this.chatPanel.setModels(data.models, data.active_model);
                } else if (data.active_model) {
                    this.chatPanel.setModelName(data.active_model);
                }
            } else {
                this._emitStatus('disconnected');
            }
        } catch {
            this._emitStatus('disconnected');
        }
    }

    static _SESSION_KEY = 'noted_terminal_secret';

    /** Show a password prompt dialog. Returns the entered string or null if cancelled. */
    static _promptSecret() {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center';
            overlay.innerHTML = `
                <div style="background:#fff;border-radius:6px;padding:24px;min-width:340px;box-shadow:0 8px 32px rgba(0,0,0,.2);font-family:var(--font-family)">
                    <div style="font-size:14px;font-weight:600;color:#333;margin-bottom:12px">
                        <i class="fa-solid fa-lock" style="margin-right:6px;color:#1a73e8"></i>Access Key Required
                    </div>
                    <div style="font-size:12px;color:#666;margin-bottom:14px">
                        Switching to a paid model requires the noted access key.
                    </div>
                    <input type="password" placeholder="Access key"
                           style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #ccc;border-radius:4px;font-size:13px;outline:none" />
                    <div class="err" style="color:#d32f2f;font-size:12px;margin-top:6px;display:none">Invalid access key</div>
                    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
                        <button data-cancel style="padding:6px 16px;border:1px solid #ccc;border-radius:4px;background:#fff;color:#333;cursor:pointer;font-size:12px">Cancel</button>
                        <button data-ok style="padding:6px 16px;border:none;border-radius:4px;background:#1a73e8;color:#fff;cursor:pointer;font-size:12px">Confirm</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            const input = overlay.querySelector('input');
            const cleanup = (val) => { overlay.remove(); resolve(val); };
            overlay.querySelector('[data-ok]').addEventListener('click', () => cleanup(input.value || null));
            overlay.querySelector('[data-cancel]').addEventListener('click', () => cleanup(null));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') cleanup(input.value || null);
                if (e.key === 'Escape') cleanup(null);
            });
            overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
            requestAnimationFrame(() => input.focus());
        });
    }

    /** Wire the model dropdown to POST /api/llm/model on change. */
    _wireModelSelect() {
        this.chatPanel.onModelChange(async (modelId) => {
            const isPaid = modelId.startsWith('claude-');
            let secret = '';

            if (isPaid) {
                // Try cached secret first, otherwise prompt
                secret = sessionStorage.getItem(ChatService._SESSION_KEY) || '';
                if (!secret) {
                    secret = await ChatService._promptSecret();
                    if (!secret) {
                        this.chatPanel.revertModelSelect();
                        return;
                    }
                }
            }

            try {
                const resp = await fetch('api/llm/model', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model_id: modelId, secret }),
                });
                if (resp.status === 403) {
                    sessionStorage.removeItem(ChatService._SESSION_KEY);
                    this.chatPanel.revertModelSelect();
                    alert('Invalid access key');
                    return;
                }
                if (isPaid && secret) {
                    sessionStorage.setItem(ChatService._SESSION_KEY, secret);
                }
                this.chatPanel._lastConfirmedModel = modelId;
            } catch (err) {
                console.warn('[ChatService] Model switch failed:', err);
                this.chatPanel.revertModelSelect();
            }
        });
    }
    onWriteAction(cb) { this._onWriteAction = cb; }
    onNavigate(cb) { this._onNavigate = cb; }
    onOpenFile(cb) { this._onOpenFile = cb; }
    onDoc(cb) { this._onDoc = cb; }
    onFileChanged(cb) { this._onFileChanged = cb; }


    async connect() {
        this._wireModelSelect();
        this._emitStatus('connecting');
        this.agentClient = new AgentClient({ url: AGENT_URL });
        await this.agentClient.connect({
            onReconnect: () => {
                console.log('[ChatService] Agent reconnected');
                this._emitStatus('connected');
                // agent_server may have restarted to apply an active-model
                // switch - re-fetch /health so the dropdown reflects the new
                // active local model (setModels marks it selected).
                this._checkHealth();
            },
        });

        // LED follows Socket.IO heartbeat (built-in ping/pong)
        this.agentClient.socket.on('disconnect', () => {
            this._emitStatus('disconnected');
        });
        this.agentClient.socket.on('reconnect', () => {
            this._emitStatus('connected');
            // Browser ↔ agent_server reconnect assigns a new sid, but
            // agent_server's CLIENT_INDEX still maps clientId to the OLD
            // sid. Without re-issuing JoinSTT, UserTranscript events
            // emit into the dead sid silently and voice input goes
            // mute even though stt_server, agent_server's stt-link,
            // and the browser audio path are all healthy. Re-emit
            // sttSubscribe to refresh the binding when voice is active.
            if (this.voiceActive) {
                this.agentClient.sttSubscribe({
                    sttUrl: STT_URL,
                    clientId: this.clientId,
                    agent: AGENT_NAME,
                    threadId: this.threadId,
                    transcriptOnly: true,
                }).catch((err) => {
                    console.warn('[ChatService] reconnect sttSubscribe failed:', err);
                });
            }
        });

        // STT transcripts arrive via agent_server's UserTranscript event.
        //   - onInterim: streaming partials from stt_server v2 (Parakeet).
        //     v1 (Whisper) never emits these; the handler stays inert.
        //     Renders a "composing" user bubble in the messages area that
        //     updates live as the user speaks. The text input textarea is
        //     reserved for typed messages and never touched by STT.
        //   - onFinal: utterance committed. Promote the composing bubble
        //     to a normal user message + trigger the LLM call without
        //     creating a duplicate bubble (showUserMessage: false).
        this.agentClient.onTranscripts({
            onInterim: (payload) => {
                const text = (payload?.text || '').trim();
                if (text) this.chatPanel.setComposingUserMessage(text);
            },
            onFinal: (payload) => {
                // commitComposingUserMessage() returns the composing
                // bubble's text and clears it IF a bubble exists. With
                // Parakeet (v2), partials → bubble → commit → already
                // rendered → suppress sendMessage's bubble. With Whisper
                // (v1), no partials, no composing bubble → nothing to
                // commit → we must let sendMessage render the user
                // message itself.
                const committedFromBubble = this.chatPanel.commitComposingUserMessage();
                const text = (payload?.text || '').trim() || committedFromBubble;
                if (!text) return;
                // Suppress sendMessage's bubble ONLY when the composing
                // bubble already rendered the message (Parakeet path).
                // Otherwise (Whisper path) we'd silently drop the user
                // message from the chat UI.
                const showUserMessage = !committedFromBubble;
                this.sendMessage(text, { showUserMessage });
            },
        });

        // LLM streaming responses (direct Socket.IO path - unused now, kept for agent events)
        this.agentClient.onStream({
            onStarted: () => { this._streamBuffer = ''; },
            onText: (fullText) => { this._streamBuffer = fullText; },
            onDone: () => { this.chatPanel.setLoading(false); this._streamBuffer = ''; },
            onError: (err) => {
                this.chatPanel.setLoading(false);
                this.chatPanel.addMessage('assistant', `Error: ${err.message}`);
                this._streamBuffer = '';
            },
        });

        console.log('[ChatService] Connected to agent server');

        // Check LLM health via HTTP (primary indicator)
        await this._checkHealth();

        // Restore previous chat history, or fire a dynamic welcome.
        //
        // Dynamic welcome: hidden user turn "Hello!" forces think_enabled
        // off and tools off; the model's streamed reply renders as the
        // visible greeting AND warms its KV cache for the user's first
        // real question. Falls back to a static random message on error.
        //
        // Known race (revisited 2026-05-02): the dynamic call shares
        // ChatPanel's single _streamingMsg slot. If the user sends a
        // message before the welcome's stream completes, turn-2 tokens
        // can append to the welcome bubble. The race is real but the
        // recent UI work (action bar, citation rendering fixes) plus
        // the latency wins (~200ms tool calls) make collision much less
        // likely. WELCOME_MESSAGES preserved as fallback path.
        const hasHistory = await this.loadHistory();
        if (!hasHistory) {
            this.sendMessage('Hello!', {
                showUserMessage: false,
                overrides: {
                    thinkEnabled: false,
                    vectorRagEnabled: false,
                    graphRagEnabled: false,
                },
            }).catch((err) => {
                console.warn('[ChatService] Dynamic welcome failed, using static fallback:', err);
                this._welcomeText = WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)];
                this.chatPanel.addMessage('assistant', this._welcomeText);
                if (this.ttsEnabled) this._sendVoiceToTTS(this._welcomeText);
            });
        }
    }


    /**
     * Strip <think>...</think> blocks from completed text.
     * Used for the direct AgentClient path where streaming isn't parsed incrementally.
     */
    static stripThinking(text) {
        const match = text.match(/^<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/);
        if (match) {
            return { thinking: match[1].trim(), answer: match[2].trim() };
        }
        return { thinking: null, answer: text };
    }

    // --- Text chat ---

    async sendMessage(content, { showUserMessage = true, overrides = null } = {}) {
        // `content` is either a plain string (text-only chat) or an
        // OpenAI-style content list (multimodal — text + image_url
        // blocks from the chat-input image attachment). All downstream
        // hops accept either shape and forward unchanged.
        // Conversational interruption: if a previous turn is still streaming,
        // abort it before opening the new one. Without this, the two SSE
        // streams race into the chat and tokens from both turns interleave
        // in whatever bubble is "current".
        if (this._activeAbortController) {
            this._activeAbortController.abort();
            this._activeAbortController = null;
            // Drop queued TTS for the cancelled turn so the user doesn't
            // keep hearing the old answer over the new one. In-progress
            // audio buffers play to completion (a few hundred ms tail).
            this._ttsPlayQueue = Promise.resolve();
            // Finalize any in-flight streaming bubble as a partial message
            // so it stays in history with whatever rendered up to now.
            this.chatPanel.finalizeStreamingMessage();
            this.chatPanel.setLoading(false);
            this.chatPanel.setThinkingIndicator(false);
        }
        // Remove stale error messages from previous failed requests
        this.chatPanel.clearTransientErrors();
        // Show user message in chat (unless already shown by ChatPanel._handleSend)
        if (showUserMessage) {
            this.chatPanel.addMessage('user', content);
        }
        // Once the user actually engages, the welcome no longer makes sense
        // to replay on a late TTS-enable. Mark it consumed.
        this._userMessagesSent++;
        // Always use the HTTP path for consistent usage tracking and memory
        const ctx = this._contextProvider?.() || {};
        return this._sendWithContext(content, ctx, overrides);
    }

    async _sendDirect(text) {
        if (!this.agentClient) return;
        this.chatPanel.setLoading(true);
        try {
            await this.agentClient.runText(text, {
                agent: AGENT_NAME,
                threadId: this.threadId,
            });
        } catch (err) {
            this.chatPanel.setLoading(false);
            this.chatPanel.addMessage('assistant', `Error: ${err.message}`);
        }
    }

    async _sendWithContext(content, contextDescriptor, overrides = null) {
        this.chatPanel.setLoading(true);

        // TEMP-DIAG turn-tagged stream logging. Every SSE token, every
        // parser event, and every TTS dispatch is logged with this turn
        // ID so the console can be grepped per-turn. Remove once the
        // streaming-parser bugs are fully chased.
        const turnId = Math.random().toString(36).slice(2, 8);
        // Preview is the text portion only — for multimodal content,
        // join the text blocks and skip the image_url payloads (they're
        // 200 KB+ data URLs and useless in a console preview).
        const _previewText = (typeof content === 'string')
            ? content
            : (Array.isArray(content)
                ? content.filter(b => b && b.type === 'text').map(b => b.text || '').join(' ')
                : String(content || ''));
        console.info(`[turn:${turnId}] START user=${JSON.stringify(_previewText.slice(0, 120))}`);

        const parser = new ThinkingParser();
        let fullAnswer = '';
        let thinkingContent = '';
        // Last graph_provenance payload received this turn. Surfaced on the
        // assistant message via finalizeStreamingMessage so the user can open
        // the per-answer KG trace.
        let graphProvenance = null;
        // Set when the model emits a write tool that needs user approval —
        // voice (and the voice fallback) must stay silent until confirm.
        let pendingActionSeen = false;
        // Voice-first: the model emits <voice>...</voice> at the START of its
        // visible response (right after </think>), so we can dispatch TTS
        // mid-stream and let it play in parallel with the answer body. Once
        // dispatched, the finalize-time fallback path must not double-fire.
        let voiceDispatched = false;

        // Resolve per-call overrides (welcome path uses these to force
        // think_enabled=false and tools off without affecting the panel
        // toggle state visible to the user).
        const _think = overrides?.thinkEnabled ?? this.chatPanel.thinkEnabled;
        const _vec = overrides?.vectorRagEnabled ?? this.chatPanel.vectorRagEnabled;
        const _graph = overrides?.graphRagEnabled ?? this.chatPanel.graphRagEnabled;

        const abortController = new AbortController();
        this._activeAbortController = abortController;

        try {
            const response = await fetch('api/llm/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    // Either a plain string OR an OpenAI-style content
                    // list (text + image_url blocks for multimodal).
                    // noted backend's ChatRequest.message accepts both.
                    message: content,
                    client_id: this.clientId,
                    context_descriptor: contextDescriptor,
                    think_enabled: _think,
                    vector_rag_enabled: _vec,
                    graph_rag_enabled: _graph,
                }),
                signal: abortController.signal,
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // Keep the typing-dots indicator visible until real content
            // arrives. The previous setLoading(false) here hid the dots the
            // moment the SSE stream OPENED, before any payload had been
            // sent - leaving the user staring at a silent gap during the
            // ~1.5-2s of pre-Gemma routing. The indicator is now hidden
            // by the first content event (thinking_start sets a label;
            // answer_token hides the dots and starts rendering text).

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let sseBuffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                sseBuffer += decoder.decode(value, { stream: true });
                const lines = sseBuffer.split('\n');
                // Keep the last (possibly incomplete) line in the buffer
                sseBuffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue;

                    let data;
                    try {
                        data = JSON.parse(trimmed.slice(6));
                    } catch {
                        continue; // skip malformed chunks
                    }
                    if (data.error) throw new Error(data.error);

                    // Usage event (sent before [DONE])
                    if (data.usage) {
                        this.chatPanel.updateTokenUsage(data.usage);
                        continue;
                    }

                    // Skills event (sent before streaming starts) - debug-panel only
                    // The chat panel no longer renders skill badges; the same data
                    // flows to the Debug panel via llm_debug events when enabled.
                    if (data.skills) {
                        continue;
                    }

                    // Navigate event - scroll notebook to cell
                    if (data.navigate) {
                        if (this._onNavigate) this._onNavigate(data.navigate.cell_index);
                        continue;
                    }

                    // Open-file event - LLM requested open_file tool. Hands
                    // off to app.js which dispatches to the appropriate tab
                    // opener based on payload.kind.
                    if (data.open_file) {
                        if (this._onOpenFile) {
                            try { this._onOpenFile(data.open_file); }
                            catch (e) { console.warn('[ChatService] onOpenFile threw', e); }
                        }
                        continue;
                    }

                    // Chart event - LLM-requested ECharts render. Payload
                    // shape: {option, title, chart_type}. The chat panel
                    // appends a chart canvas to the currently-streaming
                    // assistant bubble (or the most recent one) via its
                    // renderInlineChart() helper.
                    if (data.chart) {
                        try {
                            this.chatPanel?.renderInlineChart?.(data.chart);
                        } catch (e) {
                            console.warn('[ChatService] renderInlineChart threw', e);
                        }
                        continue;
                    }

                    // Doc event - Take-Notes capability (NOTES-1). Payload
                    // shape: {buffer_id, name, content, path}. Hands off to
                    // app.js so the document viewer either opens the buffer
                    // for the first time (create_doc) or re-renders existing
                    // content live (append_to_doc / replace_doc).
                    if (data.doc) {
                        if (this._onDoc) {
                            try { this._onDoc(data.doc); }
                            catch (e) { console.warn('[ChatService] onDoc threw', e); }
                        }
                        continue;
                    }

                    // File-changed event - NOTES-3. Emitted from /api/llm/confirm
                    // after a successful update_file / create_file (and the
                    // append_to_file path that re-routes through update_file).
                    // Payload: {path, project_id}. Hands off to app.js to refresh
                    // any DocumentViewer or FileEditor displaying the touched
                    // path.
                    if (data.file_changed) {
                        if (this._onFileChanged) {
                            try { this._onFileChanged(data.file_changed); }
                            catch (e) { console.warn('[ChatService] onFileChanged threw', e); }
                        }
                        continue;
                    }

                    // Tool badge event - debug-panel only (the SSE event is still
                    // visible to the harness; rendering moved to the Debug panel).
                    if (data.tool_badge) {
                        continue;
                    }

                    // Graph provenance event - structured KG payload from
                    // graph_and_vector_search, surfaced on the assistant
                    // message for the per-answer trace UI. Push it to the
                    // ChatPanel immediately so the "Show graph" button
                    // appears alongside "Show thinking" before answer
                    // tokens stream in (the event arrives right after the
                    // tool dispatch, well before thinking_start).
                    if (data.graph_provenance) {
                        graphProvenance = data.graph_provenance;
                        this.chatPanel.setPendingGraphTrace(data.graph_provenance);
                        continue;
                    }

                    // Pending write action(s) - skip badge render, just open
                    // the approval panel. Debug panel records the underlying
                    // tool_call event separately.
                    if (data.pending_actions) {
                        parser.voiceText = ''; // suppress voice - change not confirmed yet
                        pendingActionSeen = true;
                        this._showBatchConfirmationPanel(data.pending_actions);
                        continue;
                    }
                    if (data.pending_action) {
                        parser.voiceText = ''; // suppress voice - change not confirmed yet
                        pendingActionSeen = true;
                        this._showBatchConfirmationPanel([data.pending_action]);
                        continue;
                    }

                    if (typeof data.token !== 'string') continue;
                    // Per-token CHUNK / thinking_token / answer_token logs
                    // were silenced 2026-05-12 — they flood the console at
                    // streaming rates and made anything else unreadable.
                    // Lifecycle events (thinking_end, voice, others) still
                    // log because they fire once per turn.
                    const result = parser.processToken(data.token);
                    if (result.type !== 'pending') {
                        if (result.type === 'thinking_end') {
                            console.info(`[turn:${turnId}] EVENT thinking_end thinking_len=${(result.thinking||'').length} answer=${JSON.stringify(result.answer||'')}`);
                        } else if (result.type === 'thinking_token' || result.type === 'answer_token') {
                            // per-token; suppressed
                        } else if (result.type === 'voice') {
                            console.info(`[turn:${turnId}] EVENT voice ${JSON.stringify(result.text||'')}`);
                        } else {
                            console.info(`[turn:${turnId}] EVENT ${result.type}`);
                        }
                    }

                    switch (result.type) {
                        case 'thinking_start':
                            // Hide the typing dots - the live reasoning panel
                            // is the visual indicator now; dots are redundant.
                            this.chatPanel.setLoading(false);
                            this.chatPanel.startLiveThinkingSection();
                            // The chunk that contained <think> may have ALSO
                            // carried the first slice of the body. The parser
                            // stashes it in thinkingBuffer but never emits it
                            // as a thinking_token, so it would silently disappear
                            // from the live display - causing visible char loss
                            // (e.g. "ser is asking" instead of "user is asking").
                            // Flush that initial slice now so the live body matches
                            // the captured content.
                            if (parser.thinkingBuffer) {
                                this.chatPanel.appendLiveThinkingToken(parser.thinkingBuffer);
                            }
                            break;
                        case 'thinking_end':
                            this.chatPanel.setThinkingIndicator(false);
                            // Same race in reverse: the chunk that carried </think>
                            // may have also carried the LAST slice of the body
                            // (parts[0] in ThinkingParser). result.thinking is the
                            // full captured content; sync the live body to it
                            // before collapsing so nothing is missing visually.
                            this.chatPanel.setLiveThinkingContent(result.thinking);
                            this.chatPanel.endLiveThinkingSection();
                            thinkingContent = result.thinking;
                            if (result.answer) {
                                fullAnswer += result.answer;
                                this.chatPanel.appendToken(result.answer);
                            }
                            // Voice-first: same-chunk extraction in the parser
                            // sets parser.voiceText without firing a 'voice'
                            // event. Dispatch immediately so TTS plays in
                            // parallel with the answer body that just started
                            // streaming above.
                            if (!voiceDispatched && this.ttsEnabled && parser.voiceText && !pendingActionSeen) {
                                console.info(`[turn:${turnId}] TTS dispatch=thinking_end voiceText=${JSON.stringify(parser.voiceText)}`);
                                this._sendVoiceToTTS(parser.voiceText);
                                voiceDispatched = true;
                            }
                            break;
                        case 'thinking_token':
                            this.chatPanel.appendLiveThinkingToken(result.token);
                            break;
                        case 'tool_call':
                            // Tool badges no longer render in chat - moved to Debug panel
                            break;
                        case 'voice':
                            // Voice-first: dispatch TTS the moment the parser
                            // closes the <voice> block. With the model emitting
                            // voice BEFORE the answer body, audio starts playing
                            // while the answer is still streaming on screen.
                            if (!voiceDispatched && this.ttsEnabled && parser.voiceText && !pendingActionSeen) {
                                console.info(`[turn:${turnId}] TTS dispatch=voice_event voiceText=${JSON.stringify(parser.voiceText)}`);
                                this._sendVoiceToTTS(parser.voiceText);
                                voiceDispatched = true;
                            }
                            break;
                        case 'answer_token':
                            // First answer token marks "real content arriving" -
                            // hide the typing dots if they're still up (e.g. when
                            // the model didn't emit a <think> block).
                            this.chatPanel.setLoading(false);
                            fullAnswer += result.token;
                            this.chatPanel.appendToken(result.token);
                            break;
                    }
                    // Defensive backstop: parser CAN set voiceText in code
                    // paths that don't return a 'voice' event (notably the
                    // same-chunk voice-LAST case where voiceText is set but
                    // 'answer_token' is returned for the text BEFORE the
                    // <voice> opener). Without this, mid-stream dispatch
                    // would be stranded and only end-of-stream Tier 1
                    // recovery would fire. Cheap check, runs every event.
                    if (!voiceDispatched && this.ttsEnabled && parser.voiceText && !pendingActionSeen) {
                        console.info(`[turn:${turnId}] TTS dispatch=backstop voiceText=${JSON.stringify(parser.voiceText)}`);
                        this._sendVoiceToTTS(parser.voiceText);
                        voiceDispatched = true;
                    }
                }
            }
        } catch (err) {
            // Aborted by a new sendMessage — silent exit. The new turn
            // has already cleaned up loading/thinking indicators and
            // finalized whatever bubble was on screen.
            if (err.name === 'AbortError' || abortController.signal.aborted) {
                if (this._activeAbortController === abortController) {
                    this._activeAbortController = null;
                }
                return;
            }
            this.chatPanel.setLoading(false);
            this.chatPanel.setThinkingIndicator(false);
            this.chatPanel.addMessage('assistant', `Error: ${err.message}`);
            if (this._activeAbortController === abortController) {
                this._activeAbortController = null;
            }
            return;
        }

        // Clear the in-flight pointer first so any post-completion work
        // (voice dispatch, fallback) can't be aborted retroactively by a
        // stale pointer if a new sendMessage races in right at this line.
        if (this._activeAbortController === abortController) {
            this._activeAbortController = null;
        }

        this.chatPanel.setThinkingIndicator(false);
        this.chatPanel.finalizeStreamingMessage(thinkingContent, graphProvenance);

        console.info(`[turn:${turnId}] END thinking_len=${thinkingContent.length} answer_len=${fullAnswer.length} voiceText_len=${(parser.voiceText||'').length} voiceDispatched=${voiceDispatched} pendingActionSeen=${pendingActionSeen}`);
        console.info(`[turn:${turnId}] FULL_ANSWER ${JSON.stringify(fullAnswer)}`);
        if (parser.voiceText) console.info(`[turn:${turnId}] FULL_VOICE_TEXT ${JSON.stringify(parser.voiceText)}`);

        // Voice dispatch (only if the mid-stream path didn't already fire).
        // Voice-first ordering means voiceDispatched is normally true by
        // here; this branch handles the legacy/old-prompt path or a parser
        // miss where voice didn't surface as an event during the stream.
        if (voiceDispatched) {
            // Already speaking — nothing to do.
        } else if (this.ttsEnabled && parser.voiceText) {
            console.info(`[turn:${turnId}] TTS dispatch=finalize voiceText=${JSON.stringify(parser.voiceText)}`);
            this._sendVoiceToTTS(parser.voiceText);
        } else if (this.ttsEnabled && !pendingActionSeen && fullAnswer) {
            // Defensive fallback: model skipped <voice>. Speak the answer
            // (or a one-shot summary of it) instead of going silent.
            // TEMP-DIAG 2026-05-03: log so we can correlate with backend
            // VOICE_CAPTURED logs. If the backend captured voice for the
            // same turn, the frontend parser missed something; investigate
            // the streaming ThinkingParser. Remove once the parser-miss
            // bug is found and fixed.
            console.info(`[turn:${turnId}] FALLBACK fired fullAnswer_len=${fullAnswer.length}`);
            this._voiceFallback(fullAnswer, abortController.signal);
        }

        // History is managed server-side by ProjectMemory
    }

    /** Strip markdown, citation tags, code, URLs, and collapse whitespace
     *  so the result is plain prose suitable for TTS. */
    _cleanAnswerForVoice(text) {
        if (!text) return '';
        let s = text;
        // Defense in depth — strip any <think>...</think> / <voice>...</voice>
        // blocks (and stray opener/closer tags) in case the streaming parser
        // missed them and they leaked into fullAnswer as literal text. We
        // do NOT want TTS reading "less than think greater than" out loud.
        s = s.replace(/<think>[\s\S]*?<\/think>/g, '');
        s = s.replace(/<voice>[\s\S]*?<\/voice>/g, '');
        s = s.replace(/<\/?(?:think|voice)>/g, '');
        // Citation tags: [markdown_chunk:hex], [E:type:id], [R:...], bare hex too.
        s = s.replace(/\[(?:markdown_chunk|E|R|C\d+):[^\]]+\]/g, '');
        // Code fences (``` ... ```) - drop the whole block; speaking code is awful.
        s = s.replace(/```[\s\S]*?```/g, ' ');
        // Inline code `like this` -> like this
        s = s.replace(/`([^`]+)`/g, '$1');
        // Markdown links [text](url) -> text
        s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
        // Emphasis: **bold**, *italic*, __bold__, _italic_  -> bare text
        s = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');
        s = s.replace(/__([^_]+)__/g, '$1').replace(/_([^_]+)_/g, '$1');
        // Headings: ## Section -> Section
        s = s.replace(/^\s*#{1,6}\s+/gm, '');
        // Bullets / numbered list markers at line start
        s = s.replace(/^\s*[-*+]\s+/gm, '');
        s = s.replace(/^\s*\d+\.\s+/gm, '');
        // Collapse all whitespace (newlines too) to single spaces.
        s = s.replace(/\s+/g, ' ').trim();
        return s;
    }

    /** Fired when the model produced an answer but the streaming parser
     *  failed to surface the <voice> block. Two-tier recovery:
     *
     *  1. Recover voice text from rawAnswer directly. If a parser miss
     *     leaked <voice>...</voice> into fullAnswer as literal text,
     *     regex it back out and speak the actual content. Cheap, instant.
     *  2. If no voice tags found AND the cleaned answer is short enough
     *     to be speakable, speak it as-is — covers the rare case where
     *     the model genuinely skipped <voice>.
     *
     *  No third tier. The previous "ask Gemma to summarize" path was a
     *  band-aid for parser bugs; with the parser fixed, it added latency
     *  and unreliability without value. Removed.
     *
     *  Silent on error. Accepts the originating turn's AbortSignal so a
     *  user interruption also cancels any in-flight TTS dispatch. */
    _voiceFallback(rawAnswer, signal = null) {
        if (signal?.aborted) return;

        // Tier 1: recover voice block from the raw stream text.
        const voiceMatch = rawAnswer && rawAnswer.match(/<voice>([\s\S]*?)<\/voice>/);
        if (voiceMatch) {
            const recovered = voiceMatch[1].trim();
            if (recovered) {
                console.info(`[ChatService] fallback Tier 1 (regex recovery) fired, voice_len=${recovered.length}`);
                this._sendVoiceToTTS(recovered);
                return;
            }
        }

        // Tier 2: no voice tags — speak the cleaned answer if short enough.
        const cleaned = this._cleanAnswerForVoice(rawAnswer);
        if (!cleaned) return;
        if (cleaned.length <= VOICE_FALLBACK_MAX_CHARS) {
            console.info(`[ChatService] fallback Tier 2 (short-answer verbatim) fired, cleaned_len=${cleaned.length}`);
            this._sendVoiceToTTS(cleaned);
            return;
        }
        // Long answer with no voice block — accept the silence rather than
        // make a second LLM call. Voice-first prompt makes this rare.
        console.info(`[ChatService] fallback skipped: no voice tags + cleaned answer too long (${cleaned.length} chars)`);
    }

    /** Send extracted <voice> text to TTS for speech output.
     *
     *  Auto-switches the Kokoro voice when the detected language of
     *  `text` differs from the current voice's language. Detection
     *  uses Unicode-script majority + a small Latin stop-word lexicon
     *  (see detectKokoroLanguage). The configure event is emitted to
     *  the TTS server BEFORE the text chunk so the right pipeline is
     *  resolved when the chunk gets queued for synthesis. */
    _sendVoiceToTTS(text) {
        if (!this._ttsSocket?.connected || !text) return;

        // Sanitize: strip markdown + citation tags + structural markers
        // before sending to Kokoro. The voice block is supposed to carry
        // 1-3 plain spoken sentences, but Gemma occasionally embeds the
        // full answer body inside <voice>...</voice> (markdown headings,
        // [E:...] / [R:...] / [C\d+] / [markdown_chunk:...] citation
        // tags, bullets, bold/italic markers, code fences). Without this
        // pass, Kokoro literally voices "hash hash overview" or
        // "bracket E colon concept colon...". This is the defensive half
        // of the voice-runaway fix; the structural side (constraining
        // Gemma's voice block) is in the backlog.
        text = String(text)
            // Drop fenced code blocks entirely (rarely useful spoken).
            .replace(/```[\s\S]*?```/g, ' ')
            // Citation tags in every form.
            .replace(/\[(?:E|R|markdown_chunk):[^\]]+\]/g, '')
            .replace(/\[C\d+\]/g, '')
            .replace(/\[[0-9a-f]{8,16}\]/g, '')
            // Markdown headings, bullets, ordered list markers.
            .replace(/^\s*#{1,6}\s+/gm, '')
            .replace(/^\s*[\*\-+]\s+/gm, '')
            .replace(/^\s*\d+\.\s+/gm, '')
            // Bold / italic / inline-code markers (keep the text).
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/(^|\s)_([^_]+)_(\s|$)/g, '$1$2$3')
            .replace(/`([^`]+)`/g, '$1')
            // Collapse paragraph breaks to a sentence pause, then trim
            // any remaining multi-whitespace.
            .replace(/\n{2,}/g, '. ')
            .replace(/\s+/g, ' ')
            .trim();
        if (!text) return;

        // New TTS request — re-open the audio chunk pipeline that
        // _bargeIn closed. Without this, every turn after the first
        // barge-in would be silent.
        this._ttsBargedIn = false;
        try {
            // Voice resolution. Two paths:
            //   1. User picked a specific language in Voice Settings →
            //      use the chosen voice + speed verbatim, skip auto-detect.
            //   2. Language is 'auto' (default) → detect the language of
            //      THIS voice block and pick the matching default voice.
            //      Speed still flows from the user's setting (or the
            //      server default if untouched).
            const vs = this._voiceSettings || {};
            const userPickedLanguage = vs.language && vs.language !== 'auto';

            let targetVoice;
            if (userPickedLanguage) {
                targetVoice = vs.voice || TTS_DEFAULT_VOICE;
            } else {
                const detected = detectKokoroLanguage(text);
                targetVoice = TTS_LANGUAGE_VOICE_MAP[detected] || TTS_DEFAULT_VOICE;
            }
            const targetSpeed = (typeof vs.speed === 'number') ? vs.speed : null;

            const voiceChanged = targetVoice && targetVoice !== this._currentTtsVoice;
            const speedChanged = targetSpeed !== null && targetSpeed !== this._currentTtsSpeed;
            if (voiceChanged || speedChanged) {
                if (voiceChanged) {
                    console.info(
                        `[ChatService] TTS voice switch: ${this._currentTtsVoice} → ${targetVoice} ` +
                        `(${userPickedLanguage ? 'user-pinned' : "detected lang='" + detectKokoroLanguage(text) + "'"})`
                    );
                }
                if (speedChanged) {
                    console.info(`[ChatService] TTS speed: ${this._currentTtsSpeed} → ${targetSpeed}`);
                }
                // tts_configure_client routes through audio_client_mapping
                // (populated by register_audio_client at TTS connect time)
                // so the right session is updated. Server validates voice
                // name + speed range — failure is silent on the wire (server
                // logs warnings) and worst-case the chunk plays in the
                // previous voice / speed.
                const cfg = { client_id: this.clientId };
                if (voiceChanged) cfg.voice = targetVoice;
                if (speedChanged) cfg.speed = targetSpeed;
                this._ttsSocket.emit('tts_configure_client', cfg);
                if (voiceChanged) this._currentTtsVoice = targetVoice;
                if (speedChanged) this._currentTtsSpeed = targetSpeed;
            }

            this._ttsSocket.emit('tts_text_chunk', {
                chunk: text,
                target_client_id: this.clientId,
                final: true,
            });
        } catch (err) {
            console.warn('[ChatService] Voice TTS failed:', err);
        }
    }

    /** Update the user's voice preferences (language, gender, voice, speed).
     *  Wired by app-chat.js to ChatPanel.onVoiceSettingsChange.
     *  Takes effect on the next TTS turn (current speech keeps playing). */
    setVoiceSettings(settings) {
        this._voiceSettings = { ...(settings || {}) };
    }

    /** Hard-stop TTS playback. Called when VAD detects user speech
     *  while TTS is active (barge-in), or when the server emits
     *  tts_stop_immediate. Drains the play queue, stops the in-flight
     *  AudioBufferSourceNode (so the cut is instant, not the ~200 ms
     *  tail of the last buffer), and arms the stale-chunk guard so
     *  audio still in flight from the cancelled turn is dropped on
     *  arrival rather than enqueued. */
    _bargeIn() {
        this._ttsPlayQueue = Promise.resolve();
        if (this._currentTtsSource) {
            try { this._currentTtsSource.stop(); } catch {}
            this._currentTtsSource = null;
        }
        this._ttsActive = false;
        this._ttsActiveCount = 0;
        this._ttsBargedIn = true;
    }

    // --- Voice (STT) ---

    async startVoice() {
        try {
            this._mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, sampleRate: 48000, echoCancellation: true, noiseSuppression: true },
            });

            this._audioContext = new AudioContext({ sampleRate: 48000 });
            await this._audioContext.audioWorklet.addModule('static/js/recorder_worklet.js');

            const source = this._audioContext.createMediaStreamSource(this._mediaStream);
            this._workletNode = new AudioWorkletNode(this._audioContext, 'recorder-worklet');
            this._resampler = new AudioResampler(48000, 16000);

            // Initialize Silero VAD via vad-web. Runs in its own internal
            // worklet on the same MediaStream; fires onSpeechStart when
            // the user begins speaking. We only act on it during TTS
            // playback (barge-in). Globals (window.vad, window.ort) come
            // from <script> tags in index.html.
            //
            // Option names per vad-web 0.0.30 RealTimeVADOptions:
            //   baseAssetPath     — where to fetch silero_vad_*.onnx +
            //                        vad.worklet.bundle.min.js
            //   onnxWASMBasePath  — where vad-web's worklet should look
            //                        for ORT WASM glue
            //   model             — 'legacy' (v4) or 'v5'; legacy is
            //                        smaller (1.8 MB vs 2.3 MB) and
            //                        well-tested.
            // ort.env.wasm.numThreads = 1 prevents threaded WASM from
            // requiring SharedArrayBuffer (which needs COOP/COEP headers).
            try {
                if (window.vad?.MicVAD && window.ort) {
                    // ES module dynamic imports require proper specifiers
                    // (absolute URL or starting with / ./ ../). A bare
                    // path like "static/vendor/.../foo.mjs" is rejected
                    // by the browser as a "bare specifier". Build absolute
                    // URLs from window.location so the .mjs glue and the
                    // .onnx model resolve unambiguously.
                    const ortBase = new URL('static/vendor/onnxruntime-web/', window.location.href).href;
                    const vadBase = new URL('static/vendor/vad/', window.location.href).href;
                    window.ort.env.wasm.wasmPaths = ortBase;
                    window.ort.env.wasm.numThreads = 1;
                    this._vad = await window.vad.MicVAD.new({
                        stream: this._mediaStream,
                        baseAssetPath: vadBase,
                        onnxWASMBasePath: ortBase,
                        model: 'legacy',
                        // Bumped from vad-web default 0.3 to reduce
                        // speculative onSpeechStart misfires that cut TTS
                        // playback when the mic picked up TTS bleed-
                        // through or mouth/breath noise. 0.5 wasn't
                        // enough for open-speaker setups (browser AEC
                        // adapts in 100-200ms, before which TTS leaks
                        // through and crosses 0.5). 0.6 raises the bar
                        // enough to ignore most echo while still letting
                        // a real spoken interruption through.
                        positiveSpeechThreshold: 0.6,
                        onSpeechStart: () => {
                            if (this._ttsActive) this._bargeIn();
                            // Pulse the mic icon while speech is detected
                            // so the user has explicit "I hear you" feedback.
                            try { this.chatPanel?.setMicListening?.(true); } catch {}
                        },
                        onSpeechEnd: () => {
                            try { this.chatPanel?.setMicListening?.(false); } catch {}
                        },
                        onVADMisfire: () => {
                            try { this.chatPanel?.setMicListening?.(false); } catch {}
                        },
                    });
                    this._vad.start();
                } else {
                    console.warn('[ChatService] VAD globals missing; barge-in disabled');
                }
            } catch (vadErr) {
                console.warn('[ChatService] VAD init failed; barge-in disabled:', vadErr);
                this._vad = null;
            }

            // Connect STT socket
            const sttOrigin = new URL(STT_URL, window.location.origin).origin;
            this._sttSocket = io(sttOrigin, {
                path: STT_PATH,
                transports: ['websocket', 'polling'],
                forceNew: true,
                query: { client_id: this.clientId },
            });

            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('STT connection timeout')), 10000);
                this._sttSocket.once('connect', () => { clearTimeout(timeout); resolve(); });
                this._sttSocket.once('connect_error', (err) => { clearTimeout(timeout); reject(err); });
            });

            // Packetize and send audio (~100ms chunks)
            let pending = [];
            let pendingLength = 0;
            const sampleRate = this._audioContext.sampleRate;
            const samplesPerPacket = Math.round(sampleRate * 0.1);

            this._workletNode.port.onmessage = (event) => {
                const chunk = event.data;
                if (!chunk?.length) return;

                // VAD runs in vad-web's own internal worklet on the same
                // MediaStream — no per-frame work needed here. The only
                // gate this handler enforces is STT echo prevention:
                // accumulate to ~100ms packet, resample to 16k, ship to
                // STT socket — SUPPRESSED while TTS is playing so the
                // assistant's own voice (bleeding through speakers /
                // imperfect echo cancellation) can't be transcribed.
                pending.push(chunk);
                pendingLength += chunk.length;

                if (pendingLength >= samplesPerPacket) {
                    const merged = new Float32Array(pendingLength);
                    let offset = 0;
                    for (const part of pending) {
                        merged.set(part, offset);
                        offset += part.length;
                    }
                    pending = [];
                    pendingLength = 0;

                    if (this._ttsActive) {
                        // Drop the packet but still pump the resampler so
                        // its internal phase stays correct for when we
                        // resume streaming after barge-in.
                        this._resampler.pushFloat32(merged);
                        return;
                    }

                    const pcm16 = this._resampler.pushFloat32(merged);
                    if (pcm16?.length > 0 && this._sttSocket?.connected) {
                        this._sttSocket.emit('audio_data', {
                            clientId: this.clientId,
                            audioData: pcm16.buffer,
                        });
                    }
                }
            };

            source.connect(this._workletNode);
            this._workletNode.connect(this._audioContext.destination);

            // Subscribe agent_server to STT transcripts (transcriptOnly: skip LLM, just forward)
            await this.agentClient.sttSubscribe({
                sttUrl: STT_URL,
                clientId: this.clientId,
                agent: AGENT_NAME,
                threadId: this.threadId,
                transcriptOnly: true,
            });

            this.voiceActive = true;
            console.log('[ChatService] Voice active');

        } catch (err) {
            console.error('[ChatService] Voice start failed:', err);
            this.stopVoice();
        }
    }

    async stopVoice() {
        if (this._workletNode) { this._workletNode.disconnect(); this._workletNode = null; }
        if (this._audioContext) { await this._audioContext.close().catch(() => {}); this._audioContext = null; }
        if (this._mediaStream) { this._mediaStream.getTracks().forEach(t => t.stop()); this._mediaStream = null; }
        if (this._resampler) { this._resampler.reset(); this._resampler = null; }
        if (this._sttSocket) { this._sttSocket.disconnect(); this._sttSocket = null; }
        if (this._vad) {
            try { this._vad.pause(); } catch {}
            try { this._vad.destroy(); } catch {}
            this._vad = null;
        }
        if (this.agentClient && this.clientId) {
            try { await this.agentClient.sttUnsubscribe({ sttUrl: STT_URL, clientId: this.clientId }); } catch {}
        }
        this.voiceActive = false;
        console.log('[ChatService] Voice stopped');
    }

    // --- TTS ---

    async enableTTS() {
        if (this.ttsEnabled) return;
        try {
            // Create + resume the AudioContext NOW, while we're still in
            // the user-gesture stack from the TTS-toggle click. If we wait
            // for the first audio chunk to lazily create it, the gesture
            // is gone and Chrome puts the context in `suspended` state -
            // src.start() then plays into silence with no error.
            const actx = this._ensureTtsAudioContext();
            try { await actx.resume(); } catch {}

            const ttsOrigin = new URL(TTS_URL, window.location.origin).origin;
            this._ttsSocket = io(ttsOrigin, {
                path: TTS_PATH,
                transports: ['websocket', 'polling'],
                forceNew: true,
                query: { type: 'browser', format: 'binary', main_client_id: this.clientId },
            });

            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('TTS connection timeout')), 10000);
                this._ttsSocket.once('connect', () => { clearTimeout(timeout); resolve(); });
                this._ttsSocket.once('connect_error', (err) => { clearTimeout(timeout); reject(err); });
            });

            await new Promise((resolve) => {
                this._ttsSocket.emit('register_audio_client', {
                    main_client_id: this.clientId,
                    connection_type: 'browser',
                    mode: 'tts',
                }, () => resolve());
            });

            this._ttsSocket.on('tts_audio_chunk', async (evt) => {
                const buf = evt?.audio_buffer;
                if (!buf) return;
                // Stale-chunk guard: if barge-in fired and we haven't yet
                // sent a new tts_text_chunk, drop chunks still arriving
                // from the cancelled turn so they don't play after the
                // user already interrupted. Cleared in _sendVoiceToTTS.
                if (this._ttsBargedIn) return;

                const actx = this._ensureTtsAudioContext();
                let audioBuf;
                try {
                    audioBuf = await actx.decodeAudioData(buf.slice(0));
                } catch (e) {
                    console.warn('[ChatService] TTS decodeAudioData failed:', e);
                    return;
                }

                // Mark TTS active for the worklet's STT-gating logic
                // (suppress sending mic packets to STT while we're
                // playing audio — kills the echo hallucination loop).
                this._ttsActive = true;
                this._ttsActiveCount++;

                this._ttsPlayQueue = this._ttsPlayQueue.then(() => {
                    const src = actx.createBufferSource();
                    src.buffer = audioBuf;
                    src.connect(actx.destination);
                    this._currentTtsSource = src;
                    src.start();
                    return new Promise(res => {
                        src.onended = () => {
                            if (this._currentTtsSource === src) {
                                this._currentTtsSource = null;
                            }
                            this._ttsActiveCount = Math.max(0, this._ttsActiveCount - 1);
                            if (this._ttsActiveCount === 0) {
                                this._ttsActive = false;
                            }
                            res();
                        };
                    });
                });
            });

            this._ttsSocket.on('tts_stop_immediate', () => {
                // Server-initiated stop. Treat the same as a local barge-in:
                // drain the queue, hard-stop the in-flight source, mark
                // inactive. AudioContext stays open (created in the
                // user-gesture stack of the TTS toggle click; closing it
                // means future messages would need to recreate it OUTSIDE
                // any gesture, which Chrome forces into `suspended` state).
                this._bargeIn();
            });

            this.ttsEnabled = true;
            this.chatPanel.setTtsActive(true);
            console.log('[ChatService] TTS enabled');

        } catch (err) {
            console.error('[ChatService] TTS enable failed:', err);
            await this.disableTTS();
            this.chatPanel.addMessage('assistant', 'Error: Voice playback unavailable - TTS server unreachable.');
        }
    }

    async disableTTS() {
        if (this._ttsSocket) {
            try { this._ttsSocket.disconnect(); } catch {}
            this._ttsSocket = null;
        }
        this._closeTtsAudioContext();
        this.ttsEnabled = false;
        this.chatPanel.setTtsActive(false);
    }

    _ensureTtsAudioContext() {
        if (!this._ttsAudioContext) {
            this._ttsAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        }
        return this._ttsAudioContext;
    }

    _closeTtsAudioContext() {
        if (this._ttsAudioContext) {
            try { this._ttsAudioContext.close(); } catch {}
            this._ttsAudioContext = null;
        }
        this._ttsPlayQueue = Promise.resolve();
    }

    // --- Cleanup ---

    disconnect() {
        this.stopVoice();
        if (this.agentClient) {
            this.agentClient.disconnect();
            this.agentClient = null;
        }
    }

    /**
     * Show a jsPanel confirmation dialog for one or more pending write actions.
     * All changes shown in one panel. Apply/Reject applies to all.
     */
    _showBatchConfirmationPanel(actions) {
        if (!actions || !actions.length) return;

        // Use batch_id if present, otherwise first action's id
        const confirmId = actions[0].batch_id || actions[0].id;
        const notebookName = (actions[0].notebook_path || '').split('/').pop() || 'current notebook';

        const title = actions.length === 1
            ? this._getActionTitle(actions[0])
            : `${actions.length} Proposed Changes in ${notebookName}`;

        // Build combined diff for all actions
        let diffHtml = '';
        for (let i = 0; i < actions.length; i++) {
            const action = actions[i];
            if (actions.length > 1) {
                diffHtml += `<div style="padding:6px 8px;background:#f5f5f5;border-bottom:1px solid #e0e0e0;font-weight:600;font-size:11px;color:#555">${i + 1}. ${this._getActionTitle(action)}</div>`;
            }
            if (action.args.description) {
                diffHtml += `<div style="padding:4px 8px;font-size:10px;color:#777;border-bottom:1px solid #eee">${this._escapeHtml(action.args.description)}</div>`;
            }
            const hasCurrentContent = action.current_content != null;
            const isUpdateWithDiff = (action.tool === 'update_cell' || action.tool === 'update_file') && hasCurrentContent;
            if (isUpdateWithDiff) {
                diffHtml += this._buildDiffHtml(action.current_content, action.args.new_content);
            } else {
                const content = action.args.new_content || action.args.content || '';
                const cleanContent = content.replace(/\\n/g, '\n');
                const label = action.tool === 'create_file' ? `New File` :
                              action.tool === 'update_file' ? `Updated File` :
                              `New Cell (${action.args.cell_type || 'code'})`;
                const lines = cleanContent.split('\n');
                const numStyle = 'padding:2px 4px;color:#999;text-align:right;font-size:10px;border-bottom:1px solid #eee;border-right:1px solid #e0e0e0;min-width:24px;user-select:none';
                const cellStyle = 'padding:2px 6px;white-space:pre;overflow-x:auto;font-size:11px;border-bottom:1px solid #eee;background:#e8f5e9';
                let tableHtml = `<table style="width:100%;border-collapse:collapse"><colgroup><col style="width:28px"><col></colgroup>
                    <thead><tr><th colspan="2" style="padding:4px 6px;background:#e8f5e9;color:#1b5e20;font-size:10px;font-weight:600;text-align:left">${label}</th></tr></thead><tbody>`;
                for (let j = 0; j < lines.length; j++) {
                    tableHtml += `<tr><td style="${numStyle}">${j + 1}</td><td style="${cellStyle}">${this._escapeHtml(lines[j]) || '&nbsp;'}</td></tr>`;
                }
                tableHtml += '</tbody></table>';
                diffHtml += tableHtml;
            }
            if (i < actions.length - 1) {
                diffHtml += '<div style="height:8px;background:#f0f0f0"></div>';
            }
        }

        const panel = jsPanel.create({
            headerTitle: `<i class="fa-solid fa-pen-to-square" style="margin-right:6px;font-size:11px"></i>${title}`,
            theme: '#ffe39e filled',
            borderRadius: '5px',
            contentSize: { width: Math.min(650, window.innerWidth - 80), height: Math.min(500, window.innerHeight - 100) },
            position: 'center',
            headerControls: 'closeonly',
            content: `
                <div style="height:100%;display:flex;flex-direction:column;font-size:12px">
                    <div style="flex:1;overflow:auto">
                        ${diffHtml}
                    </div>
                    <div style="padding:6px 12px;border-top:1px solid #e0e0e0;background:#fafafa">
                        <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
                            <input class="confirm-feedback-input" type="text" placeholder="Optional message to the assistant..." style="flex:1;padding:4px 8px;font-size:11px;border:1px solid #ddd;border-radius:3px;font-family:var(--font-sans);outline:none">
                        </div>
                        <div style="display:flex;gap:8px;justify-content:flex-end">
                            <button class="confirm-reject-btn" style="padding:4px 16px;font-size:12px;border:1px solid #e57373;border-radius:4px;background:#fff;color:#c62828;cursor:pointer">Reject</button>
                            <button class="confirm-apply-btn" style="padding:4px 16px;font-size:12px;border:1px solid #66bb6a;border-radius:4px;background:#e8f5e9;color:#2e7d32;cursor:pointer;font-weight:600">Apply All</button>
                        </div>
                    </div>
                </div>
            `,
            callback: (p) => {
                p.content.style.backgroundColor = '#fff';
                const applyBtn = p.content.querySelector('.confirm-apply-btn');
                const rejectBtn = p.content.querySelector('.confirm-reject-btn');
                const feedbackInput = p.content.querySelector('.confirm-feedback-input');

                applyBtn.addEventListener('click', () => {
                    applyBtn.disabled = true;
                    rejectBtn.disabled = true;
                    applyBtn.textContent = 'Applying...';
                    const feedback = feedbackInput.value.trim();
                    if (feedback) this.chatPanel.addMessage('user', feedback);
                    for (const action of actions) {
                        if (this._onWriteAction) this._onWriteAction(action);
                    }
                    this._sendConfirmation(confirmId, true, feedback);
                    p.close();
                });

                rejectBtn.addEventListener('click', () => {
                    applyBtn.disabled = true;
                    rejectBtn.disabled = true;
                    const feedback = feedbackInput.value.trim();
                    if (feedback) this.chatPanel.addMessage('user', feedback);
                    this._sendConfirmation(confirmId, false, feedback);
                    p.close();
                });

                // Allow Enter key to apply
                feedbackInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') { applyBtn.click(); }
                });
            },
        });
    }

    _getActionTitle(action) {
        if (action.tool === 'update_file') {
            const fileName = (action.file_path || action.args.file_path || '').split('/').pop() || 'file';
            return `Update ${fileName}`;
        }
        if (action.tool === 'create_file') {
            const filePath = action.args.file_path || 'new file';
            return `Create ${filePath}`;
        }
        const isUpdate = action.tool === 'update_cell';
        const cellIndex = isUpdate ? action.args.cell_index : action.args.after_cell_index;
        const cellType = action.cell_type || action.args.cell_type || 'code';
        const notebookName = (action.notebook_path || '').split('/').pop() || 'current notebook';
        return isUpdate
            ? `Update Cell ${cellIndex} in ${notebookName}`
            : `Insert ${cellType} Cell after Cell ${cellIndex} in ${notebookName}`;
    }

    /**
     * Show a jsPanel confirmation dialog for a pending write action (legacy single-action).
     * On Apply/Reject, sends POST /api/llm/confirm and streams the follow-up.
     */
    _showConfirmationPanel(action) {
        this._showBatchConfirmationPanel([action]);
        return;
        const isUpdate = action.tool === 'update_cell';
        const cellIndex = isUpdate ? action.args.cell_index : action.args.after_cell_index;
        const cellType = action.cell_type || action.args.cell_type || 'code';
        const description = action.args.description || '';
        const notebookName = (action.notebook_path || '').split('/').pop() || 'current notebook';

        const title = isUpdate
            ? `Proposed Change - Cell ${cellIndex} in ${notebookName}`
            : `Insert ${cellType} Cell after Cell ${cellIndex} in ${notebookName}`;

        // Build diff content
        let diffHtml = '';
        if (isUpdate && action.current_content != null) {
            diffHtml = this._buildDiffHtml(action.current_content, action.args.new_content);
        } else {
            // Insert: show new content with line numbers
            const content = action.args.new_content || action.args.content || '';
            // Replace literal \n with actual newlines (in case LLM sent escaped)
            const cleanContent = content.replace(/\\n/g, '\n');
            const lines = cleanContent.split('\n');
            const numStyle = 'padding:2px 4px;color:#999;text-align:right;font-size:10px;border-bottom:1px solid #eee;border-right:1px solid #e0e0e0;min-width:24px;user-select:none';
            const cellStyle = 'padding:2px 6px;white-space:pre;overflow-x:auto;font-size:11px;border-bottom:1px solid #eee;background:#e8f5e9';
            let tableHtml = `<table style="width:100%;border-collapse:collapse"><colgroup><col style="width:28px"><col></colgroup>
                <thead><tr><th colspan="2" style="padding:4px 6px;background:#e8f5e9;color:#1b5e20;font-size:10px;font-weight:600;text-align:left">New Cell (${cellType})</th></tr></thead><tbody>`;
            for (let i = 0; i < lines.length; i++) {
                tableHtml += `<tr><td style="${numStyle}">${i + 1}</td><td style="${cellStyle}">${this._escapeHtml(lines[i]) || '&nbsp;'}</td></tr>`;
            }
            tableHtml += '</tbody></table>';
            diffHtml = tableHtml;
        }

        const panel = jsPanel.create({
            headerTitle: `<i class="fa-solid fa-pen-to-square" style="margin-right:6px;font-size:11px"></i>${title}`,
            theme: '#ffe39e filled',
            borderRadius: '5px',
            contentSize: { width: Math.min(600, window.innerWidth - 80), height: Math.min(450, window.innerHeight - 100) },
            position: 'center',
            headerControls: 'closeonly',
            content: `
                <div style="height:100%;display:flex;flex-direction:column;font-size:12px">
                    <div style="padding:8px 12px;background:#f9f9f9;border-bottom:1px solid #e0e0e0;color:#555;font-size:11px">
                        ${this._escapeHtml(description)}
                    </div>
                    <div style="flex:1;overflow:auto;padding:8px 12px;font-family:var(--font-mono);font-size:11px;line-height:1.5">
                        ${diffHtml}
                    </div>
                    <div style="display:flex;gap:8px;justify-content:flex-end;padding:8px 12px;border-top:1px solid #e0e0e0;background:#fafafa">
                        <button class="confirm-reject-btn" style="padding:4px 16px;font-size:12px;border:1px solid #e57373;border-radius:4px;background:#fff;color:#c62828;cursor:pointer">Reject</button>
                        <button class="confirm-apply-btn" style="padding:4px 16px;font-size:12px;border:1px solid #66bb6a;border-radius:4px;background:#e8f5e9;color:#2e7d32;cursor:pointer;font-weight:600">Apply</button>
                    </div>
                </div>
            `,
            callback: (p) => {
                p.content.style.backgroundColor = '#fff';
                const applyBtn = p.content.querySelector('.confirm-apply-btn');
                const rejectBtn = p.content.querySelector('.confirm-reject-btn');

                applyBtn.addEventListener('click', () => {
                    applyBtn.disabled = true;
                    rejectBtn.disabled = true;
                    applyBtn.textContent = 'Applying...';
                    // Apply the change in the editor first
                    if (this._onWriteAction) {
                        this._onWriteAction(action);
                    }
                    this._sendConfirmation(action.id, true);
                    p.close();
                });

                rejectBtn.addEventListener('click', () => {
                    applyBtn.disabled = true;
                    rejectBtn.disabled = true;
                    this._sendConfirmation(action.id, false);
                    p.close();
                });
            },
        });
    }

    /**
     * Send confirmation to backend and stream the follow-up response.
     */
    async _sendConfirmation(actionId, approved, feedback = '') {
        try {
            const resp = await fetch('api/llm/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action_id: actionId, approved, feedback: feedback || undefined }),
            });

            if (!resp.ok) throw new Error(`Confirm failed: ${resp.status}`);

            // Stream the follow-up response
            this.chatPanel.startStreamingMessage();
            if (approved) {
                this.chatPanel.appendToken('*Change applied.* ');
            } else {
                this.chatPanel.appendToken('*Change rejected.* ');
            }

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            const parser = new ThinkingParser();
            let thinkingContent = '';
            let fullAnswer = '';
            // Voice-first: dispatch TTS the moment the parser surfaces the
            // <voice> block (mid-stream), not at end-of-stream. See the
            // primary consumer in _sendWithContext for full rationale.
            let voiceDispatched = false;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const text = decoder.decode(value, { stream: true });
                for (const line of text.split('\n')) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data: ')) continue;
                    if (trimmed === 'data: [DONE]') continue;

                    let data;
                    try { data = JSON.parse(trimmed.slice(6)); } catch { continue; }
                    if (data.error) break;
                    if (data.usage) {
                        this.chatPanel.updateTokenUsage(data.usage);
                        continue;
                    }

                    // Chained write tool(s) - just open the confirmation panel.
                    // Tool badges no longer render in the chat (moved to Debug panel).
                    if (data.pending_actions) {
                        this.chatPanel.finalizeStreamingMessage(thinkingContent);
                        this._showBatchConfirmationPanel(data.pending_actions);
                        return;
                    }
                    if (data.pending_action) {
                        this.chatPanel.finalizeStreamingMessage(thinkingContent);
                        this._showBatchConfirmationPanel([data.pending_action]);
                        return;
                    }

                    if (!data.token) continue;
                    const result = parser.processToken(data.token);
                    switch (result.type) {
                        case 'thinking_start':
                            // Hide the typing dots; the live reasoning panel
                            // takes over as the visual indicator.
                            this.chatPanel.setLoading(false);
                            this.chatPanel.startLiveThinkingSection();
                            // Same fix as the primary consumer: flush the
                            // initial slice that arrived in the same chunk
                            // as the <think> tag so it's not lost from the
                            // live display.
                            if (parser.thinkingBuffer) {
                                this.chatPanel.appendLiveThinkingToken(parser.thinkingBuffer);
                            }
                            break;
                        case 'thinking_token':
                            this.chatPanel.appendLiveThinkingToken(result.token);
                            break;
                        case 'thinking_end':
                            this.chatPanel.setThinkingIndicator(false);
                            this.chatPanel.setLiveThinkingContent(result.thinking);
                            this.chatPanel.endLiveThinkingSection();
                            thinkingContent = result.thinking;
                            if (result.answer) {
                                fullAnswer += result.answer;
                                this.chatPanel.appendToken(result.answer);
                            }
                            if (!voiceDispatched && this.ttsEnabled && parser.voiceText) {
                                this._sendVoiceToTTS(parser.voiceText);
                                voiceDispatched = true;
                            }
                            break;
                        case 'voice':
                            if (!voiceDispatched && this.ttsEnabled && parser.voiceText) {
                                this._sendVoiceToTTS(parser.voiceText);
                                voiceDispatched = true;
                            }
                            break;
                        case 'answer_token':
                            // First answer token marks "real content arriving" -
                            // hide the typing dots if they're still up (e.g. when
                            // the model didn't emit a <think> block).
                            this.chatPanel.setLoading(false);
                            fullAnswer += result.token;
                            this.chatPanel.appendToken(result.token);
                            break;
                    }
                    // Defensive backstop — see _sendWithContext for rationale.
                    if (!voiceDispatched && this.ttsEnabled && parser.voiceText) {
                        this._sendVoiceToTTS(parser.voiceText);
                        voiceDispatched = true;
                    }
                }
            }
            this.chatPanel.finalizeStreamingMessage(thinkingContent);
            if (voiceDispatched) {
                // Already speaking — nothing to do.
            } else if (this.ttsEnabled && parser.voiceText) {
                this._sendVoiceToTTS(parser.voiceText);
            } else if (this.ttsEnabled && fullAnswer) {
                this._voiceFallback(fullAnswer);
            }

        } catch (err) {
            console.error('[ChatService] Confirmation error:', err);
            this.chatPanel.appendToken(`\n\nError: ${err.message}`);
            this.chatPanel.finalizeStreamingMessage();
        }
    }

    /**
     * Build a side-by-side diff HTML view.
     */
    _buildDiffHtml(oldText, newText) {
        // Normalize escaped newlines to actual newlines
        const oldLines = (oldText || '').replace(/\\n/g, '\n').split('\n');
        const newLines = (newText || '').replace(/\\n/g, '\n').split('\n');

        // Simple LCS-based diff to pair lines
        const pairs = this._diffLines(oldLines, newLines);

        const cellStyle = 'padding:2px 6px;white-space:pre;overflow-x:auto;font-size:11px;border-bottom:1px solid #eee;vertical-align:top';
        const numStyle = 'padding:2px 4px;color:#999;text-align:right;font-size:10px;border-bottom:1px solid #eee;border-right:1px solid #e0e0e0;min-width:24px;user-select:none';

        let html = `<table style="width:100%;border-collapse:collapse;table-layout:fixed">
            <colgroup><col style="width:28px"><col style="width:calc(50% - 28px)"><col style="width:28px"><col style="width:calc(50% - 28px)"></colgroup>
            <thead><tr>
                <th colspan="2" style="padding:4px 34px;background:#fce4ec;color:#b71c1c;font-size:10px;font-weight:600;text-align:left">Current</th>
                <th colspan="2" style="padding:4px 34px;background:#e8f5e9;color:#1b5e20;font-size:10px;font-weight:600;text-align:left">Proposed</th>
            </tr></thead><tbody>`;

        for (const [oldIdx, oldLine, newIdx, newLine, status] of pairs) {
            const leftNum = oldIdx != null ? oldIdx + 1 : '';
            const rightNum = newIdx != null ? newIdx + 1 : '';
            const leftText = oldLine != null ? this._escapeHtml(oldLine) : '';
            const rightText = newLine != null ? this._escapeHtml(newLine) : '';

            let leftBg = '', rightBg = '';
            if (status === 'removed') {
                leftBg = 'background:#fce4ec';
            } else if (status === 'added') {
                rightBg = 'background:#e8f5e9';
            } else if (status === 'changed') {
                leftBg = 'background:#fce4ec';
                rightBg = 'background:#e8f5e9';
            }

            html += `<tr>
                <td style="${numStyle};${leftBg}">${leftNum}</td>
                <td style="${cellStyle};${leftBg}">${leftText || '&nbsp;'}</td>
                <td style="${numStyle};${rightBg}">${rightNum}</td>
                <td style="${cellStyle};${rightBg}">${rightText || '&nbsp;'}</td>
            </tr>`;
        }

        html += '</tbody></table>';
        return html;
    }

    /**
     * Simple line diff producing pairs: [oldIdx, oldLine, newIdx, newLine, status]
     * status: 'equal', 'removed', 'added', 'changed'
     */
    _diffLines(oldLines, newLines) {
        const pairs = [];
        let oi = 0, ni = 0;

        while (oi < oldLines.length || ni < newLines.length) {
            if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
                pairs.push([oi, oldLines[oi], ni, newLines[ni], 'equal']);
                oi++; ni++;
            } else {
                // Look ahead to find next matching line
                let foundOld = -1, foundNew = -1;
                for (let look = 1; look < 10; look++) {
                    if (foundNew < 0 && ni + look < newLines.length && oi < oldLines.length && oldLines[oi] === newLines[ni + look]) {
                        foundNew = ni + look;
                    }
                    if (foundOld < 0 && oi + look < oldLines.length && ni < newLines.length && oldLines[oi + look] === newLines[ni]) {
                        foundOld = oi + look;
                    }
                }

                if (foundOld >= 0 && (foundNew < 0 || (foundOld - oi) <= (foundNew - ni))) {
                    // Lines were removed from old
                    while (oi < foundOld) {
                        pairs.push([oi, oldLines[oi], null, null, 'removed']);
                        oi++;
                    }
                } else if (foundNew >= 0) {
                    // Lines were added in new
                    while (ni < foundNew) {
                        pairs.push([null, null, ni, newLines[ni], 'added']);
                        ni++;
                    }
                } else {
                    // Lines changed
                    if (oi < oldLines.length && ni < newLines.length) {
                        pairs.push([oi, oldLines[oi], ni, newLines[ni], 'changed']);
                        oi++; ni++;
                    } else if (oi < oldLines.length) {
                        pairs.push([oi, oldLines[oi], null, null, 'removed']);
                        oi++;
                    } else {
                        pairs.push([null, null, ni, newLines[ni], 'added']);
                        ni++;
                    }
                }
            }
        }
        return pairs;
    }

    _escapeHtml(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
}

/**
 * ThinkingParser - State machine for parsing <think>...</think> blocks
 * from Qwen 3's streaming output.
 *
 * Buffers thinking tokens separately so the UI can show a "Reasoning..."
 * indicator instead of raw <think> content.
 */
class ThinkingParser {
    constructor() {
        this._inThinking = false;
        this._inToolCall = false;
        this._inVoice = false;
        this._voiceBuffer = '';
        this._buffer = '';       // Accumulates partial tags at chunk boundaries
        this.thinkingBuffer = '';
        this.voiceText = '';     // Collected <voice>...</voice> text
    }

    /** Pull `<voice>...</voice>` out of a same-chunk post-</think> answer.
     *  Sets this.voiceText (preserving any prior content via append) and
     *  returns the cleaned answer with the voice block removed. Without this,
     *  responses that arrive as one big token (think + answer + voice all
     *  together) leak the voice text into the visible chat AND leave
     *  voiceText empty so TTS never fires.
     *
     *  Voice-first added a new edge case: with the model emitting <voice>
     *  immediately after </think>, the chunk that closes thinking often
     *  contains the OPENER but not the CLOSER (e.g. "</think><voice>partial
     *  spoken te"). The simple regex-or-nothing path used to leak that
     *  partial as literal chat text and never set voiceText. Now we also
     *  detect the unclosed opener, enter `_inVoice` so the streaming
     *  state machine catches the </voice> in the next chunk, and stash
     *  the post-opener content in _voiceBuffer. */
    _extractVoiceFromAnswer(answer) {
        if (!answer) return answer;
        let cleaned = answer;

        // 1. Complete <voice>...</voice> block — extract.
        const m = cleaned.match(/<voice>([\s\S]*?)<\/voice>/);
        if (m) {
            this.voiceText = (this.voiceText ? this.voiceText + ' ' : '') + m[1].trim();
            cleaned = (cleaned.slice(0, m.index) + cleaned.slice(m.index + m[0].length)).trim();
            console.info(`[parser] _extract: voice block extracted, voiceText_len=${this.voiceText.length}`);
        } else {
            // 2. Complete <voice> opener but no closer in this chunk —
            //    enter voice mode so the streaming state machine catches
            //    the </voice> in the next chunk.
            const voiceOpenIdx = cleaned.indexOf('<voice>');
            if (voiceOpenIdx >= 0) {
                this._inVoice = true;
                this._voiceBuffer = cleaned.slice(voiceOpenIdx + '<voice>'.length);
                cleaned = cleaned.slice(0, voiceOpenIdx).trim();
                console.info(`[parser] _extract: <voice> opener (no closer), entered voice mode, voiceBuffer_len=${this._voiceBuffer.length}`);
            } else {
                // 3. Partial <voice> opener at end of input (chunk boundary
                //    cut the tag) — push back into _buffer so the next
                //    processToken assembles the complete tag.
                const partialVoice = cleaned.match(/<v(?:o(?:i(?:c(?:e)?)?)?)?$/);
                if (partialVoice) {
                    this._buffer = (this._buffer || '') + partialVoice[0];
                    cleaned = cleaned.slice(0, partialVoice.index).trim();
                    console.info(`[parser] _extract: partial <voice> opener stashed: ${JSON.stringify(partialVoice[0])}`);
                }
            }
        }

        // 4. <tool_call> opener (full or partial) — same pattern. Push
        //    back into _buffer so the state machine's <tool_call> handler
        //    catches it and emits a 'tool_call' event with parsed JSON.
        //    Without this, <tool_call>...</tool_call> leaks into chat as
        //    text (browsers render <tool_call> as a transparent unknown
        //    inline element, so the JSON content shows through).
        const toolIdx = cleaned.indexOf('<tool_call>');
        if (toolIdx >= 0) {
            this._buffer = (this._buffer || '') + cleaned.slice(toolIdx);
            cleaned = cleaned.slice(0, toolIdx).trim();
            console.info(`[parser] _extract: <tool_call> opener stashed to _buffer (len=${this._buffer.length})`);
        } else {
            const partialTool = cleaned.match(/<t(?:o(?:o(?:l(?:_(?:c(?:a(?:l(?:l)?)?)?)?)?)?)?)?$/);
            if (partialTool) {
                this._buffer = (this._buffer || '') + partialTool[0];
                cleaned = cleaned.slice(0, partialTool.index).trim();
                console.info(`[parser] _extract: partial <tool_call> opener stashed: ${JSON.stringify(partialTool[0])}`);
            }
        }

        // 5. Bare `<` at the end of input — a chunk boundary cut a tag at
        //    its very first character (e.g. "</think><" with the rest of
        //    the tag arriving in the next chunk). The partial regexes
        //    above need at least the second character (`<v`, `<t`); a
        //    bare `<` matches none. Without deferring it, the `<` leaks
        //    as text AND the subsequent chunk's content (`tool_call>...`)
        //    arrives without the leading `<`, so the state machine's
        //    opener check (`buffer.includes('<voice>')` etc.) never
        //    fires and the entire tag content leaks into chat.
        if (cleaned.endsWith('<')) {
            this._buffer = (this._buffer || '') + '<';
            cleaned = cleaned.slice(0, -1).trim();
            console.info(`[parser] _extract: bare '<' stashed to _buffer`);
        }

        return cleaned;
    }

    processToken(token) {
        // Accumulate into buffer to handle tags split across chunks
        this._buffer += token;

        // Check for <think> opening
        if (!this._inThinking && !this._inToolCall && this._buffer.includes('<think>')) {
            this._inThinking = true;
            const after = this._buffer.split('<think>').pop();
            this._buffer = '';
            this.thinkingBuffer = '';
            // If </think> is already in the remainder (same chunk), handle it immediately
            if (after.includes('</think>')) {
                this._inThinking = false;
                const parts = after.split('</think>');
                this.thinkingBuffer = parts[0];
                const answer = this._extractVoiceFromAnswer(parts.slice(1).join('</think>').trimStart());
                return { type: 'thinking_end', thinking: this.thinkingBuffer, answer };
            }
            this.thinkingBuffer = after;
            return { type: 'thinking_start' };
        }

        // Check for </think> closing
        if (this._inThinking && this._buffer.includes('</think>')) {
            this._inThinking = false;
            const parts = this._buffer.split('</think>');
            this.thinkingBuffer += parts[0];
            // Reset _buffer BEFORE _extractVoiceFromAnswer so that if it
            // detects a partial <voice> opener at the end of input and
            // stashes it back into _buffer, the stash isn't immediately
            // wiped. The same-chunk path above already resets _buffer
            // before its _extract call.
            this._buffer = '';
            const answer = this._extractVoiceFromAnswer(parts.slice(1).join('</think>').trimStart());
            return { type: 'thinking_end', thinking: this.thinkingBuffer, answer };
        }

        // Check for <tool_call> opening
        if (!this._inToolCall && !this._inThinking && this._buffer.includes('<tool_call>')) {
            this._inToolCall = true;
            this._toolCallBuffer = '';
            const before = this._buffer.split('<tool_call>')[0];
            this._buffer = '';
            if (before.trim()) return { type: 'answer_token', token: before };
            return { type: 'pending' };
        }

        // Check for </tool_call> closing - emit tool_call event with parsed details
        if (this._inToolCall && this._buffer.includes('</tool_call>')) {
            this._inToolCall = false;
            const content = this._buffer.split('</tool_call>')[0];
            this._toolCallBuffer += content;
            const after = this._buffer.split('</tool_call>').slice(1).join('</tool_call>');
            this._buffer = after || '';
            let toolInfo = this._toolCallBuffer.trim();
            try { toolInfo = JSON.parse(toolInfo); } catch { toolInfo = { raw: toolInfo }; }
            this._toolCallBuffer = '';
            return { type: 'tool_call', tool: toolInfo };
        }

        // Check for <voice> opening
        if (!this._inVoice && !this._inThinking && !this._inToolCall && this._buffer.includes('<voice>')) {
            this._inVoice = true;
            const before = this._buffer.split('<voice>')[0];
            const after = this._buffer.split('<voice>').slice(1).join('<voice>');
            this._voiceBuffer = after; // preserve content that arrived after <voice> in same chunk
            this._buffer = '';
            // Handle same-chunk open+close
            if (after.includes('</voice>')) {
                this._inVoice = false;
                const parts = after.split('</voice>');
                this.voiceText = parts[0].trim();
                this._voiceBuffer = '';
                this._buffer = parts.slice(1).join('</voice>');
                if (before.trim()) return { type: 'answer_token', token: before };
                return { type: 'voice', text: this.voiceText };
            }
            if (before.trim()) return { type: 'answer_token', token: before };
            return { type: 'pending' };
        }

        // Check for </voice> closing
        if (this._inVoice && this._buffer.includes('</voice>')) {
            this._inVoice = false;
            const content = this._buffer.split('</voice>')[0];
            this._voiceBuffer += content;
            this.voiceText = this._voiceBuffer.trim();
            const after = this._buffer.split('</voice>').slice(1).join('</voice>');
            this._buffer = after || '';
            return { type: 'voice', text: this.voiceText };
        }

        // Partial tag at boundary - wait for more data
        if (!this._inThinking && !this._inToolCall && !this._inVoice && this._buffer.endsWith('<')) return { type: 'pending' };
        if (!this._inThinking && !this._inToolCall && !this._inVoice && /<t(?:h(?:i(?:n(?:k)?)?)?)?$/.test(this._buffer)) return { type: 'pending' };
        if (!this._inThinking && !this._inToolCall && !this._inVoice && /<t(?:o(?:o(?:l(?:_(?:c(?:a(?:l(?:l)?)?)?)?)?)?)?)?$/.test(this._buffer)) return { type: 'pending' };
        if (!this._inThinking && !this._inToolCall && !this._inVoice && /<v(?:o(?:i(?:c(?:e)?)?)?)?$/.test(this._buffer)) return { type: 'pending' };
        if (this._inThinking && /<\/(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/.test(this._buffer)) return { type: 'pending' };
        if (this._inToolCall && /<\/(?:t(?:o(?:o(?:l(?:_(?:c(?:a(?:l(?:l)?)?)?)?)?)?)?)?)?$/.test(this._buffer)) return { type: 'pending' };
        if (this._inVoice && /<\/(?:v(?:o(?:i(?:c(?:e)?)?)?)?)?$/.test(this._buffer)) return { type: 'pending' };

        // Normal token flow
        const content = this._buffer;
        this._buffer = '';

        if (this._inThinking) {
            this.thinkingBuffer += content;
            return { type: 'thinking_token', token: content };
        }
        if (this._inToolCall) {
            this._toolCallBuffer += content;
            return { type: 'pending' };
        }
        if (this._inVoice) {
            this._voiceBuffer += content;
            return { type: 'pending' };
        }
        return { type: 'answer_token', token: content };
    }
}
