/**
 * FileEditor - CodeMirror-based editor for text files.
 * Edit-only: no execution UI. Supports Ctrl+S save and dirty tracking.
 */
import {
    EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
    EditorState, Compartment,
    defaultKeymap, indentWithTab, history, historyKeymap, undo,
    syntaxHighlighting, defaultHighlightStyle,
    python, javascript, html, css, json, yaml, r, indentUnit,
    lintGutter, diagnosticCount, forEachDiagnostic,
    autocompletion, completionKeymap,
    Prec,
    languageServer, jumpToDefinition, languageServerPlugin,
    showMinimap,
    ayuLight, clouds, espresso, smoothy, tomorrow, oneDark
} from '../vendor/codemirror/codemirror.bundle.js';

import { notify } from './Notify.js';
import { buildDiffHtml } from './DiffView.js';
import { breakpointGutter, setCurrentLine, getBreakpoints } from './BreakpointGutter.js';

const editorThemes = {
    'Default': null,
    'Ayu Light': ayuLight,
    'Clouds': clouds,
    'Espresso': espresso,
    'Smoothy': smoothy,
    'Tomorrow': tomorrow,
    'One Dark': oneDark
};

/** Track all FileEditor instances for theme reconfiguration. */
const _allEditors = new Set();
/** Global registry of all CodeMirror EditorViews (files + notebook cells). */
const _editorViewRegistry = new Set();
export function registerEditorView(view) { _editorViewRegistry.add(view); }
export function unregisterEditorView(view) { _editorViewRegistry.delete(view); }
const _themeCompartment = new Compartment();
const _minimapCompartment = new Compartment();
let _minimapVisible = true;

/**
 * Enrich lint diagnostic tooltips with styled rule badges, category info,
 * and clickable docs links.
 *
 * Backend sends diagnostics in the format: "CODE: message\nCATEGORY\nURL"
 * This observer parses that and renders structured HTML.
 */
