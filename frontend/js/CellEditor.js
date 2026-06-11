import { CellOutput } from './CellOutput.js';
import { CellPostIt, POST_IT_ICON_CELL } from './CellPostIt.js';
import { enableLintTooltips, registerEditorView, unregisterEditorView } from './FileEditor.js';
import { breakpointGutter, setCurrentLine, getBreakpoints } from './BreakpointGutter.js';

/**
 * CellEditor - Manages a single notebook cell with CodeMirror editor.
 * CodeMirror 6 is loaded dynamically from ESM CDN on first use.
 */

import {
    EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
    EditorState, Compartment,
    defaultKeymap, indentWithTab, history, historyKeymap,
    syntaxHighlighting, defaultHighlightStyle, HighlightStyle,
    tags,
    python, javascript, markdown,
    lintGutter, setDiagnostics,
    autocompletion, completionKeymap,
    Prec,
    ayuLight, clouds, espresso, smoothy, tomorrow, oneDark
} from '../vendor/codemirror/codemirror.bundle.js';

/** Map LSP CompletionItemKind to CodeMirror completion type. */
function _completionKindToType(kind) {
    const map = {
        1: 'text', 2: 'method', 3: 'function', 4: 'constructor',
        5: 'field', 6: 'variable', 7: 'class', 8: 'interface',
        9: 'module', 10: 'property', 11: 'unit', 12: 'value',
        13: 'enum', 14: 'keyword', 15: 'snippet', 16: 'color',
        17: 'file', 18: 'reference', 19: 'folder', 20: 'enum',
        21: 'constant', 22: 'struct', 23: 'event', 24: 'operator',
        25: 'type',
    };
    return map[kind] || 'text';
}

/** Highlight style for markdown tokens. */
const markdownHighlightStyle = HighlightStyle.define([
    { tag: tags.heading1, fontWeight: 'bold', fontSize: '1.4em', color: '#1a1a1a' },
    { tag: tags.heading2, fontWeight: 'bold', fontSize: '1.2em', color: '#2a2a2a' },
    { tag: tags.heading3, fontWeight: 'bold', fontSize: '1.1em', color: '#3a3a3a' },
    { tag: tags.heading, fontWeight: 'bold', color: '#1a1a1a' },
    { tag: tags.emphasis, fontStyle: 'italic', color: '#6a5acd' },
    { tag: tags.strong, fontWeight: 'bold', color: '#d63384' },
    { tag: tags.link, color: '#0969da', textDecoration: 'underline' },
    { tag: tags.url, color: '#0969da' },
    { tag: tags.monospace, fontFamily: 'var(--font-mono)', backgroundColor: '#f0f0f0', borderRadius: '3px', color: '#c7254e' },
    { tag: tags.strikethrough, textDecoration: 'line-through', color: '#999' },
    { tag: tags.quote, color: '#57606a', fontStyle: 'italic' },
    { tag: tags.list, color: '#cf222e' },
    { tag: tags.processingInstruction, color: '#888' },
]);

const cmModules = {
    EditorView, keymap, lineNumbers, highlightActiveLine,
    highlightActiveLineGutter, EditorState, defaultKeymap,
    indentWithTab, history, historyKeymap,
    syntaxHighlighting, defaultHighlightStyle,
    python, javascript, markdown
};

/** Shared theme compartment for all editors. */
const _themeCompartment = new Compartment();

/** Track all live CellEditor instances for theme reconfiguration. */
const _allEditors = new Set();

/** Available editor themes keyed by name. */
export const editorThemes = {
    'Default': null,
    'Ayu Light': ayuLight,
    'Clouds': clouds,
    'Espresso': espresso,
    'Smoothy': smoothy,
    'Tomorrow': tomorrow,
    'One Dark': oneDark
};

function loadCodeMirror() {
    return cmModules;
}


// Track the currently focused cell so we can blur it when another is focused
let _currentlyFocusedCell = null;
let _currentProjectId = null;

export class CellEditor {
    /**
     * @param {object} cellData - Cell data from .ipynb JSON
     * @param {number} index - Cell index in notebook
     * @param {object} callbacks - { onFocus, onBlur, onChange, onRun, onDelete }
     */
    constructor(cellData, index, callbacks = {}, kernelLanguage = '') {
        this._data = cellData;
        this._index = index;
        this._callbacks = callbacks;
        this._cellType = cellData.cell_type || 'code';
        this._kernelLanguage = kernelLanguage;
        this._source = Array.isArray(cellData.source)
            ? cellData.source.join('')
            : (cellData.source || '');
        this._executionCount = cellData.execution_count;
        this._editorView = null;
        this._locked = false;
        this._lockedBy = null;
        this._focused = false;
        this._executing = false;
        this._markdownRendered = false;

        this._output = new CellOutput();
        this._el = this._buildElement();
        _allEditors.add(this);

        if (cellData.outputs && cellData.outputs.length > 0) {
            this._output.setOutputs(cellData.outputs);
        }

        // Post-it note (persisted in cell.metadata.noted)
        if (!this._data.metadata) this._data.metadata = {};
        this._postIt = new CellPostIt(this._el, this._data.metadata, () => {
            this._notifyChange();
        });

        this._initEditor();
    }

