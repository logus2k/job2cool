/**
 * CellOutput - Renders cell outputs (text, images, HTML, errors).
 * Supports streaming with ANSI colors, carriage-return progress bars,
 * update_display_data, and clear_output.
 */

/** Normalize ipynb text values: arrays of strings or plain strings. */
function textValue(v) {
    if (Array.isArray(v)) return v.join('');
    return v || '';
}

// ANSI 256-color palette (standard 16 colors)
const ANSI_COLORS = [
    '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
    '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
];

/**
 * Convert ANSI escape sequences to HTML spans.
 * Handles: SGR codes (colors, bold, italic, underline, dim, strikethrough).
 */
function ansiToHtml(text) {
    let html = '';
    let i = 0;
    let bold = false, dim = false, italic = false, underline = false, strikethrough = false;
    let fg = null, bg = null;

    const openSpan = () => {
        const styles = [];
        if (bold) styles.push('font-weight:bold');
        if (dim) styles.push('opacity:0.6');
        if (italic) styles.push('font-style:italic');
        if (underline) styles.push('text-decoration:underline');
        if (strikethrough) styles.push('text-decoration:line-through');
        if (fg) styles.push(`color:${fg}`);
        if (bg) styles.push(`background:${bg}`);
        return styles.length ? `<span style="${styles.join(';')}">` : '';
    };

    const hasStyle = () => bold || dim || italic || underline || strikethrough || fg || bg;

    while (i < text.length) {
        if (text[i] === '\x1b' && text[i + 1] === '[') {
            // Parse CSI sequence
            let j = i + 2;
            while (j < text.length && text[j] !== 'm' && text[j] !== 'K' && text[j] !== 'H' &&
                   text[j] !== 'J' && text[j] !== 'A' && text[j] !== 'B' && text[j] !== 'C' &&
                   text[j] !== 'D' && text[j] !== 'G') {
                j++;
            }
            if (j >= text.length) break;
            const finalChar = text[j];
            if (finalChar === 'm') {
                // SGR - Select Graphic Rendition
                if (hasStyle()) html += '</span>';
                const paramStr = text.substring(i + 2, j);
                const codes = paramStr === '' ? [0] : paramStr.split(';').map(Number);
                for (let ci = 0; ci < codes.length; ci++) {
                    const c = codes[ci];
                    if (c === 0) { bold = dim = italic = underline = strikethrough = false; fg = bg = null; }
                    else if (c === 1) bold = true;
                    else if (c === 2) dim = true;
                    else if (c === 3) italic = true;
                    else if (c === 4) underline = true;
                    else if (c === 9) strikethrough = true;
                    else if (c === 22) { bold = false; dim = false; }
                    else if (c === 23) italic = false;
                    else if (c === 24) underline = false;
                    else if (c === 29) strikethrough = false;
                    else if (c >= 30 && c <= 37) fg = ANSI_COLORS[c - 30];
                    else if (c === 38 && codes[ci + 1] === 5) { fg = ansi256Color(codes[ci + 2]); ci += 2; }
                    else if (c === 39) fg = null;
                    else if (c >= 40 && c <= 47) bg = ANSI_COLORS[c - 40];
                    else if (c === 48 && codes[ci + 1] === 5) { bg = ansi256Color(codes[ci + 2]); ci += 2; }
                    else if (c === 49) bg = null;
                    else if (c >= 90 && c <= 97) fg = ANSI_COLORS[c - 90 + 8];
                    else if (c >= 100 && c <= 107) bg = ANSI_COLORS[c - 100 + 8];
                }
                html += openSpan();
            }
            // Skip other CSI sequences (cursor movement, erase) silently
            i = j + 1;
        } else {
            // Escape HTML special chars
            const ch = text[i];
            if (ch === '<') html += '&lt;';
            else if (ch === '>') html += '&gt;';
            else if (ch === '&') html += '&amp;';
            else html += ch;
            i++;
        }
    }
    if (hasStyle()) html += '</span>';
    return html;
}

