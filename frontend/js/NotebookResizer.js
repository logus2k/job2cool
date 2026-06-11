/**
 * NotebookResizer - Draggable splitter between notebook area and right panel.
 * Replaces the width slider in DisplaySettingsPanel.
 */
export class NotebookResizer {
    constructor() {
        this._resizer = document.getElementById('notebook-resizer');
        this._container = document.getElementById('center-column');

        // Restore saved width
        const saved = localStorage.getItem('notebook-cell-width');
        if (saved) {
            const px = parseInt(saved, 10);
            this._container.style.width = (px + 28) + 'px';
        }

        this._setupDrag();
    }

    _setupDrag() {
        let startX, startWidth, rafId;

        this._resizer.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            this._resizer.setPointerCapture(e.pointerId);
            this._resizer.classList.add('dragging');
            document.body.classList.add('resizing');
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';
            // Disable other resizers during drag to prevent cross-capture
            const otherResizer = document.getElementById('sidebar-resizer');
            if (otherResizer) otherResizer.style.pointerEvents = 'none';
            // Overlay iframes to prevent them from stealing pointer events
            const iframeOverlay = document.createElement('div');
            iframeOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;cursor:col-resize;touch-action:none';
            document.body.appendChild(iframeOverlay);
            startX = e.clientX;
            startWidth = this._container.getBoundingClientRect().width;
            // Lock the current computed width to prevent jump from flex-grow
            this._container.style.width = startWidth + 'px';
            rafId = 0;

            const onPointerMove = (e) => {
                if (rafId) return;
                rafId = requestAnimationFrame(() => {
                    const dx = e.clientX - startX;
                    const newWidth = Math.max(400, Math.min(startWidth + dx, window.innerWidth - 100));
                    this._container.style.width = newWidth + 'px';
                    rafId = 0;
                });
            };

            const onPointerUp = () => {
                if (rafId) cancelAnimationFrame(rafId);
                this._resizer.classList.remove('dragging');
                document.body.classList.remove('resizing');
                document.body.style.userSelect = '';
                document.body.style.cursor = '';
                // Re-enable other resizers
                const otherResizer = document.getElementById('sidebar-resizer');
                if (otherResizer) otherResizer.style.pointerEvents = '';
                // Remove iframe overlay
                if (iframeOverlay.parentNode) iframeOverlay.remove();
                this._resizer.removeEventListener('pointermove', onPointerMove);
                this._resizer.removeEventListener('pointerup', onPointerUp);
                this._resizer.removeEventListener('pointercancel', onPointerUp);
                try { this._resizer.releasePointerCapture(e.pointerId); } catch (_) {}

                // Save as cell width (subtract padding)
                const containerWidth = this._container.getBoundingClientRect().width;
                const cellWidth = Math.round(containerWidth - 28);
                localStorage.setItem('notebook-cell-width', String(cellWidth));
            };

            this._resizer.addEventListener('pointermove', onPointerMove);
            this._resizer.addEventListener('pointerup', onPointerUp);
            this._resizer.addEventListener('pointercancel', onPointerUp);
        });
    }
}
