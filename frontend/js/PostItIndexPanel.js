/**
 * PostItIndexPanel - Lists all cells with post-it notes.
 * Clicking an entry scrolls to and highlights that cell.
 */

const INDEX_DOT_COLORS = {
    yellow: 'rgb(253, 193, 94)',
    green:  '#7ec87a',
    red:    '#e08080',
};

export class PostItIndexPanel {
    /**
     * @param {function} getCells - Returns the current cells array
     */
    constructor(getCells) {
        this._getCells = getCells;
        this._panel = null;
    }

    toggle() {
        if (this._panel) {
            this._panel.close();
            return;
        }
        this._open();
    }

    _open() {
        this._panel = jsPanel.create({
            headerTitle: '<i class="fa-solid fa-note-sticky" style="color:#f7e15c;-webkit-text-stroke:1px #555;paint-order:stroke fill;margin-right:6px"></i>Notes',
            theme: 'none',
            borderRadius: '5px',
            border: '1px solid var(--border-color)',
            boxShadow: 3,
            panelSize: { width: 360, height: 400 },
            position: 'center',
            headerControls: { minimize: 'remove', smallify: 'remove', normalize: 'remove', maximize: 'remove' },
            cssClass: ['postit-panel'],
            onclosed: () => {
                this._panel = null;
            },
            callback: (panel) => {
                panel.content.style.padding = '0';
                panel.content.style.overflow = 'hidden';
                panel.content.style.display = 'flex';
                panel.content.style.flexDirection = 'column';
                this._renderList(panel.content);
            },
        });
    }

    _renderList(contentEl) {
        contentEl.innerHTML = '';
        const cells = this._getCells();
        const notedCells = [];

        for (let i = 0; i < cells.length; i++) {
            const meta = cells[i]._data?.metadata?.noted;
            if (meta && meta.annotation !== undefined) {
                notedCells.push({ index: i, cell: cells[i], annotation: meta.annotation, color: meta.color || 'yellow' });
            }
        }

        if (notedCells.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'postit-index-empty';
            empty.textContent = 'No notes in this notebook.';
            contentEl.appendChild(empty);
            return;
        }

        const list = document.createElement('div');
        list.className = 'postit-index-list';

        for (const { index, cell, annotation, color } of notedCells) {
            const item = document.createElement('div');
            item.className = 'postit-index-item';

            const dot = document.createElement('span');
            dot.className = 'postit-index-dot';
            dot.style.background = INDEX_DOT_COLORS[color] || INDEX_DOT_COLORS.yellow;

            const cellLabel = document.createElement('span');
            cellLabel.className = 'postit-index-cell';
            cellLabel.textContent = `Cell ${index + 1}`;

            const preview = document.createElement('span');
            preview.className = 'postit-index-preview';
            preview.textContent = annotation
                ? annotation.substring(0, 80).replace(/\n/g, ' ')
                : '(empty note)';

            item.append(dot, cellLabel, preview);
            item.addEventListener('click', () => {
                cell.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                cell.focusCell();
            });

            list.appendChild(item);
        }

        contentEl.appendChild(list);
    }

    refresh() {
        if (this._panel) {
            this._renderList(this._panel.content);
        }
    }
}
