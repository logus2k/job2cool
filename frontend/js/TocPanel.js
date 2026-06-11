/**
 * TocPanel - Table of Contents sidebar view.
 * Supports three content modes:
 *   - notebook: extracts headings from markdown cells
 *   - markdown: extracts headings from rendered DOM (DocumentViewer / FileEditor preview)
 *   - pdf: extracts outline from PDF document via pdf.js
 * Designed to be registered as a sidebar view (no own wrapper/resizer).
 */

export class TocPanel {
    /**
     * @param {function} getCells - Returns the current cells array (notebook mode)
     * @param {function} [onSelectCell] - Called with cell index on click (notebook mode)
     */
    constructor(getCells, onSelectCell) {
        this._getCells = getCells;
        this._onSelectCell = onSelectCell || null;
        this._active = false;
        this._headingEls = [];
        this._tocLinks = [];
        this._scrollHost = null;
        this._scrollHandler = null;

        // Active content mode: 'notebook' | 'markdown' | 'pdf' | null
        this._mode = 'notebook';
        this._markdownContainer = null; // DOM element with rendered markdown
        this._markdownScrollHost = null; // scrollable parent for markdown content
        this._pdfDoc = null; // pdf.js document for outline extraction
        this._pdfPageDivs = null; // page div references for PDF navigation
        this._pdfScrollHost = null; // scrollable parent for PDF pages

        // Cache extracted PDF heading data to avoid re-parsing on tab switch
        // Key: pdfDoc.fingerprints[0], Value: [{level, text, pageIndex}]
        this._pdfHeadingCache = new Map();

        this._build();
    }

    _build() {
        this._el = document.createElement('div');
        this._el.className = 'toc-nav';

        this._list = document.createElement('ul');
        this._el.appendChild(this._list);

        // Drive a class on the panel from real pointer enter/leave events.
        // The scrollbar thumb's visibility was previously gated on
        // `.toc-nav:hover ::-webkit-scrollbar-thumb`, but Chromium's
        // :hover state on scrollbar pseudos is unreliable: after a click
        // elsewhere in the document, re-hovering the panel sometimes
        // doesn't re-fire the hover style on the thumb. A JS-driven
        // `is-hovered` class survives that and re-applies cleanly.
        this._el.addEventListener('mouseenter', () => this._el.classList.add('is-hovered'));
        this._el.addEventListener('mouseleave', () => this._el.classList.remove('is-hovered'));
    }

    get element() {
        return this._el;
    }

    /** Called when the sidebar activates this view */
    activate() {
        this._active = true;
        this._renderList();
        this._setupScrollTracking();
    }

    /** Called when the sidebar deactivates this view */
    deactivate() {
        this._active = false;
        this._teardownScrollTracking();
    }

    /** Refresh list if currently active */
    refresh() {
        if (this._active) {
            this._renderList();
            this._setupScrollTracking();
        }
    }

    // ── Mode switching (called from app.js on tab change) ────────────

    /** Switch to notebook TOC mode */
    setNotebookMode() {
        this._mode = 'notebook';
        this._markdownContainer = null;
        this._markdownScrollHost = null;
        this._pdfDoc = null;
        this._pdfPageDivs = null;
        this._pdfScrollHost = null;
        this.refresh();
    }

    /** Switch to markdown TOC mode */
    setMarkdownMode(contentEl, scrollHost) {
        this._mode = 'markdown';
        this._markdownContainer = contentEl;
        this._markdownScrollHost = scrollHost;
        this._pdfDoc = null;
        this._pdfPageDivs = null;
        this._pdfScrollHost = null;
        this.refresh();
    }

    /** Switch to PDF TOC mode */
    setPdfMode(pdfDoc, pageDivs, scrollHost) {
        this._mode = 'pdf';
        this._markdownContainer = null;
        this._markdownScrollHost = null;
        this._pdfDoc = pdfDoc;
        this._pdfPageDivs = pageDivs;
        this._pdfScrollHost = scrollHost;
        this.refresh();
    }