function _linkifyLintTooltips() {
    if (_linkifyObserver) return;

    // Intercept link clicks in hover tooltips and doc panels -> open in new tab
    document.addEventListener('click', (e) => {
        const a = e.target.closest('.cm-tooltip-hover a[href], .doc-panel-content a[href]');
        if (a && a.href) {
            e.preventDefault();
            window.open(a.href, '_blank', 'noopener');
        }
    });
    _linkifyObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (!(node instanceof HTMLElement)) continue;
                const diags = node.matches?.('.cm-diagnostic')
                    ? [node]
                    : [...(node.querySelectorAll?.('.cm-diagnostic') || [])];
                // Highlight code blocks in hover tooltips
                const codeBlocks = node.matches?.('.cm-tooltip-hover')
                    ? [...node.querySelectorAll('pre code')]
                    : [...(node.querySelectorAll?.('.cm-tooltip-hover pre code') || [])];
                for (const block of codeBlocks) {
                    if (!block.dataset.highlighted) {
                        hljs.highlightElement(block);
                        block.dataset.highlighted = 'true';
                    }
                }
                // Open tooltip links in new tab (hover + completion info)
                const hoverLinks = node.matches?.('.cm-tooltip-hover') || node.matches?.('.cm-completionInfo')
                    ? [...node.querySelectorAll('a')]
                    : [...(node.querySelectorAll?.('.cm-tooltip-hover a, .cm-completionInfo a') || [])];
                for (const a of hoverLinks) {
                    a.target = '_blank';
                    a.rel = 'noopener';
                }

                for (const el of diags) {
                    const text = el.textContent;
                    const lines = text.split('\x1f');
                    // First line: "CODE: message" or just "message" (syntax errors)
                    // Ruff: "F401: message", Biome: "noDoubleEquals: message"
                    const firstMatch = lines[0]?.match(/^([A-Za-z]\w+):\s*(.*)$/);
                    const code = firstMatch ? firstMatch[1] : null;
                    const msg = firstMatch ? firstMatch[2] : lines[0];
                    // Remaining lines (skip first): category and/or URL
                    const rest = lines.slice(1);
                    const cat = rest.find(l => l && !l.startsWith('http')) || null;
                    const url = rest.find(l => l?.startsWith('http'));

                    el.textContent = '';

                    // Line 1: badge + message + docs link
                    const line1 = document.createElement('div');
                    line1.style.cssText = 'display:flex;align-items:baseline;gap:6px;background:#fefefe;padding:6px 8px;border-radius:3px 3px 0 0';

                    if (code) {
                        const badge = document.createElement('span');
                        badge.textContent = code;
                        badge.style.cssText = 'display:inline-block;background:#d4edda;color:#2d6a3f;font-size:10px;font-weight:600;padding:1px 6px;border-radius:3px;letter-spacing:0.3px;white-space:nowrap';
                        line1.appendChild(badge);
                    }

                    const msgSpan = document.createElement('span');
                    msgSpan.textContent = msg.trim();
                    msgSpan.style.cssText = 'flex:1;color:#1d1d1d';
                    line1.appendChild(msgSpan);

                    if (code) {
                        const fixBtn = document.createElement('span');
                        fixBtn.textContent = 'fix';
                        fixBtn.style.cssText = 'color:#2e7d32;cursor:pointer;font-size:11px;white-space:nowrap;margin-left:4px;text-decoration:underline';
                        fixBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            _applyFix(code);
                        });
                        line1.appendChild(fixBtn);
                    }

                    if (url) {
                        const a = document.createElement('a');
                        a.href = url;
                        a.target = '_blank';
                        a.rel = 'noopener';
                        a.textContent = 'docs';
                        a.style.cssText = 'color:#5ba0d0;text-decoration:underline;cursor:pointer;font-size:11px;white-space:nowrap;margin-left:4px';
                        line1.appendChild(a);
                    }

                    el.appendChild(line1);

                    // Line 2: category
                    if (cat) {
                        const catParts = cat.split(' - ');
                        const catEl = document.createElement('div');
                        catEl.style.cssText = 'font-size:10px;color:#1d1d1d;padding:5px 8px;background:#fff9e3;border-radius:0 0 3px 3px;display:flex;align-items:baseline;gap:6px';

                        const catBadge = document.createElement('span');
                        catBadge.textContent = catParts[0].toUpperCase();
                        catBadge.style.cssText = 'display:inline-block;background:#ffe39e;color:#5a4000;font-size:10px;font-weight:600;padding:1px 6px;border-radius:3px;letter-spacing:0.3px;white-space:nowrap';
                        catEl.appendChild(catBadge);

                        if (catParts[1]) {
                            const catDesc = document.createElement('span');
                            catDesc.textContent = catParts[1].toUpperCase();
                            catEl.appendChild(catDesc);
                        }
                        el.appendChild(catEl);
                    }
                }
            }
        }
    });
    _linkifyObserver.observe(document.body, { childList: true, subtree: true });
}
let _linkifyObserver = null;

/** Apply a single ruff fix by rule code on the active editor (file or notebook cell). */
async function _applyFix(ruleCode) {
    let editorView = null;
    let project = '';
    let filename = 'cell.py';

    // Try FileEditor first (check active/visible ones)
    const fileEditor = [..._fileEditorInstances].find(
        fe => fe._lspEnabled && fe._editorView && fe._el?.offsetParent
    );
    if (fileEditor) {
        editorView = fileEditor._editorView;
        project = fileEditor._projectId;
        filename = fileEditor._filename;
    }

    // Try any registered editor that has the matching diagnostic
    if (!editorView) {
        for (const view of _editorViewRegistry) {
            let found = false;
            forEachDiagnostic(view.state, (d) => {
                if (d.message?.includes(ruleCode)) found = true;
            });
            if (found) { editorView = view; break; }
        }
    }

    if (!editorView) {
        notify.error('Could not find editor for fix');
        return;
    }

    const content = editorView.state.doc.toString();
    try {
        const resp = await fetch('api/lsp/fix-one', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                project,
                filename,
                content,
                code: ruleCode,
                line: 0,
            }),
        });
        if (!resp.ok) throw new Error(await resp.text());
        const { fixed, changed } = await resp.json();
        if (!changed) {
            notify.info('No fix available for this rule');
            return;
        }
        _showFixApprovalPanel({ _editorView: editorView }, ruleCode, content, fixed);
    } catch (e) {
        notify.error('Fix failed: ' + e.message);
    }
}

/** Show a before/after diff panel for a proposed fix. */
/** Callback for "Ask Assistant" - set by app.js */
let _onAskAssistant = null;
export function setOnAskAssistant(cb) { _onAskAssistant = cb; }
export { _linkifyLintTooltips as enableLintTooltips };

