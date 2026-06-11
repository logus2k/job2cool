/**
 * MediaViewer — displays images, audio, video, and PDFs from project/mount files.
 * Uses the raw file endpoint as the source URL.
 */
import { mediaType } from './file-icons.js';

export class MediaViewer {
    constructor() {
        this._el = document.createElement('div');
        this._el.className = 'media-viewer';
        this._projectId = null;
        this._filename = null;
        this._pdfModule = null;
        this._pdfState = null;
        this._pdfZoom = 1;
        this._onZoomChange = null;  // callback: (zoomPercent) => void
    }

    get element() { return this._el; }
    get projectId() { return this._projectId; }
    get filename() { return this._filename; }
    get pdfZoom() { return this._pdfZoom; }

    /** Set callback for zoom changes. */
    set onZoomChange(fn) { this._onZoomChange = fn; }

    _rawUrl() {
        const rootType = this._rootType || 'project';
        const name = this._projectId || '';
        return `api/files/${rootType}/${encodeURIComponent(name)}/raw?path=${encodeURIComponent(this._filename)}`;
    }

    open(projectId, filename, rootType) {
        this._projectId = projectId;
        this._filename = filename;
        this._rootType = rootType || 'project';
        this._cleanup();
        this._el.innerHTML = '';

        const type = mediaType(filename);
        const url = this._rawUrl();

        switch (type) {
            case 'image':
                this._renderImage(url);
                break;
            case 'audio':
                this._renderAudio(url);
                break;
            case 'video':
                this._renderVideo(url);
                break;
            case 'pdf':
                this._renderPdf(url);
                break;
            default:
                this._el.textContent = 'Unsupported file type';
        }
    }

    _renderImage(url) {
        const container = document.createElement('div');
        container.className = 'media-viewer-image-container';

        const img = document.createElement('img');
        img.className = 'media-viewer-image';
        img.src = url;
        img.alt = this._filename;
        img.addEventListener('error', () => {
            container.innerHTML = '<div class="media-viewer-error">Failed to load image</div>';
        });

        container.appendChild(img);
        this._el.appendChild(container);
    }

    _renderAudio(url) {
        const container = document.createElement('div');
        container.className = 'media-viewer-audio-container';

        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = url;
        audio.addEventListener('error', () => {
            container.innerHTML = '<div class="media-viewer-error">Failed to load audio</div>';
        });

        container.appendChild(audio);
        this._el.appendChild(container);
    }

    _renderVideo(url) {
        const container = document.createElement('div');
        container.className = 'media-viewer-video-container';

        const video = document.createElement('video');
        video.className = 'media-viewer-video';
        video.controls = true;
        video.src = url;
        video.addEventListener('error', () => {
            container.innerHTML = '<div class="media-viewer-error">Failed to load video</div>';
        });

        container.appendChild(video);
        this._el.appendChild(container);
    }

    async _renderPdf(url) {
        this._el.className = 'media-viewer media-viewer-pdf';
        this._pdfZoom = 1;
        try {
            if (!this._pdfModule) {
                this._pdfModule = await import('../vendor/pdf.min.mjs');
                this._pdfModule.GlobalWorkerOptions.workerSrc = 'static/vendor/pdf.worker.min.mjs';
            }

            // wasmUrl: folder (trailing slash) PDF.js loads decoder WASM
            // modules from at runtime — openjpeg (JPEG 2000), jbig2,
            // qcms_bg (color management), quickjs-eval (form scripting).
            // Without this, PDF.js builds `${wasmUrl}openjpeg_nowasm_fallback.js`
            // with wasmUrl=undefined → literal "null..." path → 404 →
            // pages with JPX images refuse to render (UAE strategy doc
            // first-two-pages symptom 2026-05-15).
            const pdfDoc = await this._pdfModule.getDocument({
                url,
                wasmUrl: 'static/vendor/wasm/',
            }).promise;
            const renderVersion = Date.now();
            const state = {
                pdfDoc,
                pageDivs: [],
                intersectionObserver: null,
                renderVersion,
            };
            this._pdfState = state;

            for (let i = 0; i < pdfDoc.numPages; i++) {
                const pageDiv = document.createElement('div');
                pageDiv.className = 'pdf-page';

                try {
                    const page = await pdfDoc.getPage(i + 1);
                    if (state.renderVersion !== renderVersion) return;
                    // Placeholder viewport at scale 1: only used for the
                    // page's aspect ratio. The render call computes a
                    // pixel-aligned scale from clientWidth × DPR.
                    const viewport = page.getViewport({ scale: 1 });
                    pageDiv.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
                    pageDiv._pdfPage = page;
                    pageDiv._pdfViewport = viewport;
                } catch {
                    pageDiv.style.aspectRatio = '8.5 / 11';
                }

                pageDiv._renderState = 'idle';
                pageDiv._pageIndex = i;
                this._el.appendChild(pageDiv);
                state.pageDivs.push(pageDiv);
            }

            // Lazy render pages as they enter viewport
            state.intersectionObserver = new IntersectionObserver((entries) => {
                if (state.renderVersion !== renderVersion) return;
                for (const entry of entries) {
                    const pd = entry.target;
                    if (entry.isIntersecting && pd._renderState === 'idle' && pd._pdfPage) {
                        pd._renderState = 'rendering';
                        this._renderPdfPage(pd, state);
                    }
                }
            }, { rootMargin: '200px' });

            for (const pd of state.pageDivs) {
                state.intersectionObserver.observe(pd);
            }
        } catch (err) {
            this._el.innerHTML = `<div class="media-viewer-error">Failed to load PDF: ${err.message}</div>`;
        }
    }

