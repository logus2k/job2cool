/**
 * DocPanel - Persistent documentation panel for the right pane.
 * Shows hover documentation for the symbol at the cursor position.
 * Styled to match the LLM chat code block rendering.
 */

export class DocPanel {
    constructor() {
        this._el = document.createElement('div');
        this._el.className = 'doc-panel';
        this._el.innerHTML = '<div class="doc-panel-empty">Place cursor on a symbol to see documentation.</div>';
        this._projectId = null;
        this._envName = '';
        this._filename = null;
        this._debounceTimer = null;
        this._lastKey = '';
    }

    get element() { return this._el; }

    /**
     * Called when cursor moves in a file editor.
     * @param {string} projectId
     * @param {string} envName
     * @param {string} filename
     * @param {number} line - 0-based
     * @param {number} character - 0-based
     */
    onCursorMove(projectId, envName, filename, line, character) {
        this._projectId = projectId;
        this._envName = envName || '';
        this._filename = filename;
        this._notebookPath = null;
        this._cellIndex = null;

        const key = `${projectId}:${filename}:${line}:${character}`;
        if (key === this._lastKey) return;
        this._lastKey = key;

        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => this._fetchDocs(line, character), 300);
    }

    onNotebookCursorMove(projectId, envName, notebookPath, cellIndex, line, character) {
        this._projectId = projectId;
        this._envName = envName || '';
        this._filename = null;
        this._notebookPath = notebookPath;
        this._cellIndex = cellIndex;

        const key = `${projectId}:${notebookPath}:${cellIndex}:${line}:${character}`;
        if (key === this._lastKey) return;
        this._lastKey = key;

        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => this._fetchDocs(line, character), 300);
    }

    clear() {
        this._lastKey = '';
        this._el.innerHTML = '<div class="doc-panel-empty">Place cursor on a symbol to see documentation.</div>';
    }

    async _fetchDocs(line, character) {
        if (!this._projectId) return;
        if (!this._filename && !this._notebookPath) return;

        try {
            const isNotebook = !!this._notebookPath;
            const url = isNotebook ? 'api/lsp/notebook/hover' : 'api/lsp/hover';
            const body = isNotebook
                ? { project: this._projectId, env: this._envName, notebook_path: this._notebookPath, cell_index: this._cellIndex, line, character }
                : { project: this._projectId, env: this._envName, filename: this._filename, line, character };
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!resp.ok) return;
            const data = await resp.json();

            if (!data.contents) {
                return;
            }

            if (data.body_html) {
                // docutils rendered HTML (modules, keywords)
                this._el.innerHTML = '';
                const container = document.createElement('div');
                container.className = 'doc-panel-content';
                let html = '';
                if (data.signature) {
                    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    html += `<pre class="doc-signature"><code class="language-python">${esc(data.signature)}</code></pre>`;
                }
                html += data.body_html;
                container.innerHTML = html;
                this._postProcess(container);
                this._el.appendChild(container);
            } else if (data.parsed) {
                this._el.innerHTML = '';
                const container = document.createElement('div');
                container.className = 'doc-panel-content';
                container.innerHTML = this._renderParsed(data.parsed);
                this._postProcess(container);
                this._el.appendChild(container);
            } else if (data.kind === 'markdown') {
                this._el.innerHTML = '';
                const container = document.createElement('div');
                container.className = 'doc-panel-content';
                try {
                    container.innerHTML = marked.parse(data.contents);
                } catch (e) {
                    container.textContent = data.contents;
                }
                this._postProcess(container);
                this._el.appendChild(container);
            } else {
                this._render(data.contents, data.kind);
            }
        } catch {
            // Silently ignore fetch errors
        }
    }

    _render(contents, kind) {
        this._el.innerHTML = '';

        const container = document.createElement('div');
        container.className = 'doc-panel-content';

        if (kind === 'markdown') {
            container.innerHTML = marked.parse(contents);
            container.querySelectorAll('pre code').forEach(block => {
                hljs.highlightElement(block);
            });
        } else {
            // Plaintext fallback (shouldn't reach here if parsed is available)
            const pre = document.createElement('pre');
            pre.textContent = contents;
            container.appendChild(pre);
        }

        this._el.appendChild(container);
        // Highlight any code blocks
        container.querySelectorAll('pre code').forEach(block => {
            hljs.highlightElement(block);
        });
    }

    _postProcess(container) {
        container.querySelectorAll('pre code').forEach(block => {
            hljs.highlightElement(block);
        });
        // Docutils literal blocks: wrap content in <code> for hljs
        container.querySelectorAll('pre.literal-block, pre.code').forEach(pre => {
            if (!pre.querySelector('code')) {
                const code = document.createElement('code');
                code.className = 'language-python';
                code.textContent = pre.textContent;
                pre.textContent = '';
                pre.appendChild(code);
                hljs.highlightElement(code);
            }
        });
        container.querySelectorAll('a').forEach(a => {
            a.target = '_blank';
            a.rel = 'noopener';
        });
    }

    _renderParsed(doc) {
        const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let html = '';

        // Signature
        if (doc.signature) {
            html += `<pre class="doc-signature"><code class="language-python">${esc(doc.signature)}</code></pre>`;
        }

        // Description (use heading style if short, paragraph if long)
        if (doc.description) {
            if (doc.description.length < 80 && !doc.description.includes('.')) {
                html += `<h2 class="doc-title">${esc(doc.description)}</h2>`;
            } else {
                html += `<div class="doc-description"><p>${this._linkify(doc.description)}</p></div>`;
            }
        }
        if (doc.long_description_html) {
            html += `<div class="doc-description">${doc.long_description_html}</div>`;
        } else if (doc.long_description) {
            try {
                html += `<div class="doc-description">${marked.parse(doc.long_description)}</div>`;
            } catch {
                html += `<div class="doc-description"><p>${this._linkify(doc.long_description)}</p></div>`;
            }
        }

        // Parameters
        if (doc.params?.length) {
            html += '<div class="doc-section"><div class="doc-section-title">Parameters</div><dl class="doc-params">';
            for (const p of doc.params) {
                const typeTag = p.type ? `<span class="doc-param-type">${esc(p.type)}</span>` : '';
                html += `<dt>${esc(p.name)}${typeTag}</dt><dd>${this._linkify(p.description)}</dd>`;
            }
            html += '</dl></div>';
        }

        // Returns
        if (doc.returns) {
            html += `<div class="doc-section"><div class="doc-section-title">Returns</div><p>${this._linkify(doc.returns)}</p></div>`;
        }

        // Raises
        if (doc.raises?.length) {
            html += '<div class="doc-section"><div class="doc-section-title">Raises</div><dl class="doc-params">';
            for (const r of doc.raises) {
                html += `<dt>${esc(r.type || '')}</dt><dd>${this._linkify(r.description)}</dd>`;
            }
            html += '</dl></div>';
        }

        // Examples
        if (doc.examples?.length) {
            html += '<div class="doc-section"><div class="doc-section-title">Examples</div>';
            for (const ex of doc.examples) {
                html += `<pre><code class="language-python">${esc(ex)}</code></pre>`;
            }
            html += '</div>';
        }

        // Notes
        if (doc.notes?.length) {
            html += '<div class="doc-section"><div class="doc-section-title">Notes</div>';
            for (const n of doc.notes) {
                html += `<p>${this._linkify(n)}</p>`;
            }
            html += '</div>';
        }

        return html;

        return html;
    }

    _formatParagraphs(lines) {
        const paragraphs = [];
        let current = [];
        for (const line of lines) {
            if (!line.trim()) {
                if (current.length) { paragraphs.push(current.join(' ')); current = []; }
            } else {
                current.push(line.trim());
            }
        }
        if (current.length) paragraphs.push(current.join(' '));
        return paragraphs.map(p => `<p>${this._linkify(p)}</p>`).join('');
    }

    _renderStructuredText(text) {
        const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // Split into blocks on double newlines
        const blocks = text.split(/\n\n+/);
        let html = '';
        for (const block of blocks) {
            const trimmed = block.trim();
            if (!trimmed) continue;
            // Skip reST underlines (*****, =====, -----)
            if (/^[*=\-~^]{3,}$/.test(trimmed)) continue;
            // Indented block = code
            const lines = block.split('\n');
            const allIndented = lines.every(l => !l.trim() || l.startsWith('   '));
            if (allIndented && lines.some(l => l.trim())) {
                const code = lines.map(l => l.replace(/^   /, '')).join('\n').trim();
                html += `<pre><code class="language-python">${esc(code)}</code></pre>`;
                continue;
            }
            // Numbered list (1. 2. etc.)
            if (/^\d+\.\s/.test(trimmed)) {
                html += '<ol>';
                for (const line of lines) {
                    const m = line.match(/^\d+\.\s+(.*)/);
                    if (m) html += `<li>${this._linkify(m[1])}</li>`;
                    else if (line.trim()) html += `<li>${this._linkify(line.trim())}</li>`;
                }
                html += '</ol>';
                continue;
            }
            // Bullet list (* or -)
            if (/^[*\-]\s/.test(trimmed)) {
                html += '<ul>';
                let currentLi = '';
                for (const line of lines) {
                    const m = line.match(/^[*\-]\s+(.*)/);
                    if (m) {
                        if (currentLi) html += `<li>${this._linkify(currentLi)}</li>`;
                        currentLi = m[1];
                    } else if (line.trim()) {
                        currentLi += ' ' + line.trim();
                    }
                }
                if (currentLi) html += `<li>${this._linkify(currentLi)}</li>`;
                html += '</ul>';
                continue;
            }
            // Regular paragraph
            html += `<p>${this._linkify(trimmed.replace(/\n/g, ' '))}</p>`;
        }
        return html;
    }

    _linkify(text) {
        const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // Escape HTML first, then convert URLs to links
        return esc(text).replace(
            /https?:\/\/[^\s<>&)]+/g,
            url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`
        );
    }
}