/** Convert ANSI 256-color index to hex. */
function ansi256Color(n) {
    if (n < 16) return ANSI_COLORS[n];
    if (n >= 232) { const g = 8 + (n - 232) * 10; return `rgb(${g},${g},${g})`; }
    n -= 16;
    const r = Math.floor(n / 36) * 51;
    const g = Math.floor((n % 36) / 6) * 51;
    const b = (n % 6) * 51;
    return `rgb(${r},${g},${b})`;
}

/**
 * Process carriage returns in stream text.
 * Splits text into lines, handling \r to overwrite current line content.
 * Returns array of line strings (final state after CR processing).
 */
function processCarriageReturns(existingText, newText) {
    const combined = existingText + newText;
    const result = [];
    let current = '';

    for (let i = 0; i < combined.length; i++) {
        const ch = combined[i];
        if (ch === '\n') {
            result.push(current);
            current = '';
        } else if (ch === '\r') {
            // Carriage return: reset to beginning of current line
            // But not if followed by \n (that's just \r\n line ending)
            if (i + 1 < combined.length && combined[i + 1] === '\n') {
                continue; // skip \r, the \n will handle the line break
            }
            current = '';
        } else {
            current += ch;
        }
    }
    // Don't push the last line into result — it's the "current" incomplete line
    return { lines: result, current };
}


export class CellOutput {
    constructor() {
        this._el = document.createElement('div');
        this._el.className = 'cell-output';
        this._outputs = [];
        // Track last stream element for merging consecutive streams
        this._lastStreamName = null;
        this._lastStreamEl = null;
        this._lastStreamText = ''; // raw text accumulated for CR processing
        this._pendingClear = false; // for clear_output(wait=True)

    }

    get element() { return this._el; }

    clear() {
        this._outputs = [];
        this._el.innerHTML = '';
        this._lastStreamName = null;
        this._lastStreamEl = null;
        this._lastStreamText = '';
        this._pendingClear = false;
    }

    showExecuting(label = 'Running...') {
        this.clear();
        const div = document.createElement('div');
        div.className = 'output-executing';
        div.innerHTML = `<div class="spinner"></div><span>${label}</span>`;
        this._el.appendChild(div);
    }

    showElapsed(seconds) {
        // Remove any previous elapsed indicator
        const prev = this._el.querySelector('.output-elapsed');
        if (prev) prev.remove();
        const label = seconds < 0.1 ? '0.0s'
            : seconds < 10 ? seconds.toFixed(1) + 's'
            : seconds < 60 ? Math.round(seconds) + 's'
            : Math.floor(seconds / 60) + 'm ' + Math.round(seconds % 60) + 's';
        const div = document.createElement('div');
        div.className = 'output-elapsed';
        div.innerHTML = `<span class="elapsed-check">\u2713</span> ${label}`;
        this._el.appendChild(div);
    }

    addOutput(output) {
        console.debug('[CellOutput] addOutput:', output.output_type,
            output.output_type === 'stream' ? `(${output.name})` : '',
            output.output_type === 'display_data' ? Object.keys(output.data || {}) : '');

        const executing = this._el.querySelector('.output-executing');
        if (executing) executing.remove();

        if (output.output_type === 'clear_output') {
            this._handleClearOutput(output);
            return;
        }

        if (output.output_type === 'update_display_data') {
            this._handleUpdateDisplay(output);
            return;
        }

        // Flush pending clear before any real output
        if (this._pendingClear) {
            this._pendingClear = false;
            this._el.innerHTML = '';
            this._outputs = [];
            this._lastStreamName = null;
            this._lastStreamEl = null;
            this._lastStreamText = '';
        }

        if (output.output_type === 'stream') {
            this._handleStream(output);
            return;
        }

        // Non-stream output breaks the stream merge
        this._lastStreamName = null;
        this._lastStreamEl = null;
        this._lastStreamText = '';

        this._outputs.push(output);
        const rendered = this._renderOutput(output);
        if (rendered) {
            this._el.appendChild(rendered);
            // Activate any scripts in the rendered output (innerHTML won't execute them)
            if (rendered.querySelector('script')) this._activateScripts(rendered);
        }
    }

