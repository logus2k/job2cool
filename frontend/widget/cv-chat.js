/* cv-chat.js - Conversational CV chat widget.
 *
 * A self-contained, dependency-light floating chat widget for the static CV
 * page. It is injected by build.py (two <script> tags + one <link>) and
 * builds its own DOM on load. It is a thin client of:
 *   - cv-backend   POST /cv/api/chat        (SSE stream of the cited answer)
 *                  GET  /cv/api/citation/.. (resolve a clicked citation)
 *   - stt_server   Socket.IO /stt/socket.io (speech -> text)
 *   - tts_server   Socket.IO /tts/socket.io (text -> spoken audio)
 *
 * The only third-party code is the vendored socket.io client. Markdown and
 * citation rendering are implemented here. See
 * ~/env/assets/cv/documents/plans/conversational_cv.md.
 */
(function () {
    'use strict';

    // ---- configuration ----------------------------------------------------
    var API = 'api';                       // relative to /cv/  -> /cv/api/...
    var ORIGIN = window.location.origin;
    var STT_PATH = '/stt/socket.io';
    var TTS_PATH = '/tts/socket.io';
    var AVATAR_PATH = '/avatar/socket.io';
    // Try codecs in order - the avatar server may encode at different H.264
    // profiles depending on the active face/voice. Mirrors the reference
    // implementation in avatar_server/browser/script_v3.js.
    // Main 3.0 first because ffmpeg encodes with `-profile:v main` on the
    // server. Declaring Baseline (the old default) lied about the stream and
    // Safari/iOS rejected the decode. Other browsers tolerated it.
    var AVATAR_CODECS = [
        'video/mp4; codecs="avc1.4D401E,mp4a.40.2"',
        'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
        'video/mp4; codecs="avc1.42C01E,mp4a.40.2"',
        'video/mp4; codecs="avc1.4D401E"',
        'video/mp4; codecs="avc1.42E01E"',
        'video/mp4; codecs="avc1.42C01E"'
    ];
    var AVATAR_BUFFER_MIN_S = 0.15;         // buffer headroom before play()
                                            // Was 1.0 → 0.3 → 0.15. Pairs with
                                            // server GOP=5 so first fragment
                                            // alone is enough to start playback.
                                            // Higher = safer against early stall;
                                            // lower = faster perceived response.
    var PACKET_SECONDS = 0.1;              // ~100 ms STT audio packets
    var SOCKET_TIMEOUT = 8000;             // socket.io's own connect timeout
    var TTS_SPEED = 1.1;

    // ---- TTS voice (Kokoro multilingual) - mirrors noted ------------------
    // Default af_heart (American English, female - same as noted's
    // default); the spoken voice auto-switches to match the detected
    // language of each answer (see detectKokoroLanguage below).
    var TTS_LANGUAGE_VOICE_MAP = {
        a: 'af_heart',     // American English
        b: 'bf_emma',      // British English
        j: 'jf_alpha',     // Japanese
        z: 'zf_xiaoxiao',  // Mandarin Chinese
        e: 'ef_dora',      // Spanish
        f: 'ff_siwis',     // French
        h: 'hf_alpha',     // Hindi
        i: 'if_sara',      // Italian
        p: 'pf_dora'       // Brazilian Portuguese
    };
    var TTS_DEFAULT_VOICE = TTS_LANGUAGE_VOICE_MAP.a;

    var clientId = 'cvchat-' + (
        (window.crypto && crypto.randomUUID)
            ? crypto.randomUUID()
            : Date.now().toString(36) + Math.random().toString(36).slice(2)
    );

    // ---- inline SVG icons -------------------------------------------------
    var ICON = {
        chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"/></svg>',
        close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
        send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
        mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v4M8 23h8"/></svg>',
        speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"/></svg>',
        avatarFace: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2"/></svg>',
        // Dock/undock toggle (shown inside the avatar stage). Two glyphs
        // sized + shaped to match the close X's visual weight:
        // - dock:    diagonal arrow pointing IN  (↙) -> shown when undocked
        //            (clicking it docks the avatar back into the latest bubble)
        // - undock:  diagonal arrow pointing OUT (↗) -> shown when docked
        //            (clicking it pops the avatar out into the floating panel)
        dock:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M20 4L10 14"/><path d="M10 8v6h6"/></svg>',
        undock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20L14 10"/><path d="M14 16v-6H8"/></svg>'
    };
    var CLOSE_BTN = '<button class="cvchat-popover-close" type="button" aria-label="Close">×</button>';

    // ---- module state ----------------------------------------------------
    var root, panel, launcher, messagesEl, popover, input, sendBtn, micBtn, speakerBtn,
        avatarBtn, avatarPanel, avatarVideo, avatarStatus, avatarStage, avatarDockBtn,
        avatarCloseBtn;

    var state = {
        greeted: false,
        streaming: false,
        sttOn: false,
        ttsOn: false,
        ttsPlaying: false,
        avatarOn: false,
        // Avatar dock state. Default = docked (inside the latest assistant
        // bubble). Undocked = floating jsPanel. Session-only - not
        // persisted to localStorage.
        avatarDocked: true,
        history: [],           // [{role, content}] - prior turns, no evidence
        // Per-turn scoreData objects pushed into this array as turns
        // complete. The Score body reads from it to compute session-
        // wide running averages alongside the current turn's metrics.
        // Each entry is a live reference - judge callbacks mutate the
        // same object, so the averages stay accurate as RAGAS scores
        // land asynchronously.
        scoreHistory: []
    };
    var stt = { socket: null, ctx: null, node: null, source: null, stream: null,
                resampler: null, vad: null,
                // VAD-gated streaming. `speaking` gates the audio_data emit so
                // the server receives discrete utterances (each ending in real
                // trailing silence) instead of a never-ending stream that pins
                // its rolling buffer at the 30s cap. Defaults true so that if
                // the client VAD fails to load, behaviour degrades to the old
                // continuous stream rather than going mute. `preRoll` retains a
                // few packets of pre-speech audio so word onsets (captured just
                // before the VAD fires) aren't clipped; `postRollTimer` keeps
                // streaming briefly after onSpeechEnd to give the server its
                // trailing silence. `sending` tracks the rising edge so the
                // pre-roll is flushed exactly once per utterance.
                speaking: true, sending: false,
                preRoll: [], preRollMax: 3, postRollTimer: null };
    var tts = { socket: null, ctx: null, queue: null, current: null,
                activeCount: 0, bargedIn: false, currentVoice: null };
    var avatar = { socket: null, ms: null, sb: null, pendingInit: null,
                   queue: Promise.resolve(), chunkCount: 0, statusHideTimer: null,
                   codec: null, started: false,
                   firstChunkAt: 0, cumDuration: 0, lastChunkAt: 0,
                   syncTimer: null, idleTimer: null, keysSeen: false,
                   // Per-utterance drift tracking: an "utterance" starts at
                   // the first chunk after an idle period and ends when
                   // idle is detected again.
                   uttIndex: 0, uttFirstChunkAt: 0, uttFirstChunkN: 0,
                   uttCumDuration: 0,
                   prevBufferedEnd: 0,
                   prevRangeCount: 1,
                   // True once the avatar server has registered itself with
                   // the TTS server as an audio consumer for our client_id.
                   // Until this is true, any tts_text_chunk sent by the
                   // widget goes nowhere (only the browser is registered,
                   // mode=avatar_only filters it out). pendingTtsReady is
                   // the resolver of a Promise that the waitForTtsReady()
                   // helper uses to block setMode('avatar') from returning
                   // before the bridge is up.
                   ttsReady: false, pendingTtsReady: null,
                   // iOS 17+ ManagedMediaSource memory-pressure handling.
                   streamingPaused: false, pendingFeeds: [],
                   // Dock-mode bookkeeping (session-only, never persisted).
                   // lastUndockedPos: {left, top, width, height} from the
                   //   most recent user drag/resize of the floating panel.
                   //   Used to restore the panel's position when the user
                   //   undocks again later in the same session.
                   // dragged: false until the user has manually moved or
                   //   resized the floating panel for the first time this
                   //   session. Currently informational - the placement
                   //   logic in computeUndockedPlacement just keys off
                   //   lastUndockedPos directly.
                   // suppressOnClose: set briefly while we close the
                   //   floating panel during a dock transition - prevents
                   //   the jsPanel onclosed handler from dropping avatar
                   //   mode back to silent.
                   lastUndockedPos: null, dragged: false,
                   suppressOnClose: false };

    // ======================================================================
    // AudioResampler - mono Float32 (e.g. 48 kHz) -> Int16 PCM (16 kHz).
    // Vendored from noted/frontend/js/AudioResampler.js.
    // ======================================================================
    function AudioResampler(inRate, outRate) {
        this._ratio = inRate / outRate;
        this._carry = new Float32Array(0);
    }
    AudioResampler.prototype.pushFloat32 = function (chunk) {
        var input = new Float32Array(this._carry.length + chunk.length);
        input.set(this._carry, 0);
        input.set(chunk, this._carry.length);
        var outLen = Math.floor(input.length / this._ratio);
        if (outLen === 0) { this._carry = input; return null; }
        var out = new Int16Array(outLen);
        for (var i = 0; i < outLen; i++) {
            var idx = i * this._ratio;
            var i0 = Math.floor(idx);
            var i1 = Math.min(i0 + 1, input.length - 1);
            var frac = idx - i0;
            var s = input[i0] * (1 - frac) + input[i1] * frac;
            s = Math.max(-1, Math.min(1, s));
            out[i] = (s < 0 ? s * 0x8000 : s * 0x7FFF) | 0;
        }
        this._carry = input.subarray(Math.floor(outLen * this._ratio));
        return out;
    };

    // ======================================================================
    // detectKokoroLanguage - lightweight language detector for the 9 Kokoro
    // TTS languages, so spoken replies use a matching-language voice.
    // Ported verbatim from noted/frontend/js/ChatService.js. Never throws.
    // ======================================================================
    function detectKokoroLanguage(text) {
        if (!text || typeof text !== 'string') return 'a';
        var t = text.trim();
        if (t.length < 3) return 'a';

        var cjk = 0, hiragana = 0, katakana = 0, hangul = 0, devanagari = 0;
        for (var ci = 0; ci < t.length; ci++) {
            var cp = t.codePointAt(ci);
            if ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF)) cjk++;
            else if (cp >= 0x3040 && cp <= 0x309F) hiragana++;
            else if (cp >= 0x30A0 && cp <= 0x30FF) katakana++;
            else if (cp >= 0xAC00 && cp <= 0xD7AF) hangul++;
            else if (cp >= 0x0900 && cp <= 0x097F) devanagari++;
        }
        if (hiragana + katakana > 0) return 'j';
        if (hangul > 0) return 'a';                 // Korean not supported by Kokoro
        if (devanagari > 0) return 'h';
        if (cjk > 0 && hiragana + katakana === 0) return 'z';

        if (/[ñ¿¡]/i.test(t)) return 'e';   // Spanish-only chars
        if (/[ãõ]/i.test(t)) return 'p';         // Portuguese-only chars
        if (/ç/i.test(t) && /[éèê]/i.test(t)) return 'f';

        var words = t.toLowerCase().match(/[a-zà-ÿ']+/g) || [];
        if (!words.length) return 'a';
        var wordSet = {};
        words.forEach(function (w) { wordSet[w] = 1; });
        function score(lex) {
            return lex.reduce(function (acc, w) { return acc + (wordSet[w] ? 1 : 0); }, 0);
        }
        var scores = {
            a: score(['the', 'and', 'is', 'of', 'to', 'in', 'for', 'with', 'this', 'that', 'are', 'you', 'have', 'not', 'but']),
            e: score(['el', 'la', 'los', 'las', 'es', 'en', 'para', 'con', 'que', 'por', 'una', 'del', 'pero', 'muy', 'esto']),
            p: score(['o', 'os', 'as', 'um', 'uma', 'para', 'com', 'que', 'do', 'da', 'dos', 'das', 'mas', 'ser', 'isso']),
            f: score(['le', 'la', 'les', 'des', 'et', 'est', 'pour', 'avec', 'que', 'dans', 'sur', 'pas', 'ce', 'son', 'ne']),
            i: score(['il', 'la', 'gli', 'le', 'di', 'per', 'con', 'che', 'del', 'della', 'una', 'sono', 'ma', 'questo', 'non'])
        };
        var best = 'a', bestScore = scores.a;
        ['e', 'p', 'f', 'i'].forEach(function (lang) {
            if (scores[lang] > bestScore) { best = lang; bestScore = scores[lang]; }
        });
        return best;
    }

    // ======================================================================
    // Markdown rendering - marked + KaTeX + highlight.js. Ports noted's
    // ChatPanel.js rendering layer: GFM tables, math expressions
    // ($...$ / $$...$$), and fenced code with syntax highlighting.
    // ======================================================================
    function escapeHtml(s) {
        return String(s).replace(/[&<>]/g, function (c) {
            return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
        });
    }

    // marked math extension - intercepts $$...$$ and $...$ before marked
    // processes the text, so backslashes and underscores inside math are
    // never corrupted by markdown rules. Renders directly via
    // katex.renderToString().
    (function _installMarkedMath() {
        if (typeof marked === 'undefined' || typeof katex === 'undefined') return;
        marked.use({
            extensions: [
                {
                    name: 'math_block',
                    level: 'block',
                    start: function (src) { return src.indexOf('$$'); },
                    tokenizer: function (src) {
                        var m = src.match(/^\$\$([\s\S]+?)\$\$/);
                        if (m) return { type: 'math_block', raw: m[0], math: m[1] };
                    },
                    renderer: function (token) {
                        try {
                            return katex.renderToString(token.math.trim(),
                                { displayMode: true, throwOnError: false });
                        } catch (e) { return '<div>$$' + token.math + '$$</div>'; }
                    }
                },
                {
                    name: 'math_inline',
                    level: 'inline',
                    start: function (src) { return src.indexOf('$'); },
                    tokenizer: function (src) {
                        var m = src.match(/^\$([^$\n]+?)\$/);
                        if (m) return { type: 'math_inline', raw: m[0], math: m[1] };
                    },
                    renderer: function (token) {
                        try {
                            return katex.renderToString(token.math.trim(),
                                { displayMode: false, throwOnError: false });
                        } catch (e) { return '<span>$' + token.math + '$</span>'; }
                    }
                }
            ]
        });
    }());

    function renderMarkdown(src) {
        if (typeof marked === 'undefined') return escapeHtml(src || '');
        return marked.parse(String(src || ''));
    }

    // Apply syntax highlighting + KaTeX math rendering to a freshly-rendered
    // bubble. Called after every innerHTML write in renderParserBubble so
    // both streaming and final renders pick up the visual upgrade.
    // hljs.highlightElement auto-detects language when no language- class
    // is present, which is the common case here (the model rarely tags
    // fenced blocks with an explicit language).
    function applyMarkdownExtras(rootEl) {
        if (!rootEl) return;
        if (typeof hljs !== 'undefined') {
            rootEl.querySelectorAll('pre code').forEach(function (block) {
                try { hljs.highlightElement(block); } catch (e) {}
            });
        }
        if (typeof renderMathInElement !== 'undefined') {
            try {
                renderMathInElement(rootEl, {
                    delimiters: [
                        { left: '$$', right: '$$', display: true },
                        { left: '$',  right: '$',  display: false },
                        { left: '\\(', right: '\\)', display: false },
                        { left: '\\[', right: '\\]', display: true }
                    ],
                    throwOnError: false
                });
            } catch (e) {}
        }
        // Auto-link bare domains the model writes without a protocol
        // (e.g. "logus2k.com" instead of "https://logus2k.com"). marked's
        // GFM autolinker only fires on `http(s)://` / `www.` prefixes, so
        // bare-domain references render as plain text and look broken.
        autolinkBareDomains(rootEl);
        // Force every real URL in Diana's answer to open in a new tab.
        // Skip citation badges (`a.cvchat-cite`) because those use
        // `href="javascript:void(0)"` and are handled by the delegated
        // click listener; opening them in a new tab would do nothing.
        rootEl.querySelectorAll('a[href]').forEach(function (a) {
            if (a.classList.contains('cvchat-cite')) return;
            var href = a.getAttribute('href') || '';
            if (!/^https?:\/\//i.test(href)) return;
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
        });
    }

    // Conservative bare-domain matcher: at least one label of 1+ chars,
    // dot, then one of a short whitelist of TLDs. Optional path with no
    // whitespace or quotes. Anchored against word boundaries so it can't
    // grab the second half of "foo.example.com" mid-token. TLD whitelist
    // skips common file extensions (.md / .py / .js etc) so URLs in prose
    // aren't confused with filenames.
    var _BARE_DOMAIN_RE = /\b((?:[a-z0-9][a-z0-9-]*\.)+(?:com|org|net|io|ai|dev|app|me|co|tech|cloud))\b(\/[^\s<>"')\]]*)?/gi;
    function autolinkBareDomains(rootEl) {
        if (!rootEl) return;
        var walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
                if (!node.parentElement) return NodeFilter.FILTER_REJECT;
                // Skip text already inside an anchor, code, citation
                // wrap, or KaTeX-rendered span.
                if (node.parentElement.closest(
                    'a, code, pre, .cvchat-cite-wrap, .katex, script, style')) {
                    return NodeFilter.FILTER_REJECT;
                }
                _BARE_DOMAIN_RE.lastIndex = 0;
                return _BARE_DOMAIN_RE.test(node.nodeValue)
                    ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            }
        });
        var targets = [], n;
        while ((n = walker.nextNode())) targets.push(n);
        targets.forEach(function (textNode) {
            var text = textNode.nodeValue;
            var frag = document.createDocumentFragment();
            var last = 0, m;
            _BARE_DOMAIN_RE.lastIndex = 0;
            while ((m = _BARE_DOMAIN_RE.exec(text)) !== null) {
                if (m.index > last) frag.appendChild(
                    document.createTextNode(text.slice(last, m.index)));
                var domain = m[1];
                var path = m[2] || '';
                var a = document.createElement('a');
                a.href = 'https://' + domain + path;
                a.textContent = domain + path;
                a.setAttribute('target', '_blank');
                a.setAttribute('rel', 'noopener noreferrer');
                frag.appendChild(a);
                last = m.index + m[0].length;
            }
            if (last < text.length) frag.appendChild(
                document.createTextNode(text.slice(last)));
            textNode.parentNode.replaceChild(frag, textNode);
        });
    }

    // ======================================================================
    // Citations - turn [markdown_chunk:..] [E:..] [R:..] [Cn] tags into
    // numbered, clickable badges. Adapted from noted's _renderCitations.
    // ======================================================================
    var CITE_PART = [
        'markdown_chunk:[0-9a-f]{6,16}',
        '[0-9a-f]{8,16}',
        'E:[^,\\]]+',
        'R:[^,\\]]+',
        'C\\d+'
    ].join('|');
    var CITE_GROUP = new RegExp(
        '\\[((?:' + CITE_PART + ')(?:\\s*,\\s*(?:' + CITE_PART + '))*)\\]', 'g');
    var CITE_ONE = new RegExp(CITE_PART, 'g');

    function citeKind(tag) {
        if (tag.indexOf('E:') === 0) return 'Knowledge-graph entity';
        if (tag.indexOf('R:') === 0) return 'Knowledge-graph relationship';
        if (/^C\d+$/.test(tag)) return 'Knowledge-graph community';
        return 'Source document';
    }

    // Inline SVGs for the citation family icon. Mirrors noted's
    // fa-file-lines (chunks) / fa-share-nodes (graph) split so the two
    // families read identically across the two products.
    // fa-regular fa-file-lines (FontAwesome 6 free) — outline document with
    // text lines. Matches noted's choice: the doc body is transparent and
    // only the outline + the text lines carry colour. Using the solid
    // variant here read as "color-inverted" against noted because the
    // green filled the whole document instead of just the outline.
    var _CITE_ICON_DOC = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512" width="11" height="11" aria-hidden="true" focusable="false"><path fill="currentColor" d="M64 464c-8.8 0-16-7.2-16-16L48 64c0-8.8 7.2-16 16-16l160 0 0 80c0 17.7 14.3 32 32 32l80 0 0 288c0 8.8-7.2 16-16 16L64 464zM64 0C28.7 0 0 28.7 0 64L0 448c0 35.3 28.7 64 64 64l256 0c35.3 0 64-28.7 64-64l0-293.5c0-17-6.7-33.3-18.7-45.3L274.7 18.7C262.7 6.7 246.5 0 229.5 0L64 0zm56 256c-13.3 0-24 10.7-24 24s10.7 24 24 24l144 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-144 0zm0 96c-13.3 0-24 10.7-24 24s10.7 24 24 24l144 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-144 0z"/></svg>';
    var _CITE_ICON_GRAPH = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="18" cy="5" r="3" fill="#a8d8a0"></circle><circle cx="6" cy="12" r="3" fill="#a8d8a0"></circle><circle cx="18" cy="19" r="3" fill="#a8d8a0"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>';
    function _makeCiteIcon(isGraph) {
        var span = document.createElement('span');
        span.className = 'cvchat-cite-icon';
        span.innerHTML = isGraph ? _CITE_ICON_GRAPH : _CITE_ICON_DOC;
        return span;
    }

    function renderCitations(rootEl, numbering) {
        var walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
                if (node.parentElement &&
                    node.parentElement.closest('pre, code, a.cvchat-cite, .cvchat-score-body')) {
                    // Skip the Score body: its hint text contains literal
                    // tag examples ("[E:...]", "[R:...]") that must NOT be
                    // turned into clickable (and broken) citation badges.
                    return NodeFilter.FILTER_REJECT;
                }
                CITE_GROUP.lastIndex = 0;
                return CITE_GROUP.test(node.nodeValue)
                    ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            }
        });
        var targets = [], n;
        while ((n = walker.nextNode())) targets.push(n);

        targets.forEach(function (textNode) {
            var text = textNode.nodeValue;
            var frag = document.createDocumentFragment();
            var last = 0, m;
            CITE_GROUP.lastIndex = 0;
            while ((m = CITE_GROUP.exec(text)) !== null) {
                if (m.index > last) {
                    frag.appendChild(document.createTextNode(text.slice(last, m.index)));
                }
                var parts = m[1].match(CITE_ONE) || [];
                parts.forEach(function (raw) {
                    var tag = raw.trim();
                    var cls = 'cvchat-cite-chunk';
                    var isGraph = false;
                    if (tag.indexOf('E:') === 0) { cls = 'cvchat-cite-entity'; isGraph = true; }
                    else if (tag.indexOf('R:') === 0) { cls = 'cvchat-cite-edge'; isGraph = true; }
                    else if (/^C\d+$/.test(tag)) { cls = 'cvchat-cite-community'; isGraph = true; }
                    else if (/^[0-9a-f]{8,16}$/.test(tag)) tag = 'markdown_chunk:' + tag;
                    if (!numbering.has(tag)) numbering.set(tag, numbering.size + 1);

                    // Match noted's two-family visual model: chunk
                    // citations get a document icon, graph citations
                    // (entity / edge / community) get a network-nodes
                    // icon. The colored pill underneath keeps carrying
                    // the per-type hue. Inline-flex wrap keeps icon +
                    // pill paired across line wraps.
                    var wrap = document.createElement('span');
                    wrap.className = 'cvchat-cite-wrap ' +
                        (isGraph ? 'cvchat-cite-family-graph' : 'cvchat-cite-family-doc');
                    // Tag goes on the wrap so the delegated click handler
                    // resolves the same tag whether the user clicks the icon
                    // or the numbered anchor. Mirrors noted's pattern.
                    wrap.setAttribute('data-cite-tag', tag);
                    wrap.title = citeKind(tag);
                    wrap.appendChild(_makeCiteIcon(isGraph));

                    var a = document.createElement('a');
                    a.className = 'cvchat-cite ' + cls;
                    a.href = 'javascript:void(0)';
                    a.textContent = String(numbering.get(tag));
                    a.title = citeKind(tag);
                    a.setAttribute('data-cite-tag', tag);
                    wrap.appendChild(a);
                    frag.appendChild(wrap);
                });
                last = m.index + m[0].length;
            }
            if (last < text.length) {
                frag.appendChild(document.createTextNode(text.slice(last)));
            }
            textNode.parentNode.replaceChild(frag, textNode);
        });
    }

    // ======================================================================
    // Citation popover
    // ======================================================================
    // The cv-backend normalises every citation type (chunk / entity /
    // relationship / community) into one shape: {kind, title, fields, body}.
    function citationContent(tag, data) {
        var title = (data && data.title) || citeKind(tag);
        var head = '<div class="cvchat-popover-head"><span>' +
            escapeHtml(title) + '</span>' + CLOSE_BTN + '</div>';
        var body = '';
        var fields = (data && data.fields) || [];
        if (fields.length) {
            body += '<dl>';
            for (var i = 0; i < fields.length; i++) {
                body += '<dt>' + escapeHtml(String(fields[i][0])) + '</dt><dd>' +
                    escapeHtml(String(fields[i][1])) + '</dd>';
            }
            body += '</dl>';
        }
        if (data && data.body) {
            var txt = String(data.body);
            body += '<div class="cvchat-popover-text">' +
                escapeHtml(txt.slice(0, 1000)) + (txt.length > 1000 ? '…' : '') + '</div>';
        }
        if (!body) body = '<div>No additional detail available.</div>';
        return head + body;
    }

    // Auto-close state. The popover closes when:
    //   - the user clicks anywhere outside the popover and outside any
    //     citation badge (clicks on another badge re-open the popover
    //     for that citation, handled by the badge's own click handler);
    //   - the mouse leaves the popover for longer than POPOVER_LEAVE_MS
    //     (with mouseenter cancelling the pending close so the user can
    //     move from popover to badge and back without flicker).
    var POPOVER_LEAVE_MS = 250;
    var _popoverLeaveTimer = null;
    var _popoverDocHandler = null;
    var _popoverEnterHandler = null;
    var _popoverLeaveHandler = null;

    function _detachPopoverCloseHandlers() {
        if (_popoverLeaveTimer) {
            clearTimeout(_popoverLeaveTimer);
            _popoverLeaveTimer = null;
        }
        if (_popoverDocHandler) {
            document.removeEventListener('mousedown', _popoverDocHandler, true);
            _popoverDocHandler = null;
        }
        if (_popoverEnterHandler) {
            popover.removeEventListener('mouseenter', _popoverEnterHandler);
            _popoverEnterHandler = null;
        }
        if (_popoverLeaveHandler) {
            popover.removeEventListener('mouseleave', _popoverLeaveHandler);
            _popoverLeaveHandler = null;
        }
    }

    function showPopover(anchor, html) {
        popover.innerHTML = html;
        popover.hidden = false;
        var panelRect = panel.getBoundingClientRect();
        var aRect = anchor.getBoundingClientRect();
        var pw = popover.offsetWidth, ph = popover.offsetHeight;
        var left = Math.max(8, Math.min(
            aRect.left - panelRect.left, panel.clientWidth - pw - 8));
        var top = aRect.bottom - panelRect.top + 6;
        if (top + ph > panel.clientHeight - 8) {
            top = Math.max(8, aRect.top - panelRect.top - ph - 6);
        }
        popover.style.left = left + 'px';
        popover.style.top = top + 'px';

        // Rebind close handlers fresh on every show (previous popover
        // might have been re-anchored by a new badge click - the old
        // doc-mousedown handler would otherwise immediately close it).
        _detachPopoverCloseHandlers();
        _popoverDocHandler = function (e) {
            if (popover.hidden) return;
            var t = e.target;
            if (popover.contains(t)) return;
            // Don't close on clicks targeting another citation badge -
            // its own click handler will re-anchor the popover.
            if (t.closest && t.closest('.cvchat-cite-wrap')) return;
            hidePopover();
        };
        _popoverEnterHandler = function () {
            if (_popoverLeaveTimer) {
                clearTimeout(_popoverLeaveTimer);
                _popoverLeaveTimer = null;
            }
        };
        _popoverLeaveHandler = function () {
            if (_popoverLeaveTimer) clearTimeout(_popoverLeaveTimer);
            _popoverLeaveTimer = setTimeout(hidePopover, POPOVER_LEAVE_MS);
        };
        document.addEventListener('mousedown', _popoverDocHandler, true);
        popover.addEventListener('mouseenter', _popoverEnterHandler);
        popover.addEventListener('mouseleave', _popoverLeaveHandler);
    }

    function hidePopover() {
        _detachPopoverCloseHandlers();
        popover.hidden = true;
        popover.innerHTML = '';
    }

    // ======================================================================
    // In-page citation highlight - locate the cited passage in the live CV
    // page (main.page) and highlight it with the CSS Custom Highlight API,
    // then scroll to it. The KB is built from the same Markdown the page is
    // built from, so the chunk text matches the rendered text closely.
    // ======================================================================
    var CV_HL = 'cvchat-cite';

    function normForMatch(s) {
        return String(s)
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')   // md links -> link text
            .replace(/[*_`#>~|]+/g, ' ')                // md markers
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function clearCVHighlight() {
        try {
            if (window.CSS && CSS.highlights) CSS.highlights.delete(CV_HL);
        } catch (e) {}
    }

    // HTML tags that browsers render inline by default. When we walk the
    // CV's text nodes, two consecutive text nodes whose closest non-inline
    // ancestor is the same actually belong to the same paragraph (e.g. a
    // <p> with an <a> link in the middle of it) and must NOT be separated
    // by a synthetic block-boundary space - otherwise the indexed string
    // reads "...at logus2k.com ." with an extra space the chunk text
    // doesn't have, and indexOf(fullChunk) fails.
    var CVCHAT_INLINE_TAGS = {
        A: 1, ABBR: 1, B: 1, BDI: 1, BDO: 1, CITE: 1, CODE: 1, DFN: 1,
        EM: 1, FONT: 1, I: 1, KBD: 1, MARK: 1, Q: 1, RP: 1, RT: 1, RUBY: 1,
        S: 1, SAMP: 1, SMALL: 1, SPAN: 1, STRONG: 1, SUB: 1, SUP: 1, TIME: 1,
        TT: 1, U: 1, VAR: 1, WBR: 1
    };

    function cvchatNearestBlock(el, target) {
        var cur = el;
        while (cur && cur !== target && CVCHAT_INLINE_TAGS[cur.tagName]) {
            cur = cur.parentElement;
        }
        return cur || target;
    }

    // Concatenate main.page's text nodes into one whitespace-collapsed,
    // lowercased string, with a parallel map from each char index back to
    // its {node, offset} in the DOM. Synthetic separator spaces are
    // inserted only at REAL block boundaries (different non-inline
    // ancestors), so inline structure (<a>, <strong>, ...) is transparent.
    function buildPageIndex() {
        var target = document.querySelector('main.page')
            || document.querySelector('main');
        if (!target) return null;
        var walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
            acceptNode: function (n) {
                if (n.parentElement &&
                    n.parentElement.closest('script, style, .cvchat-root')) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        var chars = [], map = [], node;
        var prevSpace = true;
        var prevBlock = null;
        while ((node = walker.nextNode())) {
            var t = node.nodeValue;
            var block = cvchatNearestBlock(node.parentElement, target);
            // Crossed into a different block container -> separator space.
            // Within the same block (text split by inline <a>/<strong>/...)
            // keep the run continuous so chunk-vs-page text aligns.
            if (prevBlock && block !== prevBlock && !prevSpace) {
                chars.push(' ');
                map.push({ node: node, offset: 0 });
                prevSpace = true;
            }
            prevBlock = block;
            for (var i = 0; i < t.length; i++) {
                var c = t.charAt(i);
                if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
                    if (prevSpace) continue;
                    chars.push(' '); map.push({ node: node, offset: i });
                    prevSpace = true;
                } else {
                    chars.push(c.toLowerCase()); map.push({ node: node, offset: i });
                    prevSpace = false;
                }
            }
        }
        return { text: chars.join(''), map: map };
    }

    // After a substring fallback hit, walk outward to the nearest word
    // boundary on each side (capped at 24 chars) so the highlight doesn't
    // visually cut mid-word. The substring search slices in steps of 12,
    // so up to ~12 chars at each end can be missing from the matched span
    // even when the full word is plainly there. Word chars include
    // letters, digits, underscore, hyphen, dot - so URLs / domains /
    // hyphenated words stay whole.
    function expandToWordBoundaries(text, start, end) {
        var WORD = /[A-Za-z0-9_.\-]/;
        var max = 24;
        var n = 0;
        while (start > 0 && WORD.test(text.charAt(start - 1)) && n < max) {
            start--;
            n++;
        }
        n = 0;
        while (end < text.length && WORD.test(text.charAt(end)) && n < max) {
            end++;
            n++;
        }
        return { start: start, end: end };
    }

    // Find the cited text - or its longest locatable contiguous sub-span -
    // in the page. Returns {start, end} indices into idx.text, or null.
    // Substring fallback hits are expanded outward to word boundaries so
    // the highlighted span doesn't end mid-word.
    function findInPage(idx, q) {
        if (q.length < 12) return null;
        var page = idx.text;
        var pos = page.indexOf(q);
        if (pos >= 0) return { start: pos, end: pos + q.length };
        for (var len = q.length - 12; len >= 40; len -= 12) {
            for (var s = 0; s + len <= q.length; s += 12) {
                var p = page.indexOf(q.substr(s, len));
                if (p >= 0) return expandToWordBoundaries(page, p, p + len);
            }
        }
        return null;
    }

    function highlightInCV(text) {
        clearCVHighlight();
        if (!(window.CSS && CSS.highlights && window.Highlight)) return false;
        var q = normForMatch(text);
        if (q.length < 12) return false;
        var idx = buildPageIndex();
        if (!idx) return false;
        var span = findInPage(idx, q);
        if (!span) return false;
        var a = idx.map[span.start];
        var endEntry = idx.map[span.end];
        var b = endEntry || idx.map[idx.map.length - 1];
        if (!a || !b) return false;
        var range = document.createRange();
        try {
            range.setStart(a.node, a.offset);
            if (endEntry) {
                range.setEnd(b.node, b.offset);
            } else {
                range.setEnd(b.node, Math.min(b.offset + 1, b.node.nodeValue.length));
            }
            CSS.highlights.set(CV_HL, new Highlight(range));
        } catch (e) {
            return false;
        }
        var anchor = a.node.parentElement;
        if (anchor && anchor.scrollIntoView) {
            anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return true;
    }

    // Fallback when the exact passage can't be located: scroll the CV page
    // to the heading named by the chunk's section_path.
    function scrollToCVSection(sectionPath) {
        if (!sectionPath) return false;
        var target = document.querySelector('main.page') || document.body;
        var heads = target.querySelectorAll('h1, h2, h3, h4, h5, h6');
        var leaf = sectionPath.split('>').pop().trim().toLowerCase();
        if (!leaf) return false;
        for (var i = 0; i < heads.length; i++) {
            var ht = (heads[i].textContent || '').trim().toLowerCase();
            if (ht && (ht === leaf || ht.indexOf(leaf) === 0 || leaf.indexOf(ht) === 0)) {
                heads[i].scrollIntoView({ behavior: 'smooth', block: 'start' });
                return true;
            }
        }
        return false;
    }

    function resolveCitation(tag, badge) {
        showPopover(badge, '<div class="cvchat-popover-head"><span>Loading…</span>' +
            CLOSE_BTN + '</div>');
        fetch(API + '/citation/' + encodeURIComponent(tag))
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                // A document chunk highlights the cited passage in the live
                // CV page the recruiter is already reading. Graph citations
                // (entity / relationship / community) have no page location
                // and use the popover.
                if (data && data.kind === 'chunk') {
                    hidePopover();
                    // job2cool: any chunk with a source opens the source PDF and
                    // highlights the cited passage (bbox when available), like noted.
                    if (data.source_path && window.JOB2COOL_OPEN_PDF) {
                        window.JOB2COOL_OPEN_PDF(data);
                        return;
                    }
                    var ok = highlightInCV(data.body || '');
                    if (!ok) ok = scrollToCVSection(data.section_path || '');
                    if (!ok) showPopover(badge, citationContent(tag, data));
                } else {
                    showPopover(badge, citationContent(tag, data));
                }
            })
            .catch(function () {
                showPopover(badge, '<div class="cvchat-popover-head"><span>' +
                    escapeHtml(citeKind(tag)) + '</span>' + CLOSE_BTN +
                    '</div><div>Source detail is not available right now.</div>');
            });
    }

    // ======================================================================
    // Messages
    // ======================================================================
    function scrollToBottom() {
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // Copy-to-clipboard button (same icon/behaviour as noted's notebook-viewer).
    var COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" fill="#a8d8a0"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    var CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2a7a2a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 9 17 20 6"/></svg>';

    function createCopyBtn(getText) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cvchat-copy-btn';
        btn.title = 'Copy';
        btn.setAttribute('aria-label', 'Copy message');
        btn.innerHTML = COPY_ICON;
        btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var text = typeof getText === 'function' ? getText() : String(getText || '');
            if (!text || !navigator.clipboard) return;
            navigator.clipboard.writeText(text).then(function () {
                btn.innerHTML = CHECK_ICON;
                setTimeout(function () { btn.innerHTML = COPY_ICON; }, 1500);
            });
        });
        return btn;
    }

    // Every bubble holds its text inside a .cvchat-bubble-content wrapper
    // so the docked avatar stage can sit as a sibling (left) without
    // being clobbered when streaming code rewrites the content's
    // innerHTML. Callers receive the content div as the write target;
    // it behaves like the old bubble reference. The outer .cvchat-bubble
    // is what flips into a flex row when the avatar docks in.
    function addMessage(role, html) {
        var msg = document.createElement('div');
        msg.className = 'cvchat-msg cvchat-msg-' + role;
        var bubble = document.createElement('div');
        bubble.className = 'cvchat-bubble';
        var content = document.createElement('div');
        content.className = 'cvchat-bubble-content';
        content.innerHTML = html;
        bubble.appendChild(content);
        if (role === 'assistant') {
            // Copy reads `innerText` from the LIVE content element so
            // block-level line breaks render correctly (innerText on a
            // detached clone collapses to textContent — no newlines).
            // The .cvchat-think section is temporarily detached for the
            // read so the reasoning text doesn't end up in the clipboard.
            bubble.appendChild(createCopyBtn(function () {
                var think = content.querySelector('.cvchat-think');
                var thinkParent = null, thinkNext = null;
                if (think) {
                    thinkParent = think.parentNode;
                    thinkNext = think.nextSibling;
                    think.remove();
                }
                var text = (content.innerText || content.textContent || '').trim();
                if (think && thinkParent) {
                    thinkParent.insertBefore(think, thinkNext);
                }
                return text;
            }));
        }
        msg.appendChild(bubble);
        messagesEl.appendChild(msg);
        scrollToBottom();
        // Latest assistant bubble takes over as the docked-avatar host.
        if (role === 'assistant' && state.avatarOn && state.avatarDocked) {
            relocateDockedAvatarTo(bubble);
        }
        return content;
    }

    function notice(text) {
        var n = document.createElement('div');
        n.className = 'cvchat-error';
        n.textContent = text;
        messagesEl.appendChild(n);
        scrollToBottom();
    }

    // ======================================================================
    // Chat - send a message and stream the cited answer
    // ======================================================================
    // Stateful streaming parser for <think>...</think> and <voice>...
    // </voice>, ported from noted/ChatService.js (ThinkingParser). The
    // earlier batch-regex approach couldn't distinguish a real <voice>
    // opener from a literal <voice> reference inside the CoT (the system
    // prompt instructs the model to end reasoning with "My next visible
    // token is '<voice>'."). Once _inThinking is true, ANY tag-looking
    // text is treated as plain reasoning content - only </think> exits
    // that mode. Same invariant for _inVoice.
    function ThinkingParser() {
        this._inThinking = false;
        this._inVoice = false;
        this._voiceBuffer = '';
        this._buffer = '';           // partial tags at chunk boundaries
        this.thinkingBuffer = '';
        this.voiceText = '';         // collected <voice>...</voice> text
    }

    // Pull <voice>...</voice> out of a same-chunk post-</think> answer.
    // Three cases: complete block (extract), opener-without-closer (enter
    // voice mode + stash tail), partial opener at boundary (push back to
    // _buffer for the next processToken).
    ThinkingParser.prototype._extractVoiceFromAnswer = function (answer) {
        if (!answer) return answer;
        var cleaned = answer;
        // Defensive: if the post-</think> content opens another <think>
        // block (model derail → multi-think), push from <think> onward
        // back to _buffer so the next processToken re-enters thinking
        // instead of treating a <voice> inside the second think as real.
        var nextThink = cleaned.indexOf('<think>');
        if (nextThink >= 0) {
            this._buffer = (this._buffer || '') + cleaned.slice(nextThink);
            cleaned = cleaned.slice(0, nextThink);
            if (!cleaned) return cleaned;
        }
        var m = cleaned.match(/<voice>([\s\S]*?)<\/voice>/);
        if (m) {
            this.voiceText = (this.voiceText ? this.voiceText + ' ' : '') + m[1].trim();
            cleaned = (cleaned.slice(0, m.index) + cleaned.slice(m.index + m[0].length)).trim();
        } else {
            var voiceOpenIdx = cleaned.indexOf('<voice>');
            if (voiceOpenIdx >= 0) {
                this._inVoice = true;
                this._voiceBuffer = cleaned.slice(voiceOpenIdx + '<voice>'.length);
                cleaned = cleaned.slice(0, voiceOpenIdx).trim();
            } else {
                var partialVoice = cleaned.match(/<v(?:o(?:i(?:c(?:e)?)?)?)?$/);
                if (partialVoice) {
                    this._buffer = (this._buffer || '') + partialVoice[0];
                    cleaned = cleaned.slice(0, partialVoice.index).trim();
                }
            }
        }
        // Partial <think> opener at chunk boundary (`<t`, `<th`, ...
        // `<think`). Defer so the next processToken assembles the
        // complete tag and re-enters thinking. Without this, '<t' is
        // treated as body content and the rest of '<think>' leaks into
        // the answer as literal text on multi-think turns.
        var partialThink = cleaned.match(/<t(?:h(?:i(?:n(?:k)?)?)?)?$/);
        if (partialThink) {
            this._buffer = (this._buffer || '') + partialThink[0];
            cleaned = cleaned.slice(0, partialThink.index).trim();
        }
        // Bare '<' at end: chunk boundary cut a tag at its first char.
        // Defer to _buffer so the next processToken assembles it.
        if (cleaned.endsWith('<')) {
            this._buffer = (this._buffer || '') + '<';
            cleaned = cleaned.slice(0, -1).trim();
        }
        return cleaned;
    };

    ThinkingParser.prototype.processToken = function (token) {
        this._buffer += token;

        // <think> opening (only when not already thinking/voicing)
        if (!this._inThinking && !this._inVoice && this._buffer.indexOf('<think>') >= 0) {
            this._inThinking = true;
            var after1 = this._buffer.split('<think>').pop();
            this._buffer = '';
            this.thinkingBuffer = '';
            if (after1.indexOf('</think>') >= 0) {
                this._inThinking = false;
                var parts1 = after1.split('</think>');
                this.thinkingBuffer = parts1[0];
                var answer1 = this._extractVoiceFromAnswer(parts1.slice(1).join('</think>').replace(/^\s+/, ''));
                return { type: 'thinking_end', thinking: this.thinkingBuffer, answer: answer1 };
            }
            this.thinkingBuffer = after1;
            return { type: 'thinking_start' };
        }

        // </think> closing
        if (this._inThinking && this._buffer.indexOf('</think>') >= 0) {
            this._inThinking = false;
            var parts2 = this._buffer.split('</think>');
            this.thinkingBuffer += parts2[0];
            this._buffer = '';
            var answer2 = this._extractVoiceFromAnswer(parts2.slice(1).join('</think>').replace(/^\s+/, ''));
            return { type: 'thinking_end', thinking: this.thinkingBuffer, answer: answer2 };
        }

        // <voice> opening (post-thinking, not nested)
        if (!this._inVoice && !this._inThinking && this._buffer.indexOf('<voice>') >= 0) {
            this._inVoice = true;
            var before = this._buffer.split('<voice>')[0];
            var after3 = this._buffer.split('<voice>').slice(1).join('<voice>');
            this._voiceBuffer = after3;
            this._buffer = '';
            if (after3.indexOf('</voice>') >= 0) {
                this._inVoice = false;
                var parts3 = after3.split('</voice>');
                this.voiceText = parts3[0].trim();
                this._voiceBuffer = '';
                this._buffer = parts3.slice(1).join('</voice>');
                if (before.trim()) return { type: 'answer_token', token: before };
                return { type: 'voice', text: this.voiceText };
            }
            if (before.trim()) return { type: 'answer_token', token: before };
            return { type: 'pending' };
        }

        // </voice> closing
        if (this._inVoice && this._buffer.indexOf('</voice>') >= 0) {
            this._inVoice = false;
            var content = this._buffer.split('</voice>')[0];
            this._voiceBuffer += content;
            this.voiceText = this._voiceBuffer.trim();
            this._voiceBuffer = '';
            var after4 = this._buffer.split('</voice>').slice(1).join('</voice>');
            this._buffer = after4 || '';
            return { type: 'voice', text: this.voiceText };
        }

        // Partial tag at chunk boundary - defer. Patterns include bare
        // '<' so a single-char chunk arriving as the start of a close tag
        // isn't absorbed into thinkingBuffer/voiceBuffer before the rest
        // of the tag arrives in the next chunk(s).
        if (!this._inThinking && !this._inVoice && this._buffer.endsWith('<')) return { type: 'pending' };
        if (!this._inThinking && !this._inVoice && /<t(?:h(?:i(?:n(?:k)?)?)?)?$/.test(this._buffer)) return { type: 'pending' };
        if (!this._inThinking && !this._inVoice && /<v(?:o(?:i(?:c(?:e)?)?)?)?$/.test(this._buffer)) return { type: 'pending' };
        if (this._inThinking && /<(?:\/(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?)?$/.test(this._buffer)) return { type: 'pending' };
        if (this._inVoice && /<(?:\/(?:v(?:o(?:i(?:c(?:e)?)?)?)?)?)?$/.test(this._buffer)) return { type: 'pending' };

        // Normal token flow
        var c = this._buffer;
        this._buffer = '';
        if (this._inThinking) {
            this.thinkingBuffer += c;
            return { type: 'thinking_token', token: c };
        }
        if (this._inVoice) {
            this._voiceBuffer += c;
            return { type: 'pending' };
        }
        return { type: 'answer_token', token: c };
    };

    // The most recent top-level section of the reasoning text (a markdown
    // heading, or a top-level numbered/bulleted step) - shown live as the
    // status while the model is still thinking.
    function latestThinkingSection(thinkingText) {
        var lines = String(thinkingText).split('\n');
        var last = '';
        for (var i = 0; i < lines.length; i++) {
            var m = lines[i].match(/^\s{0,3}#{1,4}\s+(.+?)\s*#*$/)
                 || lines[i].match(/^\s{0,3}\d+[.)]\s+(.+)$/)
                 || lines[i].match(/^\s{0,3}[-*+]\s+(.+)$/);
            if (m) last = m[1];
        }
        if (!last) return '';
        var bold = last.match(/^\*\*([^*]+?)\*\*/);
        var txt = (bold ? bold[1] : last)
            .replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim();
        return txt.length > 110 ? txt.slice(0, 110) + '…' : txt;
    }

    // Render a bubble from parser state. While thinking is live, show
    // only the transient status line (latest top-level section). Once
    // thinking has closed, show the collapsed reasoning <details> + the
    // accumulated answer body + citations. If `traceData` is provided
    // (post-stream-end, after the trace fetch resolves), an additional
    // "Graph" <details> sits beside the Thinking toggle.
    function renderParserBubble(bubble, parser, body, numbering, traceData, scoreData) {
        if (parser._inThinking) {
            var sec = latestThinkingSection(parser.thinkingBuffer);
            bubble.innerHTML = '<div class="cvchat-think-status">'
                + '<span class="cvchat-think-preview">'
                + escapeHtml(sec || 'Thinking…') + '</span></div>';
            return;
        }
        // Tear down any prior 3D scene the bubble owns; we rebuild
        // innerHTML below so the old canvas would lose its host anyway.
        if (bubble._graph3d && typeof bubble._graph3d.dispose === 'function') {
            try { bubble._graph3d.dispose(); } catch (e) {}
            bubble._graph3d = null;
        }
        // Toggle row carries only the summary labels - the expanded
        // bodies live in a separate row below so opening Graph never
        // pushes Thinking down (and vice versa). Native <details>
        // bundles summary + body in one element, which forces them
        // onto the same flex row; manual button+body splits them.
        var html = '';
        var hasThinking = !!(parser.thinkingBuffer && parser.thinkingBuffer.trim());
        // The Graph toggle appears as soon as the model emits ANY
        // entity or chunk citation - we don't have to wait for the
        // post-stream trace fetch. While the trace is still in flight
        // (or not yet kicked off), opening the toggle shows a
        // "Loading…" placeholder; once `traceData` lands and the
        // bubble re-renders, the 3D scene takes its place.
        var hasGraphCitations = false;
        if (numbering && typeof numbering.forEach === 'function') {
            numbering.forEach(function (_ord, tag) {
                if (hasGraphCitations) return;
                if (tag.indexOf('E:') === 0
                    || tag.indexOf('markdown_chunk:') === 0) {
                    hasGraphCitations = true;
                }
            });
        }
        var hasTrace = !!(traceData && traceData.entities
                          && traceData.entities.length);
        // Show the Graph toggle optimistically while citations stream in
        // and the trace fetch is still pending. Once the fetch resolves
        // (bubble._graphResolved), only keep the toggle if it actually
        // produced graph entities - otherwise it cleanly disappears
        // instead of hanging on "Loading…". (Dense-corpus chunk
        // citations don't map to graph entities, so an empty trace is
        // a normal outcome now that vector retrieval works.)
        var hasGraph = hasTrace
            || (hasGraphCitations && !bubble._graphResolved);
        var hasScore = !!scoreData;
        if (hasThinking || hasGraph || hasScore) {
            html += '<div class="cvchat-toggles">';
            if (hasThinking) {
                html += '<button type="button" class="cvchat-toggle cvchat-toggle-think"'
                     + ' aria-expanded="false">'
                     + '<span class="cvchat-toggle-label">Thinking</span>'
                     + '</button>';
            }
            if (hasGraph) {
                html += '<button type="button" class="cvchat-toggle cvchat-toggle-graph"'
                     + ' aria-expanded="false">'
                     + '<span class="cvchat-toggle-label">Graph</span>'
                     + '</button>';
            }
            if (hasScore) {
                html += '<button type="button" class="cvchat-toggle cvchat-toggle-score"'
                     + ' aria-expanded="false">'
                     + '<span class="cvchat-toggle-label">Score</span>'
                     + '</button>';
            }
            html += '</div>';
        }
        if (hasThinking) {
            html += '<div class="cvchat-think-body" hidden>'
                  + renderMarkdown(neutralizeCitationLinkRefs(parser.thinkingBuffer))
                  + '</div>';
        }
        if (hasGraph) {
            // Body is intentionally empty - filled lazily by mountGraph3D()
            // when the user first opens it.
            html += '<div class="cvchat-graph-body" hidden></div>';
        }
        if (hasScore) {
            html += '<div class="cvchat-score-body" hidden>'
                  + _scoreBodyHtml(scoreData)
                  + '</div>';
        }
        if (body && body.trim()) {
            html += renderMarkdown(neutralizeCitationLinkRefs(body));
        }
        bubble.innerHTML = html;
        applyMarkdownExtras(bubble);
        renderCitations(bubble, numbering);

        // Wire the two toggles as a mutually exclusive pair:
        //   - opening Thinking closes Graph (and vice versa)
        //   - clicking an already-open toggle closes it
        //   - both may be closed at the same time
        // This keeps only one auxiliary panel visible below the answer
        // text, which is less visually noisy than letting two stacked
        // bodies expand together.
        var thinkBtn = hasThinking ? bubble.querySelector('.cvchat-toggle-think') : null;
        var thinkBody = hasThinking ? bubble.querySelector('.cvchat-think-body') : null;
        var graphBtn = hasGraph ? bubble.querySelector('.cvchat-toggle-graph') : null;
        var graphBody = hasGraph ? bubble.querySelector('.cvchat-graph-body') : null;
        function _setOpen(btn, body, open) {
            if (!btn || !body) return;
            if (open) body.removeAttribute('hidden');
            else body.setAttribute('hidden', '');
            btn.classList.toggle('is-open', open);
            btn.setAttribute('aria-expanded', String(open));
        }
        // Open state survives across the per-token re-renders that
        // happen while the stream is still in flight - without this,
        // clicking Graph mid-stream would close on the next token.
        function _renderGraphBody() {
            if (!graphBody) return;
            if (hasTrace) {
                graphBody.innerHTML = '';
                // Persist the camera pose on the bubble so re-opening
                // the toggle (or a re-render) restores where the user
                // left it instead of replaying the intro fly-in.
                bubble._graphCam = bubble._graphCam || {};
                mountGraph3D(graphBody, traceData, bubble._graphCam).then(function (h) {
                    bubble._graph3d = h;
                });
            } else {
                graphBody.innerHTML =
                    '<div class="cvchat-graph-loading">Loading graph…</div>';
            }
        }
        var scoreBtn = hasScore ? bubble.querySelector('.cvchat-toggle-score') : null;
        var scoreBody = hasScore ? bubble.querySelector('.cvchat-score-body') : null;
        if (thinkBtn && thinkBody) {
            if (bubble._thinkOpen) _setOpen(thinkBtn, thinkBody, true);
            thinkBtn.addEventListener('click', function () {
                var willOpen = thinkBody.hasAttribute('hidden');
                if (willOpen) {
                    _setOpen(graphBtn, graphBody, false);
                    bubble._graphOpen = false;
                    _setOpen(scoreBtn, scoreBody, false);
                    bubble._scoreOpen = false;
                }
                _setOpen(thinkBtn, thinkBody, willOpen);
                bubble._thinkOpen = willOpen;
            });
        }
        if (graphBtn && graphBody) {
            // Restore prior open state + body content after a per-token
            // re-render. If we're now showing real trace data (hasTrace
            // just became true), refresh the body even if it was open.
            if (bubble._graphOpen) {
                _setOpen(graphBtn, graphBody, true);
                _renderGraphBody();
            }
            graphBtn.addEventListener('click', function () {
                var willOpen = graphBody.hasAttribute('hidden');
                if (willOpen) {
                    _setOpen(thinkBtn, thinkBody, false);
                    bubble._thinkOpen = false;
                    _setOpen(scoreBtn, scoreBody, false);
                    bubble._scoreOpen = false;
                    _renderGraphBody();
                }
                _setOpen(graphBtn, graphBody, willOpen);
                bubble._graphOpen = willOpen;
            });
        }
        if (scoreBtn && scoreBody) {
            if (bubble._scoreOpen) _setOpen(scoreBtn, scoreBody, true);
            scoreBtn.addEventListener('click', function () {
                var willOpen = scoreBody.hasAttribute('hidden');
                if (willOpen) {
                    _setOpen(thinkBtn, thinkBody, false);
                    bubble._thinkOpen = false;
                    _setOpen(graphBtn, graphBody, false);
                    bubble._graphOpen = false;
                }
                _setOpen(scoreBtn, scoreBody, willOpen);
                bubble._scoreOpen = willOpen;
            });
        }
    }

    function _fmtPct(v) {
        return v == null ? '—' : Math.round(v * 100) + '%';
    }
    function _fmtMs(v) {
        if (v == null) return '—';
        return v >= 1000 ? (v / 1000).toFixed(2) + ' s' : v + ' ms';
    }
    // Average across state.scoreHistory of a numeric accessor that
    // returns null/undefined when the metric isn't available yet.
    // Returns null if no entry has it.
    function _sessionMean(getter) {
        var history = (state && state.scoreHistory) || [];
        var sum = 0, n = 0;
        for (var i = 0; i < history.length; i++) {
            var v = getter(history[i]);
            if (typeof v === 'number' && !isNaN(v)) {
                sum += v; n++;
            }
        }
        return n ? sum / n : null;
    }

    // Build one section of the Score body: a row showing the metric
    // name, the current turn's value, and the session running average,
    // followed by a small italic hint explaining what the metric means.
    function _scoreRow(label, current, session, hint) {
        return '<div class="cvchat-score-section">'
            + '<div class="cvchat-score-row">'
            + '<span class="cvchat-score-key">' + escapeHtml(label) + '</span>'
            + '<span class="cvchat-score-vals">'
            +   '<span class="cvchat-score-val">' + escapeHtml(String(current)) + '</span>'
            +   '<span class="cvchat-score-avg" title="Session running average">avg ' + escapeHtml(String(session)) + '</span>'
            + '</span>'
            + '</div>'
            + (hint
                ? '<div class="cvchat-score-hint">' + escapeHtml(hint) + '</div>'
                : '')
            + '</div>';
    }

    function _scoreBodyHtml(s) {
        var composite = _scoreComposite(s);
        var sessionN = (state.scoreHistory || []).length;
        var compositeAvg = _sessionMean(function (h) { return _scoreComposite(h); });
        var faithAvg = _sessionMean(function (h) { return h.faithfulness; });
        var relAvg = _sessionMean(function (h) { return h.answer_relevance; });
        var covAvg = _sessionMean(function (h) { return h.evidence_coverage; });
        var noiseAvg = _sessionMean(function (h) {
            return h.evidence_coverage == null ? null : 1 - h.evidence_coverage;
        });
        var ttftAvg = _sessionMean(function (h) {
            return h.ttft_ms == null ? null : h.ttft_ms;
        });
        var totalAvg = _sessionMean(function (h) {
            return h.total_ms == null ? null : h.total_ms;
        });

        var pending = s.judge_pending;
        var judgeError = s.judge_error;
        function judgeVal(v) {
            if (pending) return 'pending…';
            if (judgeError) return 'unavailable';
            return _fmtPct(v);
        }

        var compositeCls = composite >= 0.8 ? 'is-good'
                         : composite >= 0.6 ? 'is-mid' : 'is-poor';
        var html = '';
        html += '<div class="cvchat-score-head">'
              +   '<span class="cvchat-score-head-key">Composite</span>'
              +   '<span class="cvchat-score-head-vals">'
              +     '<span class="cvchat-score-head-val ' + compositeCls + '">'
              +       _fmtPct(composite) + '</span>'
              +     '<span class="cvchat-score-head-avg">avg ' + _fmtPct(compositeAvg)
              +       ' · ' + sessionN + ' turn' + (sessionN === 1 ? '' : 's') + '</span>'
              +   '</span>'
              + '</div>';
        html += '<div class="cvchat-score-head-hint">Weighted average of faithfulness, answer relevance, and evidence coverage (judge axes weighted 2×). Higher is better.</div>';

        html += '<div class="cvchat-score-group">Quality (LLM judge)</div>';
        html += _scoreRow(
            'Faithfulness', judgeVal(s.faithfulness), _fmtPct(faithAvg),
            'How well each factual claim in the answer is grounded in the retrieved evidence.');
        html += _scoreRow(
            'Answer relevance', judgeVal(s.answer_relevance), _fmtPct(relAvg),
            'How directly the answer addresses your question — penalises drift or off-topic content.');

        html += '<div class="cvchat-score-group">Retrieval structure</div>';
        html += _scoreRow(
            'Evidence coverage', _fmtPct(s.evidence_coverage), _fmtPct(covAvg),
            'Share of retrieved chunks (dense-corpus + graph-grounded excerpts) the assistant actually cited in the answer.');
        html += _scoreRow(
            'Context noise', _fmtPct(1 - s.evidence_coverage),
            covAvg == null ? '—' : _fmtPct(1 - covAvg),
            'Inverse of evidence coverage — the share of retrieved chunks that went unused. Persistently high hints retrieval over-fetched.');
        // Graph items are tracked separately because the LLM rarely
        // cites entities/edges by design; folding them into a rate
        // would dilute the signal.
        var gCited = s.cited.entities + s.cited.edges;
        var gRetrieved = s.retrieved.entities + s.retrieved.edges;
        html += _scoreRow(
            'Graph items cited',
            gCited + ' / ' + gRetrieved,
            '—',
            'Entities + relationships cited from the knowledge graph. Low is expected — graph items mostly serve as background context for the model.');

        html += '<div class="cvchat-score-group">Performance</div>';
        html += _scoreRow(
            'Time to first token', _fmtMs(s.ttft_ms), _fmtMs(ttftAvg),
            'Wall-clock from sending the question until the model emits its first output token.');
        html += _scoreRow(
            'Total time', _fmtMs(s.total_ms), _fmtMs(totalAvg),
            'Wall-clock from sending the question until the stream ends.');

        html += '<div class="cvchat-score-group">Retrieval counts</div>';
        html += '<div class="cvchat-score-section">'
              + '<div class="cvchat-score-row">'
              + '<span class="cvchat-score-key">Retrieved</span>'
              + '<span class="cvchat-score-val">'
              +   s.retrieved.chunks + ' chunks · '
              +   s.retrieved.entities + ' entities · '
              +   s.retrieved.edges + ' edges'
              + '</span></div>'
              + '<div class="cvchat-score-hint">What the backend retrieved from the knowledge base before sending to the assistant.</div>'
              + '</div>';
        html += '<div class="cvchat-score-section">'
              + '<div class="cvchat-score-row">'
              + '<span class="cvchat-score-key">Cited</span>'
              + '<span class="cvchat-score-val">'
              +   s.cited.chunks + ' chunks · '
              +   s.cited.entities + ' entities · '
              +   s.cited.edges + ' edges'
              + '</span></div>'
              + '<div class="cvchat-score-hint">What the assistant referenced in the answer via [markdown_chunk:...], [E:...], [R:...] tags.</div>'
              + '</div>';

        if (s.judge_rationale) {
            html += '<div class="cvchat-score-rationale">'
                  + '<strong>Judge note:</strong> ' + escapeHtml(s.judge_rationale)
                  + '</div>';
        }
        return html;
    }

    // Inline 3D graph renderer using Three.js, mirroring the engine
    // noted's GraphPanel uses (see noted/frontend/js/knowledge-graph/
    // KnowledgeGraph3D.js). Lazy-loaded on first Graph toggle expand
    // so the ~370 KB of vendored Three.js never ships on initial page
    // load. Trace shape comes from cv-backend's /api/graph_trace: a
    // merged 1-hop neighborhood across every [E:...] cited in the
    // turn. Seeds are the actually-cited entities; the rest are their
    // immediate neighbors.
    var _threeLoadPromise = null;
    function _loadThree() {
        if (_threeLoadPromise) return _threeLoadPromise;
        _threeLoadPromise = Promise.all([
            import(new URL('static/widget/vendor/three/three.module.min.js', document.baseURI).href),
            import(new URL('static/widget/vendor/three/OrbitControls.js', document.baseURI).href)
        ]).then(function (mods) {
            return { THREE: mods[0], OrbitControls: mods[1].OrbitControls };
        }).catch(function (e) {
            _threeLoadPromise = null;     // allow retry on next expand
            throw e;
        });
        return _threeLoadPromise;
    }

    // Static node color palette - matches the per-family hues used by
    // the inline citation badges (see .cvchat-cite-* in cv-chat.css)
    // so a reader can tie a 3D sphere back to the colored pill in the
    // answer text.
    var GRAPH_NODE_COLORS = {
        seed:         0x9dd3a9, // dusty mint - distinct, cited highlight
        entity:       0xa0c4d8, // dusty sky (default)
        relationship: 0xd4b870, // muted amber
        community:    0xb8aede, // dusty lavender
        concept:      0xa3b0d0, // dusty indigo
        organization: 0xa0c4d8, // dusty sky
        person:       0xdfafb6, // dusty rose
        term:         0xdab088  // dusty peach
    };

    function _nodeColor(seed, type) {
        // All nodes use their type color - the legend swatches always
        // match the rendered spheres. Seeds (cited entities) are
        // marked with a separate gold ring sprite, see below.
        return GRAPH_NODE_COLORS[type] || GRAPH_NODE_COLORS.entity;
    }

    // Cited entities are wrapped in a slightly larger wireframe
    // ("grid") sphere so the colored fill of the inner sphere stays
    // visible (matching the legend type color) while a 3D cage marks
    // it as a seed. Reuse the same geometry across all seed nodes.
    var _seedCageGeoCache = null;
    function _seedCageGeo(THREE) {
        if (_seedCageGeoCache) return _seedCageGeoCache;
        // 10x6 segments give a clear visible grid pattern at the
        // scale we render seeds. Higher counts crowd the grid into
        // a near-solid sphere; lower makes it look polygonal.
        _seedCageGeoCache = new THREE.SphereGeometry(1, 10, 6);
        return _seedCageGeoCache;
    }

    // Render a label to an offscreen canvas, then wrap as a Three.js
    // CanvasTexture for use on a Sprite. `style` is 'node' (large,
    // dark pill) or 'edge' (smaller, lighter pill) so edges read as
    // secondary labels.
    function _makeLabelTexture(THREE, text, style) {
        var label = String(text || '');
        var isEdge = style === 'edge';
        if (label.length > 28) label = label.slice(0, 26) + '…';
        var fontSize = isEdge ? 16 : 22;
        var pad = isEdge ? 6 : 8;
        var weight = isEdge ? '500' : '600';
        // Super-sample the label canvas so the sprite stays sharp
        // when projected to screen. Drawing at 3x the logical size
        // and letting Three.js downscale through mipmaps eliminates
        // the linear-filter softness that plain 1x textures show.
        var SS = 3;
        var measureCanvas = document.createElement('canvas');
        var mctx = measureCanvas.getContext('2d');
        mctx.font = weight + ' ' + fontSize + 'px Inter, system-ui, sans-serif';
        var w = Math.ceil(mctx.measureText(label).width) + pad * 2;
        var h = fontSize + pad * 2;
        var canvas = document.createElement('canvas');
        canvas.width = w * SS;
        canvas.height = h * SS;
        var ctx = canvas.getContext('2d');
        ctx.scale(SS, SS);
        ctx.font = weight + ' ' + fontSize + 'px Inter, system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        // No pill background or border - text only, floating in the
        // scene. The white canvas-graph background gives plain text
        // enough contrast to stay readable.
        ctx.fillStyle = '#010101';
        ctx.fillText(label, pad, h / 2 + 1);
        var tex = new THREE.CanvasTexture(canvas);
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        tex.anisotropy = 8;
        tex.needsUpdate = true;
        return { texture: tex, w: w, h: h };
    }

    function _placeSphere(list, radius, seedSet, into) {
        var n = list.length;
        if (!n) return;
        // Fibonacci sphere distribution - even node spread regardless
        // of count, no clumping at the poles.
        var golden = Math.PI * (3 - Math.sqrt(5));
        for (var k = 0; k < n; k++) {
            var y = 1 - (k / Math.max(1, n - 1)) * 2;
            var r = Math.sqrt(Math.max(0, 1 - y * y));
            var theta = golden * k;
            into[list[k].id] = {
                id: list[k].id,
                label: list[k].label || list[k].id,
                type: list[k].type || '',
                description: list[k].description || '',
                seed: !!seedSet[list[k].id],
                pos: [Math.cos(theta) * r * radius,
                      y * radius,
                      Math.sin(theta) * r * radius]
            };
        }
    }

    // Build + start the inline 3D graph inside `container`. Returns
    // {dispose} for the caller to invoke when the toggle collapses or
    // the bubble is unmounted (avoids WebGL context leaks - browsers
    // cap at ~16 active contexts per tab).
    async function mountGraph3D(container, trace, camState) {
        camState = camState || {};
        container.innerHTML = '';
        var loading = document.createElement('div');
        loading.className = 'cvchat-graph-loading';
        loading.textContent = 'Loading 3D graph…';
        container.appendChild(loading);

        var THREE, OrbitControls;
        try {
            var mods = await _loadThree();
            THREE = mods.THREE;
            OrbitControls = mods.OrbitControls;
        } catch (e) {
            container.innerHTML = '';
            var err = document.createElement('div');
            err.className = 'cvchat-graph-error';
            err.textContent = '3D graph unavailable.';
            container.appendChild(err);
            console.warn('[cvchat] failed to load three.js:', e);
            return { dispose: function () {} };
        }
        container.innerHTML = '';

        // Stage = flex row: [canvas host] [legend]. Splitting the
        // canvas off into its own host lets the renderer's resize
        // observer track the host's dimensions independently of the
        // legend column, so adding/removing legend items never resizes
        // the 3D scene.
        var stage = document.createElement('div');
        stage.className = 'cvchat-graph-3d';
        container.appendChild(stage);

        var canvasHost = document.createElement('div');
        canvasHost.className = 'cvchat-graph-canvas-host';
        stage.appendChild(canvasHost);

        var legendEl = document.createElement('div');
        legendEl.className = 'cvchat-graph-legend';
        stage.appendChild(legendEl);

        var width = canvasHost.clientWidth || 360;
        var height = canvasHost.clientHeight || 420;

        var scene = new THREE.Scene();
        var camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 200);
        camera.position.set(0, 0, 6);

        // alpha:false + an opaque scene background gives truer node
        // colors (no compositing against the page) and lets the GPU
        // skip alpha blending for the clear pass. The white clear
        // color matches the .cvchat-graph-3d CSS background so the
        // bubble's white surface continues into the canvas seamlessly.
        var renderer = new THREE.WebGLRenderer({
            alpha: false, antialias: true
        });
        renderer.setPixelRatio(window.devicePixelRatio || 1);
        renderer.setSize(width, height);
        renderer.setClearColor(0xffffff, 1);
        scene.background = new THREE.Color(0xffffff);
        canvasHost.appendChild(renderer.domElement);

        var controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.enablePan = true;
        controls.screenSpacePanning = true;
        controls.minDistance = 2;
        controls.maxDistance = 18;
        controls.rotateSpeed = 0.6;
        // Standard OrbitControls mapping: LEFT rotates, RIGHT pans
        // (drags the scene sideways/up-down), MIDDLE zooms. Left-click
        // on a node is still captured by our own pointerdown handler
        // below for node-drag before OrbitControls sees it.
        controls.mouseButtons = {
            LEFT:   THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT:  THREE.MOUSE.PAN
        };
        // Suppress the browser context menu on the canvas so right-
        // drag pans cleanly instead of popping the OS menu over the
        // scene mid-drag.
        renderer.domElement.addEventListener('contextmenu', function (e) {
            e.preventDefault();
        });

        // Soft hemispheric light - flat-shaded spheres still need
        // enough contrast that seeds (filled) read against neighbors.
        scene.add(new THREE.AmbientLight(0xffffff, 0.85));
        var dir = new THREE.DirectionalLight(0xffffff, 0.45);
        dir.position.set(2, 3, 4);
        scene.add(dir);

        // Place nodes on two concentric spheres - seeds inner, neighbors
        // outer - so the eye reads cited entities as the focal cluster.
        var seedSet = {};
        (trace.seeds || []).forEach(function (s) { seedSet[s] = true; });
        var entities = trace.entities || [];
        var seedEnts = [], nbrEnts = [];
        for (var i = 0; i < entities.length; i++) {
            (seedSet[entities[i].id] ? seedEnts : nbrEnts).push(entities[i]);
        }
        var nodes = {};
        _placeSphere(seedEnts, 0.7, seedSet, nodes);
        _placeSphere(nbrEnts, 2.2, seedSet, nodes);

        // Node spheres + label sprites. Track meshes/sprites by entity
        // id so the pointer drag handler below can move mesh, sprite
        // and every connected edge in lockstep.
        var sphereGeo = new THREE.SphereGeometry(1, 16, 12);
        var meshes = [];
        var sprites = [];
        var nodeMeshes = {};   // entityId -> mesh
        var nodeSprites = {};  // entityId -> { sprite, offsetY }
        var nodeRings = {};    // entityId -> wireframe-cage mesh (seeds only)
        var seedCageGeo = _seedCageGeo(THREE);
        Object.keys(nodes).forEach(function (eid) {
            var n = nodes[eid];
            var color = _nodeColor(n.seed, n.type);
            // MeshBasicMaterial = unlit, displays the raw color exactly.
            // We use it so the rendered sphere color matches the
            // legend swatch on the right (the legend draws raw hex).
            // Phong/lambert would shade the spheres darker via the
            // scene lights, breaking that visual match.
            var mat = new THREE.MeshBasicMaterial({ color: color });
            var radius = n.seed ? 0.18 : 0.12;
            var mesh = new THREE.Mesh(sphereGeo, mat);
            mesh.position.set(n.pos[0], n.pos[1], n.pos[2]);
            mesh.scale.setScalar(radius);
            mesh.userData = { entityId: n.id, label: n.label,
                              type: n.type, radius: radius };
            scene.add(mesh);
            meshes.push(mesh);
            nodeMeshes[n.id] = mesh;

            // Cited entities (seeds) are wrapped in a gold wireframe
            // sphere - a 3D "net" cage that lets the inner type-
            // colored fill show through while marking the node as
            // cited from any orbit angle.
            if (n.seed) {
                var cageMat = new THREE.MeshBasicMaterial({
                    color: 0xffcc00,
                    wireframe: true
                });
                var cage = new THREE.Mesh(seedCageGeo, cageMat);
                cage.position.copy(mesh.position);
                cage.scale.setScalar(radius * 1.65);
                scene.add(cage);
                nodeRings[n.id] = cage;
            }

            var lbl = _makeLabelTexture(THREE, n.label);
            var spriteMat = new THREE.SpriteMaterial({
                map: lbl.texture, transparent: true, depthTest: false
            });
            var sprite = new THREE.Sprite(spriteMat);
            var sScale = 0.0055;
            sprite.scale.set(lbl.w * sScale, lbl.h * sScale, 1);
            sprite.position.set(n.pos[0], n.pos[1] + radius + 0.22, n.pos[2]);
            sprite.renderOrder = 10;
            scene.add(sprite);
            sprites.push(sprite);
            nodeSprites[n.id] = { sprite: sprite, offsetY: radius + 0.22 };
        });

        // Edges - thin grey line segments between any two placed nodes,
        // each carrying its own sprite label showing the relationship
        // type (e.g. "similar to", "member of"). Sprite sits at the
        // midpoint of the line so it stays readable when nodes move.
        var edges = trace.edges || [];
        var edgeMat = new THREE.LineBasicMaterial({
            // Opaque mid-grey - more vivid than the previous 0.55-alpha
            // version, reads clearly against the white background.
            color: 0x64748b
        });
        var edgeLines = [];
        edges.forEach(function (ed) {
            var a = nodeMeshes[ed.source], b = nodeMeshes[ed.target];
            if (!a || !b) return;
            var g = new THREE.BufferGeometry().setFromPoints([
                a.position.clone(), b.position.clone()
            ]);
            var line = new THREE.Line(g, edgeMat);
            line.userData = { source: ed.source, target: ed.target };
            scene.add(line);

            // Relationship-type label. Underscore-to-space mirrors
            // noted's display convention (e.g. similar_to -> "similar to").
            var typeLabel = String(ed.type || '').replace(/_/g, ' ');
            var lblSprite = null;
            if (typeLabel) {
                var lbl = _makeLabelTexture(THREE, typeLabel, 'edge');
                var spriteMat = new THREE.SpriteMaterial({
                    map: lbl.texture, transparent: true, depthTest: false
                });
                lblSprite = new THREE.Sprite(spriteMat);
                var sScale = 0.0050;
                lblSprite.scale.set(lbl.w * sScale, lbl.h * sScale, 1);
                lblSprite.position.set(
                    (a.position.x + b.position.x) / 2,
                    (a.position.y + b.position.y) / 2,
                    (a.position.z + b.position.z) / 2);
                lblSprite.renderOrder = 5;
                scene.add(lblSprite);
                sprites.push(lblSprite);
            }
            line.userData.labelSprite = lblSprite;
            edgeLines.push(line);
        });

        function _updateEdgesForNode(entityId) {
            for (var ei = 0; ei < edgeLines.length; ei++) {
                var line = edgeLines[ei];
                if (line.userData.source !== entityId &&
                    line.userData.target !== entityId) continue;
                var sm = nodeMeshes[line.userData.source];
                var tm = nodeMeshes[line.userData.target];
                if (!sm || !tm) continue;
                var pos = line.geometry.attributes.position;
                pos.setXYZ(0, sm.position.x, sm.position.y, sm.position.z);
                pos.setXYZ(1, tm.position.x, tm.position.y, tm.position.z);
                pos.needsUpdate = true;
                line.geometry.computeBoundingSphere();
                // Re-center the relationship-type label between the
                // (now-moved) endpoints.
                if (line.userData.labelSprite) {
                    line.userData.labelSprite.position.set(
                        (sm.position.x + tm.position.x) / 2,
                        (sm.position.y + tm.position.y) / 2,
                        (sm.position.z + tm.position.z) / 2);
                }
            }
        }

        // Pointer-driven node drag - mirrors noted's KnowledgeGraph3D
        // approach (raycast against meshes, drag along a camera-facing
        // plane through the node). Simpler here: no physics simulation,
        // just direct positioning. OrbitControls is disabled while a
        // drag is active so the camera doesn't fight the mouse.
        var raycaster = new THREE.Raycaster();
        var pointer = new THREE.Vector2();
        var dragPlane = new THREE.Plane();
        var dragOffset = new THREE.Vector3();
        var dragIntersect = new THREE.Vector3();
        var dragging = null;
        var cameraDir = new THREE.Vector3();

        function _pointerNDC(evt) {
            var rect = renderer.domElement.getBoundingClientRect();
            pointer.x = ((evt.clientX - rect.left) / rect.width) * 2 - 1;
            pointer.y = -((evt.clientY - rect.top) / rect.height) * 2 + 1;
        }

        function _onPointerDown(evt) {
            if (evt.button !== 0) return;
            _pointerNDC(evt);
            raycaster.setFromCamera(pointer, camera);
            var hits = raycaster.intersectObjects(meshes, false);
            if (!hits.length) return;
            var mesh = hits[0].object;
            dragging = { entityId: mesh.userData.entityId, mesh: mesh };
            controls.enabled = false;
            renderer.domElement.style.cursor = 'grabbing';
            camera.getWorldDirection(cameraDir);
            dragPlane.setFromNormalAndCoplanarPoint(cameraDir, mesh.position);
            raycaster.ray.intersectPlane(dragPlane, dragIntersect);
            dragOffset.copy(dragIntersect).sub(mesh.position);
            try { renderer.domElement.setPointerCapture(evt.pointerId); }
            catch (e) {}
            evt.preventDefault();
        }

        function _onPointerMove(evt) {
            if (!dragging) {
                // Hover affordance only - tells the user a node is
                // interactive before they actually click.
                _pointerNDC(evt);
                raycaster.setFromCamera(pointer, camera);
                var hits = raycaster.intersectObjects(meshes, false);
                renderer.domElement.style.cursor = hits.length ? 'pointer' : 'grab';
                return;
            }
            _pointerNDC(evt);
            raycaster.setFromCamera(pointer, camera);
            if (raycaster.ray.intersectPlane(dragPlane, dragIntersect)) {
                var next = dragIntersect.clone().sub(dragOffset);
                dragging.mesh.position.copy(next);
                var spr = nodeSprites[dragging.entityId];
                if (spr) spr.sprite.position.set(
                    next.x, next.y + spr.offsetY, next.z);
                var cage = nodeRings[dragging.entityId];
                if (cage) cage.position.copy(next);
                _updateEdgesForNode(dragging.entityId);
            }
            evt.preventDefault();
        }

        function _onPointerUp(evt) {
            if (!dragging) return;
            try { renderer.domElement.releasePointerCapture(evt.pointerId); }
            catch (e) {}
            dragging = null;
            controls.enabled = true;
            renderer.domElement.style.cursor = 'grab';
        }

        renderer.domElement.addEventListener('pointerdown', _onPointerDown);
        renderer.domElement.addEventListener('pointermove', _onPointerMove);
        renderer.domElement.addEventListener('pointerup',   _onPointerUp);
        renderer.domElement.addEventListener('pointercancel', _onPointerUp);

        var disposed = false;
        var rafId = null;

        // Intro fly-in: over ~2.5s sweep the camera from the head-on
        // default to 30° up and 20° to the right, AND pan the view so the
        // graph rises ~20° in the frame (same motion as a right-button
        // drag upward). Done by animating spherical coords around a
        // panned look-at target, then handing control to OrbitControls.
        var INTRO_MS = 2500;
        var introT0 = performance.now();
        var introDone = false;
        var camR = camera.position.length() || 6;       // ~6
        var azStart = 0, polStart = Math.PI / 2;          // == (0,0,camR)
        var azEnd = 20 * Math.PI / 180;                   // 20° right
        var polEnd = 60 * Math.PI / 180;                  // 30° up (90-30)
        // Vertical pan: shift camera + look-at target down by tan(5°)*R
        // so the graph (at origin) appears ~5° higher in the frame -
        // i.e. it moves UP, matching a right-button pan upward.
        var panEndY = -camR * Math.tan(5 * Math.PI / 180);
        controls.enabled = false;                         // suspend input during intro

        // If we have a saved camera pose for this bubble (toggle was
        // opened before), restore it and SKIP the intro - the graph
        // resumes exactly where the user left it.
        if (camState.pos && camState.target) {
            camera.position.set(camState.pos[0], camState.pos[1], camState.pos[2]);
            controls.target.set(camState.target[0], camState.target[1], camState.target[2]);
            controls.enabled = true;
            controls.update();
            introDone = true;
        }
        function _sph(az, pol) {
            return new THREE.Vector3(
                camR * Math.sin(pol) * Math.sin(az),
                camR * Math.cos(pol),
                camR * Math.sin(pol) * Math.cos(az));
        }
        function _easeInOut(t) {
            return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        }

        function tick() {
            if (disposed) return;
            if (!introDone) {
                var e = (performance.now() - introT0) / INTRO_MS;
                if (e >= 1) { e = 1; introDone = true; }
                var k = _easeInOut(e);
                var az = azStart + (azEnd - azStart) * k;
                var pol = polStart + (polEnd - polStart) * k;
                var panY = panEndY * k;
                var pos = _sph(az, pol);
                camera.position.set(pos.x, pos.y + panY, pos.z);
                camera.lookAt(0, panY, 0);
                if (introDone) {
                    controls.target.set(0, panEndY, 0);   // orbit around the panned point
                    controls.enabled = true;
                    controls.update();   // sync OrbitControls to final pose
                }
            } else {
                controls.update();
            }
            // Persist the live camera pose so a later re-mount restores
            // it (and skips the intro).
            camState.pos = [camera.position.x, camera.position.y, camera.position.z];
            camState.target = [controls.target.x, controls.target.y, controls.target.z];
            renderer.render(scene, camera);
            rafId = requestAnimationFrame(tick);
        }
        tick();

        // Resize when the canvas host box changes (chat panel drag,
        // viewport resize, bubble width). We observe the host - not
        // the whole stage - because the stage also contains the
        // legend column, which shouldn't influence the camera aspect.
        var ro = null;
        function _resize() {
            var w = canvasHost.clientWidth;
            var h = canvasHost.clientHeight;
            if (!w || !h) return;
            // `true` (default) updates the canvas CSS dims along with
            // the rendering buffer, otherwise the buffer outgrows the
            // displayed canvas and the scene visibly flattens.
            renderer.setSize(w, h, true);
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
        }
        if (typeof ResizeObserver !== 'undefined') {
            ro = new ResizeObserver(_resize);
            ro.observe(canvasHost);
        }
        window.addEventListener('resize', _resize);

        // Legend - one row per entity type present in the trace,
        // each with a colored swatch + label + count. Clicking a row
        // toggles visibility of all nodes (and their connected edges
        // + labels) of that type. Always-on by default.
        var typeCounts = {};
        Object.keys(nodes).forEach(function (eid) {
            var t = nodes[eid].type || 'entity';
            typeCounts[t] = (typeCounts[t] || 0) + 1;
        });
        var typeVisible = {};
        // Independent global toggles. Final visibility folds these
        // together with the per-type visibility map:
        //   - node mesh:    typeOn
        //   - node label:   typeOn AND showNodeLabels
        //   - edge line:    bothEndpointsVisible AND showEdges
        //   - edge label:   bothEndpointsVisible AND showEdges AND showEdgeLabels
        var showEdges = true;
        var showNodeLabels = true;
        var showEdgeLabels = false;
        var showSeedCage = true;
        function _hex6(n) { return ('00000' + n.toString(16)).slice(-6); }
        function _applyVisibility() {
            Object.keys(nodeMeshes).forEach(function (eid) {
                var t = (nodes[eid].type || 'entity');
                var typeOn = typeVisible[t] !== false;
                // Cited (seed) nodes stay visible when the "Cited"
                // legend toggle is on, even if every type is disabled.
                // Lets the reader filter the view down to just the
                // citations and their cage markers.
                var isSeed = !!(nodes[eid] && nodes[eid].seed);
                var visible = typeOn || (isSeed && showSeedCage);
                nodeMeshes[eid].visible = visible;
                var spr = nodeSprites[eid];
                if (spr) spr.sprite.visible = visible && showNodeLabels;
                var cage = nodeRings[eid];
                if (cage) cage.visible = visible && showSeedCage;
            });
            edgeLines.forEach(function (line) {
                var s = nodeMeshes[line.userData.source];
                var t = nodeMeshes[line.userData.target];
                var bothOn = !!(s && t && s.visible && t.visible);
                line.visible = bothOn && showEdges;
                if (line.userData.labelSprite) {
                    line.userData.labelSprite.visible =
                        bothOn && showEdges && showEdgeLabels;
                }
            });
        }
        // Stable type order so the legend doesn't shuffle between
        // renders: known types first in semantic order, then any
        // others alphabetically.
        var KNOWN_ORDER = ['concept', 'organization', 'person', 'term', 'community'];
        var allTypes = Object.keys(typeCounts);
        var orderedTypes = KNOWN_ORDER.filter(function (t) {
            return typeCounts[t];
        }).concat(allTypes.filter(function (t) {
            return KNOWN_ORDER.indexOf(t) === -1;
        }).sort());
        // Communities start hidden by default - they're aggregate
        // cluster nodes that often dominate the layout and are usually
        // less interesting at first glance than the actual entities
        // a user just had cited to them.
        var DEFAULT_OFF = { community: true };
        orderedTypes.forEach(function (type) {
            var defaultOn = !DEFAULT_OFF[type];
            typeVisible[type] = defaultOn;
            var item = document.createElement('div');
            item.className = 'cvchat-graph-legend-item' + (defaultOn ? ' is-on' : '');
            item.dataset.type = type;
            var color = GRAPH_NODE_COLORS[type] || GRAPH_NODE_COLORS.entity;
            var swatch = document.createElement('span');
            swatch.className = 'cvchat-graph-legend-swatch';
            swatch.style.background = '#' + _hex6(color);
            item.appendChild(swatch);
            var lbl = document.createElement('span');
            lbl.className = 'cvchat-graph-legend-label';
            lbl.textContent = type + ' (' + typeCounts[type] + ')';
            item.appendChild(lbl);
            item.addEventListener('click', function () {
                typeVisible[type] = !typeVisible[type];
                item.classList.toggle('is-on', typeVisible[type]);
                _applyVisibility();
            });
            legendEl.appendChild(item);
        });
        // Apply the initial visibility immediately so anything in
        // DEFAULT_OFF is hidden from the first frame.
        _applyVisibility();

        // Separator + two label-visibility toggles. These are not
        // per-type filters - they globally hide/show the text labels
        // attached to nodes and to edges, independently of which
        // node types are visible.
        var sep = document.createElement('div');
        sep.className = 'cvchat-graph-legend-sep';
        legendEl.appendChild(sep);

        function _addLabelToggle(text, swatchText, onClick, initialOn) {
            var on = initialOn !== false;
            var item = document.createElement('div');
            item.className = 'cvchat-graph-legend-item' + (on ? ' is-on' : '');
            var swatch = document.createElement('span');
            swatch.className = 'cvchat-graph-legend-swatch cvchat-graph-legend-swatch-text';
            swatch.textContent = swatchText;
            item.appendChild(swatch);
            var lbl = document.createElement('span');
            lbl.className = 'cvchat-graph-legend-label';
            lbl.textContent = text;
            item.appendChild(lbl);
            item.addEventListener('click', function () {
                var nowOn = !item.classList.contains('is-on');
                item.classList.toggle('is-on', nowOn);
                onClick(nowOn);
                _applyVisibility();
            });
            legendEl.appendChild(item);
        }
        _addLabelToggle('Cited',       '◍',  function (on) { showSeedCage = on; });
        _addLabelToggle('Edges',       '─',  function (on) { showEdges = on; });
        _addLabelToggle('Node labels', 'Aa', function (on) { showNodeLabels = on; });
        _addLabelToggle('Edge labels', '—',  function (on) { showEdgeLabels = on; }, false);

        // Separator between the visibility toggles above and the
        // mutually-exclusive layout view toggles below.
        var layoutSep = document.createElement('div');
        layoutSep.className = 'cvchat-graph-legend-sep';
        legendEl.appendChild(layoutSep);

        // ---- Layout view toggles (mutually exclusive) ----------------
        // Fibonacci: seeds on inner sphere, neighbors on outer sphere
        // (the default placement built at mount time).
        // Cluster: nodes group by type around per-type cluster centers
        // arranged on a horizontal ring around the origin.
        var currentLayout = 'cluster';
        var layoutToggles = {};

        function _moveNode(eid, x, y, z) {
            var m = nodeMeshes[eid];
            if (m) m.position.set(x, y, z);
            var spr = nodeSprites[eid];
            if (spr) spr.sprite.position.set(x, y + spr.offsetY, z);
            var cage = nodeRings[eid];
            if (cage) cage.position.set(x, y, z);
        }

        function _updateAllEdges() {
            edgeLines.forEach(function (line) {
                var sm = nodeMeshes[line.userData.source];
                var tm = nodeMeshes[line.userData.target];
                if (!sm || !tm) return;
                var pa = line.geometry.attributes.position;
                pa.setXYZ(0, sm.position.x, sm.position.y, sm.position.z);
                pa.setXYZ(1, tm.position.x, tm.position.y, tm.position.z);
                pa.needsUpdate = true;
                line.geometry.computeBoundingSphere();
                if (line.userData.labelSprite) {
                    line.userData.labelSprite.position.set(
                        (sm.position.x + tm.position.x) / 2,
                        (sm.position.y + tm.position.y) / 2,
                        (sm.position.z + tm.position.z) / 2);
                }
            });
        }

        function _layoutFibonacci() {
            var seedEnts = [], nbrEnts = [];
            Object.keys(nodes).forEach(function (eid) {
                (nodes[eid].seed ? seedEnts : nbrEnts).push(eid);
            });
            function ring(ids, R) {
                var nn = ids.length;
                if (!nn) return;
                var golden = Math.PI * (3 - Math.sqrt(5));
                for (var k = 0; k < nn; k++) {
                    var y = 1 - (k / Math.max(1, nn - 1)) * 2;
                    var r = Math.sqrt(Math.max(0, 1 - y * y));
                    var theta = golden * k;
                    _moveNode(ids[k],
                        Math.cos(theta) * r * R,
                        y * R,
                        Math.sin(theta) * r * R);
                }
            }
            ring(seedEnts, 0.7);
            ring(nbrEnts, 2.2);
        }

        function _layoutCluster() {
            // Group entities by type, place each type's nodes around
            // its own cluster center. Cluster centers sit on a
            // horizontal ring; intra-cluster placement is a small
            // Fibonacci sphere scaled to the cluster's node count.
            var perType = {};
            Object.keys(nodes).forEach(function (eid) {
                var t = nodes[eid].type || 'entity';
                (perType[t] = perType[t] || []).push(eid);
            });
            var types = Object.keys(perType);
            var K = types.length;
            var R_cluster = 2.4;
            var golden = Math.PI * (3 - Math.sqrt(5));
            types.forEach(function (t, ti) {
                var ang = K > 1 ? (ti / K) * Math.PI * 2 : 0;
                var cx = K > 1 ? Math.cos(ang) * R_cluster : 0;
                var cz = K > 1 ? Math.sin(ang) * R_cluster : 0;
                var ids = perType[t];
                var nn = ids.length;
                var rInner = Math.max(0.35, 0.18 * Math.sqrt(nn));
                for (var k = 0; k < nn; k++) {
                    var y = 1 - (k / Math.max(1, nn - 1)) * 2;
                    var r = Math.sqrt(Math.max(0, 1 - y * y));
                    var theta = golden * k;
                    _moveNode(ids[k],
                        cx + Math.cos(theta) * r * rInner,
                        y * rInner,
                        cz + Math.sin(theta) * r * rInner);
                }
            });
        }

        function _layoutForceDirected() {
            // Cheap 3D force-directed: per-pair Coulomb repulsion +
            // spring attraction along edges + soft centering pull.
            // ~120 Euler steps with velocity damping. O(N^2) per step,
            // fine for the 50-200 nodes a typical trace produces.
            var ids = Object.keys(nodes);
            var pos = {}, vel = {};
            ids.forEach(function (eid) {
                var m = nodeMeshes[eid];
                pos[eid] = m
                    ? new THREE.Vector3(m.position.x, m.position.y, m.position.z)
                    : new THREE.Vector3(
                        (Math.random() - 0.5) * 2,
                        (Math.random() - 0.5) * 2,
                        (Math.random() - 0.5) * 2);
                vel[eid] = new THREE.Vector3();
            });
            var adj = {};
            ids.forEach(function (eid) { adj[eid] = []; });
            edgeLines.forEach(function (line) {
                var s = line.userData.source, t = line.userData.target;
                if (adj[s] && adj[t]) {
                    adj[s].push(t); adj[t].push(s);
                }
            });
            var ITER = 120;
            var K_REPEL = 0.06;
            var K_SPRING = 0.04;
            var K_CENTER = 0.004;
            var SPRING_LEN = 1.1;
            var DAMP = 0.82;
            var tmp = new THREE.Vector3();
            for (var it = 0; it < ITER; it++) {
                ids.forEach(function (a) {
                    var f = new THREE.Vector3();
                    ids.forEach(function (b) {
                        if (a === b) return;
                        tmp.copy(pos[a]).sub(pos[b]);
                        var d2 = Math.max(0.04, tmp.lengthSq());
                        tmp.multiplyScalar(K_REPEL / d2);
                        f.add(tmp);
                    });
                    adj[a].forEach(function (b) {
                        tmp.copy(pos[b]).sub(pos[a]);
                        var d = tmp.length();
                        if (d < 0.001) return;
                        var k = K_SPRING * (d - SPRING_LEN);
                        tmp.multiplyScalar(k / d);
                        f.add(tmp);
                    });
                    tmp.copy(pos[a]).multiplyScalar(-K_CENTER);
                    f.add(tmp);
                    vel[a].add(f).multiplyScalar(DAMP);
                    pos[a].add(vel[a]);
                });
            }
            ids.forEach(function (eid) {
                _moveNode(eid, pos[eid].x, pos[eid].y, pos[eid].z);
            });
        }

        function _layoutConcentric() {
            // Place most-connected nodes (hubs) at the center, less-
            // connected on outer rings. Flat on Y=0 to make hub
            // structure read at a glance.
            var degree = {};
            Object.keys(nodes).forEach(function (eid) { degree[eid] = 0; });
            edgeLines.forEach(function (line) {
                if (degree[line.userData.source] != null) degree[line.userData.source]++;
                if (degree[line.userData.target] != null) degree[line.userData.target]++;
            });
            var sorted = Object.keys(nodes).sort(function (a, b) {
                return (degree[b] || 0) - (degree[a] || 0);
            });
            var N = sorted.length;
            var k = 0, ring = 0;
            while (k < N) {
                var capacity = ring === 0 ? 1 : Math.max(1, Math.floor(ring * 6));
                var thisCount = Math.min(capacity, N - k);
                var R = ring * 0.85;
                for (var j = 0; j < thisCount; j++) {
                    var theta = thisCount > 1 ? (j / thisCount) * Math.PI * 2 : 0;
                    _moveNode(sorted[k],
                        Math.cos(theta) * R, 0, Math.sin(theta) * R);
                    k++;
                }
                ring++;
            }
        }

        function _layoutHierarchy() {
            // Stack vertical levels: community nodes at the top,
            // each community's members one level below, "uncategorized"
            // entities at the bottom. Within each level nodes spread
            // on a horizontal circle.
            var nodeComm = {};
            edgeLines.forEach(function (line) {
                if (line.userData.type === 'member_of') {
                    var src = line.userData.source, tgt = line.userData.target;
                    if (nodes[tgt] && nodes[tgt].type === 'community') {
                        nodeComm[src] = tgt;
                    }
                }
            });
            var communityIds = [];
            var byComm = {}; var orphans = [];
            Object.keys(nodes).forEach(function (eid) {
                if (nodes[eid].type === 'community') {
                    communityIds.push(eid);
                    return;
                }
                var c = nodeComm[eid];
                if (c) (byComm[c] = byComm[c] || []).push(eid);
                else orphans.push(eid);
            });
            var levels = [];
            if (communityIds.length) levels.push(communityIds);
            communityIds.forEach(function (cid) {
                if (byComm[cid] && byComm[cid].length) levels.push(byComm[cid]);
            });
            // Members of communities NOT in the trace's community list
            Object.keys(byComm).forEach(function (cid) {
                if (communityIds.indexOf(cid) === -1) levels.push(byComm[cid]);
            });
            if (orphans.length) levels.push(orphans);
            var yStep = 0.9;
            var yTop = (levels.length - 1) * yStep / 2;
            levels.forEach(function (ids, li) {
                var y = yTop - li * yStep;
                var n = ids.length;
                var R = Math.max(0.5, 0.32 * Math.sqrt(n));
                for (var k2 = 0; k2 < n; k2++) {
                    var theta = n > 1 ? (k2 / n) * Math.PI * 2 : 0;
                    _moveNode(ids[k2], Math.cos(theta) * R, y, Math.sin(theta) * R);
                }
            });
        }

        function _layoutSpiral() {
            // Archimedean spiral on the Y=0 plane: r = a * theta.
            // Most-compact view for high-node-count traces.
            var ids = Object.keys(nodes);
            var a = 0.16;
            var step = 0.55;
            for (var k = 0; k < ids.length; k++) {
                var theta = k * step;
                var r = a * theta;
                _moveNode(ids[k], Math.cos(theta) * r, 0, Math.sin(theta) * r);
            }
        }

        function _setLayout(mode) {
            if (mode === currentLayout) return;
            currentLayout = mode;
            if (mode === 'cluster')         _layoutCluster();
            else if (mode === 'force')      _layoutForceDirected();
            else if (mode === 'concentric') _layoutConcentric();
            else if (mode === 'hierarchy')  _layoutHierarchy();
            else if (mode === 'spiral')     _layoutSpiral();
            else                            _layoutFibonacci();
            _updateAllEdges();
            Object.keys(layoutToggles).forEach(function (k) {
                layoutToggles[k].classList.toggle('is-on', k === mode);
            });
        }

        function _addLayoutToggle(mode, text, swatchText) {
            var item = document.createElement('div');
            item.className = 'cvchat-graph-legend-item'
                + (mode === currentLayout ? ' is-on' : '');
            var swatch = document.createElement('span');
            swatch.className = 'cvchat-graph-legend-swatch cvchat-graph-legend-swatch-text';
            swatch.textContent = swatchText;
            item.appendChild(swatch);
            var lbl = document.createElement('span');
            lbl.className = 'cvchat-graph-legend-label';
            lbl.textContent = text;
            item.appendChild(lbl);
            item.addEventListener('click', function () {
                _setLayout(mode);
            });
            legendEl.appendChild(item);
            layoutToggles[mode] = item;
        }
        _addLayoutToggle('fibonacci',  'Fibonacci',  '❋');
        _addLayoutToggle('cluster',    'Cluster',    '▦');
        _addLayoutToggle('force',      'Force',      '⚛');
        _addLayoutToggle('concentric', 'Concentric', '◎');
        _addLayoutToggle('hierarchy',  'Hierarchy',  '⫶');
        _addLayoutToggle('spiral',     'Spiral',     '꩜');

        // currentLayout = 'cluster' by default, but the meshes were
        // initially positioned by Fibonacci's _placeSphere calls at
        // mount time. Apply the cluster layout once now so the first
        // frame matches the active legend selection. Also fold in the
        // initial visibility state (community hidden, edge labels off)
        // via _applyVisibility.
        _layoutCluster();
        _updateAllEdges();
        _applyVisibility();

        return {
            dispose: function () {
                if (disposed) return;
                disposed = true;
                if (rafId !== null) cancelAnimationFrame(rafId);
                if (ro) ro.disconnect();
                window.removeEventListener('resize', _resize);
                controls.dispose();
                renderer.dispose();
                sphereGeo.dispose();
                sprites.forEach(function (s) {
                    if (s.material) {
                        if (s.material.map) s.material.map.dispose();
                        s.material.dispose();
                    }
                });
                if (renderer.domElement && renderer.domElement.parentNode) {
                    renderer.domElement.parentNode.removeChild(renderer.domElement);
                }
            }
        };
    }

    // CommonMark treats `[label]: url` at line-start as a link reference
    // DEFINITION and strips it from the rendered output. The model often
    // writes its chain-of-thought as `[markdown_chunk:abc]: explanation`
    // (a citation followed by a colon-separated note) — pattern that
    // matches the link-reference syntax exactly. Without neutralising,
    // those citations disappear from the rendered Thinking section and
    // never reach the citation walker. Inserting a non-breaking space
    // between `]` and `:` defeats the link-reference recognition while
    // staying invisible to the user and leaving the `[...]` tag intact
    // for the citation regex.
    var _LINK_REF_BREAKER = new RegExp(
        '^([ \\t]*\\[(?:(?:' + CITE_PART + ')(?:\\s*,\\s*(?:' + CITE_PART + '))*)\\])[ \\t]*:',
        'gm');
    // The model often indents an "evidence review" list under a heading
    // (4+ leading spaces). CommonMark turns 4-space-indented lines into a
    // <pre><code> block, and the citation walker skips pre/code - so those
    // citations are never badged. Strip the leading indent ONLY when it is
    // immediately followed by a citation tag, so the line renders as normal
    // (badged) text while genuine indented code (no citation tag) stays a
    // code block untouched.
    var _CITE_DEINDENT = new RegExp(
        '^[ \\t]{4,}(?=\\[(?:' + CITE_PART + '))', 'gm');
    // The model often wraps citation tags in backticks when listing them
    // in its evidence-scan phase (e.g. `- ` + `[markdown_chunk:abc]` +
    // ` - note`). Backticks make marked emit <code>[markdown_chunk:...]</code>
    // and the citation walker correctly rejects text inside <code>, so the
    // tag never gets badged. Citation tags are never literal code in this
    // chat, so strip the wrapping backticks before marked sees them.
    var _CITE_DEBACKTICK = new RegExp(
        '`(\\[(?:(?:' + CITE_PART + ')(?:\\s*,\\s*(?:' + CITE_PART + '))*)\\])`',
        'g');
    function neutralizeCitationLinkRefs(text) {
        text = String(text || '').replace(_CITE_DEINDENT, '');
        text = text.replace(_CITE_DEBACKTICK, '$1');
        return text.replace(_LINK_REF_BREAKER, '$1 :');
    }

    function sendMessage(rawText) {
        var text = (rawText || '').trim();
        if (!text || state.streaming) {
            console.warn('[cvchat] sendMessage early-return',
                'textLen=' + text.length, 'streaming=' + state.streaming);
            return;
        }
        var turnId = Math.random().toString(36).slice(2, 8);

        stopTtsPlayback();                       // barge-in: a new turn cancels speech

        addMessage('user', escapeHtml(text).replace(/\n/g, '<br>'));
        input.value = '';
        autoGrow();
        hidePopover();

        state.streaming = true;
        sendBtn.disabled = true;

        var bubble = addMessage('assistant', '');
        bubble.innerHTML = '<span class="cvchat-typing"><span></span><span></span><span></span></span>';
        var numbering = new Map();
        var parser = new ThinkingParser();
        var body = '';                 // accumulated answer text (post-</think>, voice stripped)
        var gotFirst = false;
        // TTS is dispatched the moment the spoken-summary block closes,
        // not at end-of-turn. Tracked here so finishTurn doesn't double-speak.
        var turnState = { ttsDispatched: false };

        function handleEvent(ev) {
            switch (ev.type) {
                case 'thinking_end':
                    if (ev.answer) body += ev.answer;
                    if (parser.voiceText && !turnState.ttsDispatched && state.ttsOn) {
                        turnState.ttsDispatched = true;
                        speak(parser.voiceText, 'early-voice');
                    }
                    break;
                case 'answer_token':
                    body += ev.token;
                    break;
                case 'voice':
                    if (!turnState.ttsDispatched && state.ttsOn && parser.voiceText) {
                        turnState.ttsDispatched = true;
                        speak(parser.voiceText, 'early-voice');
                    }
                    break;
                // thinking_start, thinking_token, pending: no-op (render reads parser state)
            }
        }

        // Captured from the final `meta` SSE event the server emits
        // just before [DONE]. Carries turn_id (for the async judge
        // fetch) plus the cheap retrieval stats used to compute the
        // instant score.
        var metaData = null;
        // Performance timings: TTFT (first delta) + Total (stream done),
        // both relative to t0 (just before POSTing to /api/chat).
        var t0 = performance.now();
        var tFirst = null;

        // job2cool: reset the document tabs at the start of each new turn.
        try { if (window.JOB2COOL_NEW_TURN) window.JOB2COOL_NEW_TURN(); } catch (e) {}

        fetch(API + '/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text, history: state.history, config: window.JOB2COOL_CONFIG || {} })
        }).then(function (resp) {
            if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
            var reader = resp.body.getReader();
            var dec = new TextDecoder();
            var buf = '';

            function pump() {
                return reader.read().then(function (res) {
                    if (res.done) return;
                    buf += dec.decode(res.value, { stream: true });
                    var nl = buf.split('\n');
                    buf = nl.pop();
                    for (var j = 0; j < nl.length; j++) {
                        var t = nl[j].trim();
                        if (t.indexOf('data:') !== 0) continue;
                        var data = t.slice(5).trim();
                        if (data === '[DONE]' || !data) continue;
                        var obj;
                        try { obj = JSON.parse(data); } catch (e) { continue; }
                        if (obj.error) throw new Error(obj.error);
                        if (obj.meta) {
                            metaData = obj.meta;
                            continue;
                        }
                        if (obj.delta) {
                            if (!gotFirst) {
                                gotFirst = true;
                                tFirst = performance.now();
                                bubble.innerHTML = '';
                            }
                            handleEvent(parser.processToken(obj.delta));
                            renderParserBubble(bubble, parser, body, numbering);
                            scrollToBottom();
                        }
                    }
                    return pump();
                });
            }
            return pump();
        }).then(function () {
            var timings = {
                ttft_ms: tFirst != null ? Math.round(tFirst - t0) : null,
                total_ms: Math.round(performance.now() - t0)
            };
            finishTurn(bubble, text, parser, body, gotFirst, numbering, null,
                turnState.ttsDispatched, turnId, metaData, timings);
        }).catch(function (err) {
            var timings = {
                ttft_ms: tFirst != null ? Math.round(tFirst - t0) : null,
                total_ms: Math.round(performance.now() - t0)
            };
            finishTurn(bubble, text, parser, body, gotFirst, numbering, err,
                turnState.ttsDispatched, turnId, metaData, timings);
        });
    }

    // Compute the per-turn scoreData rendered as the inline Score
    // pill: cheap signals (citation rate, evidence coverage) plus
    // performance timings (TTFT, total). RAGAS faithfulness +
    // answer_relevance start undefined and are filled in by the
    // background judge fetch.
    function _computeScoreData(numbering, metaData, timings) {
        var citedChunks = 0, citedEntities = 0, citedEdges = 0;
        if (numbering && typeof numbering.forEach === 'function') {
            numbering.forEach(function (_ord, tag) {
                if (tag.indexOf('markdown_chunk:') === 0) citedChunks++;
                else if (tag.indexOf('E:') === 0) citedEntities++;
                else if (tag.indexOf('R:') === 0) citedEdges++;
            });
        }
        var meta = metaData || {};
        var retrievedChunks = meta.retrieved_chunks || 0;
        var retrievedEntities = meta.retrieved_entities || 0;
        var retrievedEdges = meta.retrieved_edges || 0;
        // evidence_coverage is computed over CHUNKS ONLY (rag chunks +
        // graph chunk_excerpts, already merged server-side). The earlier
        // composite citation_rate included entities/edges in the
        // denominator, but the model rarely cites those by design - so
        // folding them in dilutes the signal and inflates the apparent
        // "context noise" without telling us anything new.
        var evidenceCoverage = retrievedChunks
            ? Math.min(1, citedChunks / retrievedChunks) : 0;
        return {
            turn_id: meta.turn_id || null,
            evidence_coverage: evidenceCoverage,
            avg_similarity: meta.avg_similarity || 0,
            retrieved: { chunks: retrievedChunks,
                         entities: retrievedEntities,
                         edges: retrievedEdges },
            cited:     { chunks: citedChunks, entities: citedEntities,
                         edges: citedEdges },
            faithfulness: null,
            answer_relevance: null,
            judge_rationale: null,
            judge_pending: !!meta.turn_id,
            ttft_ms: timings ? timings.ttft_ms : null,
            total_ms: timings ? timings.total_ms : null
        };
    }

    // Composite 0-1 across the metrics that have a value. RAGAS axes
    // (faithfulness, answer_relevance) are weighted 2x because they
    // reflect actual answer quality; evidence_coverage is a structural
    // signal kept at weight 1 so the composite is non-zero even before
    // the judge pass returns.
    function _scoreComposite(s) {
        var parts = [
            { v: s.evidence_coverage, w: 1 }
        ];
        if (s.faithfulness != null)     parts.push({ v: s.faithfulness, w: 2 });
        if (s.answer_relevance != null) parts.push({ v: s.answer_relevance, w: 2 });
        var num = 0, den = 0;
        parts.forEach(function (p) {
            if (p.v == null) return;
            num += p.v * p.w; den += p.w;
        });
        return den ? num / den : 0;
    }

    function finishTurn(bubble, userText, parser, body, gotFirst, numbering, err, ttsDispatched, turnId, metaData, timings) {
        state.streaming = false;
        sendBtn.disabled = false;

        if (err) {
            if (!gotFirst) bubble.innerHTML = '';
            var e = document.createElement('div');
            e.className = 'cvchat-error';
            e.textContent = 'Sorry - I could not answer just now.' +
                (err && err.message ? ' (' + err.message + ')' : '');
            bubble.appendChild(e);
        } else if (!body.trim() && !(parser.thinkingBuffer && parser.thinkingBuffer.trim())) {
            bubble.innerHTML = '';
            var e2 = document.createElement('div');
            e2.className = 'cvchat-error';
            e2.textContent = 'Sorry - I did not get a response. Please try again.';
            bubble.appendChild(e2);
        } else {
            // Initial render with cheap signals only - the judge
            // fetch below fills the RAGAS axes in a second pass.
            var scoreData = _computeScoreData(numbering, metaData, timings);
            // Push the live reference into session history so running
            // averages in the Score body update automatically when the
            // judge response mutates this object later.
            state.scoreHistory.push(scoreData);
            renderParserBubble(bubble, parser, body, numbering, null, scoreData);
            state.history.push({ role: 'user', content: userText });
            state.history.push({ role: 'assistant', content: body });
            // Only fall back to speaking at end if early-TTS-on-</voice>
            // didn't already fire mid-stream.
            if (state.ttsOn && !ttsDispatched) {
                if (parser.voiceText) {
                    speak(parser.voiceText, 'finish-voice');
                } else if (body.trim()) {
                    speak(body, 'finish-body');
                }
            }
            // Background RAGAS judge - faithfulness + answer_relevance
            // - via cv-backend /api/score_answer. Fails soft: if the
            // judge errors out we keep showing the cheap composite.
            if (scoreData.turn_id) {
                fetch(API + '/score_answer', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ turn_id: scoreData.turn_id })
                }).then(function (r) {
                    return r.ok ? r.json() : null;
                }).then(function (j) {
                    scoreData.judge_pending = false;
                    if (!j || j.error) {
                        scoreData.judge_error = (j && j.error) || 'judge unavailable';
                    } else {
                        scoreData.faithfulness = j.faithfulness;
                        scoreData.answer_relevance = j.answer_relevance;
                        scoreData.judge_rationale = j.rationale || null;
                    }
                    renderParserBubble(bubble, parser, body, numbering,
                        bubble._traceData || null, scoreData);
                }).catch(function (e) {
                    scoreData.judge_pending = false;
                    scoreData.judge_error = String(e && e.message || e);
                    renderParserBubble(bubble, parser, body, numbering,
                        bubble._traceData || null, scoreData);
                });
            }
            // After stream-end, fetch the aggregated trace and re-
            // render the bubble with the inline "Graph" toggle. Seeds
            // come from BOTH the directly-cited [E:...] entities AND
            // any cited [markdown_chunk:...] tags (the backend
            // resolves chunks -> entities via noted-graph's retrieval
            // per_entity_chunks map). The chunk-derived seeds matter
            // because the model mostly cites chunks, not entities.
            var entityIds = [];
            var chunkIds = [];
            numbering.forEach(function (_ord, tag) {
                if (tag.indexOf('E:') === 0) entityIds.push(tag.slice(2));
                else if (tag.indexOf('markdown_chunk:') === 0) chunkIds.push(tag);
            });
            if (entityIds.length || chunkIds.length) {
                fetch(API + '/graph_trace', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        entity_ids: entityIds,
                        chunk_ids: chunkIds,
                        message: userText
                    })
                }).then(function (r) {
                    return r.ok ? r.json() : null;
                }).then(function (trace) {
                    // Mark resolved either way so the Graph toggle stops
                    // showing "Loading…" - it becomes the graph if there
                    // are entities, or disappears if the trace is empty
                    // (dense-corpus citations that don't map to the graph).
                    bubble._graphResolved = true;
                    var hasEnts = !!(trace && trace.entities && trace.entities.length);
                    bubble._traceData = hasEnts ? trace : null;
                    renderParserBubble(bubble, parser, body, numbering,
                        bubble._traceData, scoreData);
                }).catch(function (e) {
                    console.warn('[cvchat] graph_trace fetch failed:', e);
                    bubble._graphResolved = true;
                    bubble._traceData = null;
                    renderParserBubble(bubble, parser, body, numbering, null, scoreData);
                });
            } else {
                // No graph-relevant citations at all - nothing to resolve.
                bubble._graphResolved = true;
            }
        }
        scrollToBottom();
        if (document.body.classList.contains('cvchat-open')) input.focus();
    }

    // ======================================================================
    // STT - microphone -> stt_server -> transcript
    // ======================================================================
    async function startSTT() {
        if (typeof io === 'undefined') {
            notice('Voice is unavailable (the socket library failed to load).');
            return false;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            notice('Voice input is not supported by this browser.');
            return false;
        }
        try {
            stt.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1, echoCancellation: true,
                    noiseSuppression: true, autoGainControl: true
                }
            });
            stt.ctx = new (window.AudioContext || window.webkitAudioContext)();
            await stt.ctx.audioWorklet.addModule('static/widget/recorder-worklet.js');
            stt.source = stt.ctx.createMediaStreamSource(stt.stream);
            stt.node = new AudioWorkletNode(stt.ctx, 'recorder-worklet');
            stt.resampler = new AudioResampler(stt.ctx.sampleRate, 16000);

            // Client-side Silero VAD (vad-web + onnxruntime-web). Best-effort:
            // if the globals or assets fail to load, STT still works (the
            // server does its own endpointing) - only barge-in + the live
            // "listening" pulse are lost. numThreads = 1 avoids needing
            // SharedArrayBuffer / COOP-COEP headers.
            try {
                if (window.vad && window.vad.MicVAD && window.ort) {
                    var ortBase = new URL('static/widget/vendor/onnxruntime-web/', window.location.href).href;
                    var vadBase = new URL('static/widget/vendor/vad/', window.location.href).href;
                    window.ort.env.wasm.wasmPaths = ortBase;
                    window.ort.env.wasm.numThreads = 1;
                    stt.vad = await window.vad.MicVAD.new({
                        stream: stt.stream,
                        baseAssetPath: vadBase,
                        onnxWASMBasePath: ortBase,
                        model: 'legacy',
                        positiveSpeechThreshold: 0.6,
                        onSpeechStart: function () {
                            if (state.ttsPlaying) stopTtsPlayback();  // voice barge-in
                            micBtn.classList.add('listening');
                            // Open the send gate; cancel any pending post-roll
                            // close so a brief mid-utterance pause doesn't cut
                            // the stream.
                            stt.speaking = true;
                            if (stt.postRollTimer) {
                                clearTimeout(stt.postRollTimer);
                                stt.postRollTimer = null;
                            }
                        },
                        onSpeechEnd: function () {
                            micBtn.classList.remove('listening');
                            // POST-ROLL: keep streaming ~0.9s after speech ends
                            // (slightly longer than the server's 0.8s
                            // silence_duration) so the server sees real trailing
                            // silence and endpoints the utterance cleanly, then
                            // close the gate.
                            if (stt.postRollTimer) clearTimeout(stt.postRollTimer);
                            stt.postRollTimer = setTimeout(function () {
                                stt.speaking = false;
                                stt.postRollTimer = null;
                            }, 900);
                        },
                        onVADMisfire: function () { micBtn.classList.remove('listening'); }
                    });
                    stt.vad.start();
                }
            } catch (vadErr) {
                stt.vad = null;
            }

            stt.socket = io(ORIGIN, {
                path: STT_PATH, transports: ['websocket', 'polling'],
                forceNew: true, timeout: SOCKET_TIMEOUT
            });
            stt.socket.on('connect', function () {
                console.log('[cvchat stt] connected, sid=', stt.socket.id);
            });
            stt.socket.on('disconnect', function (reason) {
                console.warn('[cvchat stt] disconnected:', reason,
                    '(audio sends will silently drop until reconnect or page reload)');
            });
            stt.socket.on('connect_error', function (err) {
                console.warn('[cvchat stt] connect_error:', err && err.message);
            });
            stt.socket.on('transcription', onTranscription);
            stt.socket.on('transcription_partial', onPartial);
            stt.packetCount = 0;
            stt.transcriptionCount = 0;
            stt.lastSendAt = 0;
            stt.lastLogAt = 0;
            // Gate state. If the client VAD loaded, start gated (wait for
            // speech). If it didn't (best-effort fallback), leave the gate
            // open so we degrade to the old continuous stream, never mute.
            stt.speaking = stt.vad ? false : true;
            stt.sending = false;
            stt.preRoll = [];
            if (stt.postRollTimer) { clearTimeout(stt.postRollTimer); stt.postRollTimer = null; }

            var perPacket = Math.round(stt.ctx.sampleRate * PACKET_SECONDS);
            var pending = [], pendingLen = 0;
            stt.node.port.onmessage = function (ev) {
                var chunk = ev.data;
                if (!chunk || !chunk.length) return;
                pending.push(chunk);
                pendingLen += chunk.length;
                if (pendingLen < perPacket) return;
                var merged = new Float32Array(pendingLen), o = 0;
                for (var k = 0; k < pending.length; k++) {
                    merged.set(pending[k], o);
                    o += pending[k].length;
                }
                pending = []; pendingLen = 0;
                // Gate while our own TTS plays - never transcribe the reply.
                // The VAD keeps running, so a real spoken interruption fires
                // onSpeechStart -> stopTtsPlayback, which re-opens this gate.
                if (state.ttsPlaying) { stt.resampler.pushFloat32(merged); return; }
                var pcm = stt.resampler.pushFloat32(merged);
                if (!pcm || !pcm.length) return;

                if (!(stt.socket && stt.socket.connected)) {
                    // pcm produced but socket not connected - the cause of
                    // "STT silently stops working" from the user's report.
                    console.warn('[cvchat stt] PCM ready but socket not connected,',
                        'connected=' + (stt.socket && stt.socket.connected),
                        'ctx.state=' + (stt.ctx && stt.ctx.state));
                    return;
                }

                if (!stt.speaking) {
                    // Between utterances: retain a short pre-roll, send nothing.
                    // This is the fix for the 30s-buffer pin: the server only
                    // gets audio while the user is actually speaking, so its
                    // rolling buffer drains every turn instead of growing
                    // unbounded on a continuous stream.
                    stt.preRoll.push(pcm);
                    if (stt.preRoll.length > stt.preRollMax) stt.preRoll.shift();
                    stt.sending = false;
                    return;
                }

                // Speaking. On the rising edge, flush the pre-roll first so the
                // word onset captured just before the VAD fired isn't clipped.
                if (!stt.sending) {
                    for (var pr = 0; pr < stt.preRoll.length; pr++) {
                        stt.socket.emit('audio_data', {
                            clientId: clientId, audioData: stt.preRoll[pr].buffer
                        });
                        stt.packetCount++;
                    }
                    stt.preRoll = [];
                    stt.sending = true;
                }
                stt.socket.emit('audio_data', {
                    clientId: clientId, audioData: pcm.buffer
                });
                stt.packetCount++;
                stt.lastSendAt = Date.now();
            };
            stt.source.connect(stt.node);
            stt.node.connect(stt.ctx.destination);  // worklet output is silent
            return true;
        } catch (e) {
            cleanupSTT();
            notice(e && e.name === 'NotAllowedError'
                ? 'Microphone permission was denied.'
                : 'Voice input could not be started.');
            return false;
        }
    }

    function onTranscription(payload) {
        var text = (payload && payload.text || '').trim();
        stt.transcriptionCount = (stt.transcriptionCount || 0) + 1;
        micBtn.classList.remove('listening');
        if (text) sendMessage(text);
    }

    function onPartial(payload) {
        // Interim transcript (only some STT builds emit it). The VAD owns
        // the "listening" pulse; here we just show the live text.
        var text = (payload && payload.text || '').trim();
        if (text) {
            input.value = text;
            autoGrow();
        }
    }

    function cleanupSTT() {
        if (stt.postRollTimer) { clearTimeout(stt.postRollTimer); stt.postRollTimer = null; }
        try { if (stt.vad) { stt.vad.pause(); if (stt.vad.destroy) stt.vad.destroy(); } } catch (e) {}
        try { if (stt.node) stt.node.port.onmessage = null; } catch (e) {}
        try { if (stt.source) stt.source.disconnect(); } catch (e) {}
        try { if (stt.node) stt.node.disconnect(); } catch (e) {}
        try { if (stt.stream) stt.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        try { if (stt.ctx) stt.ctx.close(); } catch (e) {}
        try { if (stt.socket) stt.socket.disconnect(); } catch (e) {}
        stt.node = stt.source = stt.stream = stt.ctx = stt.socket = stt.resampler = stt.vad = null;
    }

    function toggleMic() {
        if (state.sttOn) {
            state.sttOn = false;
            micBtn.classList.remove('active', 'listening');
            cleanupSTT();
            return;
        }
        micBtn.disabled = true;
        startSTT().then(function (ok) {
            micBtn.disabled = false;
            if (ok) {
                state.sttOn = true;
                micBtn.classList.add('active');
            }
        });
    }

    // ======================================================================
    // TTS - answer text -> tts_server -> spoken audio
    // ======================================================================
    // `forAvatar`: register the connection so the TTS server forwards audio
    // to the avatar server instead of streaming it back to this browser.
    // Both pieces (register_audio_client mode + set_client_mode) are emitted
    // exactly once at connect time - re-registering on an already-connected
    // socket does not change routing reliably, so callers should cleanupTTS()
    // and call startTTS(forAvatar) again to flip mode.
    function startTTS(forAvatar) {
        if (typeof io === 'undefined') {
            notice('Spoken replies are unavailable (the socket library failed to load).');
            return Promise.resolve(false);
        }
        var connMode = forAvatar ? 'avatar_only' : 'tts';
        var routeMode = forAvatar ? 'avatar' : 'tts';
        tts.ctx = new (window.AudioContext || window.webkitAudioContext)();
        var resumed = tts.ctx.resume ? tts.ctx.resume() : Promise.resolve();
        return resumed.catch(function () {}).then(function () {
            // Query string mirrors the avatar_server reference exactly -
            // (client_id, format). Some routing decisions on the TTS server
            // key off the query, so any deviation can stop audio from
            // reaching the avatar.
            tts.socket = io(ORIGIN, {
                path: TTS_PATH, transports: ['websocket', 'polling'],
                forceNew: true, timeout: SOCKET_TIMEOUT,
                query: { client_id: clientId, format: 'binary' }
            });
            return new Promise(function (resolve) {
                tts.socket.once('connect', function () { resolve(true); });
                tts.socket.once('connect_error', function () { resolve(false); });
            });
        }).then(function (connected) {
            if (!connected) {
                cleanupTTS();
                notice('Could not connect to the voice service.');
                return false;
            }
            tts.socket.emit('register_audio_client', {
                main_client_id: clientId, connection_type: 'browser',
                mode: connMode, format: 'binary',
                voice: TTS_DEFAULT_VOICE, speed: TTS_SPEED
            });
            tts.socket.emit('tts_configure_client', {
                client_id: clientId, voice: TTS_DEFAULT_VOICE, speed: TTS_SPEED
            });
            tts.socket.emit('set_client_mode', {
                mode: routeMode, client_id: clientId
            });
            tts.socket.on('tts_audio_chunk', onTtsChunk);
            tts.socket.on('tts_stop_immediate', function () { stopTtsLocal(); });
            tts.queue = Promise.resolve();
            tts.activeCount = 0;
            tts.bargedIn = false;
            tts.currentVoice = TTS_DEFAULT_VOICE;
            return true;
        }).catch(function () {
            cleanupTTS();
            notice('Spoken replies could not be started.');
            return false;
        });
    }

    function onTtsChunk(evt) {
        // When the avatar is active the TTS server should be routing audio to
        // it instead of back to us, but guard locally too so we never play
        // a chunk that slipped through during a routing-mode transition.
        if (state.avatarOn) {
            // Make this loud - if the server is still forwarding audio to
            // the browser while the avatar is on, two audio paths could be
            // overlapping (avatar video's muxed audio + this local path).
            // We discard here, but the warning tells us the server's
            // routing isn't actually honoring our 'avatar_only' mode.
            tts.bypassedWhileAvatar = (tts.bypassedWhileAvatar || 0) + 1;
            if (tts.bypassedWhileAvatar === 1 || tts.bypassedWhileAvatar % 25 === 0) {
                console.warn('[cvchat tts] discarded chunk while avatar is on',
                    '(count=' + tts.bypassedWhileAvatar + ').',
                    'If you see this, server is still echoing audio back to',
                    'us despite mode=avatar_only - audio path may be',
                    'duplicated.');
            }
            return;
        }
        var buf = evt && evt.audio_buffer;
        if (!buf || tts.bargedIn || !tts.ctx) return;
        var ab;
        if (buf instanceof ArrayBuffer) ab = buf.slice(0);
        else if (buf && buf.buffer) ab = buf.buffer.slice(0);
        else return;
        tts.ctx.decodeAudioData(ab).then(function (audioBuf) {
            if (tts.bargedIn || !tts.ctx) return;
            tts.activeCount++;
            setSpeaking(true);
            tts.queue = tts.queue.then(function () {
                return new Promise(function (res) {
                    if (tts.bargedIn || !tts.ctx) {
                        tts.activeCount = Math.max(0, tts.activeCount - 1);
                        if (!tts.activeCount) setSpeaking(false);
                        return res();
                    }
                    var src = tts.ctx.createBufferSource();
                    src.buffer = audioBuf;
                    src.connect(tts.ctx.destination);
                    tts.current = src;
                    src.onended = function () {
                        if (tts.current === src) tts.current = null;
                        tts.activeCount = Math.max(0, tts.activeCount - 1);
                        if (!tts.activeCount) setSpeaking(false);
                        res();
                    };
                    try { src.start(); } catch (e) { res(); }
                });
            });
        }).catch(function () {});
    }

    function setSpeaking(on) {
        state.ttsPlaying = on;
        speakerBtn.classList.toggle('speaking', on);
    }

    function sanitizeForTTS(text) {
        return String(text)
            // Strip thinking + voice tags entirely. The angle brackets get
            // eaten by later markdown rules but the bare word ("think"/
            // "voice") would survive and TTS would say it aloud. Defense
            // in depth: ThinkingParser should already have given us tag-
            // less content, but if anything slips through it dies here.
            .replace(/<think>[\s\S]*?<\/think>/gi, '')   // never speak reasoning
            .replace(/<think>[\s\S]*$/i, '')
            .replace(/<\/?think>/gi, '')
            .replace(/<voice>[\s\S]*?<\/voice>/gi, '')   // never re-speak a wrapped voice block
            .replace(/<voice>[\s\S]*$/i, '')
            .replace(/<\/?voice>/gi, '')
            .replace(/```[\s\S]*?```/g, ' ')
            .replace(/\[(?:markdown_chunk|E|R):[^\]]+\]/g, '')
            .replace(/\[C\d+\]/g, '')
            .replace(/\[[0-9a-f]{8,16}\]/g, '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/^\s*#{1,6}\s+/gm, '')
            .replace(/^\s*[-*+]\s+/gm, '')
            .replace(/^\s*\d+[.)]\s+/gm, '')
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/\n{2,}/g, '. ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function speak(text, source) {
        if (!tts.socket || !tts.socket.connected) {
            console.warn('[cvchat tts] speak() but TTS socket not connected');
            return;
        }
        // In avatar mode, defer until the avatar server has registered
        // itself with the TTS server (avatar.ttsReady). Otherwise the
        // FIRST tts_text_chunk after enabling avatar (e.g. when the
        // launcher click both opens the chat AND turns on avatar mode,
        // and the user immediately sends a message) is silently dropped
        // - the avatar isn't yet in the TTS server's audio_client_mapping
        // so the speech never reaches it and Diana stays still.
        if (state.avatarOn && !avatar.ttsReady) {
            waitForTtsReady().then(function () { speak(text, source); });
            return;
        }
        var clean = sanitizeForTTS(text);
        if (!clean) return;
        tts.bargedIn = false;
        // Auto-switch the Kokoro voice to match the answer's language
        // (mirrors noted). The configure event must precede the text chunk
        // so the right language pipeline is resolved server-side.
        var targetVoice = TTS_LANGUAGE_VOICE_MAP[detectKokoroLanguage(clean)]
            || TTS_DEFAULT_VOICE;
        if (targetVoice !== tts.currentVoice) {
            tts.socket.emit('tts_configure_client', {
                client_id: clientId, voice: targetVoice
            });
            tts.currentVoice = targetVoice;
        }
        console.log('[cvchat tts] emitting tts_text_chunk source=', source,
                    'len=', clean.length, 'avatarOn=', state.avatarOn);
        tts.socket.emit('tts_text_chunk', {
            chunk: clean, target_client_id: clientId, final: true
        });
    }

    // Stop local playback only - does NOT notify the server. Used when the
    // server itself signalled the stop (tts_stop_immediate): emitting
    // stop_generation back would create an infinite stop<->stop loop.
    function stopTtsLocal() {
        tts.bargedIn = true;
        try { if (tts.current) tts.current.stop(); } catch (e) {}
        tts.current = null;
        tts.activeCount = 0;
        tts.queue = Promise.resolve();
        setSpeaking(false);
    }

    // User-initiated barge-in: stop local playback AND tell the server to
    // stop generating.
    function stopTtsPlayback() {
        stopTtsLocal();
        if (tts.socket && tts.socket.connected) {
            tts.socket.emit('stop_generation', {
                client_id: clientId, reason: 'user_interrupted'
            });
        }
    }

    function cleanupTTS() {
        stopTtsLocal();
        try { if (tts.socket) tts.socket.disconnect(); } catch (e) {}
        try { if (tts.ctx) tts.ctx.close(); } catch (e) {}
        tts.socket = null;
        tts.ctx = null;
    }

    // Speaker and Avatar are mutually exclusive but either can be off:
    //   'silent'  -> both off, TTS socket torn down
    //   'speaker' -> TTS on, audio played locally via AudioContext
    //   'avatar'  -> TTS on, audio routed to avatar server (no local playback)
    // setMode is the single source of truth for transitioning between them.
    function setMode(mode) {
        var current = state.avatarOn ? 'avatar' : (state.ttsOn ? 'speaker' : 'silent');
        if (mode === current) return Promise.resolve(true);

        speakerBtn.disabled = true;
        avatarBtn.disabled = true;

        // Always re-enable buttons at the end, even if anything inside the
        // chain throws. Without this safety net a single bug can lock the
        // UI permanently.
        function reenable() {
            speakerBtn.disabled = false;
            avatarBtn.disabled = false;
        }

        // ALWAYS tear down the existing TTS + avatar pipelines before
        // setting up the target mode. The TTS server's audio routing is
        // determined by the register_audio_client + set_client_mode pair
        // emitted on connect; trying to mutate routing on an established
        // socket is unreliable. A fresh socket per mode change is cleaner.
        if (state.avatarOn) {
            state.avatarOn = false;
            avatarBtn.classList.remove('active');
            cleanupAvatar();
            // Pull the stage out of wherever it is (bubble or panel) so
            // the bubble's normal layout is restored, then close the
            // floating panel if any. Don't run the panel's onclosed
            // silent-drop here - we're already doing the drop.
            detachAvatarStage();
            destroyAvatarPanel(true);
        }
        if (state.ttsOn) {
            state.ttsOn = false;
            speakerBtn.classList.remove('active', 'speaking');
            cleanupTTS();
        }

        if (mode === 'silent') {
            reenable();
            return Promise.resolve(true);
        }

        var forAvatar = (mode === 'avatar');

        var chain = startTTS(forAvatar).then(function (ttsOk) {
            if (!ttsOk) return false;
            state.ttsOn = true;

            if (mode === 'speaker') {
                speakerBtn.classList.add('active');
                return true;
            }
            // mode === 'avatar' - bring up the avatar socket + place the
            // stage. mountAvatar() picks docked-in-bubble vs floating
            // panel based on state.avatarDocked (defaults to docked).
            return mountAvatar().then(function (mountOk) {
                if (!mountOk) return false;
                return startAvatar().then(function (avatarOk) {
                    if (!avatarOk) {
                        detachAvatarStage();
                        destroyAvatarPanel(true);
                        return false;
                    }
                    // Block setMode from returning until the avatar server
                    // has registered itself with the TTS server. Without
                    // this, the FIRST tts_text_chunk after toggling avatar
                    // on is silently dropped (avatar_server isn't in
                    // audio_client_mapping yet).
                    return waitForTtsReady().then(function () {
                        state.avatarOn = true;
                        avatarBtn.classList.add('active');
                        if (state.ttsPlaying) stopTtsLocal();
                        return true;
                    });
                });
            });
        });

        return chain
            .catch(function (e) {
                console.warn('[cvchat] setMode error:', e);
                return false;
            })
            .then(function (result) {
                reenable();
                return result;
            });
    }

    function toggleSpeaker() {
        setMode(state.ttsOn && !state.avatarOn ? 'silent' : 'speaker');
    }

    // ======================================================================
    // Avatar - lip-synced talking head over Socket.IO + MediaSource Extensions.
    // The avatar server reads audio that the TTS server forwards to it (keyed
    // by client_id) and pushes muxed fMP4 chunks back to us as
    // 'avatar_video_chunk'. See ~/env/assets/avatar_server/documents/
    // client_integration.md for the full protocol.
    // ======================================================================
    function setAvatarStatus(text, sticky) {
        if (!avatarStatus) return;
        if (avatar.statusHideTimer) {
            clearTimeout(avatar.statusHideTimer);
            avatar.statusHideTimer = null;
        }
        if (!text) {
            avatarStatus.setAttribute('hidden', '');
            return;
        }
        avatarStatus.textContent = text;
        avatarStatus.className = 'cvchat-avatar-status cvchat-avatar-status-' + text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        avatarStatus.removeAttribute('hidden');
        if (!sticky) {
            avatar.statusHideTimer = setTimeout(function () {
                avatarStatus.setAttribute('hidden', '');
            }, 2500);
        }
    }

    function startAvatar() {
        if (typeof io === 'undefined') {
            notice('Avatar is unavailable (the socket library failed to load).');
            return Promise.resolve(false);
        }
        if (!pickAvatarCodec()) {
            notice('Your browser does not support the avatar video format.');
            return Promise.resolve(false);
        }
        avatar.chunkCount = 0;
        setAvatarStatus('Connecting', true);
        avatar.socket = io(ORIGIN, {
            path: AVATAR_PATH, transports: ['websocket', 'polling'],
            forceNew: true, timeout: SOCKET_TIMEOUT, reconnection: true,
            // perMessageDeflate off — avatar chunks are already H.264-compressed
            // entropy, gzip can't help; pays only a small per-message latency.
            perMessageDeflate: false,
            query: { client_id: clientId }
        });
        // CRITICAL: attach event listeners *before* the connect handler
        // resolves. The avatar server emits 'avatar_init' immediately on
        // connect; if we wait until the connect promise resolves to bind
        // the listener, the init segment arrives in the same task and our
        // listener is one microtask late - the first media chunk then
        // hits MSE without ftyp+moov and the SourceBuffer errors.
        avatar.socket.on('avatar_init', onAvatarInit);
        avatar.socket.on('avatar_video_chunk', onAvatarChunk);
        avatar.socket.on('avatar_reset', onAvatarReset);
        avatar.socket.on('tts_ready', function (data) {
            console.log('[cvchat avatar] tts_ready:', data);
            // The avatar server emits this AFTER it has registered itself
            // with the TTS server for our client_id. Only then will any
            // tts_text_chunk we send actually be routed to the avatar.
            if (data && data.ready) {
                avatar.ttsReady = true;
                if (avatar.pendingTtsReady) {
                    avatar.pendingTtsReady();
                    avatar.pendingTtsReady = null;
                }
            }
        });
        avatar.socket.on('disconnect', function (reason) {
            console.warn('[cvchat avatar] disconnected:', reason);
            setAvatarStatus('Disconnected', true);
        });
        avatar.socket.io.on('reconnect', function () {
            // After Socket.IO auto-reconnect: rebuild the MSE pipeline,
            // reset chunkCount so the next first-chunk-arrived path fires
            // (which auto-hides the status overlay), and replace the
            // sticky 'Disconnected' status with the connecting state so
            // the message clears once chunks resume.
            avatar.chunkCount = 0;
            resetAvatarMediaSource();
            setAvatarStatus('Connecting', true);
        });
        // Build the MediaSource pipeline *now*, so the SourceBuffer is open
        // by the time chunks arrive. attachAvatarMediaSource is idempotent
        // (resets internal state and rebinds src).
        attachAvatarMediaSource();
        return new Promise(function (resolve) {
            avatar.socket.once('connect', function () {
                console.log('[cvchat avatar] connected, sid=', avatar.socket.id,
                            'client_id=', clientId);
                resolve(true);
            });
            avatar.socket.once('connect_error', function (err) {
                console.warn('[cvchat avatar] connect_error:', err && err.message);
                resolve(false);
            });
        }).then(function (connected) {
            if (!connected) {
                cleanupAvatar();
                notice('Could not connect to the avatar service.');
                return false;
            }
            setAvatarStatus('Connecting', true);
            return true;
        }).catch(function (e) {
            console.warn('[cvchat avatar] startAvatar caught:', e);
            cleanupAvatar();
            notice('Avatar could not be started.');
            return false;
        });
    }

    function pickAvatarCodec() {
        // Prefer ManagedMediaSource — iPhone Safari (iOS 17+) exposes ONLY
        // ManagedMediaSource and intentionally hides plain MediaSource, so a
        // check against `MediaSource` alone fails on iPhone. iPad and desktop
        // expose MediaSource; either implementation answers isTypeSupported.
        var MS = window.ManagedMediaSource || window.MediaSource;
        if (!MS || typeof MS.isTypeSupported !== 'function') return null;
        for (var i = 0; i < AVATAR_CODECS.length; i++) {
            if (MS.isTypeSupported(AVATAR_CODECS[i])) {
                return AVATAR_CODECS[i];
            }
        }
        return null;
    }

    function newAvatarMediaSource() {
        // Prefer Safari/iOS ManagedMediaSource when available.
        var Ctor = window.ManagedMediaSource || window.MediaSource;
        return new Ctor();
    }

    function attachAvatarMediaSource() {
        if (!avatarVideo) return;
        avatar.ms = newAvatarMediaSource();
        avatar.sb = null;
        avatar.pendingInit = null;
        avatar.queue = Promise.resolve();
        avatar.started = false;
        avatar.streamingPaused = false;
        avatar.pendingFeeds = [];
        // Don't pause() here - the upcoming src reassignment + load() resets
        // the element naturally, and pausing here aborts any prime play()
        // we did in the user-gesture handler (which would forfeit autoplay
        // credit for the upcoming chunks).
        avatarVideo.src = URL.createObjectURL(avatar.ms);
        try { avatarVideo.load(); } catch (e) {}
        // ManagedMediaSource (iOS 17+ Safari) backpressure protocol. MMS
        // manages decoder memory aggressively and tells the app via these
        // events when to throttle / resume. Ignoring them is the #1 way to
        // make playback silently freeze after a few chunks.
        if (window.ManagedMediaSource && avatar.ms instanceof window.ManagedMediaSource) {
            avatar.ms.addEventListener('startstreaming', function () {
                console.log('[cvchat avatar] MMS startstreaming - resuming feeds');
                avatar.streamingPaused = false;
                drainPendingAvatarFeeds();
            });
            avatar.ms.addEventListener('endstreaming', function () {
                console.log('[cvchat avatar] MMS endstreaming - pausing feeds (buffer pressure)');
                avatar.streamingPaused = true;
            });
        }
        avatar.ms.addEventListener('sourceopen', function () {
            try {
                avatar.codec = pickAvatarCodec();
                if (!avatar.codec) throw new Error('no supported codec');
                avatar.sb = avatar.ms.addSourceBuffer(avatar.codec);
                avatar.sb.mode = 'sequence';
                console.log('[cvchat avatar] SourceBuffer ready, codec=',
                            avatar.codec);
                avatar.sb.addEventListener('updateend', onSbUpdateEnd);
                avatar.sb.addEventListener('error', function (e) {
                    console.warn('[cvchat avatar] SourceBuffer error:', e);
                });
            } catch (e) {
                console.warn('[cvchat avatar] addSourceBuffer failed:', e);
                notice('Avatar codec init failed.');
            }
        }, { once: true });
    }

    // After each buffer append, decide whether we have enough headroom to
    // call play() for the first time. Mirrors the reference's manual
    // playback gating - relying on native autoplay is unreliable with audio.
    function onSbUpdateEnd() {
        if (avatar.started || !avatar.sb || !avatarVideo) return;
        if (!avatar.sb.buffered.length) return;
        var buf = avatar.sb.buffered;
        var dur = buf.end(buf.length - 1) - buf.start(0);
        if (dur < AVATAR_BUFFER_MIN_S) return;
        avatar.started = true;
        // Defensive: re-assert unmuted + audible right before play().
        // The audio is muxed into the fMP4 chunks - if the <video> element
        // is muted or volume-0, you'll see the face move silently.
        try {
            avatarVideo.muted = false;
            avatarVideo.volume = 1.0;
        } catch (e) {}
        var p = avatarVideo.play();
        if (p && typeof p.then === 'function') {
            p.catch(function (e) {
                console.warn('[cvchat avatar] play() rejected:', e.message);
                avatar.started = false;
            });
        }
    }

    function resetAvatarMediaSource() {
        avatar.pendingInit = null;
        attachAvatarMediaSource();
    }

    // The MSE init segment (ftyp+moov) is cached server-side and re-sent to
    // every joining socket via 'avatar_init'. Stash it; prepend to the next
    // media chunk so the decoder always sees init before media.
    function onAvatarInit(data) {
        if (!data || !data.mp4) return;
        avatar.pendingInit = new Uint8Array(data.mp4);
        console.log('[cvchat avatar] avatar_init received,',
                    avatar.pendingInit.byteLength, 'bytes');
    }

    // ffmpeg restarted server-side. The new fragments will have PTS=0,
    // colliding with what's already in the SourceBuffer. We:
    //   1. abort() any pending append so the buffer is in a stable state
    //   2. set timestampOffset = currentTime so PTS=0 of the new content
    //      lands where the playback head is right now (rather than at 0
    //      and getting buffered behind already-played content)
    //   3. stash the new init segment for prepending to the next chunk
    // Without this, MSE silently stalls on overlap.
    function onAvatarReset(data) {
        if (!data || !data.mp4) return;
        console.warn('[cvchat avatar] avatar_reset received (ffmpeg restarted),',
                     (data.mp4.byteLength || data.mp4.length), 'bytes new init');
        try {
            if (avatar.sb && avatar.sb.updating) {
                avatar.sb.abort();
            }
        } catch (e) {
            console.warn('[cvchat avatar] avatar_reset: sb.abort() failed:', e);
        }
        try {
            if (avatar.sb && avatarVideo) {
                avatar.sb.timestampOffset = avatarVideo.currentTime || 0;
            }
        } catch (e) {
            console.warn('[cvchat avatar] avatar_reset: timestampOffset set failed:', e);
        }
        avatar.pendingInit = new Uint8Array(data.mp4);
    }

    function onAvatarChunk(data) {
        if (!data) return;
        // Per-utterance boundary marker - keep the MSE stream open, no append.
        if (data.type === 'stream_end' || data.type === 'utterance_end') {
            return;
        }
        if (!data.mp4) return;
        if (!avatar.sb || !avatar.ms || avatar.ms.readyState !== 'open') {
            console.warn('[cvchat avatar] dropping chunk - sb not ready');
            return;
        }
        var payload = new Uint8Array(data.mp4);
        if (avatar.pendingInit) {
            var merged = new Uint8Array(
                avatar.pendingInit.byteLength + payload.byteLength);
            merged.set(avatar.pendingInit, 0);
            merged.set(payload, avatar.pendingInit.byteLength);
            payload = merged;
            avatar.pendingInit = null;
        }
        avatar.chunkCount++;
        // Watch for buffered-range growth (the per-chunk-duration-mismatch
        // signature). logBufferState only emits on actual range opening.
        if (avatar.sb && !avatar.sb._driftListener) {
            avatar.sb._driftListener = true;
            avatar.sb.addEventListener('updateend', logBufferState);
        }
        if (avatar.chunkCount === 1) {
            setAvatarStatus('Connected', false);
        }
        // On iOS/MMS: if MMS told us to stop feeding, queue the payload for
        // later instead of appending. The startstreaming handler drains it.
        if (avatar.streamingPaused) {
            avatar.pendingFeeds.push(payload);
            return;
        }
        appendAvatarBuffer(payload);
    }

    // Drain queued payloads after MMS asks us to resume. Stop early if MMS
    // re-pauses mid-drain (the flag is checked each iteration).
    function drainPendingAvatarFeeds() {
        while (avatar.pendingFeeds.length > 0 && !avatar.streamingPaused) {
            var payload = avatar.pendingFeeds.shift();
            appendAvatarBuffer(payload);
        }
    }

    // Fires once per appendBuffer's updateend. Detects new range openings
    // (timeline gaps - the per-chunk-duration-mismatch signature) and
    // logs them as they happen.
    function logBufferState() {
        if (!avatarVideo || !avatar.sb) return;
        var buf = avatarVideo.buffered;
        if (buf.length > avatar.prevRangeCount) {
            var ranges = [];
            for (var i = 0; i < buf.length; i++) {
                ranges.push([
                    Number(buf.start(i).toFixed(3)),
                    Number(buf.end(i).toFixed(3))
                ]);
            }
            console.warn('[cvchat avatar][drift] buffered range count grew '
                + avatar.prevRangeCount + ' -> ' + buf.length + ' after chunk #'
                + avatar.chunkCount + '. Gap detected. Ranges: '
                + JSON.stringify(ranges));
            avatar.prevRangeCount = buf.length;
        }
    }

    // sourceBuffer.appendBuffer is async - serialise appends through a
    // promise queue so we never start one while sb.updating is true.
    function appendAvatarBuffer(bytes) {
        avatar.queue = avatar.queue.then(function () {
            return new Promise(function (resolve) {
                var sb = avatar.sb;
                if (!sb || !avatar.ms || avatar.ms.readyState !== 'open') {
                    return resolve();
                }
                function doAppend() {
                    try {
                        sb.addEventListener('updateend', function ue() {
                            sb.removeEventListener('updateend', ue);
                            resolve();
                        }, { once: true });
                        sb.appendBuffer(bytes);
                    } catch (e) { resolve(); }
                }
                if (sb.updating) {
                    sb.addEventListener('updateend', function go() {
                        sb.removeEventListener('updateend', go);
                        doAppend();
                    }, { once: true });
                } else {
                    doAppend();
                }
            });
        }).catch(function () {});
    }

    // Wait until the avatar server confirms it has registered with TTS for
    // our client_id (tts_ready={ready:true}). Without this the very first
    // speak() races ahead of avatar_server's registration; the TTS server
    // sees only the browser sid in audio_client_mapping, filters it out
    // because mode=avatar_only, and drops the text silently. Times out
    // after 5s with a warning so we don't hang the UI indefinitely.
    // Resolves once N avatar_video_chunk events have arrived since
    // this call. Used by the launcher's greeting flow as a minimal
    // proof-of-life that the avatar pipeline is producing frames.
    // Listens on a fresh socket subscription that piggy-backs the
    // existing onAvatarChunk handler. Event-driven, no setTimeouts.
    function waitForAvatarChunks(n) {
        n = n || 1;
        if (!avatar.socket) return Promise.resolve();
        var target = avatar.chunkCount + n;
        if (avatar.chunkCount >= target) return Promise.resolve();
        return new Promise(function (resolve) {
            function check() {
                if (avatar.chunkCount >= target) {
                    avatar.socket.off('avatar_video_chunk', check);
                    resolve();
                }
            }
            avatar.socket.on('avatar_video_chunk', check);
        });
    }

    function waitForTtsReady() {
        if (avatar.ttsReady) return Promise.resolve(true);
        return new Promise(function (resolve) {
            var t = setTimeout(function () {
                console.warn('[cvchat avatar] tts_ready timeout - bridge not',
                    'confirmed after 5s. First message may be lost.');
                avatar.pendingTtsReady = null;
                resolve(false);
            }, 5000);
            avatar.pendingTtsReady = function () {
                clearTimeout(t);
                resolve(true);
            };
        });
    }


    function cleanupAvatar() {
        try { if (avatar.socket) avatar.socket.disconnect(); } catch (e) {}
        avatar.socket = null;
        avatar.pendingInit = null;
        avatar.queue = Promise.resolve();
        avatar.ttsReady = false;
        avatar.pendingTtsReady = null;
        try {
            if (avatar.ms && avatar.ms.readyState === 'open') avatar.ms.endOfStream();
        } catch (e) {}
        avatar.ms = null;
        avatar.sb = null;
        if (avatarVideo) {
            try {
                avatarVideo.pause();
                avatarVideo.removeAttribute('src');
                avatarVideo.load();
            } catch (e) {}
        }
    }

    // ----- avatar stage + dock-mode plumbing -------------------------------
    // The video element + its stage wrapper live across panel open/close
    // AND across dock/undock transitions so the MediaSource pipeline never
    // has to be rebuilt. The stage is reparented; the video element keeps
    // playing throughout. When the user closes the floating panel (X) we
    // drop avatar mode entirely (back to 'silent'); when the user toggles
    // the dock button, the stage just moves between containers.
    function ensureAvatarStage() {
        if (avatarStage) return avatarStage;
        avatarStage = document.createElement('div');
        avatarStage.className = 'cvchat-avatar-stage';
        avatarVideo = document.createElement('video');
        avatarVideo.className = 'cvchat-avatar-video';
        avatarVideo.autoplay = true;
        avatarVideo.playsInline = true;
        // Some iOS versions check the HTML attribute, not just the property.
        avatarVideo.setAttribute('playsinline', '');
        avatarVideo.setAttribute('webkit-playsinline', '');
        // Stop iOS Safari from offering to AirPlay our small in-app avatar.
        // ManagedMediaSource on iOS requires this to enable inline playback.
        try { avatarVideo.disableRemotePlayback = true; } catch (e) {}
        avatarVideo.setAttribute('disableremoteplayback', '');
        avatarVideo.muted = false;
        avatarStatus = document.createElement('div');
        avatarStatus.className = 'cvchat-avatar-status';
        avatarStatus.setAttribute('hidden', '');
        // Dock/undock toggle. Lives on the stage so it travels with it
        // across reparenting. Title + icon flip to reflect target action.
        avatarDockBtn = document.createElement('button');
        avatarDockBtn.type = 'button';
        avatarDockBtn.className = 'cvchat-stage-btn cvchat-dock-btn';
        avatarDockBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            toggleAvatarDocked();
        });
        updateDockBtn();
        // Close button. Replaces jsPanel's native close X (which has
        // its own coordinate system and is awkward to align with the
        // dock button). Lives in the stage too, so both buttons share
        // the same coordinate system and styling. Only shown when
        // undocked (hidden via CSS in the docked-bubble layout).
        avatarCloseBtn = document.createElement('button');
        avatarCloseBtn.type = 'button';
        avatarCloseBtn.className = 'cvchat-stage-btn cvchat-close-btn';
        avatarCloseBtn.setAttribute('aria-label', 'Close avatar');
        avatarCloseBtn.title = 'Close avatar';
        avatarCloseBtn.innerHTML = ICON.close;
        avatarCloseBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            setMode('silent');
        });
        avatarStage.appendChild(avatarVideo);
        avatarStage.appendChild(avatarStatus);
        avatarStage.appendChild(avatarDockBtn);
        avatarStage.appendChild(avatarCloseBtn);
        // Keep the stage's aspect-ratio CSS var in sync with the video so
        // the docked size scales correctly regardless of the talking head.
        avatarVideo.addEventListener('loadedmetadata', updateStageRatio);
        avatarVideo.addEventListener('resize', updateStageRatio);

        // iOS Safari stall recovery. After an idle-burst gap the buffer
        // underruns; iOS pauses the video and doesn't auto-resume when
        // new chunks arrive. We watch the lifecycle events and call play()
        // again ourselves. Desktop browsers either don't stall here or
        // auto-resume on their own, so this is harmless cross-platform.
        function tryResume(reason) {
            if (!avatar.started) return;          // never started yet
            if (!avatarVideo.paused) return;      // already playing
            if (!avatar.sb || !avatar.sb.buffered.length) return;
            var buf = avatar.sb.buffered;
            var endT = buf.end(buf.length - 1);
            if (endT - avatarVideo.currentTime < 0.15) return;   // still underrun
            avatarVideo.play().catch(function (e) {
                console.warn('[cvchat avatar] auto-resume play() rejected:', e.message);
            });
        }
        avatarVideo.addEventListener('canplay', function () { tryResume('canplay'); });
        avatarVideo.addEventListener('canplaythrough', function () { tryResume('canplaythrough'); });
        avatarVideo.addEventListener('error', function (e) {
            var err = avatarVideo.error;
            console.warn('[cvchat avatar] video error: code=', err && err.code,
                         'message=', err && err.message);
        });
        // Wire the panel-drag listeners on the video itself - the dock
        // toggle + close X live as siblings of the video and are
        // therefore immune to this drag handler.
        setupAvatarVideoDrag();
        return avatarStage;
    }

    function updateStageRatio() {
        if (!avatarStage || !avatarVideo) return;
        var vw = avatarVideo.videoWidth;
        var vh = avatarVideo.videoHeight;
        if (!vw || !vh) return;
        avatarStage.style.setProperty('--cv-stage-ratio', vw + ' / ' + vh);
        avatarStage.classList.add('cvchat-stage-ratio-known');
    }

    function updateDockBtn() {
        if (!avatarDockBtn) return;
        if (state.avatarDocked) {
            avatarDockBtn.innerHTML = ICON.undock;
            avatarDockBtn.setAttribute('aria-label', 'Undock avatar');
            avatarDockBtn.title = 'Undock avatar';
        } else {
            avatarDockBtn.innerHTML = ICON.dock;
            avatarDockBtn.setAttribute('aria-label', 'Dock avatar');
            avatarDockBtn.title = 'Dock avatar';
        }
    }

    // Find the latest assistant bubble in the messages area, or null.
    function latestAssistantBubble() {
        if (!messagesEl) return null;
        var msgs = messagesEl.querySelectorAll('.cvchat-msg-assistant .cvchat-bubble');
        return msgs.length ? msgs[msgs.length - 1] : null;
    }

    // Detach the avatar stage from whatever parent it currently has, and
    // restore that parent's layout (un-flex an assistant bubble, etc.).
    // Safe to call when the stage isn't currently mounted.
    function detachAvatarStage() {
        if (!avatarStage || !avatarStage.parentNode) return;
        var parent = avatarStage.parentNode;
        parent.removeChild(avatarStage);
        if (parent.classList && parent.classList.contains('cvchat-bubble')) {
            parent.classList.remove('cvchat-has-avatar');
        }
    }

    // Place the avatar stage as the LEFT-side child of the given assistant
    // bubble. The bubble flips to flex-row via the cvchat-has-avatar class
    // so its existing .cvchat-bubble-content wrapper flows to the right.
    function dockAvatarInto(bubble) {
        if (!avatarStage || !bubble) return;
        if (avatarStage.parentNode === bubble) return;
        detachAvatarStage();
        bubble.insertBefore(avatarStage, bubble.firstChild);
        bubble.classList.add('cvchat-has-avatar');
        scrollToBottom();
    }

    function relocateDockedAvatarTo(bubble) {
        if (!state.avatarDocked) return;
        dockAvatarInto(bubble);
    }

    // Place the avatar stage into the floating jsPanel content area. The
    // panel must already exist; openAvatarPanel handles creation.
    function attachAvatarStageToPanel(panel) {
        if (!avatarStage || !panel || !panel.content) return;
        if (avatarStage.parentNode === panel.content) return;
        detachAvatarStage();
        panel.content.appendChild(avatarStage);
    }

    // Decide where the avatar stage should live based on state.avatarDocked
    // and put it there. Used both during initial setMode('avatar') and
    // every time the user flips the dock toggle.
    function mountAvatar() {
        ensureAvatarStage();
        updateDockBtn();
        if (state.avatarDocked) {
            // Tear down any floating panel; keep the stage alive.
            if (avatarPanel) destroyAvatarPanel(true);
            var bubble = latestAssistantBubble();
            if (bubble) {
                dockAvatarInto(bubble);
            } else {
                // No assistant bubble yet (shouldn't happen - the greeting
                // is always inserted before the user can click the avatar
                // button). Defer; addMessage will pick it up on next assistant
                // turn.
                detachAvatarStage();
            }
            return Promise.resolve(true);
        }
        // Undocked: open the floating panel and reparent the stage into it.
        detachAvatarStage();
        return openAvatarPanel();
    }

    // Toggle handler for the dock button. Flips state.avatarDocked and
    // re-mounts. No-op when the avatar is off.
    function toggleAvatarDocked() {
        if (!state.avatarOn) return;
        state.avatarDocked = !state.avatarDocked;
        mountAvatar();
    }

    // Resize the panel so its content area's aspect ratio matches the
    // video's intrinsic ratio. Called on loadedmetadata + resize events;
    // until the first chunk arrives we default to 1:1.
    function adjustAvatarPanelAspect() {
        if (!avatarPanel || !avatarVideo) return;
        var vw = avatarVideo.videoWidth;
        var vh = avatarVideo.videoHeight;
        if (!vw || !vh) return;
        var ratio = vw / vh;
        // Use the panel's current width and derive the matching height.
        var w = avatarPanel.offsetWidth;
        var h = Math.round(w / ratio);
        avatarPanel.style.height = h + 'px';
        // Re-arm jsPanel's resize aspect lock so corner drags now follow
        // the new ratio instead of the initial 1:1.
        try {
            if (avatarPanel.options && avatarPanel.options.resizeit) {
                avatarPanel.options.resizeit.aspectRatio = ratio;
            }
        } catch (e) {}
    }

    // Initial position for the floating panel. If the user has already
    // dragged or resized the panel earlier this session, restore that
    // exact spot. Otherwise anchor to the TOP-RIGHT corner of the chat
    // messages area with a small inset. Returns the absolute viewport
    // coordinates jsPanel expects (my=left-top, at=left-top + offsets).
    function computeUndockedPlacement() {
        var w = 160, h = 160;
        if (avatar.lastUndockedPos) {
            return {
                position: { my: 'left-top', at: 'left-top',
                            offsetX: avatar.lastUndockedPos.left,
                            offsetY: avatar.lastUndockedPos.top },
                size: { width: avatar.lastUndockedPos.width,
                        height: avatar.lastUndockedPos.height }
            };
        }
        var rect = messagesEl ? messagesEl.getBoundingClientRect()
                              : { right: window.innerWidth - 24,
                                  top: 80 };
        var inset = 12;
        return {
            position: { my: 'left-top', at: 'left-top',
                        offsetX: Math.round(rect.right - w - inset),
                        offsetY: Math.round(rect.top + inset) },
            size: { width: w, height: h }
        };
    }

    function openAvatarPanel() {
        if (typeof jsPanel === 'undefined') {
            notice('Avatar window library failed to load.');
            return Promise.resolve(false);
        }
        if (avatarPanel) {
            // Panel already exists. Just make sure the stage is inside it.
            attachAvatarStageToPanel(avatarPanel);
            return Promise.resolve(true);
        }
        var stage = ensureAvatarStage();
        var placement = computeUndockedPlacement();
        return new Promise(function (resolve) {
            avatarPanel = jsPanel.create({
                id: 'cvchat-avatar-panel',
                headerTitle: '',                 // no title text
                theme: 'none',
                borderRadius: '10px',
                border: '1px solid #2a2a2a',
                boxShadow: 3,
                position: placement.position,
                panelSize: placement.size,
                headerControls: {
                    size: 'xs',
                    minimize: 'remove',
                    smallify: 'remove',
                    normalize: 'remove',
                    maximize: 'remove'
                },
                // We use our own close button inside the stage (so it
                // shares coordinate system with the dock toggle).
                addCloseControl: 0,
                // jsPanel's built-in drag is wired to .jsPanel-headerbar
                // only; we want drag-from-the-image, so disable jsPanel's
                // drag and rely on our own listener bound to the <video>
                // element (setupAvatarVideoDrag, wired in ensureAvatarStage).
                // Buttons live as siblings of the video and stay
                // untouched by that handler.
                dragit: false,
                // Only corner handles - side handles would change one axis
                // independently and break the locked aspect ratio. The
                // resize callback enforces panel-width / video-ratio so
                // even if jsPanel's own aspect lock drifts, we clamp.
                resizeit: {
                    minWidth: 120, minHeight: 120,
                    aspectRatio: 'panel',
                    handles: 'nw, ne, sw, se',
                    resize: function (panel) {
                        if (!avatarVideo) return;
                        var vw = avatarVideo.videoWidth;
                        var vh = avatarVideo.videoHeight;
                        if (!vw || !vh) return;
                        var ratio = vw / vh;
                        var w = panel.offsetWidth;
                        panel.style.height = Math.round(w / ratio) + 'px';
                    },
                    stop: function (panel) {
                        // User resized; treat that the same as a drag for
                        // the purposes of remembering the spot.
                        rememberUndockedPos(panel);
                    }
                },
                onclosed: function () {
                    avatarPanel = null;
                    if (avatar.suppressOnClose) return;   // dock transition
                    if (state.avatarOn) setMode('silent');
                },
                callback: function (panel) {
                    panel.content.style.padding = '0';
                    panel.content.style.background = '#000';
                    panel.content.style.overflow = 'hidden';
                    panel.content.appendChild(stage);
                    if (avatarVideo) {
                        avatarVideo.addEventListener('loadedmetadata',
                            adjustAvatarPanelAspect);
                        avatarVideo.addEventListener('resize',
                            adjustAvatarPanelAspect);
                    }
                    // Snap the panel to the known video aspect ratio so the
                    // image doesn't get letterboxed inside a default square
                    // panel. Done on the next frame so jsPanel has finished
                    // applying its inline styles - calling it synchronously
                    // here could read offsetWidth before the panelSize is
                    // committed.
                    requestAnimationFrame(adjustAvatarPanelAspect);
                    resolve(true);
                }
            });
            if (!avatarPanel) resolve(false);
        });
    }

    // Capture the floating panel's current geometry so we can restore it
    // next time the user undocks. Also drops the pinned body class - once
    // the user has moved the panel, messages should flow full-width.
    function rememberUndockedPos(panel) {
        if (!panel) return;
        var rect = panel.getBoundingClientRect();
        avatar.lastUndockedPos = {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
        };
        avatar.dragged = true;
    }

    // Drag the avatar panel by grabbing the <video> element. Bound to
    // the video (not the panel root) so the dock-toggle button and the
    // jsPanel close X are NEVER intercepted - they live as siblings of
    // the video and never see these listeners, so their own click
    // handlers fire normally. The handlers are attached once when the
    // video element is created (in ensureAvatarStage); they reference
    // the current panel via the avatarPanel module variable rather than
    // a closure, so they correctly track the live panel across
    // dock/undock cycles.
    function setupAvatarVideoDrag() {
        if (!avatarVideo || avatarVideo.__cvchatDragWired) return;
        avatarVideo.__cvchatDragWired = true;
        var dragging = false;
        var moved = false;
        var startX, startY, startLeft, startTop;

        avatarVideo.addEventListener('pointerdown', function (e) {
            if (e.button !== 0) return;                    // left-click only
            if (!avatarPanel) return;                      // only drag undocked
            dragging = true;
            moved = false;
            startX = e.clientX;
            startY = e.clientY;
            var rect = avatarPanel.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            try { avatarVideo.setPointerCapture(e.pointerId); } catch (err) {}
            avatarVideo.style.cursor = 'grabbing';
            e.preventDefault();
        });
        avatarVideo.addEventListener('pointermove', function (e) {
            if (!dragging || !avatarPanel) return;
            moved = true;
            var nx = startLeft + (e.clientX - startX);
            var ny = startTop + (e.clientY - startY);
            // Clamp inside the viewport so the panel can't be lost.
            nx = Math.max(0, Math.min(window.innerWidth - avatarPanel.offsetWidth, nx));
            ny = Math.max(0, Math.min(window.innerHeight - avatarPanel.offsetHeight, ny));
            avatarPanel.style.left = nx + 'px';
            avatarPanel.style.top = ny + 'px';
        });
        function endDrag(e) {
            if (!dragging) return;
            dragging = false;
            avatarVideo.style.cursor = '';
            try { avatarVideo.releasePointerCapture(e.pointerId); } catch (err) {}
            if (moved && avatarPanel) rememberUndockedPos(avatarPanel);
        }
        avatarVideo.addEventListener('pointerup', endDrag);
        avatarVideo.addEventListener('pointercancel', endDrag);
    }

    // silent=true closes the panel WITHOUT dropping avatar mode to silent
    // - used by dock transitions where the avatar should keep running.
    function destroyAvatarPanel(silent) {
        if (!avatarPanel) return;
        if (silent) avatar.suppressOnClose = true;
        try { avatarPanel.close(); } catch (e) {}
        avatarPanel = null;
        avatar.suppressOnClose = false;
    }

    function toggleAvatar() {
        // Capture the "first time turning ON" flag BEFORE setMode flips
        // state.avatarOn. Used to trigger the greeting speech once after
        // the avatar pipeline is up. Works whether the user clicked the
        // launcher or the avatar button inside the panel.
        var firstActivation = !state.avatarOn && !state.greetingSpoken;
        console.log('[cvchat greet] toggleAvatar entry avatarOn=', state.avatarOn,
                    'greetingSpoken=', state.greetingSpoken,
                    'firstActivation=', firstActivation);
        if (!state.avatarOn) {
            // Going silent/speaker -> avatar. Prime autoplay inside the user
            // gesture: create the video element now if needed and call .play()
            // before any chunks arrive. Mirrors the reference's sendButton
            // click handler.
            ensureAvatarStage();
            try {
                if (avatarVideo) {
                    avatarVideo.muted = false;
                    var p = avatarVideo.play();
                    if (p && typeof p.then === 'function') {
                        p.catch(function (e) {
                            console.warn('[cvchat avatar] prime play() rejected:',
                                         e && e.message);
                        });
                    }
                }
            } catch (e) {}
        }
        return setMode(state.avatarOn ? 'silent' : 'avatar').then(function (ok) {
            console.log('[cvchat greet] setMode resolved ok=', ok,
                        'firstActivation=', firstActivation);
            if (ok && firstActivation) {
                state.greetingSpoken = true;
                console.log('[cvchat greet] awaiting first chunk before greeting...');
                waitForAvatarChunks(1).then(function () {
                    console.log('[cvchat greet] first chunk arrived, calling speak()');
                    speak(GREETING_TEXT, 'greeting');
                });
            }
            return ok;
        });
    }

    // ======================================================================
    // UI wiring
    // ======================================================================
    function autoGrow() {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 110) + 'px';
    }

    // Drag the panel's inner edge to resize it (like noted). The width
    // lives in the --cvchat-panel-w CSS variable, which drives both the
    // panel width and the CV page's reflow padding - so one update moves
    // both. Not persisted across reloads (localStorage is off-limits).
    function setupResize(handle) {
        if (!handle) return;
        var MIN_W = 320;
        handle.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            try { handle.setPointerCapture(e.pointerId); } catch (err) {}
            document.body.classList.add('cvchat-resizing');
            function onMove(ev) {
                var w = window.innerWidth - ev.clientX;
                w = Math.max(MIN_W, Math.min(window.innerWidth, w));
                document.documentElement.style.setProperty(
                    '--cvchat-panel-w', w + 'px');
            }
            function onUp() {
                document.body.classList.remove('cvchat-resizing');
                handle.removeEventListener('pointermove', onMove);
                handle.removeEventListener('pointerup', onUp);
                handle.removeEventListener('pointercancel', onUp);
            }
            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup', onUp);
            handle.addEventListener('pointercancel', onUp);
        });
    }

    // Pool of greeting variants. One is picked at random per page load
    // and cached as GREETING_TEXT, so the same chosen line is both
    // rendered in the bubble (openPanel) and spoken by Diana (toggleAvatar).
    // Keep them welcoming, focused on who Diana is and how the user can
    // interact — let actual CV content come out in the answers.
    var GREETING_TEXTS = [
        "I'm Diana, your HR Assistant. Tell me what you need.",
        "Hi! I'm Diana, your HR Assistant. How can I help you today?",
        "Hello, I'm Diana, your HR Assistant. What are you hiring for?",
        "I'm Diana, your HR Assistant. Who are you looking to hire?",
        "Hi there! I'm Diana, your HR Assistant. What can I help you with?",
        "Welcome. I'm Diana, your HR Assistant. What do you need?",
        "I'm Diana, your HR Assistant. Tell me about the role.",
        "Hello! I'm Diana, your HR Assistant. What role are you filling?",
        "Hi, I'm Diana, your HR Assistant. How can I help?",
        "I'm Diana, your HR Assistant. What would you like to create?",
        "Hey! I'm Diana, your HR Assistant. What are we hiring for?",
        "Hello, I'm Diana, your HR Assistant. How can I assist you today?",
        "I'm Diana, your HR Assistant. Just tell me the role.",
        "Hi there. I'm Diana, your HR Assistant. What do you have in mind?",
        "Welcome! I'm Diana, your HR Assistant. What can I do for you?",
        "I'm Diana, your HR Assistant. Ready when you are.",
        "Hi! I'm Diana, your HR Assistant. What position are you hiring for?",
        "Hello, I'm Diana, your HR Assistant. Tell me how I can help.",
        "I'm Diana, your HR Assistant. What's the role?",
        "Hi, I'm Diana, your HR Assistant. Let's get started. What do you need?"
    ];
    var GREETING_TEXT = GREETING_TEXTS[Math.floor(Math.random() * GREETING_TEXTS.length)];

    function openPanel() {
        document.body.classList.add('cvchat-open');
        if (!state.greeted) {
            state.greeted = true;
            addMessage('assistant', renderMarkdown(GREETING_TEXT));
        }
        requestAnimationFrame(function () { if (input) input.focus(); });
    }

    function closePanel() {
        document.body.classList.remove('cvchat-open');
        hidePopover();
        clearCVHighlight();
        // Reset audio + avatar to their startup defaults (both off) so the
        // next launcher click triggers the auto-enable-avatar path again.
        if (state.avatarOn || state.ttsOn) setMode('silent');
    }

    function mount() {
        if (document.querySelector('.cvchat-root')) return;

        root = document.createElement('div');
        root.className = 'cvchat-root';

        launcher = document.createElement('button');
        launcher.type = 'button';
        launcher.className = 'cvchat-launcher';
        launcher.setAttribute('aria-label', 'Chat with Diana, the job2cool assistant');
        launcher.innerHTML =
            '<img class="cvchat-launcher-img" src="static/widget/diana.png" alt="" aria-hidden="true">' +
            '<span>Diana</span>';

        panel = document.createElement('div');
        panel.className = 'cvchat-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Diana, the job2cool assistant');
        panel.innerHTML =
            '<div class="cvchat-resize" aria-hidden="true"></div>' +
            '<div class="cvchat-header">' +
                '<div class="cvchat-avatar">' +
                    '<img src="static/widget/diana.png" alt="" aria-hidden="true">' +
                '</div>' +
                '<div class="cvchat-titles"><strong>Diana</strong>' +
                "<small>HR Assistant</small></div>" +
                '<button class="cvchat-close" type="button" aria-label="Close chat">' +
                ICON.close + '</button>' +
            '</div>' +
            '<div class="cvchat-messages-wrap">' +
                '<div class="cvchat-messages" role="log" aria-live="polite"></div>' +
            '</div>' +
            '<div class="cvchat-popover" hidden></div>' +
            '<form class="cvchat-inputbar">' +
                '<button class="cvchat-iconbtn cvchat-mic" type="button" ' +
                'aria-label="Voice input" title="Voice input">' + ICON.mic + '</button>' +
                '<button class="cvchat-iconbtn cvchat-speaker" type="button" ' +
                'aria-label="Spoken replies" title="Spoken replies">' + ICON.speaker + '</button>' +
                '<button class="cvchat-iconbtn cvchat-avatar-btn" type="button" ' +
                'aria-label="Show avatar" title="Show avatar">' + ICON.avatarFace + '</button>' +
                '<textarea class="cvchat-input" rows="1" ' +
                'placeholder="Describe the hiring need…"></textarea>' +
                '<button class="cvchat-iconbtn cvchat-send" type="submit" ' +
                'aria-label="Send message">' + ICON.send + '</button>' +
            '</form>' +
            '<div class="cvchat-hint">AI-generated content may contain inaccuracies - please review before use.</div>';

        // Panel sits inside cvchat-root, fixed-positioned (overlays the page).
        // Launcher is inlined into the CV body between the header (with the
        // LinkedIn / GitHub / etc. contact links) and the first section, so
        // it flows with the document and is naturally excluded from printing
        // via the @media print rule in cv-chat.css.
        root.appendChild(panel);
        document.body.appendChild(root);
        var cvHeader = document.querySelector('.page .cv-header')
            || document.querySelector('.cv-header');
        if (cvHeader && cvHeader.parentNode) {
            cvHeader.parentNode.insertBefore(launcher, cvHeader.nextSibling);
        } else {
            // Fallback: if the CV body doesn't expose .cv-header for any
            // reason, fall back to the old floating-launcher behaviour so
            // the widget still surfaces.
            root.insertBefore(launcher, panel);
        }

        messagesEl = panel.querySelector('.cvchat-messages');
        popover = panel.querySelector('.cvchat-popover');
        input = panel.querySelector('.cvchat-input');
        sendBtn = panel.querySelector('.cvchat-send');
        micBtn = panel.querySelector('.cvchat-mic');
        speakerBtn = panel.querySelector('.cvchat-speaker');
        avatarBtn = panel.querySelector('.cvchat-avatar-btn');
        var form = panel.querySelector('.cvchat-inputbar');
        setupResize(panel.querySelector('.cvchat-resize'));

        // Opening the chat from the launcher also enables avatar mode
        // (same effect as clicking the avatar button) - the click is
        // the user gesture browsers need to unlock AudioContext +
        // video-with-sound autoplay. Once the avatar pipeline is fully
        // ready (setMode resolves -> tts socket connected + avatar
        // bridge registered), Diana speaks the greeting so the first
        // message the user sees is also the first message they hear.
        launcher.addEventListener('click', function () {
            // Opening the chat from the launcher also enables avatar mode
            // (same effect as clicking the avatar button) - the click is
            // the user gesture browsers need to unlock AudioContext +
            // video-with-sound autoplay. The greeting speech is triggered
            // by toggleAvatar on first activation; works the same whether
            // the user clicked the launcher or the avatar button.
            openPanel();
            if (!state.avatarOn && typeof io !== 'undefined') {
                toggleAvatar();
            }
        });
        panel.querySelector('.cvchat-close').addEventListener('click', closePanel);

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            sendMessage(input.value);
        });
        input.addEventListener('input', autoGrow);
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage(input.value);
            }
        });
        micBtn.addEventListener('click', toggleMic);
        speakerBtn.addEventListener('click', toggleSpeaker);
        avatarBtn.addEventListener('click', toggleAvatar);

        messagesEl.addEventListener('click', function (e) {
            // Match the WHOLE wrap (icon + number) so either click target
            // resolves the same citation. Tag is on wrap.dataset; anchor
            // also carries it for keyboard nav. Mirrors noted's pattern.
            var wrap = e.target.closest('.cvchat-cite-wrap');
            if (wrap) {
                e.preventDefault();
                var tag = wrap.getAttribute('data-cite-tag');
                var badge = wrap.querySelector('a.cvchat-cite') || wrap;
                if (tag) resolveCitation(tag, badge);
            }
        });
        messagesEl.addEventListener('scroll', hidePopover);
        popover.addEventListener('click', function (e) {
            if (e.target.closest('.cvchat-popover-close')) hidePopover();
        });

        if (typeof io === 'undefined') {
            micBtn.disabled = true;
            speakerBtn.disabled = true;
            avatarBtn.disabled = true;
            micBtn.title = speakerBtn.title = avatarBtn.title = 'Voice unavailable';
        }

        // Chat panel stays closed on load. The launcher click handler
        // (wired above) opens it and ALSO turns on avatar mode in the
        // same gesture - see below.

        // GPU savings safeguard: when this tab is backgrounded, drop the
        // avatar socket so avatar_server stops pushing liveness frames
        // to us. state.avatarOn stays true, so when the tab is brought
        // back to the foreground we reconnect transparently. Without
        // this, a tab left open in a background window keeps the avatar
        // pipeline producing 25 fps idle motion indefinitely.
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'hidden') {
                if (state.avatarOn && avatar.socket && avatar.socket.connected) {
                    cleanupAvatar();
                }
            } else if (document.visibilityState === 'visible') {
                if (state.avatarOn && (!avatar.socket || !avatar.socket.connected)) {
                    startAvatar();
                }
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }

    // Debug helpers exposed on window so you can probe the audio path live
    // from DevTools. Type `cvchatMuteAvatar()` in the console while Diana
    // is speaking: if the audio stops, you proved the audio is coming
    // from the avatar's muxed video. If audio keeps playing, the sound
    // is coming from somewhere else (a different audio path).
    window.cvchatMuteAvatar = function () {
        if (!avatarVideo) { console.log('no avatar video'); return; }
        avatarVideo.muted = !avatarVideo.muted;
        console.log('avatar video muted =', avatarVideo.muted);
    };
    window.cvchatAudioPath = function () {
        if (!avatarVideo) { console.log('no avatar video'); return; }
        console.log({
            'video.muted': avatarVideo.muted,
            'video.volume': avatarVideo.volume,
            'video.currentTime': avatarVideo.currentTime,
            'video.paused': avatarVideo.paused,
            'video.audioDecodedBytes': avatarVideo.webkitAudioDecodedByteCount || 0,
            'video.videoDecodedBytes': avatarVideo.webkitVideoDecodedByteCount || 0,
            'tts.socket.connected': !!(tts.socket && tts.socket.connected),
            'tts.bypassedWhileAvatar': tts.bypassedWhileAvatar || 0,
            'state.avatarOn': state.avatarOn,
            'state.ttsOn': state.ttsOn,
            'state.ttsPlaying': state.ttsPlaying
        });
    };
})();
