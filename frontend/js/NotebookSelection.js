/**
 * NotebookSelection - Manages cell selection, keyboard navigation,
 * mouse handling, clipboard (copy/cut/paste), and undo.
 */
export class NotebookSelection {
    /**
     * @param {object} editor - NotebookEditor instance
     */
    constructor(editor) {
        this._editor = editor;
    }

    // --- Selection state ---

    selectCell(index) {
        this.clearSelection();
        this._editor._selectedIndices.add(index);
        this._editor._anchorIndex = index;
        this.updateSelectionVisuals();
    }

    extendSelectionTo(index) {
        const editor = this._editor;
        if (editor._anchorIndex === null) editor._anchorIndex = index;
        editor._selectedIndices.clear();
        const lo = Math.min(editor._anchorIndex, index);
        const hi = Math.max(editor._anchorIndex, index);
        for (let i = lo; i <= hi; i++) editor._selectedIndices.add(i);
        this.updateSelectionVisuals();
    }

    clearSelection() {
        this._editor._selectedIndices.clear();
        this.updateSelectionVisuals();
    }

    updateSelectionVisuals() {
        const editor = this._editor;
        const multi = editor._selectedIndices.size > 1;
        for (let i = 0; i < editor._cells.length; i++) {
            const isSelected = editor._selectedIndices.has(i);
            editor._cells[i].element.classList.toggle('selected', isSelected);
            editor._cells[i].element.draggable = isSelected && multi;
        }
        // Notify subscribers of the current anchor cell - the canonical
        // "currently selected cell" used by status-bar ordinal etc.
        if (editor.onSelectionChange && editor._anchorIndex != null) {
            editor.onSelectionChange(editor._anchorIndex);
        }
    }

    // --- Mouse handling ---

    onCellMousedown(index, e) {
        const editor = this._editor;

        if (e.shiftKey) {
            e.preventDefault();
            this.extendSelectionTo(index);
            editor._cells[index].focusCell();
            return;
        }

        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            if (editor._selectedIndices.has(index)) {
                editor._selectedIndices.delete(index);
                if (editor._selectedIndices.size === 0) {
                    editor._selectedIndices.add(index);
                }
            } else {
                editor._selectedIndices.add(index);
            }
            editor._anchorIndex = index;
            this.updateSelectionVisuals();
            editor._cells[index].focusCell();
            return;
        }

        const editorArea = editor._cells[index]?.element.querySelector('.cell-editor');
        if (editorArea && editorArea.contains(e.target)) {
            this.selectCell(index);
            return;
        }

        const sidebar = editor._cells[index]?.element.querySelector('.cell-sidebar');
        if (sidebar && sidebar.contains(e.target)) return;

        if (e.target.closest('.cell-delete-btn, .cell-copy-btn, .cell-clear-btn, .cell-header-btn')) return;

        if (editor._selectedIndices.has(index) && editor._selectedIndices.size > 1) {
            return;
        }