    /** Clear TOC (e.g. when switching to a non-document tab) */
    clearMode() {
        this._mode = null;
        this._markdownContainer = null;
        this._markdownScrollHost = null;
        this._pdfDoc = null;
        this._pdfPageDivs = null;
        this._pdfScrollHost = null;
        if (this._active) {
            this._teardownScrollTracking();
            this._list.innerHTML = '';
            this._headingEls = [];
            this._tocLinks = [];
            const empty = document.createElement('li');
            empty.className = 'toc-empty';
            empty.textContent = 'No document active.';
            this._list.appendChild(empty);
        }
    }

    // ── Rendering ────────────────────────────────────────────────────

    _renderList() {
        this._list.innerHTML = '';
        this._headingEls = [];
        this._tocLinks = [];

        if (this._mode === 'notebook') {
            this._renderNotebookHeadings();
        } else if (this._mode === 'markdown') {
            this._renderMarkdownHeadings();
        } else if (this._mode === 'pdf') {
            this._renderPdfOutline();
            return; // PDF outline is async
        }

        this._showEmptyIfNeeded();
    }

    _showEmptyIfNeeded() {
        if (this._list.children.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'toc-empty';
            const msgs = {
                notebook: 'No headings are currently available. Try opening a notebook or Markdown file.',
                markdown: 'No headings in this document.',
                pdf: 'No outline in this PDF.',
            };
            empty.textContent = msgs[this._mode] || 'No document active.';
            this._list.appendChild(empty);
        }
    }

    // ── Notebook headings ────────────────────────────────────────────