    /** Handle stream outputs with merging and carriage return processing. */
    _handleStream(output) {
        const name = output.name || 'stdout';
        const text = textValue(output.text);

        if (this._lastStreamName === name && this._lastStreamEl) {
            // Merge with previous stream of the same name
            const { lines, current } = processCarriageReturns(this._lastStreamText, text);
            this._lastStreamText = lines.join('\n') + (lines.length ? '\n' : '') + current;
            this._lastStreamEl.innerHTML = ansiToHtml(this._lastStreamText);
        } else {
            // New stream block
            this._lastStreamName = name;
            const { lines, current } = processCarriageReturns('', text);
            this._lastStreamText = lines.join('\n') + (lines.length ? '\n' : '') + current;
            const div = document.createElement('div');
            div.className = `output-stream ${name === 'stderr' ? 'stderr' : ''}`;
            div.innerHTML = ansiToHtml(this._lastStreamText);
            // _lastStreamEl points to the inner div so merges keep working
            this._lastStreamEl = div;
            this._el.appendChild(this._wrapWithCopyBtn(div));
        }
        this._outputs.push(output);
    }

    /** Handle update_display_data — find and replace existing display by transient.display_id */
    _handleUpdateDisplay(output) {
        const displayId = output.transient?.display_id;
        if (!displayId) return;
        const existing = this._el.querySelector(`[data-display-id="${displayId}"]`);
        if (existing) {
            const rendered = this._renderDisplayData(output.data || {}, output.metadata || {});
            if (rendered) {
                rendered.dataset.displayId = displayId;
                existing.replaceWith(rendered);
            }
        }
    }

    /** Handle clear_output — clear all current outputs */
    _handleClearOutput(output) {
        if (output.wait) {
            // Defer: clear when the next real output arrives
            this._pendingClear = true;
        } else {
            // Immediate clear
            this._el.innerHTML = '';
            this._outputs = [];
            this._lastStreamName = null;
            this._lastStreamEl = null;
            this._lastStreamText = '';
            this._pendingClear = false;
        }
    }

    setOutputs(outputs) {
        this.clear();
        for (const output of outputs) {
            this.addOutput(output);
        }
    }

    _renderOutput(output) {
        switch (output.output_type) {
            case 'stream': return this._renderStream(output);
            case 'execute_result': return this._renderResult(output);
            case 'display_data': return this._renderDisplay(output);
            case 'error': return this._renderError(output);
            default: return null;
        }
    }

    _renderStream(output) {
        const div = document.createElement('div');
        div.className = `output-stream ${output.name === 'stderr' ? 'stderr' : ''}`;
        div.innerHTML = ansiToHtml(textValue(output.text));
        return this._wrapWithCopyBtn(div);
    }

    _renderResult(output) {
        const data = output.data || {};
        // Suppress bare "undefined" results (JS kernel returns undefined for
        // statements like console.log; Python's IPython already hides None)
        const plainText = textValue(data['text/plain']);
        if (plainText === 'undefined' || plainText === 'Promise { <pending> }') return null;

        if (data['text/latex']) return this._renderLatex(textValue(data['text/latex']));
        if (data['text/html']) return this._wrapWithCopyBtn(this._renderHTML(textValue(data['text/html'])));
        if (data['image/png']) return this._renderImage(textValue(data['image/png']), 'image/png');
        if (data['image/svg+xml']) return this._renderSVG(textValue(data['image/svg+xml']));

        const div = document.createElement('div');
        div.className = 'output-result';
        div.textContent = plainText;
        return this._wrapWithCopyBtn(div);
    }

    _renderDisplay(output) {
        const data = output.data || {};
        const metadata = output.metadata || {};
        const container = this._renderDisplayData(data, metadata);
        const displayId = output.transient?.display_id;
        if (displayId && container) {
            container.dataset.displayId = displayId;
        }
        return container;
    }