    get element() { return this._el; }
    get index() { return this._index; }
    set index(val) {
        this._index = val;
        this._updateExecutionCount();
    }

    get cellType() { return this._cellType; }
    get kernelLanguage() { return this._kernelLanguage; }
    get source() { return this._getSource(); }
    get cellId() { return this._data.id; }
    get output() { return this._output; }
    get isEditorFocused() { return !!this._editorView?.hasFocus; }

    focusCell() { this._el.focus({ preventScroll: true }); }
    focusEditor() { this._editorView?.focus(); }

    /** Notify parent that cell content/metadata changed. */
    _notifyChange() {
        if (this._callbacks.onChange) {
            this._callbacks.onChange(this._index, this._getSource());
        }
    }

    _buildElement() {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.cellType = this._cellType;
        cell.dataset.kernelLanguage = this._kernelLanguage;
        cell.tabIndex = -1;

        // Click anywhere on the cell — delegate to notebook for selection
        cell.addEventListener('mousedown', (e) => {
            if (this._callbacks.onCellMousedown) {
                this._callbacks.onCellMousedown(this._index, e);
            } else if (!this._focused) {
                this._onFocus();
            }
        });

        // Click (fires after mouseup, but NOT after drag) — for deferred focus
        cell.addEventListener('click', (e) => {
            if (this._callbacks.onCellClick) {
                this._callbacks.onCellClick(this._index, e);
            }
        });

        // Command-mode keydown: only fires when cell has focus but editor does not
        cell.addEventListener('keydown', (e) => {
            if (this.isEditorFocused) return;
            if (this._callbacks.onCellKeydown) this._callbacks.onCellKeydown(this._index, e);
        });

        // Cell-level drag (for multi-selection; cell.draggable is toggled by NotebookEditor)
        cell.addEventListener('dragstart', (e) => {
            if (this._callbacks.onCellDragStart) {
                this._callbacks.onCellDragStart(this._index, e);
            }
        });
        cell.addEventListener('dragend', () => {
            if (this._callbacks.onCellDragEnd) {
                this._callbacks.onCellDragEnd(this._index);
            }
        });

        // Sidebar
        const sidebar = document.createElement('div');
        sidebar.className = 'cell-sidebar';

        // Run button wrapper (play icon + chevron dropdown for debug mode)
        const runWrap = document.createElement('div');
        runWrap.className = 'cell-run-wrap';

        this._runBtn = document.createElement('button');
        this._runBtn.className = 'cell-run-btn';
        this._runBtn.textContent = '\u25B6';
        this._runBtn.title = 'Run cell';
        this._runMode = 'run';  // 'run' or 'debug'
        this._runBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._debugging) {
                if (this._callbacks.onDebugStop) this._callbacks.onDebugStop();
            } else if (this._executing) {
                if (this._callbacks.onInterrupt) this._callbacks.onInterrupt();
            } else if (this._runMode === 'debug') {
                if (this._callbacks.onDebugRun) {
                    this._callbacks.onDebugRun(this._index, this._getSource());
                }
            } else {
                this._onRun();
            }
        });
        runWrap.appendChild(this._runBtn);

        // Chevron dropdown for switching run mode (code cells only)
        if (this._cellType === 'code') {
            const chevron = document.createElement('div');
            chevron.className = 'cell-run-chevron';
            chevron.textContent = '\u25BC';
            chevron.title = 'Switch run mode';
            chevron.addEventListener('click', (e) => {
                e.stopPropagation();
                this._showRunModeDropdown(chevron);
            });
            runWrap.appendChild(chevron);
        }

        sidebar.appendChild(runWrap);

        const dragHandle = document.createElement('div');
        dragHandle.className = 'cell-drag-handle';
        dragHandle.textContent = '\u2847';
        dragHandle.title = 'Drag to reorder';
        dragHandle.draggable = true;
        dragHandle.addEventListener('dragstart', (e) => {
            if (this._callbacks.onCellDragStart) {
                this._callbacks.onCellDragStart(this._index, e);
            } else {
                e.dataTransfer.setData('text/plain', String(this._index));
                e.dataTransfer.effectAllowed = 'move';
                cell.classList.add('dragging');
            }
        });
        dragHandle.addEventListener('dragend', () => {
            if (this._callbacks.onCellDragEnd) {
                this._callbacks.onCellDragEnd(this._index);
            } else {
                cell.classList.remove('dragging');
            }
        });
        sidebar.appendChild(dragHandle);

        // Execution count (code cells only) — outside sidebar so it's always visible
        const sidebarExecCount = document.createElement('span');
        sidebarExecCount.className = 'cell-sidebar-exec-count';
        this._sidebarExecCountEl = sidebarExecCount;
        this._updateExecutionCount();
        cell.appendChild(sidebarExecCount);

        // Header
        const header = document.createElement('div');
        header.className = 'cell-header';

        const typeBadge = document.createElement('span');
        typeBadge.className = `cell-type-badge ${this._cellType}`;
        typeBadge.textContent = this._cellType;

        const runningBadge = document.createElement('span');
        runningBadge.className = 'cell-running-badge';
        runningBadge.textContent = 'RUNNING';

        // Left segment
        const headerLeft = document.createElement('div');
        headerLeft.className = 'cell-header-left';
        headerLeft.appendChild(typeBadge);

        // Center segment
        const headerCenter = document.createElement('div');
        headerCenter.className = 'cell-header-center';

        const addCodeBtn = document.createElement('button');
        addCodeBtn.className = 'cell-header-btn cell-add-code-btn';
        addCodeBtn.textContent = '+ code';
        addCodeBtn.title = 'Insert code cell before';
        addCodeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._callbacks.onAddCell) this._callbacks.onAddCell(this._index, 'code');
        });

        const addMdBtn = document.createElement('button');
        addMdBtn.className = 'cell-header-btn cell-add-md-btn';
        addMdBtn.textContent = '+ markdown';
        addMdBtn.title = 'Insert markdown cell before';
        addMdBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._callbacks.onAddCell) this._callbacks.onAddCell(this._index, 'markdown');
        });

        headerCenter.append(addCodeBtn, addMdBtn);

        const lockIndicator = document.createElement('span');
        lockIndicator.className = 'cell-lock-indicator hidden';
        this._lockIndicatorEl = lockIndicator;

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'cell-delete-btn';
        deleteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" fill="#f4a0a0"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
        deleteBtn.title = 'Delete cell';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._callbacks.onDelete) this._callbacks.onDelete(this._index);
        });

        const copyBtn = document.createElement('button');
        copyBtn.className = 'cell-copy-btn';
        copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" fill="#a8d8a0"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
        copyBtn.title = 'Copy cell content';
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const source = this._getSource();
            navigator.clipboard.writeText(source).then(() => {
                const tip = document.createElement('span');
                tip.className = 'cell-copy-toast';
                tip.textContent = 'Copied';
                copyBtn.style.position = 'relative';
                copyBtn.appendChild(tip);
                setTimeout(() => tip.remove(), 1200);
            });
        });

        const clearBtn = document.createElement('button');
        clearBtn.className = 'cell-clear-btn';
        clearBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15.5 4 5 5-11 11H5l-2.5-2.5a1.5 1.5 0 010-2L15.5 4z" fill="#f0d080"/><path d="M5 20.5L2.5 18"/><path d="M4 22h17"/></svg>';
        clearBtn.title = 'Clear cell output';
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.clearOutput();
        });

        const runAboveBtn = document.createElement('button');
        runAboveBtn.className = 'cell-header-btn cell-run-above-btn';
        runAboveBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="1,4 1,20 13,12" fill="#f0b870"/><line x1="20" y1="20" x2="20" y2="9"/><polygon points="16,12 20,5 24,12" fill="#202020"/></svg>';
        runAboveBtn.title = 'Execute all cells above';
        runAboveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._callbacks.onRunAbove) this._callbacks.onRunAbove(this._index);
        });

        const runBelowBtn = document.createElement('button');
        runBelowBtn.className = 'cell-header-btn cell-run-below-btn';
        runBelowBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="1,4 1,20 13,12" fill="#f0b870"/><line x1="20" y1="4" x2="20" y2="15"/><polygon points="16,12 20,19 24,12" fill="#202020"/></svg>';
        runBelowBtn.title = 'Execute this cell and all below';
        runBelowBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._callbacks.onRunBelow) this._callbacks.onRunBelow(this._index);
        });

        // Add to Experiment button
        const addRunBtn = document.createElement('button');
        addRunBtn.className = 'cell-header-btn cell-add-run-btn';
        addRunBtn.innerHTML = '<i class="fa-solid fa-bookmark" style="font-size:12px;color:#83b8ef;-webkit-text-stroke:1.5px #202020;paint-order:stroke fill"></i>';
        addRunBtn.title = 'Track in experiment';
        addRunBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._callbacks.onAddToRun) this._callbacks.onAddToRun(this._index);
        });

        // Post-it button
        const postItBtn = document.createElement('button');
        postItBtn.className = 'cell-delete-btn cell-postit-btn';
        postItBtn.innerHTML = POST_IT_ICON_CELL;
        postItBtn.title = 'Note this cell';
        postItBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._postIt.toggle();
            postItBtn.classList.toggle('has-note', this._postIt.hasNote());
        });
        this._postItBtn = postItBtn;
        // Highlight if note already exists
        if (this._data.metadata?.noted?.annotation !== undefined) {
            postItBtn.classList.add('has-note');
        }

        // Export as @task button (code cells only)
        const exportTaskBtn = document.createElement('button');
        exportTaskBtn.className = 'cell-header-btn cell-export-task-btn';
        exportTaskBtn.innerHTML = '<i class="fa-solid fa-rocket" style="font-size:13px;color:#ff9800;-webkit-text-stroke:1px #202020;paint-order:stroke fill"></i>';
        exportTaskBtn.title = 'Export as Pipeline Task';
        exportTaskBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const source = this._getSource();
            const taskName = `task_cell_${this._index}`;
            const indented = source.split('\n').map(l => '    ' + l).join('\n');
            const code = [
                'from airflow.decorators import task',
                '',
                `@task()`,
                `def ${taskName}():`,
                `    """Exported from notebook cell ${this._index}."""`,
                indented,
            ].join('\n');
            navigator.clipboard.writeText(code).then(() => {
                const tip = document.createElement('span');
                tip.className = 'cell-copy-toast';
                tip.textContent = '@task copied';
                exportTaskBtn.style.position = 'relative';
                exportTaskBtn.appendChild(tip);
                setTimeout(() => tip.remove(), 1500);
            });
        });

        // Ask Assistant button
        // Ask Assistant dropdown
        const askWrapper = document.createElement('div');
        askWrapper.className = 'cell-ask-wrapper';
        const askBtn = document.createElement('button');
        askBtn.className = 'cell-header-btn cell-ask-btn';
        askBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="#c8e6c0"/></svg>';
        askBtn.title = 'Ask Assistant about this cell';

        const askMenu = document.createElement('div');
        askMenu.className = 'cell-ask-menu';

        const codeActions = [
            { label: 'Explain', prompt: 'Explain this code' },
            { label: 'Refactor', prompt: 'Suggest refactoring improvements for this code' },
            { label: 'Debug', prompt: 'Find potential bugs or issues in this code' },
            { label: 'Document', prompt: 'Add docstrings and comments to this code' },
            { label: 'Test', prompt: 'Suggest unit tests for this code' },
            { label: 'Optimize', prompt: 'Suggest performance optimizations for this code' },
        ];
        const markdownActions = [
            { label: 'Review', prompt: 'Review this text for grammar and clarity' },
            { label: 'Summarize', prompt: 'Summarize this text concisely' },
            { label: 'Improve', prompt: 'Improve the writing quality of this text' },
            { label: 'Extend', prompt: 'Expand this text with more detail' },
            { label: 'Simplify', prompt: 'Simplify this text for a broader audience' },
        ];

        const actions = this._cellType === 'code' ? codeActions : markdownActions;
        for (const action of actions) {
            const item = document.createElement('div');
            item.className = 'cell-ask-menu-item';
            item.textContent = action.label;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                askMenu.classList.remove('visible');
                const source = this._getSource();
                const llmMessage = `${action.prompt} in cell ${this._index}`;
                let displayMessage;
                if (this._cellType === 'code') {
                    displayMessage = `${action.prompt} in cell ${this._index}:\n\`\`\`python\n${source}\n\`\`\``;
                } else {
                    displayMessage = `${action.prompt} in cell ${this._index}:\n\n${source}`;
                }
                document.dispatchEvent(new CustomEvent('ask-assistant', {
                    detail: { message: llmMessage, displayMessage, action: action.label }
                }));
            });
            askMenu.appendChild(item);
        }

        // Menu shows on hover via CSS; no click handler needed

        askWrapper.appendChild(askBtn);
        askWrapper.appendChild(askMenu);

        // Right segment
        const headerRight = document.createElement('div');
        headerRight.className = 'cell-header-right';
        if (this._cellType === 'code') {
            headerRight.append(lockIndicator, addRunBtn, exportTaskBtn, postItBtn, askWrapper, runAboveBtn, runBelowBtn, copyBtn, clearBtn, deleteBtn);
        } else {
            headerRight.append(lockIndicator, postItBtn, askWrapper, runAboveBtn, runBelowBtn, copyBtn, deleteBtn);
        }

        header.append(headerLeft, headerCenter, headerRight);

        // Editor area
        const editorArea = document.createElement('div');
        editorArea.className = 'cell-editor';
        this._editorAreaEl = editorArea;

        // Markdown rendered view
        const mdRendered = document.createElement('div');
        mdRendered.className = 'cell-markdown-rendered hidden';
        this._mdRenderedEl = mdRendered;

        // Run badges container (right side of cell)
        const runBadges = document.createElement('div');
        runBadges.className = 'cell-run-badges';
        this._runBadgesEl = runBadges;

        cell.append(sidebar, header, runningBadge, editorArea, mdRendered, runBadges);

        if (this._cellType === 'code') {
            cell.appendChild(this._output.element);
        }

        return cell;
    }

    _sidebarBtn(label, title, onClick) {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.title = title;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return btn;
    }

    async _initEditor() {
        const cm = await loadCodeMirror();

        // Resolve initial theme from localStorage
        const savedThemeName = localStorage.getItem('notebook-editor-theme') || 'Default';
        const initialTheme = editorThemes[savedThemeName] || [];

        const extensions = [
            cm.lineNumbers(),
            cm.highlightActiveLine(),
            cm.highlightActiveLineGutter(),
            cm.history(),
            cm.syntaxHighlighting(cm.defaultHighlightStyle, { fallback: true }),
            cm.keymap.of([
                { key: 'Shift-Enter', run: () => { this._onRun(); return true; } },
                { key: 'Ctrl-Enter', run: () => { this._onRun(); return true; } },
                { key: 'Escape', run: () => {
                    if (this._cellType === 'markdown') {
                        this._showMarkdownRendered();
                    }
                    this._editorView.contentDOM.blur();
                    this._el.focus(); // enter command mode
                    return true;
                }},
                ...cm.defaultKeymap,
                ...cm.historyKeymap,
                cm.indentWithTab
            ]),
            cm.EditorView.updateListener.of((update) => {
                if (update.docChanged) this._onContentChanged();
                if (update.focusChanged) {
                    if (update.view.hasFocus) {
                        this._onFocus();
                        if (this._callbacks.onEditorFocus) this._callbacks.onEditorFocus(this._index);
                        this._emitCursorInfo(update.view);
                    } else {
                        this._onBlur();
                        if (this._callbacks.onEditorBlur) this._callbacks.onEditorBlur(this._index);
                    }
                }
                if (update.selectionSet || update.docChanged) {
                    if (update.view.hasFocus) this._emitCursorInfo(update.view);
                }
            }),
            cm.EditorView.theme({
                '&': { height: 'auto' },
                '.cm-scroller': { overflow: 'auto' }
            }),
            _themeCompartment.of(initialTheme)
        ];

        if (this._cellType === 'code') {
            if (this._kernelLanguage === 'javascript') {
                extensions.push(cm.javascript());
            } else if (this._kernelLanguage === 'python') {
                extensions.push(cm.python());
            }
            extensions.unshift(lintGutter());
            enableLintTooltips();
            // Breakpoint gutter (click to toggle breakpoints)
            extensions.push(...breakpointGutter((bps) => {
                if (this._callbacks.onBreakpointChange) {
                    this._callbacks.onBreakpointChange(this._index, bps);
                }
            }));
            // Notebook autocompletion via REST API
            extensions.push(autocompletion({
                override: [this._notebookCompletionSource.bind(this)],
            }));
            // The default completionKeymap binds Enter to acceptCompletion;
            // we additionally bind Tab to the same handler so users can
            // accept suggestions with Tab (matching VS Code). Tab still
            // indents when no popup is open: acceptCompletion returns
            // false in that case, so the binding falls through to the
            // editor's default Tab handler.
            //
            // Prec.highest() is REQUIRED here. Without it, CodeMirror's
            // default Tab handler (insertTab from basicSetup) wins the
            // race because it's at default precedence and registered
            // earlier in the extension chain. acceptCompletion never
            // gets a chance to run.
            const _acceptRun = (() => {
                const enterBinding = completionKeymap.find(b => b.key === 'Enter');
                return enterBinding ? enterBinding.run : null;
            })();
            const _completionKeymapWithTab = _acceptRun
                ? [...completionKeymap, { key: 'Tab', run: _acceptRun }]
                : completionKeymap;
            extensions.push(Prec.highest(cm.keymap.of(_completionKeymapWithTab)));
        } else if (this._cellType === 'markdown') {
            extensions.push(cm.markdown());
            extensions.push(syntaxHighlighting(markdownHighlightStyle));
            extensions.push(cm.EditorView.lineWrapping);
        }

        this._editorView = new cm.EditorView({
            state: cm.EditorState.create({
                doc: this._source,
                extensions
            }),
            parent: this._editorAreaEl
        });

        registerEditorView(this._editorView);

        this._syncGutterWidth();

        if (this._cellType === 'markdown' && this._source.trim()) {
            this._showMarkdownRendered();
        }
    }

    _syncGutterWidth() {
        if (!this._editorView || this._gutterObserver) return;
        const gutterEl = this._editorAreaEl.querySelector('.cm-gutters');
        if (gutterEl) {
            this._el.style.setProperty('--gutter-width', gutterEl.offsetWidth + 'px');
            this._gutterObserver = new ResizeObserver(() => {
                this._el.style.setProperty('--gutter-width', gutterEl.offsetWidth + 'px');
            });
            this._gutterObserver.observe(gutterEl);
        }
    }

    /** Set the current debug execution line (1-based) or 0 to clear. */
    setDebugCurrentLine(lineNum) {
        if (this._editorView && this._cellType === 'code') {
            setCurrentLine(this._editorView, lineNum);
        }
    }

    /** Set run mode to debug (shows bug icon) - called when debug session starts. */
    setDebugMode(active) {
        if (!this._runBtn) return;
        this._debugging = active;
        if (active) {
            // During active debug: show stop icon
            this._runBtn.innerHTML = '\u25A0';
            this._runBtn.title = 'Stop debugging';
            this._runBtn.classList.add('stopping');
        } else {
            // Revert to normal run mode
            this._runMode = 'run';
            this._runBtn.textContent = '\u25B6';
            this._runBtn.title = 'Run cell';
            this._runBtn.classList.remove('stopping', 'debug-mode');
        }
    }

    /** Switch run button between play and bug modes. */
    _setRunMode(mode) {
        this._runMode = mode;
        if (mode === 'debug') {
            this._runBtn.innerHTML = '<i class="fa-solid fa-bug" style="font-size:11px"></i>';
            this._runBtn.title = 'Debug cell (Ctrl+Shift+Enter)';
            this._runBtn.classList.add('debug-mode');
        } else {
            this._runBtn.textContent = '\u25B6';
            this._runBtn.title = 'Run cell';
            this._runBtn.classList.remove('debug-mode');
        }
    }

    /** Show dropdown to pick run or debug mode. */
    _showRunModeDropdown(anchor) {
        // Remove existing dropdown
        const existing = document.querySelector('.cell-run-dropdown');
        if (existing) { existing.remove(); return; }

        const dd = document.createElement('div');
        dd.className = 'cell-run-dropdown';

        const items = [
            { mode: 'run', icon: '<span style="color:var(--accent-green);-webkit-text-stroke:1.5px #202020;paint-order:stroke fill">\u25B6</span>', label: 'Run Cell' },
            { mode: 'debug', icon: '<i class="fa-solid fa-bug" style="color:#e53935;-webkit-text-stroke:1.5px #202020;paint-order:stroke fill"></i>', label: 'Debug Cell' },
        ];

        for (const item of items) {
            const row = document.createElement('div');
            row.className = 'cell-run-dropdown-item';
            if (item.mode === this._runMode) row.classList.add('active');
            row.innerHTML = `<span class="cell-run-dropdown-icon">${item.icon}</span>${item.label}`;
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                this._setRunMode(item.mode);
                dd.remove();
            });
            dd.appendChild(row);
        }

        // Position relative to the anchor
        const rect = anchor.getBoundingClientRect();
        dd.style.position = 'fixed';
        dd.style.left = `${rect.left}px`;
        dd.style.top = `${rect.bottom + 2}px`;
        document.body.appendChild(dd);

        // Close on outside click or mouse leave
        const close = (e) => {
            if (!dd.contains(e.target)) { cleanup(); }
        };
        const onLeave = () => { cleanup(); };
        const cleanup = () => {
            dd.remove();
            document.removeEventListener('mousedown', close);
            dd.removeEventListener('mouseleave', onLeave);
        };
        dd.addEventListener('mouseleave', onLeave);
        requestAnimationFrame(() => document.addEventListener('mousedown', close));
    }

    /** Get breakpoint line numbers for this cell. */
    getBreakpoints() {
        if (this._editorView && this._cellType === 'code') {
            return getBreakpoints(this._editorView);
        }
        return [];
    }

    _getSource() {
        if (this._editorView) {
            return this._editorView.state.doc.toString();
        }
        return this._source;
    }

    /** Set notebook context for jedi completions/hover. Called by NotebookEditor. */
    setLSPContext(projectId, notebookPath, envName) {
        this._lspProject = projectId;
        this._lspNotebook = notebookPath;
        this._lspEnv = envName || '';
    }

    async _notebookCompletionSource(context) {
        if (!this._lspProject || !this._lspNotebook) return null;
        const pos = context.pos;
        const line = context.state.doc.lineAt(pos);
        const lineNum = line.number - 1;
        const character = pos - line.from;
        // Trigger heuristics (apply to every notebook language):
        //   - explicit (Ctrl+Space): always
        //   - after `.`: object attribute access in Python / R / JS
        //   - R-flavored: after `(`, `:`, `$`, `@`, `[` for library(),
        //     pkg::sym, df$col, S4@slot, df[col] patterns
        //   - 2+ word chars: bare identifier completion (the L9 case:
        //     `my_spec` should suggest `my_special_var` without needing
        //     Ctrl+Space). Was previously gated to R only, but Python
        //     has the same need - notebooks rely on cross-cell symbols.
        let shouldTrigger = context.explicit || !!context.matchBefore(/\.\w*$/);
        if (!shouldTrigger) {
            if (context.matchBefore(/[(:$@\[]\w*$/)) shouldTrigger = true;
            else {
                const w = context.matchBefore(/\w+$/);
                if (w && (w.to - w.from) >= 2) shouldTrigger = true;
            }
        }
        if (!shouldTrigger) return null;
        try {
            const resp = await fetch('api/lsp/notebook/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    project: this._lspProject,
                    env: this._lspEnv,
                    notebook_path: this._lspNotebook,
                    cell_index: this._index,
                    line: lineNum,
                    character,
                    content: context.state.doc.toString(),
                }),
            });
            if (!resp.ok) return null;
            const data = await resp.json();
            if (!data.items?.length) return null;
            // Find the start of the word being completed
            const word = context.matchBefore(/\w*$/);
            const from = word ? word.from : pos;
            return {
                from,
                // Preserve LSP order: jedi sorts items via sortText (e.g. 'v000',
                // 'v001', ..., 'y526'), but parseInt on those returns NaN. Use the
                // item's index as a negative boost so the first item displays first.
                options: data.items.map((item, idx) => ({
                    label: item.label,
                    type: _completionKindToType(item.kind),
                    detail: item.detail || '',
                    boost: -idx,
                })),
            };
        } catch {
            return null;
        }
    }

    setLintDiagnostics(diagnostics) {
        if (!this._editorView || this._cellType !== 'code') return;
        const doc = this._editorView.state.doc;
        const cmDiags = [];
        for (const d of diagnostics) {
            const startLine = d.range?.start?.line ?? 0;
            const startChar = d.range?.start?.character ?? 0;
            const endLine = d.range?.end?.line ?? startLine;
            const endChar = d.range?.end?.character ?? startChar;
            // Diagnostics arrive asynchronously and may reference an
            // older, longer version of the cell text - if the user has
            // deleted lines or characters since the lint ran, the
            // original positions can fall past the document end and
            // CodeMirror's lineAt() throws RangeError. Drop diagnostics
            // whose start line no longer exists; clamp the rest so
            // every offset is in bounds before we hand them to CM.
            if (startLine >= doc.lines) continue;
            const startLineObj = doc.line(startLine + 1);
            const safeStartChar = Math.min(startChar, startLineObj.length);
            const from = startLineObj.from + safeStartChar;
            const safeEndLine = Math.min(endLine, doc.lines - 1);
            const endLineObj = doc.line(safeEndLine + 1);
            const safeEndChar = Math.min(endChar, endLineObj.length);
            const to = Math.min(endLineObj.from + safeEndChar, doc.length);
            const severity = d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info';
            cmDiags.push({ from, to: Math.max(to, from), severity, message: d.message || '' });
        }
        this._editorView.dispatch(setDiagnostics(this._editorView.state, cmDiags));
    }

    setSource(source) {
        if (this._editorView) {
            const currentDoc = this._editorView.state.doc.toString();
            if (currentDoc !== source) {
                this._editorView.dispatch({
                    changes: { from: 0, to: currentDoc.length, insert: source }
                });
            }
        }
        this._source = source;
    }

    _onFocus() {
        if (_currentlyFocusedCell && _currentlyFocusedCell !== this) {
            _currentlyFocusedCell._onBlur();
        }
        _currentlyFocusedCell = this;
        this._focused = true;
        this._el.classList.add('focused');
        if (this._callbacks.onFocus) this._callbacks.onFocus(this._index);
    }

    _onBlur() {
        if (_currentlyFocusedCell === this) {
            _currentlyFocusedCell = null;
        }
        this._focused = false;
        this._el.classList.remove('focused');
        if (this._callbacks.onBlur) this._callbacks.onBlur(this._index);
    }

    _emitCursorInfo(view) {
        if (!this._callbacks.onCursorActivity) return;
        const pos = view.state.selection.main.head;
        const line = view.state.doc.lineAt(pos);
        const lang = this._cellType === 'code' ? 'Python'
            : this._cellType === 'markdown' ? 'Markdown' : '';
        this._callbacks.onCursorActivity({
            line: line.number,
            col: pos - line.from + 1,
            tabSize: view.state.tabSize,
            lang,
        });
    }

    _onContentChanged() {
        if (this._callbacks.onChange) {
            this._callbacks.onChange(this._index, this._getSource());
        }
    }

    _onRun() {
        if (this._cellType === 'code') {
            if (this._callbacks.onRun) {
                this._callbacks.onRun(this._index, this._getSource());
            }
        } else if (this._cellType === 'markdown') {
            this._showMarkdownRendered();
        }
    }

    /** Called after kernel check passes to commit to execution. */
    startExecuting(debug = false) {
        this._debugAborted = false;
        this._executing = true;
        this._executeStart = performance.now();
        this._el.classList.add('executing');
        this._runBtn.textContent = '\u25A0';
        this._runBtn.title = 'Interrupt execution';
        this._runBtn.classList.add('stopping');
        this._data.outputs = [];
        this._output.showExecuting(debug ? 'Debugging...' : 'Running...');
    }

    onExecuteComplete(executionCount, serverElapsed) {
        this._executing = false;
        this._el.classList.remove('executing');
        this._runBtn.textContent = '\u25B6';
        this._runBtn.title = 'Run cell';
        this._runBtn.classList.remove('stopping');
        this._executionCount = executionCount;
        this._updateExecutionCount();
        // Clear the "Running..." spinner if no output replaced it
        const executing = this._output.element.querySelector('.output-executing');
        if (executing) executing.remove();
        // Show elapsed time: prefer backend-provided (accurate per-cell),
        // fall back to frontend timer (total elapsed)
        if (serverElapsed != null) {
            this._executeStart = null;
            this._output.showElapsed(serverElapsed);
        } else if (this._executeStart) {
            const elapsed = (performance.now() - this._executeStart) / 1000;
            this._executeStart = null;
            this._output.showElapsed(elapsed);
        }
    }

    addOutput(output) {
        if (!this._data.outputs) this._data.outputs = [];
        this._data.outputs.push(output);
        this._output.addOutput(output);
    }

    clearOutput() {
        this._data.outputs = [];
        this._output.clear();
    }

    _updateExecutionCount() {
        if (!this._sidebarExecCountEl) return;
        if (this._cellType === 'code') {
            const count = this._executionCount;
            this._sidebarExecCountEl.textContent = count != null ? `[${count}]` : '';
        } else {
            this._sidebarExecCountEl.textContent = '';
        }
    }

    // --- Lock management ---

    setLock(ownerName, ownerSid, isSelf) {
        this._locked = true;
        this._lockedBy = ownerName;
        if (isSelf) {
            this._el.classList.remove('locked-by-other');
        } else {
            this._el.classList.add('locked-by-other');
            this._lockIndicatorEl.textContent = `Editing: ${ownerName}`;
            this._lockIndicatorEl.classList.remove('hidden');
        }
    }

    clearLock() {
        this._locked = false;
        this._lockedBy = null;
        this._el.classList.remove('locked-by-other');
        this._lockIndicatorEl.classList.add('hidden');
    }

    // --- Markdown ---

    _showMarkdownRendered() {
        if (typeof marked !== 'undefined') {
            this._mdRenderedEl.innerHTML = marked.parse(this._getSource());
            // Syntax highlight code blocks in rendered markdown
            this._mdRenderedEl.querySelectorAll('pre code').forEach(block => {
                if (typeof hljs !== 'undefined') hljs.highlightElement(block);
            });
        } else {
            this._mdRenderedEl.textContent = this._getSource();
        }
        // Rewrite relative image URLs to use the project files API
        if (_currentProjectId) {
            const base = `api/projects/${encodeURIComponent(_currentProjectId)}/files/`;
            for (const img of this._mdRenderedEl.querySelectorAll('img')) {
                const src = img.getAttribute('src');
                if (src && !src.startsWith('http') && !src.startsWith('data:') && !src.startsWith('/')) {
                    img.src = base + src;
                }
            }
        }
        // Render LaTeX math expressions
        if (typeof renderMathInElement !== 'undefined') {
            renderMathInElement(this._mdRenderedEl, {
                delimiters: [
                    { left: '$$', right: '$$', display: true },
                    { left: '$', right: '$', display: false },
                    { left: '\\(', right: '\\)', display: false },
                    { left: '\\[', right: '\\]', display: true },
                ],
                throwOnError: false,
            });
        }
        this._mdRenderedEl.classList.remove('hidden');
        this._editorAreaEl.classList.add('hidden');
        this._el.classList.add('markdown-rendered');
        this._markdownRendered = true;

        this._mdRenderedEl.addEventListener('dblclick', () => {
            this._hideMarkdownRendered();
            if (this._editorView) this._editorView.focus();
        }, { once: true });
    }

    _hideMarkdownRendered() {
        this._mdRenderedEl.classList.add('hidden');
        this._editorAreaEl.classList.remove('hidden');
        this._el.classList.remove('markdown-rendered');
        this._markdownRendered = false;
    }

    destroy() {
        _allEditors.delete(this);
        if (this._postIt) {
            this._postIt.destroy();
        }
        if (this._gutterObserver) {
            this._gutterObserver.disconnect();
            this._gutterObserver = null;
        }
        if (this._editorView) {
            unregisterEditorView(this._editorView);
            this._editorView.destroy();
            this._editorView = null;
        }
        if (this._el.parentNode) this._el.parentNode.removeChild(this._el);
    }

    /**
     * Apply a theme to all live editor instances.
     * @param {string} themeName - Key from editorThemes
     */
    static setProjectId(projectId) {
        _currentProjectId = projectId;
    }

    static setTheme(themeName) {
        const theme = editorThemes[themeName] || [];
        localStorage.setItem('notebook-editor-theme', themeName);
        for (const cell of _allEditors) {
            if (cell._editorView) {
                cell._editorView.dispatch({
                    effects: _themeCompartment.reconfigure(theme)
                });
            }
        }
    }

    // ── Run Manager badges ──────────────────────────────────────

    updateRunBadges(notebookRuns) {
        if (!this._runBadgesEl) return;
        this._runBadgesEl.innerHTML = '';
        if (this._cellType !== 'code') return;

        const cellRuns = [...(this._data.metadata?.mlflow_runs || [])].sort((a, b) => a - b);
        for (const runId of cellRuns) {
            const run = notebookRuns?.[String(runId)];
            if (!run) continue;
            const badge = document.createElement('span');
            badge.className = 'cell-run-badge';
            badge.innerHTML = `<i class="fa-solid fa-bookmark" style="color:${run.color || '#4a90d9'};font-size:26px"></i><span class="cell-run-badge-num">${runId}</span>`;
            badge.title = `${run.name || 'Run ' + runId} — click to remove`;
            badge.style.cursor = 'pointer';
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleRunMembership(runId);
                if (this._callbacks.onRunBadgeClick) {
                    this._callbacks.onRunBadgeClick(this._index, runId);
                }
            });
            this._runBadgesEl.appendChild(badge);
        }
    }

    toggleRunMembership(runId) {
        if (this._cellType !== 'code') return false;
        if (!this._data.metadata) this._data.metadata = {};
        if (!this._data.metadata.mlflow_runs) this._data.metadata.mlflow_runs = [];

        const arr = this._data.metadata.mlflow_runs;
        const idx = arr.indexOf(runId);
        if (idx >= 0) {
            arr.splice(idx, 1);
        } else {
            arr.push(runId);
            arr.sort((a, b) => a - b);
        }
        this._notifyChange();
        return idx < 0; // true if added, false if removed
    }

    getRunMembership() {
        return this._data.metadata?.mlflow_runs || [];
    }

    toJSON() {
        const source = this._getSource();
        const cell = {
            cell_type: this._cellType,
            id: this._data.id,
            metadata: this._data.metadata || {},
            source: source ? source.split('\n').map((line, i, arr) =>
                i < arr.length - 1 ? line + '\n' : line
            ) : []
        };
        if (this._cellType === 'code') {
            cell.outputs = this._data.outputs || [];
            cell.execution_count = this._executionCount;
        }
        return cell;
    }
}