function _showFixApprovalPanel(editor, ruleCode, before, after) {
    const diffHtml = buildDiffHtml(before, after);
    if (!diffHtml) {
        notify.info('No visible changes');
        return;
    }

    jsPanel.create({
        headerTitle: `<i class="fa-solid fa-wrench" style="margin-right:6px;font-size:11px;color:#2e7d32"></i>Fix: ${ruleCode}`,
        theme: '#fff9e3 filled',
        borderRadius: '5px',
        contentSize: { width: Math.min(1300, window.innerWidth - 80), height: Math.min(700, window.innerHeight - 100) },
        position: 'center',
        headerControls: 'closeonly',
        content: `
            <div style="height:100%;display:flex;flex-direction:column;font-size:12px">
                <div style="flex:1;overflow:auto;overscroll-behavior:contain;background:#fff;font-family:var(--font-mono, monospace)">
                    ${diffHtml}
                </div>
                <div style="padding:8px 12px;border-top:1px solid #e0e0e0;background:#fafafa;display:flex;gap:8px;justify-content:flex-end;align-items:center">
                    <button class="fix-ask-btn" style="padding:4px 16px;font-size:12px;border:1px solid #5ba0d0;border-radius:4px;background:#e3f2fd;color:#1565c0;cursor:pointer;margin-right:auto">Ask Assistant</button>
                    <button class="fix-reject-btn" style="padding:4px 16px;font-size:12px;border:1px solid #e57373;border-radius:4px;background:#fff;color:#c62828;cursor:pointer">Reject</button>
                    <button class="fix-apply-btn" style="padding:4px 16px;font-size:12px;border:1px solid #66bb6a;border-radius:4px;background:#e8f5e9;color:#2e7d32;cursor:pointer;font-weight:600">Apply</button>
                </div>
            </div>
        `,
        callback: (p) => {
            p.content.style.backgroundColor = '#fff';
            p.content.querySelector('.fix-apply-btn').addEventListener('click', () => {
                const content = editor._editorView.state.doc.toString();
                editor._editorView.dispatch({
                    changes: { from: 0, to: content.length, insert: after },
                });
                notify.success(`Fixed: ${ruleCode}`);
                p.close();
            });
            p.content.querySelector('.fix-reject-btn').addEventListener('click', () => {
                p.close();
            });
            p.content.querySelector('.fix-ask-btn').addEventListener('click', () => {
                if (_onAskAssistant) {
                    const isFile = editor._projectId && editor._filename;
                    const location = isFile
                        ? `in file "${editor._filename}"`
                        : 'in the notebook cell';
                    const code = before;
                    _onAskAssistant(
                        `The linter reports rule ${ruleCode} ${location}. `
                        + `Here is the code:\n\`\`\`python\n${code}\n\`\`\`\n`
                        + `Explain what ${ruleCode} means and whether the suggested fix is safe to apply. Do not modify any files.`
                    );
                }
            });
        },
    });
}

function _escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
}

/** Track FileEditor instances for fix lookup. */
const _fileEditorInstances = new Set();

/** Map filename to CodeMirror language extension. */
function _languageForFile(filename) {
    if (/\.(js|ts|mjs|cjs)$/.test(filename)) return javascript();
    if (/\.(html|htm)$/.test(filename)) return html();
    if (/\.css$/.test(filename)) return css();
    if (/\.(json|jsonc)$/.test(filename)) return json();
    if (/\.(yml|yaml)$/.test(filename)) return yaml();
    if (/\.(r|rmd|qmd)$/i.test(filename)) return r();
    return python();
}

/** Map filename to LSP language identifier (null if no LSP support). */
function _lspLanguageForFile(filename) {
    if (/\.(js|ts|mjs|cjs)$/.test(filename)) return 'javascript';
    if (/\.(html|htm)$/.test(filename)) return 'html';
    if (/\.css$/.test(filename)) return 'css';
    if (/\.(json|jsonc)$/.test(filename)) return 'json';
    if (/\.(yml|yaml)$/.test(filename)) return 'yaml';
    if (/\.(r|rmd|qmd)$/i.test(filename)) return 'r';
    if (/\.py$/.test(filename)) return 'python';
    return null;
}

