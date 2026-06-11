/**
 * NotebookViewer - Read-only Jupyter notebook renderer with theme support.
 *
 * Dependencies (loaded as globals before this script):
 *   - marked.min.js          (global: marked)
 *   - highlight.min.js       (global: hljs)
 *   - highlight-python.min.js
 *   - katex.min.js           (global: katex)         [optional]
 *   - katex-auto-render.min.js (global: renderMathInElement) [optional]
 *
 * Usage:
 *   NotebookViewer.render('#container', '/path/to/notebook.ipynb');
 *   NotebookViewer.render('#container', '/path/to/notebook.ipynb', 'dark');
 *   NotebookViewer.render('#container', '/path/to/notebook.ipynb', { theme: 'presentation' });
 */
(function (root) {
    'use strict';

    // ── Default theme (embedded fallback) ─────────────────────────────

    const DEFAULT_THEME = {
        name: 'Default',
        colors: {
            scheme: 'light', background: '#ffffff', pageBg: '#f5f5f5',
            text: '#1d1d1d', textMuted: '#888888', cellBorder: '#e8e8e8',
            codeBg: '#f7f7f7', outputBg: '#ffffff', prompt: '#2069c0',
            resultText: '#2069c0', errorText: '#d32f2f', link: '#2069c0',
        },
        cells: {
            borders: true, leftBar: true,
            leftBarColors: { code: '#2069c0', markdown: '#4caf50', raw: '#999999' },
            numbering: false, spacing: 0,
        },
        code: {
            lineNumbers: false, prompt: true, copyButton: true,
            font: '"JetBrains Mono", "Fira Code", "Consolas", monospace',
        },
        output: {
            copyButton: true, collapsible: false, maxHeight: 500, imageShadow: false,
        },
        markdown: { toc: false, anchorLinks: true },
        page: { maxWidth: '960px', header: true, printStyles: true },
    };

    function mergeDeep(target, source) {
        const out = Object.assign({}, target);
        for (const key of Object.keys(source)) {
            if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                out[key] = mergeDeep(target[key] || {}, source[key]);
            } else {
                out[key] = source[key];
            }
        }
        return out;
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function textValue(v) {
        if (Array.isArray(v)) return v.join('');
        return v || '';
    }

    function escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function slugify(text) {
        return text.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
    }

    // ── Copy button helper ────────────────────────────────────────────

    const COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" fill="#a8d8a0"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    const CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2a7a2a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 9 17 20 6"/></svg>';

    function createCopyBtn(getText) {
        const btn = document.createElement('button');
        btn.className = 'nbv-copy-btn';
        btn.innerHTML = COPY_ICON;
        btn.title = 'Copy';
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const text = typeof getText === 'function' ? getText() : getText;
            navigator.clipboard.writeText(text).then(() => {
                btn.innerHTML = CHECK_ICON;
                setTimeout(() => { btn.innerHTML = COPY_ICON; }, 1500);
            });
        });
        return btn;
    }

    function createImageCopyBtn(img) {
        const btn = document.createElement('button');
        btn.className = 'nbv-copy-btn';
        btn.innerHTML = COPY_ICON;
        btn.title = 'Copy image';
        btn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext('2d').drawImage(img, 0, 0);
                const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
                await navigator.clipboard.write([
                    new ClipboardItem({ 'image/png': blob })
                ]);
                btn.innerHTML = CHECK_ICON;
                setTimeout(() => { btn.innerHTML = COPY_ICON; }, 1500);
            } catch {
                window.open(img.src, '_blank');
            }
        });
        return btn;
    }

    // ── ANSI → HTML ─────────────────────────────────────────────────────

    const ANSI_COLORS = [
        '#000000','#cd0000','#00cd00','#cdcd00','#0000ee','#cd00cd','#00cdcd','#e5e5e5',
        '#7f7f7f','#ff0000','#00ff00','#ffff00','#5c5cff','#ff00ff','#00ffff','#ffffff',
    ];

    function ansi256Color(n) {
        if (n < 16) return ANSI_COLORS[n];
        if (n >= 232) { const g = 8 + (n - 232) * 10; return `rgb(${g},${g},${g})`; }
        n -= 16;
        return `rgb(${Math.floor(n/36)*51},${Math.floor((n%36)/6)*51},${(n%6)*51})`;
    }

    function ansiToHtml(text) {
        let html = '', i = 0;
        let bold = false, dim = false, italic = false, underline = false, strike = false;
        let fg = null, bg = null;

        const openSpan = () => {
            const s = [];
            if (bold) s.push('font-weight:bold');
            if (dim) s.push('opacity:0.6');
            if (italic) s.push('font-style:italic');
            if (underline) s.push('text-decoration:underline');
            if (strike) s.push('text-decoration:line-through');
            if (fg) s.push('color:' + fg);
            if (bg) s.push('background:' + bg);
            return s.length ? '<span style="' + s.join(';') + '">' : '';
        };
        const hasStyle = () => bold || dim || italic || underline || strike || fg || bg;

        while (i < text.length) {
            if (text[i] === '\x1b' && text[i+1] === '[') {
                let j = i + 2;
                while (j < text.length && !/[mKHJABCDG]/.test(text[j])) j++;
                if (j >= text.length) break;
                if (text[j] === 'm') {
                    if (hasStyle()) html += '</span>';
                    const p = text.substring(i+2, j);
                    const codes = p === '' ? [0] : p.split(';').map(Number);
                    for (let ci = 0; ci < codes.length; ci++) {
                        const c = codes[ci];
                        if (c === 0) { bold=dim=italic=underline=strike=false; fg=bg=null; }
                        else if (c===1) bold=true; else if (c===2) dim=true;
                        else if (c===3) italic=true; else if (c===4) underline=true;
                        else if (c===9) strike=true;
                        else if (c===22) { bold=false; dim=false; }
                        else if (c===23) italic=false; else if (c===24) underline=false;
                        else if (c===29) strike=false;
                        else if (c>=30&&c<=37) fg=ANSI_COLORS[c-30];
                        else if (c===38&&codes[ci+1]===5) { fg=ansi256Color(codes[ci+2]); ci+=2; }
                        else if (c===39) fg=null;
                        else if (c>=40&&c<=47) bg=ANSI_COLORS[c-40];
                        else if (c===48&&codes[ci+1]===5) { bg=ansi256Color(codes[ci+2]); ci+=2; }
                        else if (c===49) bg=null;
                        else if (c>=90&&c<=97) fg=ANSI_COLORS[c-90+8];
                        else if (c>=100&&c<=107) bg=ANSI_COLORS[c-100+8];
                    }
                    html += openSpan();
                }
                i = j + 1;
            } else {
                const ch = text[i];
                if (ch === '<') html += '&lt;'; else if (ch === '>') html += '&gt;';
                else if (ch === '&') html += '&amp;'; else html += ch;
                i++;
            }
        }
        if (hasStyle()) html += '</span>';
        return html;
    }

    function processCarriageReturns(text) {
        const result = [];
        let current = '';
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (ch === '\n') { result.push(current); current = ''; }
            else if (ch === '\r') {
                if (i+1 < text.length && text[i+1] === '\n') continue;
                current = '';
            } else { current += ch; }
        }
        if (current) result.push(current);
        return result.join('\n');
    }

    // ── Line numbers helper ─────────────────────────────────────────────

    function addLineNumbers(source) {
        const lines = source.split('\n');
        const count = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
        const gutter = document.createElement('div');
        gutter.className = 'nbv-line-numbers';
        for (let i = 1; i <= count; i++) {
            const ln = document.createElement('span');
            ln.textContent = i;
            gutter.appendChild(ln);
        }
        return gutter;
    }

    // ── TOC builder ─────────────────────────────────────────────────────

    const BURGER_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';

    function buildToc(container, nbvContainer) {
        const headings = container.querySelectorAll('.nbv-markdown h1, .nbv-markdown h2, .nbv-markdown h3');
        if (headings.length === 0) return null;

        const wrapper = document.createElement('div');
        wrapper.className = 'nbv-toc-wrapper';

        const toc = document.createElement('nav');
        toc.className = 'nbv-toc';

        const header = document.createElement('div');
        header.className = 'nbv-toc-header';

        const innerToggle = document.createElement('button');
        innerToggle.className = 'nbv-toc-toggle';
        innerToggle.innerHTML = BURGER_ICON;
        innerToggle.title = 'Collapse table of contents';
        header.appendChild(innerToggle);

        const title = document.createElement('div');
        title.className = 'nbv-toc-title';
        title.textContent = 'Table of Contents';
        header.appendChild(title);

        toc.appendChild(header);

        const list = document.createElement('ul');
        headings.forEach((h) => {
            const li = document.createElement('li');
            li.className = 'nbv-toc-' + h.tagName.toLowerCase();
            const a = document.createElement('a');
            a.textContent = h.textContent.replace(/#$/, '').trim();
            a.href = '#' + h.id;
            li.appendChild(a);
            list.appendChild(li);
        });
        toc.appendChild(list);
        wrapper.appendChild(toc);

        // External toggle button (visible when TOC is collapsed)
        const outerToggle = document.createElement('button');
        outerToggle.className = 'nbv-toc-toggle';
        outerToggle.innerHTML = BURGER_ICON;
        outerToggle.title = 'Show table of contents';
        outerToggle.style.display = 'none';

        let savedWidth = null;

        function collapse() {
            savedWidth = wrapper.style.width || null;
            wrapper.style.width = '';
            nbvContainer.style.marginLeft = '';
            wrapper.classList.add('nbv-toc-collapsed');
            nbvContainer.classList.add('nbv-toc-hidden');
            outerToggle.style.display = '';
            isCollapsed = true;
            positionResizer();
        }

        function expand() {
            wrapper.classList.remove('nbv-toc-collapsed');
            nbvContainer.classList.remove('nbv-toc-hidden');
            outerToggle.style.display = 'none';
            isCollapsed = false;
            if (savedWidth) {
                wrapper.style.width = savedWidth;
                nbvContainer.style.marginLeft = (parseFloat(savedWidth) + 50) + 'px';
            }
            requestAnimationFrame(positionResizer);
        }

        innerToggle.addEventListener('click', collapse);
        outerToggle.addEventListener('click', expand);

        // Resize handle (sits outside toc as a sibling so it's not inside the scroll area)
        const resizer = document.createElement('div');
        resizer.className = 'nbv-toc-resizer';

        let dragging = false;
        let startX, startWidth;

        let isCollapsed = false;

        function positionResizer() {
            if (isCollapsed) {
                // Position to the right of the burger toggle (16px left + 32px width + 10px gap)
                resizer.style.left = '58px';
                resizer.style.top = '12px';
                resizer.style.height = '32px';
            } else {
                const rect = wrapper.getBoundingClientRect();
                resizer.style.left = (rect.right + 10) + 'px';
                resizer.style.top = rect.top + 'px';
                resizer.style.height = rect.height + 'px';
            }
        }

        resizer.addEventListener('mousedown', (e) => {
            e.preventDefault();
            dragging = true;
            startX = e.clientX;
            startWidth = isCollapsed ? 0 : wrapper.getBoundingClientRect().width;
            resizer.classList.add('nbv-dragging');
            wrapper.style.transition = 'none';
            nbvContainer.style.transition = 'none';
        });

        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const rawWidth = startWidth + (e.clientX - startX);
            if (rawWidth < 80) {
                // Snap to collapsed visual
                if (!isCollapsed) {
                    wrapper.classList.add('nbv-toc-collapsed');
                    nbvContainer.classList.add('nbv-toc-hidden');
                }
                wrapper.style.width = '';
                wrapper.style.opacity = '';
                nbvContainer.style.marginLeft = '';
            } else {
                // Expanding from collapsed
                if (isCollapsed || wrapper.classList.contains('nbv-toc-collapsed')) {
                    wrapper.classList.remove('nbv-toc-collapsed');
                    nbvContainer.classList.remove('nbv-toc-hidden');
                    outerToggle.style.display = 'none';
                    isCollapsed = false;
                }
                const newWidth = Math.max(100, Math.min(500, rawWidth));
                wrapper.style.width = newWidth + 'px';
                wrapper.style.opacity = '';
                nbvContainer.style.marginLeft = (newWidth + 50) + 'px';
            }
            positionResizer();
        });

        window.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            resizer.classList.remove('nbv-dragging');
            wrapper.style.transition = '';
            nbvContainer.style.transition = '';
            // If at collapsed state, finalize
            if (wrapper.classList.contains('nbv-toc-collapsed')) {
                isCollapsed = true;
                outerToggle.style.display = '';
                positionResizer();
            } else {
                isCollapsed = false;
            }
        });

        // Keep resizer aligned on scroll/resize/transition
        window.addEventListener('scroll', positionResizer, { passive: true });
        window.addEventListener('resize', positionResizer, { passive: true });
        wrapper.addEventListener('transitionend', positionResizer);
        requestAnimationFrame(positionResizer);

        return { wrapper, outerToggle, resizer };
    }

    // ── Rendering ───────────────────────────────────────────────────────

    function renderMarkdownCell(source, theme, cellIndex) {
        const cell = document.createElement('div');
        cell.className = 'nbv-cell nbv-markdown';
        if (theme.cells.leftBar) {
            cell.style.setProperty('--nbv-left-bar-color', theme.cells.leftBarColors.markdown);
        }

        if (theme.cells.numbering) {
            const num = document.createElement('span');
            num.className = 'nbv-cell-number';
            num.textContent = cellIndex + 1;
            cell.appendChild(num);
        }

        const content = document.createElement('div');
        content.className = 'nbv-markdown-content';

        if (typeof marked !== 'undefined') {
            content.innerHTML = marked.parse(source);
        } else {
            content.textContent = source;
        }

        if (theme.markdown.anchorLinks) {
            content.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
                const id = slugify(h.textContent);
                h.id = id;
                const anchor = document.createElement('a');
                anchor.className = 'nbv-anchor';
                anchor.href = '#' + id;
                anchor.textContent = '#';
                h.appendChild(anchor);
            });
        }

        if (typeof renderMathInElement !== 'undefined') {
            renderMathInElement(content, {
                delimiters: [
                    { left: '$$', right: '$$', display: true },
                    { left: '$', right: '$', display: false },
                    { left: '\\(', right: '\\)', display: false },
                    { left: '\\[', right: '\\]', display: true },
                ],
                throwOnError: false,
            });
        }

        cell.appendChild(content);
        return cell;
    }

    function renderCodeCell(source, executionCount, outputs, theme, cellIndex) {
        const cell = document.createElement('div');
        cell.className = 'nbv-cell nbv-code';
        if (theme.cells.leftBar) {
            cell.style.setProperty('--nbv-left-bar-color', theme.cells.leftBarColors.code);
        }

        if (theme.cells.numbering) {
            const num = document.createElement('span');
            num.className = 'nbv-cell-number';
            num.textContent = cellIndex + 1;
            cell.appendChild(num);
        }

        // Input area
        const input = document.createElement('div');
        input.className = 'nbv-input';

        if (theme.code.prompt) {
            const prompt = document.createElement('span');
            prompt.className = 'nbv-prompt';
            prompt.textContent = executionCount != null ? `[${executionCount}]` : '[ ]';
            input.appendChild(prompt);
        }

        const codeWrap = document.createElement('div');
        codeWrap.className = 'nbv-code-wrap';

        if (theme.code.lineNumbers) {
            codeWrap.appendChild(addLineNumbers(source));
        }

        const pre = document.createElement('pre');
        const codeEl = document.createElement('code');
        codeEl.className = 'language-python';
        codeEl.textContent = source;
        if (typeof hljs !== 'undefined') {
            hljs.highlightElement(codeEl);
        }
        pre.appendChild(codeEl);
        codeWrap.appendChild(pre);
        input.appendChild(codeWrap);

        if (theme.code.copyButton) {
            input.appendChild(createCopyBtn(() => source));
        }

        cell.appendChild(input);

        // Outputs
        if (outputs && outputs.length > 0) {
            const outputArea = document.createElement('div');
            outputArea.className = 'nbv-output';

            for (const out of outputs) {
                const rendered = renderOutput(out, theme);
                if (rendered) outputArea.appendChild(rendered);
            }

            if (outputArea.children.length > 0) {
                if (theme.output.collapsible && theme.output.maxHeight) {
                    outputArea.style.maxHeight = theme.output.maxHeight + 'px';
                    outputArea.classList.add('nbv-output-collapsible');
                }
                cell.appendChild(outputArea);
            }
        }

        return cell;
    }

    function renderOutput(output, theme) {
        const type = output.output_type;
        if (type === 'stream') return renderStreamOutput(output, theme);
        if (type === 'execute_result' || type === 'display_data') return renderRichOutput(output, theme);
        if (type === 'error') return renderErrorOutput(output, theme);
        return null;
    }

    function renderStreamOutput(output, theme) {
        const text = textValue(output.text);
        const processed = processCarriageReturns(text);
        const wrapper = document.createElement('div');
        wrapper.className = 'nbv-stream-wrapper';

        const div = document.createElement('div');
        div.className = 'nbv-stream' + (output.name === 'stderr' ? ' nbv-stderr' : '');
        div.innerHTML = ansiToHtml(processed);
        wrapper.appendChild(div);

        if (theme.output.copyButton) {
            wrapper.appendChild(createCopyBtn(() => div.textContent));
        }
        return wrapper;
    }

    function renderRichOutput(output, theme) {
        const data = output.data || {};

        if (data['text/html']) {
            const wrapper = document.createElement('div');
            wrapper.className = 'nbv-html-wrapper';
            const div = document.createElement('div');
            div.className = 'nbv-html';
            div.innerHTML = textValue(data['text/html']);
            wrapper.appendChild(div);
            if (theme.output.copyButton) {
                wrapper.appendChild(createCopyBtn(() => div.textContent));
            }
            return wrapper;
        }
        if (data['text/latex']) {
            const div = document.createElement('div');
            div.className = 'nbv-latex';
            if (typeof katex !== 'undefined') {
                let tex = textValue(data['text/latex']).trim();
                let displayMode = false;
                if (tex.startsWith('$$') && tex.endsWith('$$')) {
                    tex = tex.slice(2, -2); displayMode = true;
                } else if (tex.startsWith('$') && tex.endsWith('$')) {
                    tex = tex.slice(1, -1);
                }
                katex.render(tex, div, { displayMode, throwOnError: false });
            } else {
                div.textContent = textValue(data['text/latex']);
            }
            return div;
        }
        if (data['image/png']) {
            const div = document.createElement('div');
            div.className = 'nbv-image-wrapper';
            const img = document.createElement('img');
            img.className = 'nbv-image' + (theme.output.imageShadow ? ' nbv-image-shadow' : '');
            img.src = 'data:image/png;base64,' + textValue(data['image/png']);
            div.appendChild(img);
            if (theme.output.copyButton) div.appendChild(createImageCopyBtn(img));
            return div;
        }
        if (data['image/jpeg']) {
            const div = document.createElement('div');
            div.className = 'nbv-image-wrapper';
            const img = document.createElement('img');
            img.className = 'nbv-image' + (theme.output.imageShadow ? ' nbv-image-shadow' : '');
            img.src = 'data:image/jpeg;base64,' + textValue(data['image/jpeg']);
            div.appendChild(img);
            if (theme.output.copyButton) div.appendChild(createImageCopyBtn(img));
            return div;
        }
        if (data['image/svg+xml']) {
            const div = document.createElement('div');
            div.className = 'nbv-svg';
            div.innerHTML = textValue(data['image/svg+xml']);
            return div;
        }
        if (data['text/plain']) {
            const wrapper = document.createElement('div');
            wrapper.className = 'nbv-text-wrapper';
            const div = document.createElement('div');
            div.className = 'nbv-text';
            div.textContent = textValue(data['text/plain']);
            wrapper.appendChild(div);
            if (theme.output.copyButton) {
                wrapper.appendChild(createCopyBtn(() => div.textContent));
            }
            return wrapper;
        }
        return null;
    }

    function renderErrorOutput(output, theme) {
        const wrapper = document.createElement('div');
        wrapper.className = 'nbv-error-wrapper';

        const div = document.createElement('div');
        div.className = 'nbv-error';

        const name = document.createElement('div');
        name.className = 'nbv-error-name';
        name.textContent = (output.ename || 'Error') + ': ' + (output.evalue || '');
        div.appendChild(name);

        if (output.traceback && output.traceback.length > 0) {
            const tb = document.createElement('div');
            tb.className = 'nbv-traceback';
            tb.innerHTML = ansiToHtml(output.traceback.join('\n'));
            div.appendChild(tb);
        }

        wrapper.appendChild(div);
        if (theme.output.copyButton) {
            wrapper.appendChild(createCopyBtn(() => div.textContent));
        }
        return wrapper;
    }

    function renderRawCell(source, theme, cellIndex) {
        const cell = document.createElement('div');
        cell.className = 'nbv-cell nbv-raw';
        if (theme.cells.leftBar) {
            cell.style.setProperty('--nbv-left-bar-color', theme.cells.leftBarColors.raw);
        }
        if (theme.cells.numbering) {
            const num = document.createElement('span');
            num.className = 'nbv-cell-number';
            num.textContent = cellIndex + 1;
            cell.appendChild(num);
        }
        cell.appendChild(document.createTextNode(source));
        return cell;
    }

    // ── Header ──────────────────────────────────────────────────────────

    function renderHeader(container, notebook) {
        const header = document.createElement('div');
        header.className = 'nbv-header';

        const meta = notebook.metadata || {};
        const kernelInfo = meta.kernelspec || {};
        const langInfo = meta.language_info || {};

        const title = document.createElement('div');
        title.className = 'nbv-header-title';
        const params = new URLSearchParams(window.location.search);
        const nbName = params.get('notebook') || kernelInfo.display_name || 'Notebook';
        title.textContent = nbName.replace(/\.ipynb$/, '');
        header.appendChild(title);

        const info = document.createElement('div');
        info.className = 'nbv-header-info';

        const infoLeft = document.createElement('span');
        infoLeft.className = 'nbv-header-info-left';
        const projectName = params.get('project') || '';
        infoLeft.textContent = projectName;
        info.appendChild(infoLeft);

        const infoRight = document.createElement('span');
        infoRight.className = 'nbv-header-info-right';
        const langName = langInfo.name ? langInfo.name.charAt(0).toUpperCase() + langInfo.name.slice(1) : '';
        const langVersion = langInfo.version || '';
        infoRight.textContent = langName + (langVersion ? ' ' + langVersion : '');
        info.appendChild(infoRight);

        header.appendChild(info);

        container.appendChild(header);
    }

    // ── Apply theme CSS custom properties ───────────────────────────────

    function applyThemeVars(container, theme) {
        const c = theme.colors;
        container.style.setProperty('--nbv-bg', c.background);
        container.style.setProperty('--nbv-page-bg', c.pageBg);
        container.style.setProperty('--nbv-text', c.text);
        container.style.setProperty('--nbv-text-muted', c.textMuted);
        container.style.setProperty('--nbv-cell-border', c.cellBorder);
        container.style.setProperty('--nbv-code-bg', c.codeBg);
        container.style.setProperty('--nbv-output-bg', c.outputBg);
        container.style.setProperty('--nbv-prompt', c.prompt);
        container.style.setProperty('--nbv-result-text', c.resultText);
        container.style.setProperty('--nbv-error-text', c.errorText);
        container.style.setProperty('--nbv-link', c.link);
        container.style.setProperty('--nbv-max-width', theme.page.maxWidth);
        container.style.setProperty('--nbv-code-font', theme.code.font);
        container.style.setProperty('--nbv-cell-spacing', theme.cells.spacing + 'px');

        if (c.scheme === 'dark') container.classList.add('nbv-dark');
        if (theme.cells.leftBar) container.classList.add('nbv-left-bar');
        if (theme.cells.borders) container.classList.add('nbv-cell-borders');

        // Swap highlight.js theme if specified
        if (theme.code.highlightTheme) {
            const existing = document.querySelector('link[href*="vendor/"][href$=".min.css"]:not([href*="katex"])');
            if (existing) {
                existing.href = existing.href.replace(/\/[^/]+\.min\.css$/, '/' + theme.code.highlightTheme + '.min.css');
            }
        }
    }

    // ── Main ────────────────────────────────────────────────────────────

    function renderNotebook(container, notebook, theme) {
        container.innerHTML = '';
        container.classList.add('nbv-container');
        applyThemeVars(container, theme);

        if (theme.page.header) {
            renderHeader(container, notebook);
        }

        const cellsWrapper = document.createElement('div');
        cellsWrapper.className = 'nbv-cells';

        const cells = notebook.cells || [];
        for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            const source = textValue(cell.source);
            let el;

            if (cell.cell_type === 'markdown') {
                el = renderMarkdownCell(source, theme, i);
            } else if (cell.cell_type === 'code') {
                el = renderCodeCell(source, cell.execution_count, cell.outputs, theme, i);
            } else {
                el = renderRawCell(source, theme, i);
            }

            cellsWrapper.appendChild(el);
        }

        container.appendChild(cellsWrapper);

        // Expand buttons for collapsible outputs
        if (theme.output.collapsible) {
            cellsWrapper.querySelectorAll('.nbv-output-collapsible').forEach((outputEl) => {
                if (outputEl.scrollHeight > theme.output.maxHeight) {
                    const expandBtn = document.createElement('button');
                    expandBtn.className = 'nbv-expand-btn';
                    expandBtn.textContent = 'Show more';
                    expandBtn.addEventListener('click', () => {
                        if (outputEl.classList.contains('nbv-output-expanded')) {
                            outputEl.classList.remove('nbv-output-expanded');
                            outputEl.style.maxHeight = theme.output.maxHeight + 'px';
                            expandBtn.textContent = 'Show more';
                        } else {
                            outputEl.classList.add('nbv-output-expanded');
                            outputEl.style.maxHeight = 'none';
                            expandBtn.textContent = 'Show less';
                        }
                    });
                    outputEl.parentElement.appendChild(expandBtn);
                }
            });
        }

        // TOC — fixed sidebar outside the container
        if (theme.markdown.toc) {
            const result = buildToc(cellsWrapper, container);
            if (result) {
                container.classList.add('nbv-has-toc');
                const parent = container.parentElement;
                parent.querySelectorAll('.nbv-toc-wrapper, .nbv-toc-toggle, .nbv-toc-resizer').forEach(el => el.remove());
                parent.insertBefore(result.outerToggle, container);
                parent.insertBefore(result.wrapper, container);
                parent.insertBefore(result.resizer, container);

                // Track active heading on scroll
                const tocLinks = result.wrapper.querySelectorAll('a');
                const headingEls = [];
                tocLinks.forEach(a => {
                    const id = a.getAttribute('href').slice(1);
                    const el = document.getElementById(id);
                    if (el) headingEls.push({ el, li: a.parentElement });
                });

                if (headingEls.length > 0) {
                    const scrollHost = container.closest('#viewer-wrapper') || container.closest('#viewer') || container.parentElement;
                    const updateActive = () => {
                        let active = headingEls[0];
                        for (const h of headingEls) {
                            if (h.el.getBoundingClientRect().top <= 60) active = h;
                        }
                        const sh = scrollHost === document.documentElement ? document.body : scrollHost;
                        // If scrolled to top, activate the first heading
                        if (sh.scrollTop < 2) {
                            active = headingEls[0];
                        }
                        // If scrolled to bottom, activate the last heading
                        if (Math.abs((sh.scrollTop + sh.clientHeight) - sh.scrollHeight) < 2) {
                            active = headingEls[headingEls.length - 1];
                        }
                        tocLinks.forEach(a => a.parentElement.classList.remove('nbv-toc-active'));
                        active.li.classList.add('nbv-toc-active');
                        const tocEl = active.li.closest('.nbv-toc');
                        if (tocEl) {
                            if (active === headingEls[0]) {
                                tocEl.scrollTop = 0;
                            } else {
                                const liRect = active.li.getBoundingClientRect();
                                const tocRect = tocEl.getBoundingClientRect();
                                const styles = getComputedStyle(tocEl);
                                const padTop = parseFloat(styles.paddingTop);
                                const padBottom = parseFloat(styles.paddingBottom);
                                const visibleTop = tocRect.top + padTop;
                                const visibleBottom = tocRect.bottom - padBottom;
                                if (liRect.top < visibleTop) {
                                    tocEl.scrollTop += liRect.top - visibleTop;
                                } else if (liRect.bottom > visibleBottom) {
                                    tocEl.scrollTop += liRect.bottom - visibleBottom;
                                }
                            }
                        }
                    };
                    (scrollHost || window).addEventListener('scroll', updateActive, { passive: true });
                    updateActive();
                }
            }
        }
    }

    // ── Public API ──────────────────────────────────────────────────────

    root.NotebookViewer = {
        /**
         * Render a notebook into a container.
         * @param {string|HTMLElement} selector - CSS selector or element
         * @param {string|object} source - URL to .ipynb file, or notebook JSON object
         * @param {string|object} [themeOrOpts] - Theme name (string), theme object, or opts with .theme
         */
        render: async function (selector, source, themeOrOpts) {
            const container = typeof selector === 'string'
                ? document.querySelector(selector) : selector;
            if (!container) {
                console.error('[NotebookViewer] Container not found:', selector);
                return;
            }

            // Resolve theme
            let theme = DEFAULT_THEME;
            if (typeof themeOrOpts === 'string') {
                try {
                    const resp = await fetch('static/themes/' + themeOrOpts + '.json');
                    if (resp.ok) {
                        theme = mergeDeep(DEFAULT_THEME, await resp.json());
                    } else {
                        console.warn('[NotebookViewer] Theme not found:', themeOrOpts, '— using default');
                    }
                } catch (e) {
                    console.warn('[NotebookViewer] Failed to load theme:', e.message);
                }
            } else if (themeOrOpts && typeof themeOrOpts === 'object') {
                if (themeOrOpts.colors || themeOrOpts.cells || themeOrOpts.code) {
                    theme = mergeDeep(DEFAULT_THEME, themeOrOpts);
                } else if (themeOrOpts.theme) {
                    if (typeof themeOrOpts.theme === 'string') {
                        try {
                            const resp = await fetch('static/themes/' + themeOrOpts.theme + '.json');
                            if (resp.ok) {
                                theme = mergeDeep(DEFAULT_THEME, await resp.json());
                            }
                        } catch (_) { /* use default */ }
                    } else {
                        theme = mergeDeep(DEFAULT_THEME, themeOrOpts.theme);
                    }
                }
            }

            // Resolve notebook
            let notebook;
            if (typeof source === 'string') {
                try {
                    const resp = await fetch(source);
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    notebook = await resp.json();
                } catch (e) {
                    container.innerHTML = '<div class="nbv-error">Failed to load notebook: '
                        + escapeHtml(e.message) + '</div>';
                    return;
                }
            } else {
                notebook = source;
            }

            renderNotebook(container, notebook, theme);
        },

        renderJSON: function (selector, notebook, themeOrOpts) {
            const container = typeof selector === 'string'
                ? document.querySelector(selector) : selector;
            if (!container) return;
            let theme = DEFAULT_THEME;
            if (themeOrOpts && typeof themeOrOpts === 'object') {
                theme = mergeDeep(DEFAULT_THEME, themeOrOpts);
            }
            renderNotebook(container, notebook, theme);
        },

        defaultTheme: DEFAULT_THEME,
    };

})(typeof globalThis !== 'undefined' ? globalThis : window);