        this.selectCell(index);
        editor._cells[index].focusCell();
    }

    onCellClick(index, e) {
        const editor = this._editor;
        const editorArea = editor._cells[index]?.element.querySelector('.cell-editor');
        if (editorArea && editorArea.contains(e.target)) return;
        const sidebar = editor._cells[index]?.element.querySelector('.cell-sidebar');
        if (sidebar && sidebar.contains(e.target)) return;

        if (editor._selectedIndices.has(index) && editor._selectedIndices.size > 1 && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            this.selectCell(index);
            editor._cells[index].focusCell();
        }
    }

    // --- Keyboard handling ---

    onCellKeydown(index, e) {
        const key = e.key;

        if (key === 'ArrowUp' || key === 'ArrowDown') {
            e.preventDefault();
            const dir = key === 'ArrowUp' ? -1 : 1;
            if (e.altKey) {
                this._moveSelectedCells(dir);
            } else if (e.shiftKey) {
                this._extendSelection(index, dir);
            } else {
                this._navigateToCell(index + dir);
            }
            return;
        }

        if (key === 'Enter') {
            e.preventDefault();
            this.clearSelection();
            const cell = this._editor._cells[index];
            if (cell) {
                if (cell.cellType === 'markdown' && cell._markdownRendered) {
                    cell._hideMarkdownRendered();
                }
                cell.focusEditor();
            }
            return;
        }

        if (key === 'Delete' || key === 'Backspace') {
            e.preventDefault();
            this._deleteSelectedCells();
            return;
        }

        const mod = e.ctrlKey || e.metaKey;
        // If user has text selected (e.g. in cell output), let browser handle copy natively
        const textSelected = window.getSelection()?.toString().length > 0;
        if (mod && key === 'c') {
            if (textSelected) return; // allow native copy
            e.preventDefault();
            this._copySelectedCells(false);
            return;
        }
        if (mod && key === 'x') {
            if (textSelected) return;
            e.preventDefault();
            this._copySelectedCells(true);
            return;
        }
        if (mod && key === 'v') {
            e.preventDefault();
            this._pasteCells();
            return;
        }
        if (mod && key === 'z' && !e.shiftKey) {
            e.preventDefault();
            this._editor._undo();
            return;
        }
    }

    // --- Navigation ---

    _navigateToCell(targetIndex) {
        const editor = this._editor;
        if (targetIndex < 0 || targetIndex >= editor._cells.length) return;
        this.selectCell(targetIndex);
        editor._cells[targetIndex].focusCell();
        editor._cells[targetIndex].element.scrollIntoView({ block: 'nearest' });
    }

    _extendSelection(currentIndex, dir) {
        const editor = this._editor;
        const sorted = [...editor._selectedIndices].sort((a, b) => a - b);
        const edge = dir > 0 ? sorted[sorted.length - 1] : sorted[0];
        const next = edge + dir;
        if (next < 0 || next >= editor._cells.length) return;
        this.extendSelectionTo(next);
        editor._cells[next].focusCell();
        editor._cells[next].element.scrollIntoView({ block: 'nearest' });
    }

    // --- Move cells ---

    _moveSelectedCells(dir) {
        const editor = this._editor;
        if (editor._selectedIndices.size === 0) return;
        const sorted = [...editor._selectedIndices].sort((a, b) => a - b);

        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i] !== sorted[i - 1] + 1) return;
        }

        const first = sorted[0];
        const last = sorted[sorted.length - 1];

        if (dir < 0 && first === 0) return;
        if (dir > 0 && last === editor._cells.length - 1) return;

        editor._pushUndo();

        if (dir < 0) {
            const adj = first - 1;
            const [cell] = editor._cells.splice(adj, 1);
            editor._cells.splice(last, 0, cell);
            editor._client.moveCell(adj, last);
        } else {
            const adj = last + 1;
            const [cell] = editor._cells.splice(adj, 1);
            editor._cells.splice(first, 0, cell);
            editor._client.moveCell(adj, first);
        }

        editor._reindexCells();
        editor._notebook.cells = editor._cells.map(c => c.toJSON());
        editor._render();

        editor._selectedIndices.clear();
        for (const idx of sorted) {
            editor._selectedIndices.add(idx + dir);
        }
        editor._anchorIndex = (editor._anchorIndex !== null) ? editor._anchorIndex + dir : null;
        this.updateSelectionVisuals();

        const focusIdx = dir < 0 ? first + dir : last + dir;
        if (editor._cells[focusIdx]) {
            editor._cells[focusIdx].focusCell();
            editor._cells[focusIdx].element.scrollIntoView({ block: 'nearest' });
        }
    }

    // --- Clipboard ---

    _copySelectedCells(isCut) {
        const editor = this._editor;
        if (editor._selectedIndices.size === 0) return;
        const sorted = [...editor._selectedIndices].sort((a, b) => a - b);
        editor._clipboard = {
            cells: sorted.map(i => editor._cells[i].toJSON()),
            isCut
        };
        if (isCut) {
            this._deleteSelectedCells();
        }
    }

    _pasteCells() {
        const editor = this._editor;
        if (!editor._clipboard || editor._clipboard.cells.length === 0) return;
        editor._pushUndo();

        let insertAt;
        if (editor._selectedIndices.size > 0) {
            insertAt = Math.max(...editor._selectedIndices) + 1;
        } else {
            insertAt = editor._cells.length;
        }

        const newIndices = [];
        for (let i = 0; i < editor._clipboard.cells.length; i++) {
            const cellJSON = editor._clipboard.cells[i];
            const cellId = Math.random().toString(36).substring(2, 10);
            const cellData = {
                cell_type: cellJSON.cell_type,
                id: cellId,
                metadata: {},
                source: cellJSON.source,
                outputs: [],
                execution_count: null
            };

            const idx = insertAt + i;
            const cellEditor = editor._createCellEditor(cellData, idx);
            editor._cells.splice(idx, 0, cellEditor);

            editor._client.addCell(idx, cellData.cell_type, cellId);
            const src = Array.isArray(cellJSON.source) ? cellJSON.source.join('') : (cellJSON.source || '');
            if (src) {
                setTimeout(() => editor._client.updateCell(idx, src), 50);
            }

            newIndices.push(idx);
        }

        editor._reindexCells();
        editor._notebook.cells = editor._cells.map(c => c.toJSON());
        editor._render();

        editor._selectedIndices.clear();
        for (const idx of newIndices) editor._selectedIndices.add(idx);
        editor._anchorIndex = newIndices[0];
        this.updateSelectionVisuals();

        if (editor._cells[newIndices[0]]) {
            editor._cells[newIndices[0]].focusCell();
        }
    }

    _deleteSelectedCells() {
        const editor = this._editor;
        if (editor._selectedIndices.size === 0) return;
        editor._pushUndo();

        const sorted = [...editor._selectedIndices].sort((a, b) => b - a);
        const nearestAfter = Math.min(...editor._selectedIndices);

        for (const idx of sorted) {
            const cell = editor._cells[idx];
            cell.destroy();
            editor._cells.splice(idx, 1);

            if (editor._wrapperEl) {
                const addBtnEl = editor._wrapperEl.children[idx * 2 + 1];
                if (addBtnEl) addBtnEl.remove();
            }

            editor._client.deleteCell(idx);
        }

        editor._reindexCells();
        editor._updateAddCellLast();
        this.clearSelection();

        if (editor._cells.length === 0) {
            editor._addCell(0, 'code', { skipUndo: true });
        }

        const focusIdx = Math.min(nearestAfter, editor._cells.length - 1);
        this.selectCell(focusIdx);
        editor._cells[focusIdx].focusCell();
    }
}