/** Build WebSocket URI for LSP connection. */
function _lspUri(projectId, envName = '', language = 'python') {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const base = `${proto}//${location.host}${location.pathname}`.replace(/\/+$/, '');
    return `${base}/ws/lsp?project=${encodeURIComponent(projectId)}&env=${encodeURIComponent(envName)}&language=${language}`;
}

export class FileEditor {
    constructor() {
        this._el = document.createElement('div');
        this._el.className = 'file-editor';

        this._editorView = null;
        this._projectId = null;
        this._filename = null;
        this._dirty = false;
        this._onDirtyChange = null;
        this._onContentChange = null;
        this._lspEnabled = false;
        this._onCursorActivity = null;
        this._onDiagnosticsChange = null;
        this._lastDiagCount = 0;
    }

    set onCursorActivity(cb) { this._onCursorActivity = cb; }
    set onContentChange(cb) { this._onContentChange = cb; }
    set onDiagnosticsChange(cb) { this._onDiagnosticsChange = cb; }
    set onBreakpointChange(cb) { this._onBreakpointChange = cb; }

    getBreakpoints() {
        if (!this._editorView) return [];
        return getBreakpoints(this._editorView);
    }

    setDebugCurrentLine(lineNum) {
        if (this._editorView) setCurrentLine(this._editorView, lineNum);
    }

    getDiagnostics() {
        if (!this._editorView) return [];
        const diags = [];
        forEachDiagnostic(this._editorView.state, (d, from, to) => {
            const line = this._editorView.state.doc.lineAt(from).number;
            diags.push({ message: d.message, severity: d.severity, from, to, line });
        });
        return diags;
    }

    get element() { return this._el; }
    get projectId() { return this._projectId; }
    get filename() { return this._filename; }
    get isDirty() { return this._dirty; }

    set onDirtyChange(cb) { this._onDirtyChange = cb; }

    setEnv(envName) {
        if (this._envName === envName) return;
        this._envName = envName;
        // Reconnect LSP with the new env
        if (this._projectId && this._filename) {
            this.open(this._projectId, this._filename, this._rootType);
        }
    }

    async open(projectId, filename, rootType = null) {
        this._projectId = projectId;
        this._filename = filename;
        this._rootType = rootType || 'project';
        this._dirty = false;
        this._partial = false;
        this._partialBytes = 0;
        this._totalBytes = 0;

        // Show loading indicator
        this._el.innerHTML = '';
        const loader = document.createElement('div');
        loader.className = 'file-editor-loading';
        loader.innerHTML = `
            <div class="file-editor-loading-bar">
                <div class="file-editor-loading-bar-fill"></div>
            </div>
            <span class="file-editor-loading-label">Loading ${filename.split('/').pop()}…</span>`;
        this._el.appendChild(loader);

        // Probe file size with a 1-byte Range request. If the backend answers
        // with HTTP 206 and a Content-Range header, parse the total size and
        // decide whether to prompt the user before loading a huge file.
        const LARGE_FILE_BYTES = 10 * 1024 * 1024;
        const PREVIEW_BYTES = 1 * 1024 * 1024;
        let totalSize = null;
        try {
            const probe = await fetch(
                `api/files/${this._rootType}/${encodeURIComponent(this._projectId)}/raw?path=${encodeURIComponent(filename)}`,
                { headers: { Range: 'bytes=0-0' } }
            );
            if (probe.status === 206) {
                const cr = probe.headers.get('content-range');
                const m = cr && cr.match(/\/(\d+)$/);
                if (m) totalSize = parseInt(m[1], 10);
            }
        } catch { /* probe failed - fall through to normal load */ }

        if (totalSize !== null && totalSize > LARGE_FILE_BYTES) {
            this._showLargeFileConfirm(totalSize, PREVIEW_BYTES);
            return;
        }

        await this._loadFullFile();
    }

    async _loadFullFile() {
        const filename = this._filename;
        const resp = await fetch(
            `api/files/${this._rootType}/${encodeURIComponent(this._projectId)}/read?path=${encodeURIComponent(filename)}`
        );
        if (!resp.ok) {
            notify.error(`Failed to load ${filename}`);
            return;
        }
        const data = await resp.json();
        this._partial = false;
        this._partialBytes = 0;
        this._totalBytes = 0;
        this._createEditor(data.content || '');
    }

