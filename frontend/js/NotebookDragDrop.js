/**
 * NotebookDragDrop - Handles cell drag-and-drop reordering.
 * Manages drop indicators, auto-scroll near edges, and multi-cell drops.
 */
export class NotebookDragDrop {
    /**
     * @param {object} editor - NotebookEditor instance (provides _cells, _wrapperEl, _container, etc.)
     */
    constructor(editor) {
        this._editor = editor;
        this._dragScrollRAF = null;
        this._dropTargetIndex = null;
    }

    setup() {
        const wrapper = this._editor._wrapperEl;
        if (!wrapper) return;

        wrapper.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            this._updateDropIndicator(e.clientY);
            this._updateDragScroll(e.clientY);
        });

        wrapper.addEventListener('dragleave', (e) => {
            if (!wrapper.contains(e.relatedTarget)) {
                this._clearDropIndicator();
                this._stopDragScroll();
            }
        });

        wrapper.addEventListener('drop', (e) => {
            e.preventDefault();
            this._stopDragScroll();
            this._handleDrop(e);
        });
    }

    onDragStart(index, e) {
        const editor = this._editor;
        let indices;
        if (editor._selectedIndices.has(index) && editor._selectedIndices.size > 1) {
            indices = [...editor._selectedIndices].sort((a, b) => a - b);
        } else {
            editor.selection.selectCell(index);
            indices = [index];
        }

        e.dataTransfer.setData('text/plain', indices.join(','));
        e.dataTransfer.effectAllowed = 'move';

        for (const idx of indices) {
            editor._cells[idx].element.classList.add('dragging');
        }
    }

    onDragEnd() {
        for (const cell of this._editor._cells) {
            cell.element.classList.remove('dragging');
        }
    }

    _handleDrop(e) {
        const raw = e.dataTransfer.getData('text/plain');
        const toIndex = this._dropTargetIndex;
        this._clearDropIndicator();

        if (!raw || toIndex == null) return;

        const draggedIndices = raw.split(',').map(Number).filter(n => !isNaN(n));
        if (draggedIndices.length === 0) return;

        const sorted = [...draggedIndices].sort((a, b) => a - b);
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        if (toIndex >= first && toIndex <= last + 1) return;

        const editor = this._editor;
        editor._pushUndo();

        const draggedCells = sorted.map(i => editor._cells[i]);
        for (let i = sorted.length - 1; i >= 0; i--) {
            editor._cells.splice(sorted[i], 1);
        }

        let insertAt = toIndex;
        for (const idx of sorted) {
            if (idx < toIndex) insertAt--;
        }

        editor._cells.splice(insertAt, 0, ...draggedCells);
        editor._reindexCells();
        editor._notebook.cells = editor._cells.map(c => c.toJSON());
        editor._reorderDOM();

        for (let i = 0; i < sorted.length; i++) {
            editor._client.moveCell(sorted[i], insertAt + i);
        }

        editor._selectedIndices.clear();
        for (let i = 0; i < draggedCells.length; i++) {
            editor._selectedIndices.add(insertAt + i);
        }
        editor._anchorIndex = insertAt;
        editor.selection.updateSelectionVisuals();
    }

    _updateDragScroll(clientY) {
        const edgeZone = 60;
        const maxSpeed = 12;
        const rect = this._editor._container.getBoundingClientRect();
        const distTop = clientY - rect.top;
        const distBottom = rect.bottom - clientY;

        let speed = 0;
        if (distTop < edgeZone) {
            speed = -maxSpeed * (1 - distTop / edgeZone);
        } else if (distBottom < edgeZone) {
            speed = maxSpeed * (1 - distBottom / edgeZone);
        }

        if (speed === 0) {
            this._stopDragScroll();
            return;
        }

        if (this._dragScrollRAF) return;

        const container = this._editor._container;
        const scroll = () => {
            container.scrollTop += speed;
            this._dragScrollRAF = requestAnimationFrame(scroll);
        };
        this._dragScrollRAF = requestAnimationFrame(scroll);
    }

    _stopDragScroll() {
        if (this._dragScrollRAF) {
            cancelAnimationFrame(this._dragScrollRAF);
            this._dragScrollRAF = null;
        }
    }

    _updateDropIndicator(clientY) {
        const cells = this._editor._cells;
        if (cells.length === 0) return;

        // Find drop index: cursor above a cell's midpoint → insert before it
        let dropIndex = cells.length;
        for (let i = 0; i < cells.length; i++) {
            const rect = cells[i].element.getBoundingClientRect();
            const mid = rect.top + rect.height / 2;
            if (clientY < mid) {
                dropIndex = i;
                break;
            }
        }

        if (dropIndex === this._dropTargetIndex) return;

        this._clearDropIndicator();
        this._dropTargetIndex = dropIndex;

        // Offset by 3 to skip topBar, secondBar, and debugBar at the start of the wrapper
        const indicator = this._editor._wrapperEl.children[3 + dropIndex * 2];
        if (indicator) {
            indicator.classList.add('drop-target');
        }
    }

    _clearDropIndicator() {
        this._dropTargetIndex = null;
        const wrapper = this._editor._wrapperEl;
        if (!wrapper) return;
        for (const el of wrapper.querySelectorAll('.drop-target')) {
            el.classList.remove('drop-target');
        }
    }
}
