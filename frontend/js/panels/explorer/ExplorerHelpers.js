/**
 * ExplorerHelpers - Pure UI utility functions shared across explorer modules.
 * No state, no side effects beyond DOM creation.
 */

import { modalError } from '../../modal.js';

export function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

export function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function createDetailHeader(text, iconClassOrSrc = null) {
    const h = document.createElement('div');
    h.className = 'explorer-detail-header';
    if (iconClassOrSrc) {
        if (iconClassOrSrc.endsWith('.svg')) {
            const img = document.createElement('img');
            img.src = iconClassOrSrc;
            img.className = 'explorer-detail-icon';
            h.appendChild(img);
        } else {
            const icon = document.createElement('i');
            icon.className = iconClassOrSrc;
            h.appendChild(icon);
        }
        h.appendChild(document.createTextNode(text));
    } else {
        h.textContent = text;
    }
    return h;
}

export function addParentLabel(detailEl, parentText) {
    const label = document.createElement('div');
    label.className = 'explorer-detail-parent';
    label.textContent = parentText;
    detailEl.appendChild(label);
}

export function createEditableHeader(text, iconClassOrSrc, onRename) {
    const wrapper = document.createElement('div');
    wrapper.className = 'explorer-detail-header explorer-editable-header';

    if (iconClassOrSrc) {
        if (iconClassOrSrc.endsWith('.svg')) {
            const img = document.createElement('img');
            img.src = iconClassOrSrc;
            img.className = 'explorer-detail-icon';
            wrapper.appendChild(img);
        } else {
            const icon = document.createElement('i');
            icon.className = iconClassOrSrc;
            wrapper.appendChild(icon);
        }
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'explorer-header-name';
    nameSpan.textContent = text;
    wrapper.appendChild(nameSpan);

    const editBtn = document.createElement('i');
    editBtn.className = 'fa-solid fa-pen explorer-rename-icon';
    editBtn.title = 'Rename';
    wrapper.appendChild(editBtn);

    const startEdit = () => {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'explorer-rename-input';
        input.value = text;
        nameSpan.style.display = 'none';
        editBtn.style.display = 'none';
        wrapper.appendChild(input);
        input.focus();
        input.select();

        const commit = async () => {
            const newName = input.value.trim();
            if (!newName || newName === text) {
                cancel();
                return;
            }
            try {
                await onRename(newName);
            } catch (err) {
                modalError(err.message, { title: 'Rename Failed' });
                cancel();
            }
        };

        const cancel = () => {
            input.remove();
            nameSpan.style.display = '';
            editBtn.style.display = '';
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
        input.addEventListener('blur', () => {
            setTimeout(() => { if (input.parentNode) commit(); }, 150);
        });
    };

    editBtn.addEventListener('click', startEdit);

    return wrapper;
}

export function clearActionBar(detailRoot) {
    const existing = detailRoot?.querySelector('.explorer-action-bar');
    if (existing) existing.remove();
}

export function createActionBar(detailRoot) {
    clearActionBar(detailRoot);
    const bar = document.createElement('div');
    bar.className = 'explorer-action-bar';
    return bar;
}

export function addMetaRow(container, label, valueHtml) {
    const row = document.createElement('div');
    row.className = 's3-meta-row';
    row.innerHTML = `<span class="s3-meta-label">${label}</span><span class="s3-meta-value">${valueHtml}</span>`;
    container.appendChild(row);
}
