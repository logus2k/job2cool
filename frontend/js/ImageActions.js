/**
 * ImageActions - Adds copy/save overlay buttons to images inside cells.
 * Observes DOM changes to wrap new images as they appear.
 */
export class ImageActions {
    constructor(containerEl) {
        this._container = containerEl;
        this._copySvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" fill="#a8d8a0"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
        this._checkSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2a7a2a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 9 17 20 6"/></svg>';
        this._saveSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4" /><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" fill="#a8c8f0"/></svg>';

        this._observe();
    }

    _observe() {
        new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    const imgs = node.tagName === 'IMG' ? [node] : node.querySelectorAll?.('img') || [];
                    for (const img of imgs) this._wrapImage(img);
                }
            }
        }).observe(this._container, { childList: true, subtree: true });
    }

    _wrapImage(img) {
        if (img.closest('.img-copy-wrapper')) return;
        if (!img.closest('.cell-markdown-rendered') && !img.closest('.cell-output')) return;

        const wrapper = document.createElement('span');
        wrapper.className = 'img-copy-wrapper';
        img.parentNode.insertBefore(wrapper, img);
        wrapper.appendChild(img);

        wrapper.appendChild(this._createCopyButton(img));
        wrapper.appendChild(this._createSaveButton(img));
    }

    _createCopyButton(img) {
        const btn = document.createElement('button');
        btn.className = 'img-copy-btn';
        btn.innerHTML = this._copySvg;
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
                btn.classList.add('copied');
                btn.innerHTML = this._checkSvg;
                setTimeout(() => {
                    btn.classList.remove('copied');
                    btn.innerHTML = this._copySvg;
                }, 1500);
            } catch {
                window.open(img.src, '_blank');
            }
        });
        return btn;
    }

    _createSaveButton(img) {
        const btn = document.createElement('button');
        btn.className = 'img-copy-btn';
        btn.innerHTML = this._saveSvg;
        btn.title = 'Save image';
        btn.style.right = '38px';
        btn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext('2d').drawImage(img, 0, 0);
                const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                const srcName = img.src.split('/').pop().split('?')[0];
                a.download = srcName && srcName.includes('.') ? srcName : 'image.png';
                a.click();
                URL.revokeObjectURL(url);
            } catch {
                window.open(img.src, '_blank');
            }
        });
        return btn;
    }
}
