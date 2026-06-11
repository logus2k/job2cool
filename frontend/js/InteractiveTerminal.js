import { getTerminalTheme, onTerminalThemeChange } from './TerminalThemes.js';

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

/**
 * InteractiveTerminal - A bidirectional xterm.js terminal connected
 * to a server-side PTY via Socket.IO.
 */
export class InteractiveTerminal {

    constructor(container, socket, options = {}) {
        this._container = container;
        this._socket = socket;
        this._sessionId = options.sessionId || _uuid();
        this._cmd = options.cmd || ['bash'];
        this._cwd = options.cwd || null;
        this._env = options.env || null;
        this._secret = options.secret || null;
        this._term = null;
        this._fitObserver = null;
        this._opened = false;
        this._started = false;
        this._onExit = options.onExit || null;

        this._handleOutput = this._handleOutput.bind(this);
        this._handleExit = this._handleExit.bind(this);
    }

    get sessionId() { return this._sessionId; }

    async open() {
        if (this._opened) return;

        // Wait for font
        await Promise.all([
            document.fonts.load('12px "MesloLGS NF"'),
            document.fonts.load('bold 12px "MesloLGS NF"'),
        ]).catch(() => {});

        const theme = getTerminalTheme();
        this._container.style.background = theme.background;

        this._term = new Terminal({
            convertEol: false,
            cursorBlink: true,
            disableStdin: false,
            fontSize: 12,
            fontFamily: '"MesloLGS NF", "JetBrains Mono", "Fira Code", "Consolas", monospace',
            theme,
            scrollback: 10000,
            allowProposedApi: true,
            rightClickSelectsWord: true,
        });

        onTerminalThemeChange((t) => {
            this._term.options.theme = t;
            this._container.style.background = t.background;
        });

        this._term.open(this._container);
        this._opened = true;

        // Clipboard: Ctrl+C copies if selection exists (else SIGINT),
        // Ctrl+Shift+C always copies, Ctrl+V / Ctrl+Shift+V paste
        this._term.attachCustomKeyEventHandler((ev) => {
            if (ev.type !== 'keydown') return true;

            // Ctrl+C: copy if text selected, otherwise let terminal send SIGINT
            if (ev.ctrlKey && !ev.shiftKey && ev.code === 'KeyC') {
                const sel = this._term.getSelection();
                if (sel) {
                    navigator.clipboard.writeText(sel);
                    this._term.clearSelection();
                    return false;
                }
                return true; // no selection - send ^C to PTY
            }

            // Ctrl+Shift+C: always copy
            if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') {
                ev.preventDefault();
                const sel = this._term.getSelection();
                if (sel) navigator.clipboard.writeText(sel);
                return false;
            }

            // Ctrl+V or Ctrl+Shift+V: paste
            if (ev.ctrlKey && ev.code === 'KeyV') {
                navigator.clipboard.readText().then(text => {
                    if (text && this._started) {
                        this._socket.emit('terminal:input', {
                            session_id: this._sessionId,
                            data: text,
                        });
                    }
                });
                return false;
            }
            return true;
        });

        // Right-click paste
        this._term.element.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            navigator.clipboard.readText().then(text => {
                if (text && this._started) {
                    this._socket.emit('terminal:input', {
                        session_id: this._sessionId,
                        data: text,
                    });
                }
            });
        });

        // User input -> Socket.IO -> PTY
        this._term.onData((data) => {
            if (this._started) {
                this._socket.emit('terminal:input', {
                    session_id: this._sessionId,
                    data,
                });
            }
        });

        // Listen for PTY output
        this._socket.on('terminal:output', this._handleOutput);
        this._socket.on('terminal:exit', this._handleExit);

        // Auto-fit on resize
        this._fitObserver = new ResizeObserver(() => this._fit());
        this._fitObserver.observe(this._container);
        this._fit();
    }

    async start() {
        if (this._started) return;

        const cols = this._term?.cols || 120;
        const rows = this._term?.rows || 24;

        const payload = {
            session_id: this._sessionId,
            cmd: this._cmd,
            cwd: this._cwd,
            env: this._env,
            cols,
            rows,
        };
        if (this._secret) payload.secret = this._secret;
        this._socket.emit('terminal:start', payload);

        this._started = true;
    }

    _handleOutput(payload) {
        if (payload?.session_id !== this._sessionId) return;
        if (payload?.data) {
            let data = payload.data;
            // When R debug mode is active, filter out the debug
            // plumbing noise from the terminal output: Browse prompts
            // with injected commands (n, c, s), the listenForDAP
            // re-entry call, and their echoes. The user sees clean
            // output — just script results and the debug at ... lines.
            if (this._rDebugFilter) {
                // Strip R debug plumbing noise while preserving the
                // Browse[N]> prompt (so the cursor sits in the right
                // place). Only strip the COMMANDS injected after the
                // prompt, their echoes, and vscDebugger startup lines.

                // Injected commands after Browse prompt: "Browse[2]> n\r\n" -> "Browse[2]> \r\n"
                // Use a lookahead to keep the prompt but strip the command
                data = data.replace(/(Browse\[\d+\]> *)(n|c|s)(\r?\n)/g, '$1$3');
                data = data.replace(/(Browse\[\d+\]> *)vscDebugger[^\r\n]*/g, '$1');
                // Top-level prompt with listenForDAP: "> vscDebugger::..." -> "> "
                data = data.replace(/(^> *)vscDebugger[^\r\n]*/gm, '$1');
                // Bare command echoes (not after a prompt)
                data = data.replace(/^(n|c|s)\r?\n/gm, '');
                data = data.replace(/^vscDebugger[^\r\n]*\r?\n?/gm, '');
                // vscDebugger startup noise
                data = data.replace(/Tracing debugSourceBreakpoint[^\r\n]*\r?\n?/g, '');
                data = data.replace(/Called from: eval\(expr[^\r\n]*\r?\n?/g, '');
                if (!data.replace(/[\s\r\n]/g, '')) return;
            }
            this._term.write(data);
        }
    }

    _handleExit(payload) {
        if (payload?.session_id !== this._sessionId) return;
        this._started = false;
        this._term.writeln('\r\n\x1b[2m[Process exited]\x1b[0m');
        if (this._onExit) this._onExit(this._sessionId);
    }

    _fit() {
        if (!this._term || !this._opened) return;
        const core = this._term._core;
        if (!core?._renderService) return;
        const dims = core._renderService.dimensions;
        if (!dims?.css?.cell?.height || !dims?.css?.cell?.width) return;

        const cols = Math.max(20, Math.floor(this._container.clientWidth / dims.css.cell.width));
        const rows = Math.max(1, Math.floor(this._container.clientHeight / dims.css.cell.height));

        if (rows !== this._term.rows || cols !== this._term.cols) {
            this._term.resize(cols, rows);
            // Notify server of resize
            if (this._started) {
                this._socket.emit('terminal:resize', {
                    session_id: this._sessionId,
                    cols,
                    rows,
                });
            }
        }
    }

    write(data) {
        if (this._term) this._term.write(data);
    }

    focus() {
        if (this._term) this._term.focus();
    }

    dispose() {
        if (this._fitObserver) {
            this._fitObserver.disconnect();
            this._fitObserver = null;
        }

        this._socket.off('terminal:output', this._handleOutput);
        this._socket.off('terminal:exit', this._handleExit);

        if (this._started) {
            this._socket.emit('terminal:kill', {
                session_id: this._sessionId,
            });
            this._started = false;
        }

        if (this._term) {
            this._term.dispose();
            this._term = null;
        }

        this._opened = false;
    }
}