    async _loadPartialFile(previewBytes, totalSize) {
        const filename = this._filename;
        const resp = await fetch(
            `api/files/${this._rootType}/${encodeURIComponent(this._projectId)}/raw?path=${encodeURIComponent(filename)}`,
            { headers: { Range: `bytes=0-${previewBytes - 1}` } }
        );
        if (!resp.ok && resp.status !== 206) {
            notify.error(`Failed to load preview of ${filename}`);
            return;
        }
        const text = await resp.text();
        this._partial = true;
        this._partialBytes = previewBytes;
        this._totalBytes = totalSize;
        this._createEditor(text);
        this._showPartialBanner();
    }

    _showLargeFileConfirm(totalSize, previewBytes) {
        const fileName = this._filename.split('/').pop();
        const sizeMB = (totalSize / 1024 / 1024).toFixed(1);
        const previewMB = (previewBytes / 1024 / 1024).toFixed(0);

        this._el.innerHTML = '';
        const card = document.createElement('div');
        card.className = 'file-editor-large-warning';
        card.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:32px;text-align:center;box-sizing:border-box';

        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-circle-exclamation';
        icon.style.cssText = 'font-size:42px;color:#f0a040;margin-bottom:16px';
        card.appendChild(icon);

        const title = document.createElement('div');
        title.style.cssText = 'font-size:16px;font-weight:600;color:var(--text-primary,#222);margin-bottom:8px;word-break:break-all;max-width:560px';
        title.textContent = `Large file: ${fileName}`;
        card.appendChild(title);

        const desc = document.createElement('div');
        desc.style.cssText = 'font-size:13px;color:var(--text-secondary,#666);margin-bottom:24px;max-width:480px;line-height:1.5';
        desc.innerHTML = `This file is <strong>${sizeMB} MB</strong>, which may freeze the editor while loading. Load a small preview or confirm loading the full file.`;
        card.appendChild(desc);

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;justify-content:center';

        const previewBtn = document.createElement('button');
        previewBtn.className = 'rm-btn';
        previewBtn.textContent = `Load preview (first ${previewMB} MB)`;
        previewBtn.addEventListener('click', () => this._loadPartialFile(previewBytes, totalSize));
        btnRow.appendChild(previewBtn);

        const fullBtn = document.createElement('button');
        fullBtn.className = 'rm-btn';
        fullBtn.textContent = `Load full file (${sizeMB} MB)`;
        fullBtn.addEventListener('click', () => this._loadFullFile());
        btnRow.appendChild(fullBtn);

        card.appendChild(btnRow);
        this._el.appendChild(card);
    }

    _showPartialBanner() {
        if (!this._partial) return;
        const partialMB = (this._partialBytes / 1024 / 1024).toFixed(1);
        const totalMB = (this._totalBytes / 1024 / 1024).toFixed(1);

        const banner = document.createElement('div');
        banner.className = 'file-editor-partial-banner';
        banner.style.cssText = 'display:flex;align-items:center;gap:12px;padding:6px 12px;background:#fff3cd;border-bottom:1px solid #ffd966;font-size:12px;color:#664d03;flex-shrink:0';

        const msg = document.createElement('span');
        msg.style.flex = '1';
        msg.innerHTML = `<i class="fa-solid fa-eye" style="margin-right:6px"></i>Preview mode - showing first ${partialMB} MB of ${totalMB} MB. Editor is read-only until the full file is loaded.`;
        banner.appendChild(msg);

        const loadFullBtn = document.createElement('button');
        loadFullBtn.className = 'rm-btn';
        loadFullBtn.style.cssText = 'padding:2px 10px;font-size:11px';
        loadFullBtn.textContent = 'Load full file';
        loadFullBtn.addEventListener('click', () => this._loadFullFile());
        banner.appendChild(loadFullBtn);

        this._el.insertBefore(banner, this._el.firstChild);
    }

