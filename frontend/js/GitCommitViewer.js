/**
 * GitCommitViewer — displays a single commit's diff in the center tab area.
 * Uses CodeMirror (read-only, line numbers) with line-level diff decorations.
 */
import {
    EditorView, lineNumbers, Decoration, ViewPlugin,
    EditorState,
} from '../vendor/codemirror/codemirror.bundle.js';

const diffLinePlugin = ViewPlugin.fromClass(class {
    constructor(view) {
        this.decorations = _buildDecorations(view);
    }
    update(update) {
        if (update.docChanged) this.decorations = _buildDecorations(update.view);
    }
}, { decorations: v => v.decorations });

function _buildDecorations(view) {
    const builder = [];
    for (let i = 1; i <= view.state.doc.lines; i++) {
        const line = view.state.doc.line(i);
        const cls = _lineClass(line.text);
        if (cls) builder.push(Decoration.line({ class: cls }).range(line.from));
    }
    return Decoration.set(builder);
}

function _lineClass(text) {
    if (text.startsWith('+++') || text.startsWith('---')) return 'gcv-file';
    if (text.startsWith('+')) return 'gcv-add';
    if (text.startsWith('-')) return 'gcv-del';
    if (text.startsWith('@@')) return 'gcv-hunk';
    if (text.startsWith('diff ') || text.startsWith('index ')) return 'gcv-meta';
    return '';
}

const baseTheme = EditorView.theme({
    '&': { height: '100%', fontSize: '11px' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)' },
    '.cm-gutters': { borderRight: '1px solid #e0e0e0', background: '#f5f5f5', color: '#aaaaaa' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 4px', minWidth: '36px' },
    '.gcv-add': { background: '#e6f4e6' },
    '.gcv-del': { background: '#fde8e8' },
    '.gcv-hunk': { background: '#e8eef8', color: '#4a7bd0' },
    '.gcv-file': { background: '#f0f0f0', color: '#555555' },
    '.gcv-meta': { color: '#999999' },
});

export class GitCommitViewer {
    constructor() {
        this._el = document.createElement('div');
        this._el.className = 'git-commit-viewer';
        this._view = null;
    }

    get element() { return this._el; }

    async show(repoPath, commit) {
        this._setText('Loading\u2026');

        try {
            const res = await fetch(
                `api/git/repo/show?ref=${encodeURIComponent(commit.hash)}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ repo_path: repoPath }),
                }
            );
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            this._setText(data.diff);
        } catch (e) {
            this._setText(`Error: ${e.message}`);
        }
    }

    _setText(text) {
        if (this._view) {
            this._view.dispatch({
                changes: { from: 0, to: this._view.state.doc.length, insert: text }
            });
            this._view.scrollDOM.scrollTop = 0;
            return;
        }
        this._view = new EditorView({
            state: EditorState.create({
                doc: text,
                extensions: [
                    lineNumbers(),
                    EditorView.editable.of(false),
                    EditorState.readOnly.of(true),
                    diffLinePlugin,
                    baseTheme,
                ],
            }),
            parent: this._el,
        });
    }
}