    _renderNotebookHeadings() {
        const cells = this._getCells();

        for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            if (cell._cellType !== 'markdown') continue;

            const rendered = cell._mdRenderedEl;
            if (rendered) {
                const hEls = rendered.querySelectorAll('h1, h2, h3, h4, h5, h6');
                for (const h of hEls) {
                    const level = parseInt(h.tagName[1]);
                    const text = h.textContent.replace(/#$/, '').trim();
                    if (text) {
                        this._addNotebookEntry(level, text, cell, i, h);
                    }
                }
                if (hEls.length > 0) continue;
            }

            const source = cell._getSource ? cell._getSource() : (cell._data?.source || '');
            const srcText = Array.isArray(source) ? source.join('') : source;
            const lines = srcText.split('\n');
            for (const line of lines) {
                const match = line.match(/^(#{1,6})\s+(.+)/);
                if (match) {
                    this._addNotebookEntry(match[1].length, match[2].trim(), cell, i, null);
                }
            }
        }
    }

    _addNotebookEntry(level, text, cell, cellIndex, headingEl) {
        const li = document.createElement('li');
        li.className = `toc-h${level}`;

        const a = document.createElement('a');
        a.textContent = text;
        a.href = 'javascript:void(0)';
        a.addEventListener('click', (e) => {
            e.preventDefault();
            for (const h of this._headingEls) h.li.classList.remove('toc-active');
            li.classList.add('toc-active');
            // Block _updateActive from re-deriving the active heading
            // from layout math during the click. After the scroll lands,
            // the topmost-visible heading by viewport position can be
            // the one ABOVE the clicked target (when the scrollHost sits
            // below the 80px threshold), which would silently overwrite
            // the click-applied state.
            this._clickLock = true;

            const target = headingEl || cell.element;
            const container = target.closest('#notebook-container');
            if (container) {
                const containerRect = container.getBoundingClientRect();
                const targetRect = target.getBoundingClientRect();
                container.scrollTop += targetRect.top - containerRect.top - 60;
            } else {
                target.scrollIntoView({ behavior: 'instant', block: 'start' });
            }
            requestAnimationFrame(() => requestAnimationFrame(() => { this._clickLock = false; }));
            if (this._onSelectCell) {
                this._onSelectCell(cellIndex);
            }
        });

        li.appendChild(a);
        this._list.appendChild(li);
        this._headingEls.push({ el: headingEl || cell.element, li, isCell: !headingEl });
        this._tocLinks.push(a);
    }

    // ── Markdown headings ────────────────────────────────────────────

    _renderMarkdownHeadings() {
        const container = this._markdownContainer;
        if (!container) return;

        const hEls = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
        for (const h of hEls) {
            const level = parseInt(h.tagName[1]);
            const text = h.textContent.trim();
            if (!text) continue;

            const li = document.createElement('li');
            li.className = `toc-h${level}`;

            const a = document.createElement('a');
            a.textContent = text;
            a.href = 'javascript:void(0)';
            a.addEventListener('click', (e) => {
                e.preventDefault();
                for (const hh of this._headingEls) hh.li.classList.remove('toc-active');
                li.classList.add('toc-active');
                this._clickLock = true;

                const scrollHost = this._markdownScrollHost || container.parentElement;
                if (scrollHost) {
                    const hostRect = scrollHost.getBoundingClientRect();
                    const hRect = h.getBoundingClientRect();
                    scrollHost.scrollTop += hRect.top - hostRect.top - 30;
                } else {
                    h.scrollIntoView({ behavior: 'instant', block: 'start' });
                }
                requestAnimationFrame(() => requestAnimationFrame(() => { this._clickLock = false; }));
            });

            li.appendChild(a);
            this._list.appendChild(li);
            this._headingEls.push({ el: h, li, isCell: false });
            this._tocLinks.push(a);
        }
    }

    // ── PDF outline ──────────────────────────────────────────────────

    async _renderPdfOutline() {
        const pdfDoc = this._pdfDoc;
        if (!pdfDoc) {
            this._showEmptyIfNeeded();
            return;
        }

        try {
            // Check cache first (keyed by PDF fingerprint)
            const cacheKey = pdfDoc.fingerprints?.[0];
            const cached = cacheKey ? this._pdfHeadingCache.get(cacheKey) : null;
            if (cached) {
                for (const h of cached) {
                    this._addPdfHeadingEntry(h.level, h.text, h.pageIndex);
                }
                this._showEmptyIfNeeded();
                this._setupScrollTracking();
                return;
            }

            // Try embedded outline first
            const outline = await pdfDoc.getOutline();
            if (outline && outline.length > 0) {
                await this._addOutlineItems(outline, 1, pdfDoc);
                this._showEmptyIfNeeded();
                this._setupScrollTracking();
                return;
            }

            // Fallback: extract headings by font size from text content
            await this._extractPdfHeadingsByFontSize(pdfDoc);
            // Cache the extracted results
            if (cacheKey) {
                const entries = [];
                for (const h of this._headingEls) {
                    const a = h.li.querySelector('a');
                    const level = parseInt(h.li.className.replace('toc-h', ''));
                    entries.push({ level, text: a?.textContent || '', pageIndex: h.el?._pageIndex ?? 0 });
                }
                this._pdfHeadingCache.set(cacheKey, entries);
            }
            this._showEmptyIfNeeded();
            this._setupScrollTracking();
        } catch {
            this._showEmptyIfNeeded();
        }
    }

    async _extractPdfHeadingsByFontSize(pdfDoc) {
        const numPages = pdfDoc.numPages;

        // First pass: collect all font heights to determine body vs heading sizes
        const fontHeights = [];
        const pageTexts = []; // cache for second pass

        for (let p = 1; p <= numPages; p++) {
            try {
                const page = await pdfDoc.getPage(p);
                const textContent = await page.getTextContent();
                pageTexts.push({ pageIndex: p - 1, items: textContent.items });
                for (const item of textContent.items) {
                    if (item.str && item.str.trim()) {
                        fontHeights.push(item.height);
                    }
                }
            } catch {
                pageTexts.push({ pageIndex: p - 1, items: [] });
            }
        }

        if (fontHeights.length === 0) return;

        // Find the most common font height (body text)
        const heightCounts = {};
        for (const h of fontHeights) {
            const rounded = Math.round(h * 10) / 10;
            heightCounts[rounded] = (heightCounts[rounded] || 0) + 1;
        }
        const bodyHeight = parseFloat(
            Object.entries(heightCounts).sort((a, b) => b[1] - a[1])[0][0]
        );

        // Heading threshold: anything significantly larger than body text
        const headingThreshold = bodyHeight * 1.15;

        // Second pass: extract headings
        for (const { pageIndex, items } of pageTexts) {
            // Group text items into lines by Y coordinate (tolerance ±2)
            const lines = [];
            for (const item of items) {
                if (!item.str || !item.str.trim()) continue;
                const y = Math.round(item.transform[5]);
                let line = lines.find(l => Math.abs(l.y - y) <= 2);
                if (!line) {
                    line = { y, items: [], maxHeight: 0 };
                    lines.push(line);
                }
                line.items.push(item);
                if (item.height > line.maxHeight) line.maxHeight = item.height;
            }
            // Sort top-to-bottom
            lines.sort((a, b) => b.y - a.y);

            for (const line of lines) {
                if (line.maxHeight < headingThreshold) continue;

                // Sort items left-to-right
                line.items.sort((a, b) => a.transform[4] - b.transform[4]);
                const text = line.items.map(it => it.str).join(' ').trim();
                if (!text || text.length < 2 || text.length > 200) continue;

                // Skip lines that look like page numbers or artifacts
                if (/^\d+$/.test(text)) continue;

                // Determine heading level from size ratio
                const ratio = line.maxHeight / bodyHeight;
                const level = ratio > 1.8 ? 1 : ratio > 1.4 ? 2 : 3;

                this._addPdfHeadingEntry(level, text, pageIndex);
            }
        }
    }

    _addPdfHeadingEntry(level, text, pageIndex) {
        const li = document.createElement('li');
        li.className = `toc-h${level}`;

        const a = document.createElement('a');
        a.href = 'javascript:void(0)';
        const textSpan = document.createElement('span');
        textSpan.className = 'toc-text';
        textSpan.textContent = text;
        const pageSpan = document.createElement('span');
        pageSpan.className = 'toc-page';
        pageSpan.textContent = String(pageIndex + 1);
        a.appendChild(textSpan);
        a.appendChild(pageSpan);
        a.addEventListener('click', (e) => {
            e.preventDefault();
            // Set the click target as active manually (and lock
            // _updateActive). All TOC entries that point to the same
            // page share the same pageDiv element, so layout-derived
            // active selection can't distinguish among them and would
            // pick whichever entry happens to be last in iteration —
            // not the one the user clicked.
            for (const h of this._headingEls) h.li.classList.remove('toc-active');
            li.classList.add('toc-active');
            this._clickLock = true;
            this._scrollPdfToPage(pageIndex);
            requestAnimationFrame(() => requestAnimationFrame(() => { this._clickLock = false; }));
        });

        li.appendChild(a);
        this._list.appendChild(li);

        if (this._pdfPageDivs && this._pdfPageDivs[pageIndex]) {
            this._headingEls.push({ el: this._pdfPageDivs[pageIndex], li, isCell: false });
        }
        this._tocLinks.push(a);
    }

    async _addOutlineItems(items, level, pdfDoc) {
        for (const item of items) {
            const text = (item.title || '').trim();
            if (!text) continue;

            // Resolve destination to page index
            let pageIndex = -1;
            try {
                let dest = item.dest;
                if (typeof dest === 'string') dest = await pdfDoc.getDestination(dest);
                if (Array.isArray(dest)) {
                    const ref = dest[0];
                    pageIndex = typeof ref === 'number' ? ref : await pdfDoc.getPageIndex(ref);
                }
            } catch { /* skip */ }

            const li = document.createElement('li');
            li.className = `toc-h${Math.min(level, 6)}`;

            const a = document.createElement('a');
            a.href = 'javascript:void(0)';
            const textSpan = document.createElement('span');
            textSpan.className = 'toc-text';
            textSpan.textContent = text;
            const pageSpan = document.createElement('span');
            pageSpan.className = 'toc-page';
            // pageIndex of -1 means we couldn't resolve the destination —
            // omit the number rather than show "0" or "-1".
            if (pageIndex >= 0) pageSpan.textContent = String(pageIndex + 1);
            a.appendChild(textSpan);
            a.appendChild(pageSpan);
            a.addEventListener('click', (e) => {
                e.preventDefault();
                // Manual active-state set + _clickLock — see the matching
                // comment in _addPdfHeadingEntry for the reasoning.
                for (const h of this._headingEls) h.li.classList.remove('toc-active');
                li.classList.add('toc-active');
                this._clickLock = true;
                this._scrollPdfToPage(pageIndex);
                requestAnimationFrame(() => requestAnimationFrame(() => { this._clickLock = false; }));
            });

            li.appendChild(a);
            this._list.appendChild(li);

            // Track for scroll sync: use the page div as the reference element
            if (pageIndex >= 0 && this._pdfPageDivs && this._pdfPageDivs[pageIndex]) {
                this._headingEls.push({ el: this._pdfPageDivs[pageIndex], li, isCell: false });
            }
            this._tocLinks.push(a);

            // Recurse for children
            if (item.items && item.items.length > 0) {
                await this._addOutlineItems(item.items, level + 1, pdfDoc);
            }
        }
    }

    _scrollPdfToPage(pageIndex) {
        if (pageIndex < 0 || !this._pdfPageDivs || !this._pdfPageDivs[pageIndex]) return;
        const target = this._pdfPageDivs[pageIndex];
        const scrollHost = this._pdfScrollHost;
        if (scrollHost) {
            const hostRect = scrollHost.getBoundingClientRect();
            const targetRect = target.getBoundingClientRect();
            scrollHost.scrollTop += targetRect.top - hostRect.top;
        }
    }

    // ── Scroll tracking (shared) ─────────────────────────────────────

    _setupScrollTracking() {
        this._teardownScrollTracking();
        if (this._headingEls.length === 0) return;

        if (this._mode === 'notebook') {
            this._scrollHost = document.getElementById('notebook-container');
        } else if (this._mode === 'markdown') {
            this._scrollHost = this._markdownScrollHost || this._markdownContainer?.parentElement;
        } else if (this._mode === 'pdf') {
            this._scrollHost = this._pdfScrollHost;
        }

        if (!this._scrollHost) return;
        this._scrollHandler = () => this._updateActive();
        this._scrollHost.addEventListener('scroll', this._scrollHandler, { passive: true });
        this._updateActive();
    }

    _teardownScrollTracking() {
        if (this._scrollHost && this._scrollHandler) {
            this._scrollHost.removeEventListener('scroll', this._scrollHandler);
            this._scrollHandler = null;
        }
    }

    _updateActive() {
        if (this._headingEls.length === 0) return;
        if (this._clickLock) return;

        const host = this._scrollHost;
        if (!host) return;
        const hostRect = host.getBoundingClientRect();
        let active = this._headingEls[0];

        // Host-relative position — the heading's top measured from the
        // scrollable area's top edge, not the viewport's. Earlier code
        // used viewport-relative math (`top <= 80`), which broke when
        // toolbars and sidebars pushed the scrollHost more than ~50px
        // below the viewport top: after clicking heading B, B would
        // land at viewport y ≈ scrollHost.top + 30 ≈ 130 (failing the
        // 80 threshold) while heading A just above sat at viewport
        // y ≈ 60 (passing it), so A silently overwrote B.
        for (const h of this._headingEls) {
            const relTop = h.el.getBoundingClientRect().top - hostRect.top;
            if (relTop <= 80) active = h;
        }

        for (const h of this._headingEls) {
            h.li.classList.remove('toc-active');
        }
        active.li.classList.add('toc-active');
    }
}