    _createEditor(content) {
        if (this._editorView) {
            _allEditors.delete(this._editorView);
            _editorViewRegistry.delete(this._editorView);
            this._editorView.destroy();
        }
        this._el.innerHTML = '';

        // Heavy-file mode: for large documents, skip expensive extensions
        // (syntax highlighting, minimap, line wrapping, language pack) that
        // would otherwise freeze the tab during initial render.
        const HEAVY_FILE_BYTES = 2 * 1024 * 1024;
        const isHeavy = typeof content === 'string' && content.length > HEAVY_FILE_BYTES;
        this._heavy = isHeavy;

        const savedThemeName = localStorage.getItem('notebook-editor-theme') || 'Default';
        const initialTheme = editorThemes[savedThemeName] || [];

        const extensions = [
            lineNumbers(),
            highlightActiveLine(),
            highlightActiveLineGutter(),
            history(),
            indentUnit.of('    '),
            EditorState.tabSize.of(4),
            EditorState.readOnly.of(!!this._partial),
            keymap.of([
                ...defaultKeymap,
                ...historyKeymap,
                indentWithTab
            ]),
            EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                    if (!this._dirty) {
                        this._dirty = true;
                        if (this._onDirtyChange) this._onDirtyChange(true);
                    }
                    if (this._onContentChange) this._onContentChange(this.getContent());
                }
                if (update.selectionSet || update.focusChanged) {
                    this._emitCursorInfo();
                }
                // Check if diagnostics changed
                const count = diagnosticCount(update.state);
                if (count !== this._lastDiagCount) {
                    this._lastDiagCount = count;
                    if (this._onDiagnosticsChange) this._onDiagnosticsChange(this.getDiagnostics());
                    // Update minimap gutter markers (skip in heavy mode)
                    if (!this._heavy) this._updateMinimapGutters();
                }
            }),
            EditorView.theme({
                '&': { height: '100%' },
                '.cm-scroller': { overflow: 'auto' }
            }),
            _themeCompartment.of(initialTheme),
        ];
        if (!isHeavy) {
            extensions.push(
                syntaxHighlighting(defaultHighlightStyle),
                _languageForFile(this._filename || ''),
                EditorView.lineWrapping,
                _minimapCompartment.of(_minimapVisible
                    ? showMinimap.compute(['doc'], () => ({
                        create: () => ({ dom: document.createElement('div') }),
                        displayText: 'blocks',
                        showOverlay: 'mouse-over',
                    }))
                    : []
                ),
            );
        } else {
            // Empty compartment so later reconfiguration still works if needed.
            extensions.push(_minimapCompartment.of([]));
        }

        // LSP support for Python, JavaScript, HTML, CSS, JSON files.
        // Skipped in heavy-file mode to avoid shipping huge payloads to the
        // language server (which would freeze the LSP read loop).
        const lspLanguage = this._filename ? _lspLanguageForFile(this._filename) : null;
        const isLSPFile = lspLanguage && this._projectId && !isHeavy;
        if (isLSPFile) {
            try {
                // Python needs env for jedi venv path; others use shared server
                const lspEnv = lspLanguage === 'python' ? (this._envName || '') : '';
                const serverUri = _lspUri(this._projectId, lspEnv, lspLanguage);
                this._documentUri = `file:///${this._projectId}/${this._filename}`;

                // lintGutter before lineNumbers so it appears at the left edge
                extensions.unshift(lintGutter());
                // Breakpoint gutter for debug support
                extensions.push(...breakpointGutter((bps) => {
                    if (this._onBreakpointChange) this._onBreakpointChange(bps);
                    this._el.dispatchEvent(new CustomEvent('debug:breakpoints-changed', {
                        bubbles: true,
                        detail: { fileEditor: this, breakpoints: bps },
                    }));
                }));
                extensions.push(
                    languageServer({
                        serverUri,
                        rootUri: `file:///${this._projectId}`,
                        documentUri: this._documentUri,
                        languageId: lspLanguage,
                        allowHTMLContent: true,
                    }),
                    autocompletion(),
                    // Bind Tab to acceptCompletion (same handler as Enter)
                    // so users can accept suggestions with Tab, matching
                    // VS Code. acceptCompletion returns false when no
                    // popup is open, so Tab still indents in normal text.
                    // Prec.highest() is REQUIRED to beat the default Tab
                    // handler from basicSetup / indentWithTab.
                    Prec.highest((() => {
                        const enterBinding = completionKeymap.find(b => b.key === 'Enter');
                        const acceptRun = enterBinding ? enterBinding.run : null;
                        const km = acceptRun
                            ? [...completionKeymap, { key: 'Tab', run: acceptRun }]
                            : completionKeymap;
                        return keymap.of([
                            ...km,
                            { key: 'Ctrl-Shift-f', run: () => { this._formatDocument(); return true; } },
                        ]);
                    })()),
                );
                this._lspEnabled = true;
            } catch (e) {
                console.warn('[FileEditor] LSP setup failed:', e);
            }
        }

        this._editorView = new EditorView({
            state: EditorState.create({ doc: content, extensions }),
            parent: this._el
        });

        _allEditors.add(this._editorView);
        _editorViewRegistry.add(this._editorView);
        _fileEditorInstances.add(this);
        if (this._lspEnabled) _linkifyLintTooltips();
    }

    _updateMinimapGutters() {
        if (!this._editorView) return;
        const gutters = this._getMinimapGutters();
        this._editorView.dispatch({
            effects: _minimapCompartment.reconfigure(
                showMinimap.compute(['doc'], () => ({
                    create: () => ({ dom: document.createElement('div') }),
                    displayText: 'blocks',
                    showOverlay: 'mouse-over',
                    gutters,
                }))
            ),
        });
    }

    _getMinimapGutters() {
        if (!this._editorView) return [];
        // Minimap gutters format: array of { [lineNumber]: color } objects
        // Each object is a separate gutter column
        const lineColors = {};
        forEachDiagnostic(this._editorView.state, (d, from) => {
            const line = this._editorView.state.doc.lineAt(from).number;
            const color = d.severity === 'error' ? '#e53935'
                : d.severity === 'warning' ? '#e67e22'
                : '#4a9eda';
            // Higher severity wins if multiple diagnostics on same line
            if (!lineColors[line] || d.severity === 'error') {
                lineColors[line] = color;
            }
        });
        return Object.keys(lineColors).length ? [lineColors] : [];
    }

    _emitCursorInfo() {
        if (!this._onCursorActivity || !this._editorView) return;
        const state = this._editorView.state;
        const pos = state.selection.main.head;
        const line = state.doc.lineAt(pos);
        this._onCursorActivity({
            line: line.number,
            col: pos - line.from + 1,
            tabSize: state.tabSize || 4,
            lang: this._filename?.endsWith('.py') ? 'Python' : '',
        });
    }

    undo() {
        if (this._editorView) undo(this._editorView);
    }

    async goToDefinition() {
        if (!this._editorView) return;
        const plugin = this._editorView.plugin(languageServerPlugin);
        if (!plugin) return;
        const pos = this._editorView.state.selection.main.head;
        const doc = this._editorView.state.doc;
        const line = doc.lineAt(pos);
        const result = await plugin.requestDefinition(this._editorView, {
            line: line.number - 1,
            character: pos - line.from,
        });
        if (!result) return;
        // Same-file jump is already handled by the plugin
        if (result.uri === this._documentUri) return;
        // Cross-file: extract project-relative path from URI
        // URI format: file:///projectId/path/to/file.py
        const prefix = `file:///${this._projectId}/`;
        if (result.uri.startsWith(prefix) && this._onCrossFileNav) {
            const targetPath = result.uri.substring(prefix.length);
            const targetLine = result.range?.start?.line ?? 0;
            this._onCrossFileNav(this._projectId, targetPath, targetLine);
        }
    }

    set onCrossFileNav(fn) { this._onCrossFileNav = fn; }

    async _formatDocument() {
        if (!this._editorView || !this._lspEnabled) return;
        try {
            const content = this._editorView.state.doc.toString();
            const resp = await fetch('api/lsp/format', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    project: this._projectId,
                    filename: this._filename,
                    content,
                }),
            });
            if (!resp.ok) throw new Error(await resp.text());
            const { formatted } = await resp.json();
            if (formatted !== content) {
                this._editorView.dispatch({
                    changes: { from: 0, to: content.length, insert: formatted },
                });
                notify.success('Formatted');
            }
        } catch (e) {
            notify.error('Format failed: ' + e.message);
        }
    }

    async _organizeImports() {
        if (!this._editorView || !this._lspEnabled) return;
        try {
            const content = this._editorView.state.doc.toString();
            const resp = await fetch('api/lsp/organize-imports', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    project: this._projectId,
                    filename: this._filename,
                    content,
                }),
            });
            if (!resp.ok) throw new Error(await resp.text());
            const { formatted } = await resp.json();
            if (formatted !== content) {
                this._editorView.dispatch({
                    changes: { from: 0, to: content.length, insert: formatted },
                });
                notify.success('Imports organized');
            }
        } catch (e) {
            notify.error('Organize imports failed: ' + e.message);
        }
    }

    async save() {
        if (!this._projectId || !this._filename || !this._editorView) return;
        if (this._partial) {
            notify.error('Cannot save: file is loaded in preview mode. Load the full file first.');
            return;
        }
        const content = this._editorView.state.doc.toString();
        let resp;
        {
            resp = await fetch(
                `api/files/${this._rootType}/${encodeURIComponent(this._projectId)}/write?path=${encodeURIComponent(this._filename)}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content })
                }
            );
        }
        if (resp.ok) {
            this._dirty = false;
            if (this._onDirtyChange) this._onDirtyChange(false);
            notify.success(`${this._filename} saved`);
        } else {
            notify.error(`Failed to save ${this._filename}`);
        }
    }

    getContent() {
        return this._editorView ? this._editorView.state.doc.toString() : '';
    }

    /**
     * Replace the entire editor content without destroying/recreating the view.
     * Used when the backend writes a file and the editor needs to reflect it.
     */
    setContent(content) {
        if (!this._editorView) return;
        this._editorView.dispatch({
            changes: {
                from: 0,
                to: this._editorView.state.doc.length,
                insert: content
            }
        });
    }

    /**
     * Reload the file from disk (re-fetches from the server).
     */
    async reload() {
        if (!this._projectId || !this._filename) return;
        try {
            const resp = await fetch(
                `api/files/${this._rootType}/${encodeURIComponent(this._projectId)}/read?path=${encodeURIComponent(this._filename)}`
            );
            if (!resp.ok) return;
            const data = await resp.json();
            this.setContent(data.content || '');
            this._dirty = false;
            if (this._onDirtyChange) this._onDirtyChange(false);
        } catch (e) {
            console.error('FileEditor reload failed:', e);
        }
    }

    /** Show rendered markdown preview, hiding the editor. */
    showPreview() {
        if (!this._editorView) return;
        this._previewMode = true;
        // Hide editor
        this._editorView.dom.style.display = 'none';
        // Create preview div
        if (!this._previewEl) {
            this._previewEl = document.createElement('div');
            this._previewEl.className = 'markdown-preview';
            this._el.appendChild(this._previewEl);
        }
        const markdown = this._editorView.state.doc.toString();
        this._previewEl.innerHTML = typeof marked !== 'undefined'
            ? marked.parse(markdown)
            : `<pre>${markdown}</pre>`;
        // Syntax highlight code blocks
        if (typeof hljs !== 'undefined') {
            this._previewEl.querySelectorAll('pre code').forEach(block => {
                hljs.highlightElement(block);
            });
        }
        this._previewEl.style.display = '';
    }

    /** Hide preview, show editor again. */
    hidePreview() {
        this._previewMode = false;
        if (this._editorView) this._editorView.dom.style.display = '';
        if (this._previewEl) this._previewEl.style.display = 'none';
    }

    get isPreviewMode() { return !!this._previewMode; }

    destroy() {
        if (this._editorView) {
            _allEditors.delete(this._editorView);
            _editorViewRegistry.delete(this._editorView);
            _fileEditorInstances.delete(this);
            this._editorView.destroy();
            this._editorView = null;
        }
        this._el.innerHTML = '';
        this._projectId = null;
        this._filename = null;
        this._documentUri = null;
        this._dirty = false;
        this._lspEnabled = false;
    }

    /** Toggle minimap visibility on all open file editors. */
    static setMinimapEnabled(enabled) {
        _minimapVisible = enabled;
        for (const view of _allEditors) {
            view.dispatch({
                effects: _minimapCompartment.reconfigure(
                    enabled
                        ? showMinimap.compute(['doc'], () => ({
                            create: () => ({ dom: document.createElement('div') }),
                            displayText: 'blocks',
                            showOverlay: 'mouse-over',
                        }))
                        : []
                ),
            });
        }
    }

    /** Reconfigure theme on all open file editors. */
    static setTheme(themeName) {
        const theme = editorThemes[themeName] || [];
        for (const view of _allEditors) {
            view.dispatch({
                effects: _themeCompartment.reconfigure(theme)
            });
        }
    }
}