    async _renderPdfPage(pageDiv, state) {
        const { _pdfPage: page, _pdfViewport: placeholderViewport } = pageDiv;
        if (!page || !placeholderViewport) return;

        // Render at exact display × DPR resolution for pixel-perfect output.
        const dpr = window.devicePixelRatio || 1;
        const nativeWidth = page.getViewport({ scale: 1 }).width;
        const displayedWidth = pageDiv.clientWidth || placeholderViewport.width;
        const renderScale = (displayedWidth / nativeWidth) * dpr;
        const viewport = page.getViewport({ scale: renderScale });

        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page-canvas';
        const ctx = canvas.getContext('2d');

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = '100%';

        try {
            await page.render({ canvasContext: ctx, viewport }).promise;
            pageDiv.innerHTML = '';
            pageDiv.appendChild(canvas);
            pageDiv._renderState = 'rendered';
        } catch {
            pageDiv._renderState = 'idle';
            return;
        }

        // Annotation layer (clickable links / TOC entries)
        try {
            const annotations = await page.getAnnotations();
            const linkAnnotations = annotations.filter(a => a.subtype === 'Link' && (a.dest || a.url));
            if (linkAnnotations.length === 0) return;

            const annotDiv = document.createElement('div');
            annotDiv.className = 'pdf-annotation-layer';
            annotDiv.style.width = viewport.width + 'px';
            annotDiv.style.height = viewport.height + 'px';

            for (const annot of linkAnnotations) {
                const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annot.rect);
                const left = Math.min(x1, x2);
                const top = Math.min(y1, y2);
                const width = Math.abs(x2 - x1);
                const height = Math.abs(y2 - y1);

                const link = document.createElement('a');
                link.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;`;

                if (annot.url) {
                    link.href = annot.url;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                } else if (annot.dest) {
                    link.href = '#';
                    link.addEventListener('click', async (e) => {
                        e.preventDefault();
                        try {
                            let dest = annot.dest;
                            if (typeof dest === 'string') {
                                dest = await state.pdfDoc.getDestination(dest);
                            }
                            if (!Array.isArray(dest)) return;
                            const ref = dest[0];
                            const pageIndex = typeof ref === 'number' ? ref : await state.pdfDoc.getPageIndex(ref);
                            const targetDiv = state.pageDivs[pageIndex];
                            if (targetDiv) {
                                targetDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            }
                        } catch (err) {
                            console.warn('PDF link navigation error:', err);
                        }
                    });
                }

                annotDiv.appendChild(link);
            }

            pageDiv.appendChild(annotDiv);

            // Scale annotation overlay to match displayed page width
            const rescale = () => {
                const dw = pageDiv.clientWidth;
                if (dw > 0) annotDiv.style.transform = `scale(${dw / viewport.width})`;
            };
            rescale();

            if (!state.resizeObserver) {
                state.resizeObserver = new ResizeObserver(() => {
                    for (const pd of state.pageDivs) {
                        if (!pd._pdfViewport) continue;
                        const dw = pd.clientWidth;
                        if (dw <= 0) continue;
                        const scaleStr = `scale(${dw / pd._pdfViewport.width})`;
                        // Both the annotation layer (links) and the bbox
                        // highlight layer (citation overlay) live in PDF
                        // coords + are CSS-transformed; rescale together.
                        for (const layer of pd.querySelectorAll('.pdf-annotation-layer, .pdf-bbox-highlight-layer')) {
                            layer.style.transform = scaleStr;
                        }
                    }
                });
                state.resizeObserver.observe(this._el);
            }
        } catch (err) {
            console.warn('Failed to render annotations:', err);
        }
    }

    /**
     * Scroll to `pageNo` (1-indexed) and overlay a translucent rectangle
     * at `bbox` ([x0, y0, x1, y1] in PDF coords, bottom-left origin).
     * Replaces any prior bbox highlight. No-op if the PDF isn't loaded
     * or the page index is out of range. The page is force-rendered if
     * it hasn't lazy-loaded yet, so a deep page is highlighted on first
     * citation click without waiting for the user to scroll.
     *
     * Used by chat citation links (Docling-derived chunks carry
     * `page_no` + `bbox_*` metadata; the citation renderer calls this).
     */
    async showBboxHighlight(pageNo, bbox) {
        return this.showBboxHighlights([{ page_no: pageNo, bbox }]);
    }

    /** Multi-region highlight — a chunk that spans page breaks gets one
     * rectangle on each affected page. Scrolls to the first region.
     * Replaces any prior highlight on every page. */
    async showBboxHighlights(regions) {
        if (!this._pdfState || !Array.isArray(regions) || regions.length === 0) return;
        this.clearBboxHighlight();
        for (const r of regions) {
            await this._paintBboxOnPage(r.page_no, r.bbox);
        }
        const firstIdx = (regions[0].page_no || 1) - 1;
        const firstPage = this._pdfState.pageDivs[firstIdx];
        if (firstPage) firstPage.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async _paintBboxOnPage(pageNo, bbox) {
        if (!pageNo || pageNo < 1 || !Array.isArray(bbox) || bbox.length !== 4) return;
        const pageIndex = pageNo - 1;
        const pageDiv = this._pdfState.pageDivs[pageIndex];
        if (!pageDiv) return;

        // Force render if the lazy IntersectionObserver hasn't fired yet
        // (citation jumps deeper than the user scrolled).
        if (pageDiv._renderState === 'idle' && pageDiv._pdfPage) {
            pageDiv._renderState = 'rendering';
            await this._renderPdfPage(pageDiv, this._pdfState);
        }
        const viewport = pageDiv._pdfViewport;
        if (!viewport) return;

        const [vx1, vy1, vx2, vy2] = viewport.convertToViewportRectangle(bbox);
        const left = Math.min(vx1, vx2);
        const top = Math.min(vy1, vy2);
        const width = Math.abs(vx2 - vx1);
        const height = Math.abs(vy2 - vy1);

        const layer = document.createElement('div');
        layer.className = 'pdf-bbox-highlight-layer';
        layer.style.width = viewport.width + 'px';
        layer.style.height = viewport.height + 'px';

        const rect = document.createElement('div');
        rect.className = 'pdf-bbox-highlight';
        rect.style.left = left + 'px';
        rect.style.top = top + 'px';
        rect.style.width = width + 'px';
        rect.style.height = height + 'px';
        layer.appendChild(rect);
        pageDiv.appendChild(layer);

        // Match the annotation layer's CSS-transform sizing so the bbox
        // tracks page width as the panel resizes.
        const dw = pageDiv.clientWidth;
        if (dw > 0) layer.style.transform = `scale(${dw / viewport.width})`;
    }

    /** Clear any bbox highlight currently visible. */
    clearBboxHighlight() {
        if (!this._pdfState) return;
        for (const pd of this._pdfState.pageDivs) {
            const layer = pd.querySelector('.pdf-bbox-highlight-layer');
            if (layer) layer.remove();
        }
    }

    /** Set zoom level (decimal, e.g. 1.0 = 100%). */
    setZoom(level) {
        this._pdfZoom = Math.max(0.25, Math.min(5, level));
        const maxW = Math.round(800 * this._pdfZoom) + 'px';
        if (this._pdfState) {
            for (const pd of this._pdfState.pageDivs) {
                pd.style.maxWidth = maxW;
            }
        }
        if (this._onZoomChange) this._onZoomChange(Math.round(this._pdfZoom * 100));
    }

    zoomIn() { this.setZoom(this._pdfZoom + 0.1); }
    zoomOut() { this.setZoom(this._pdfZoom - 0.1); }

    /** Fit page width to the container width. */
    fitToWidth() {
        const availableWidth = this._el.clientWidth - 24; // subtract padding
        if (availableWidth <= 0) return;
        // Base page max-width is 800px at zoom 1.0
        const zoom = availableWidth / 800;
        this.setZoom(zoom);
    }

    _cleanup() {
        if (this._pdfState) {
            if (this._pdfState.intersectionObserver) {
                this._pdfState.intersectionObserver.disconnect();
            }
            if (this._pdfState.resizeObserver) {
                this._pdfState.resizeObserver.disconnect();
            }
            if (this._pdfState.pdfDoc) {
                this._pdfState.pdfDoc.destroy();
            }
            this._pdfState = null;
        }
    }

    destroy() {
        this._cleanup();
        this._el.innerHTML = '';
        this._projectId = null;
        this._filename = null;
    }
}
