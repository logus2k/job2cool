import {
    EditorView, EditorState, markdown
} from '../vendor/codemirror/codemirror.bundle.js';
import { modalConfirm } from './modal.js';

/**
 * SVG icon for post-it buttons (cell header and toolbar).
 * Mimics the post-it.png: yellow note, slightly tilted, darker adhesive
 * strip at top, curled bottom-left corner.
 */
const POST_IT_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <g transform="rotate(2, 12, 12)">
    <path d="M3 3h18v18H5.5L3 18.5V3z" fill="#f7e15c"/>
    <path d="M3 3h18v3.5H3z" fill="#e6b800"/>
    <path d="M3 18.5L5.5 21H3z" fill="none"/>
    <path d="M3 3h18v18H5.5L3 18.5V3z" stroke="#555" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </g>
</svg>`;
export const POST_IT_ICON_CELL = `<span style="display:inline-flex;width:14px;height:14px">${POST_IT_SVG}</span>`;
export const POST_IT_ICON_TOOLBAR = `<span style="display:inline-flex;width:18px;height:18px">${POST_IT_SVG}</span>`;

/** Color presets for post-it notes. */
const NOTE_COLORS = {
    yellow: { header: '#ffe680ee', image: 'static/images/post-it-yellow.png', dot: 'rgb(253, 193, 94)' },
    green:  { header: '#b8e6b0ee', image: 'static/images/post-it-green.png',  dot: '#7ec87a' },
    red:    { header: '#f0b8b8ee', image: 'static/images/post-it-red.png',    dot: '#e08080' },
};
const DEFAULT_COLOR = 'yellow';

/**
 * CellPostIt - Manages the floating post-it note on a single cell.
 * Handles creation, dragging within cell bounds, and opening the edit panel.
 */
export class CellPostIt {
    /**
     * @param {HTMLElement} cellEl - The .cell element
     * @param {object} metadata - cell.metadata (mutable reference)
     * @param {function} onMetadataChange - called when note content or position changes
     */
    constructor(cellEl, metadata, onMetadataChange) {
        this._cellEl = cellEl;
        this._metadata = metadata;
        this._onMetadataChange = onMetadataChange;
        this._floatingEl = null;
        this._panel = null;
        this._editing = false;
        this._editorView = null;

        if (this.hasNote()) {
            this._createFloating();
        }
    }

    get noted() {
        return this._metadata.noted || null;
    }

    hasNote() {
        return !!(this._metadata.noted && this._metadata.noted.annotation !== undefined);
    }

    /** Get the current note color, defaulting to yellow. */
    _getColor() {
        return this._metadata.noted?.color || DEFAULT_COLOR;
    }

    /** Toggle: create note if none, or open existing. */
    toggle() {
        if (this.hasNote()) {
            this._openEditPanel();
        } else {
            this._createNote();
        }
    }

    /** Create a new empty note. */
    _createNote() {
        if (!this._metadata.noted) {
            this._metadata.noted = {};
        }
        this._metadata.noted.annotation = '';
        this._metadata.noted.color = DEFAULT_COLOR;
        // Default position: top-right, below the cell header
        this._metadata.noted.position = { right: 20, top: 46 };
        this._createFloating();
        this._onMetadataChange();
        this._openEditPanel();
    }

    /** Remove the note entirely. */
    deleteNote() {
        if (this._panel) {
            this._panel.close();
            this._panel = null;
        }
        if (this._floatingEl) {
            this._floatingEl.remove();
            this._floatingEl = null;
        }
        delete this._metadata.noted;
        this._onMetadataChange();
    }

    /** Create the floating post-it image on the cell. */
    _createFloating() {
        if (this._floatingEl) return;

        const el = document.createElement('div');
        el.className = 'cell-post-it';
        const img = document.createElement('img');
        const color = this._getColor();
        img.src = NOTE_COLORS[color]?.image || NOTE_COLORS[DEFAULT_COLOR].image;
        img.draggable = false;
        el.appendChild(img);

        // Position from metadata
        const pos = this._metadata.noted?.position || { right: 20, top: 46 };
        el.style.top = `${pos.top}px`;
        el.style.right = `${pos.right}px`;

        // Drag within cell
        this._setupDrag(el);

        // Click opens edit panel (unless we just finished dragging)
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            if (el.classList.contains('dragging')) return;
            this._openEditPanel();
        });

        this._floatingEl = el;
        this._cellEl.style.position = 'relative';
        this._cellEl.appendChild(el);
    }

    /** Update the floating image to match the current color. */
    _updateFloatingImage() {
        if (!this._floatingEl) return;
        const img = this._floatingEl.querySelector('img');
        if (img) {
            const color = this._getColor();
            img.src = NOTE_COLORS[color]?.image || NOTE_COLORS[DEFAULT_COLOR].image;
        }
    }

    /** Make the floating element draggable within the cell bounds. */
    _setupDrag(el) {
        let startX, startY, startRight, startTop;

        const onMouseMove = (e) => {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (!el.classList.contains('dragging') && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
                el.classList.add('dragging');
            }

            const cellRect = this._cellEl.getBoundingClientRect();
            const elW = el.offsetWidth;
            const elH = el.offsetHeight;

            // right decreases as mouse moves right
            let newRight = startRight - dx;
            let newTop = startTop + dy;

            // Clamp within cell
            newRight = Math.max(0, Math.min(newRight, cellRect.width - elW));
            newTop = Math.max(0, Math.min(newTop, cellRect.height - elH));

            el.style.right = `${newRight}px`;
            el.style.top = `${newTop}px`;
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);

            // Save position
            if (!this._metadata.noted) this._metadata.noted = {};
            this._metadata.noted.position = {
                right: parseFloat(el.style.right),
                top: parseFloat(el.style.top)
            };
            this._onMetadataChange();

            // Remove dragging class after a tick so the click handler can check it
            requestAnimationFrame(() => el.classList.remove('dragging'));
        };

        el.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            startX = e.clientX;
            startY = e.clientY;
            startRight = parseFloat(el.style.right) || 0;
            startTop = parseFloat(el.style.top) || 0;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }

    /** Clamp post-it position after cell resize. */
    clampPosition() {
        if (!this._floatingEl || !this.hasNote()) return;
        const cellRect = this._cellEl.getBoundingClientRect();
        const elW = this._floatingEl.offsetWidth;
        const elH = this._floatingEl.offsetHeight;

        let right = parseFloat(this._floatingEl.style.right) || 0;
        let top = parseFloat(this._floatingEl.style.top) || 0;

        right = Math.max(0, Math.min(right, cellRect.width - elW));
        top = Math.max(0, Math.min(top, cellRect.height - elH));

        this._floatingEl.style.right = `${right}px`;
        this._floatingEl.style.top = `${top}px`;
    }

    /** Open the jsPanel for editing the note. */
    _openEditPanel() {
        if (this._panel) {
            this._panel.front();
            return;
        }

        // Position near the floating post-it
        const cellRect = this._cellEl.getBoundingClientRect();
        const panelLeft = Math.max(10, cellRect.right - 460);
        const panelTop = Math.max(10, cellRect.top);

        const annotation = this._metadata.noted?.annotation || '';
        const color = this._getColor();

        const panel = jsPanel.create({
            headerTitle: '<span class="postit-panel-title-content"></span>',
            theme: 'none',
            borderRadius: '5px',
            border: '1px solid var(--border-color)',
            boxShadow: 3,
            panelSize: { width: 400, height: 300 },
            position: { my: 'left-top', at: 'left-top', offsetX: panelLeft, offsetY: panelTop },
            headerControls: { minimize: 'remove', smallify: 'remove', normalize: 'remove', maximize: 'remove' },
            addCloseControl: 1,
            cssClass: ['postit-panel'],
            onclosed: () => {
                this._panel = null;
                this._editing = false;
                this._editorView = null;
                // If annotation is empty, remove the note entirely
                const text = this._metadata.noted?.annotation || '';
                if (!text.trim()) {
                    this._removeEmpty();
                }
            },
            callback: (panel) => {
                const content = panel.content;
                content.style.padding = '0';
                content.style.overflow = 'hidden';
                content.style.display = 'flex';
                content.style.flexDirection = 'column';
                content.style.height = '100%';

                // Set header color
                const hdr = panel.querySelector('.jsPanel-hdr');
                if (hdr) hdr.style.background = NOTE_COLORS[color]?.header || NOTE_COLORS[DEFAULT_COLOR].header;

                // Build color circles in title area
                this._buildColorCircles(panel);

                // Add delete button to header
                this._addDeleteButton(panel);

                // Rendered markdown view
                const renderedEl = document.createElement('div');
                renderedEl.className = 'postit-panel-rendered';
                renderedEl.innerHTML = annotation ? marked.parse(annotation) : '';
                content.appendChild(renderedEl);

                // Click to edit
                renderedEl.addEventListener('click', () => {
                    this._switchToEdit(content, renderedEl);
                });

                // If empty, go straight to edit
                if (!annotation) {
                    requestAnimationFrame(() => this._switchToEdit(content, renderedEl));
                }
            },
        });

        this._panel = panel;
    }

    /** Build the three color circles in the panel title. */
    _buildColorCircles(panel) {
        const titleEl = panel.querySelector('.postit-panel-title-content');
        if (!titleEl) return;

        const currentColor = this._getColor();

        for (const [name, cfg] of Object.entries(NOTE_COLORS)) {
            const circle = document.createElement('span');
            circle.className = 'postit-color-circle';
            if (name === currentColor) circle.classList.add('active');
            circle.style.background = cfg.dot;
            circle.title = name.charAt(0).toUpperCase() + name.slice(1);
            circle.addEventListener('click', (e) => {
                e.stopPropagation();
                this._setColor(name, panel);
            });
            titleEl.appendChild(circle);
        }
    }

    /** Change the note color and update panel + floating image. */
    _setColor(colorName, panel) {
        if (!this._metadata.noted) this._metadata.noted = {};
        this._metadata.noted.color = colorName;

        // Update panel header
        const hdr = panel.querySelector('.jsPanel-hdr');
        if (hdr) hdr.style.background = NOTE_COLORS[colorName]?.header || NOTE_COLORS[DEFAULT_COLOR].header;

        // Update active circle
        const circles = panel.querySelectorAll('.postit-color-circle');
        circles.forEach(c => c.classList.remove('active'));
        const idx = Object.keys(NOTE_COLORS).indexOf(colorName);
        if (idx >= 0 && circles[idx]) circles[idx].classList.add('active');

        // Update floating image
        this._updateFloatingImage();

        this._onMetadataChange();
    }

    /** Add a delete icon to the panel header. */
    _addDeleteButton(panel) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'jsPanel-btn';
        deleteBtn.title = 'Delete note';
        deleteBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" fill="#f4a0a0"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
        deleteBtn.style.cssText = 'background:none;border:none;cursor:pointer;padding:0 4px;display:flex;align-items:center;height:100%;';

        deleteBtn.addEventListener('click', async () => {
            const text = this._metadata.noted?.annotation || '';
            if (!text.trim() || await modalConfirm('Delete this note?')) {
                this.deleteNote();
            }
        });

        // Insert before the close button in the controlbar
        const controlbar = panel.querySelector('.jsPanel-controlbar');
        if (controlbar) {
            controlbar.insertBefore(deleteBtn, controlbar.firstChild);
        }
    }

    /** Switch from rendered view to CodeMirror editor. */
    _switchToEdit(contentEl, renderedEl) {
        if (this._editing) return;
        this._editing = true;
        renderedEl.style.display = 'none';

        const editorContainer = document.createElement('div');
        editorContainer.className = 'postit-panel-editor';
        contentEl.appendChild(editorContainer);

        const annotation = this._metadata.noted?.annotation || '';

        const view = new EditorView({
            doc: annotation,
            extensions: [
                markdown(),
                EditorView.lineWrapping,
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) {
                        const text = update.state.doc.toString();
                        if (!this._metadata.noted) this._metadata.noted = {};
                        this._metadata.noted.annotation = text;
                        this._onMetadataChange();
                    }
                }),
                EditorView.domEventHandlers({
                    blur: () => {
                        requestAnimationFrame(() => this._switchToRendered(contentEl, editorContainer, renderedEl));
                    },
                    keydown: (e) => {
                        if (e.key === 'Escape') {
                            e.preventDefault();
                            this._switchToRendered(contentEl, editorContainer, renderedEl);
                        }
                    }
                }),
            ],
            parent: editorContainer,
        });

        this._editorView = view;
        view.focus();
    }

    /** Switch from editor back to rendered markdown. */
    _switchToRendered(contentEl, editorContainer, renderedEl) {
        if (!this._editing) return;
        this._editing = false;

        const text = this._metadata.noted?.annotation || '';
        renderedEl.innerHTML = text ? marked.parse(text) : '';
        renderedEl.style.display = '';

        if (this._editorView) {
            this._editorView.destroy();
            this._editorView = null;
        }
        editorContainer.remove();
    }

    /** Remove note if empty (no content written). */
    _removeEmpty() {
        if (this._floatingEl) {
            this._floatingEl.remove();
            this._floatingEl = null;
        }
        delete this._metadata.noted;
        this._onMetadataChange();
    }

    /** Destroy: clean up panel and floating element. */
    destroy() {
        if (this._panel) {
            this._panel.close();
            this._panel = null;
        }
        if (this._floatingEl) {
            this._floatingEl.remove();
            this._floatingEl = null;
        }
    }
}