    /** Shared rendering logic for display_data and update_display_data */
    _renderDisplayData(data, _metadata) {
        const container = document.createElement('div');
        container.className = 'output-display';

        if (data['text/latex']) {
            container.appendChild(this._renderLatex(textValue(data['text/latex'])));
        } else if (data['image/png']) {
            container.appendChild(this._renderImage(textValue(data['image/png']), 'image/png'));
        } else if (data['image/jpeg']) {
            container.appendChild(this._renderImage(textValue(data['image/jpeg']), 'image/jpeg'));
        } else if (data['image/svg+xml']) {
            container.appendChild(this._renderSVG(textValue(data['image/svg+xml'])));
        } else if (data['text/html']) {
            container.appendChild(this._wrapWithCopyBtn(this._renderHTML(textValue(data['text/html']))));
        } else if (data['application/json']) {
            container.appendChild(this._wrapWithCopyBtn(this._renderJSON(data['application/json'])));
        } else if (data['text/plain']) {
            const div = document.createElement('div');
            div.className = 'output-result';
            div.textContent = textValue(data['text/plain']);
            container.appendChild(this._wrapWithCopyBtn(div));
        }
        return container;
    }

    _renderError(output) {
        const div = document.createElement('div');
        div.className = 'output-error';

        const name = document.createElement('div');
        name.className = 'error-name';
        name.textContent = `${output.ename || 'Error'}: ${output.evalue || ''}`;
        div.appendChild(name);

        if (output.traceback && output.traceback.length > 0) {
            const tb = document.createElement('div');
            tb.className = 'error-traceback';
            // Render traceback with ANSI colors instead of stripping them
            tb.innerHTML = ansiToHtml(output.traceback.join('\n'));
            div.appendChild(tb);
        }
        return this._wrapWithCopyBtn(div);
    }

    _renderImage(base64Data, mimeType) {
        const img = document.createElement('img');
        img.src = `data:${mimeType};base64,${base64Data}`;
        return img;
    }

    _renderSVG(svgString) {
        const div = document.createElement('div');
        div.className = 'output-display';
        div.innerHTML = svgString;
        return div;
    }

    _renderLatex(latexString) {
        const div = document.createElement('div');
        div.className = 'output-display-html';
        if (typeof katex !== 'undefined') {
            // Strip surrounding $/$$ delimiters if present
            let tex = latexString.trim();
            let displayMode = false;
            if (tex.startsWith('$$') && tex.endsWith('$$')) {
                tex = tex.slice(2, -2);
                displayMode = true;
            } else if (tex.startsWith('$') && tex.endsWith('$')) {
                tex = tex.slice(1, -1);
            }
            katex.render(tex, div, { displayMode, throwOnError: false });
        } else {
            div.textContent = latexString;
        }
        return div;
    }

    _renderHTML(htmlString) {
        const div = document.createElement('div');
        div.className = 'output-display-html';
        div.innerHTML = htmlString;
        return div;
    }

    /** Activate scripts inside an element after it's been inserted into the DOM. */
    _activateScripts(el) {
        for (const old of el.querySelectorAll('script')) {
            const s = document.createElement('script');
            for (const attr of old.attributes) s.setAttribute(attr.name, attr.value);
            s.textContent = old.textContent;
            old.replaceWith(s);
        }
    }

    _renderJSON(jsonData) {
        const div = document.createElement('div');
        div.className = 'output-json';
        div.textContent = JSON.stringify(jsonData, null, 2);
        return div;
    }

    /** Wrap a text output element with a hover copy button. */
    _wrapWithCopyBtn(el) {
        const wrapper = document.createElement('div');
        wrapper.className = 'output-copy-wrapper';
        wrapper.appendChild(el);

        const btn = document.createElement('button');
        btn.className = 'output-copy-btn';
        btn.title = 'Copy output';
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const text = el.textContent || '';
            navigator.clipboard.writeText(text).then(() => {
                btn.classList.add('output-copy-btn--copied');
                setTimeout(() => btn.classList.remove('output-copy-btn--copied'), 1500);
            });
        });
        wrapper.appendChild(btn);
        return wrapper;
    }
}
