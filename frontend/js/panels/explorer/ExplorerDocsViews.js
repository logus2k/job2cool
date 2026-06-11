/**
 * ExplorerDocsViews - Knowledge Base (Documents) detail views and tree loaders.
 */

import { modalConfirm, modalError } from '../../modal.js';
import { kbDocIconForFile } from '../../file-icons.js';
import { createDetailHeader, addParentLabel } from './ExplorerHelpers.js';

/**
 * @param {object} ctx - Shared explorer context (getters for live state).
 * @returns {object} View methods for Knowledge Base documents.
 */
export function createDocsViews(ctx) {

    function showDocsRootDetail() {
        ctx.detailEl.innerHTML = '';
        

        const header = createDetailHeader('Knowledge Base', 'fa-solid fa-landmark');
        ctx.detailEl.appendChild(header);

        // Upload form
        const form = document.createElement('div');
        form.className = 'explorer-create-form';

        const nameLabel = document.createElement('label');
        nameLabel.textContent = 'Document Name';
        form.appendChild(nameLabel);

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.spellcheck = false;
        nameInput.placeholder = 'Display name for the document';
        form.appendChild(nameInput);

        const catLabel = document.createElement('label');
        catLabel.textContent = 'Category';
        form.appendChild(catLabel);

        const catInput = document.createElement('input');
        catInput.type = 'text';
        catInput.spellcheck = false;
        catInput.placeholder = 'Category (e.g. Guides, References)';
        const categories = ctx.docsCatalog?.categories ? Object.keys(ctx.docsCatalog.categories) : [];
        if (categories.length > 0) {
            const datalist = document.createElement('datalist');
            datalist.id = 'doc-categories-list';
            for (const cat of categories) {
                const opt = document.createElement('option');
                opt.value = cat;
                datalist.appendChild(opt);
            }
            form.appendChild(datalist);
            catInput.setAttribute('list', 'doc-categories-list');
        }
        form.appendChild(catInput);

        const fileLabel = document.createElement('label');
        fileLabel.textContent = 'File (.md or .pdf)';
        form.appendChild(fileLabel);

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.md,.pdf,.txt,.rst';
        fileInput.className = 'explorer-file-input';
        form.appendChild(fileInput);

        const errorEl = document.createElement('div');
        errorEl.className = 'explorer-form-error';
        form.appendChild(errorEl);

        const uploadBtn = document.createElement('button');
        uploadBtn.className = 'explorer-btn primary';
        uploadBtn.textContent = 'Upload Document';
        uploadBtn.addEventListener('click', () => uploadDocument(nameInput, catInput, fileInput, uploadBtn, errorEl));
        form.appendChild(uploadBtn);

        ctx.detailEl.appendChild(form);
    }

    function showDocCategoryDetail(category) {
        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, 'Knowledge Base');

        const header = createDetailHeader(category, 'fa-solid fa-folder');
        ctx.detailEl.appendChild(header);

        const docs = (ctx.docsCatalog?.documents || []).filter(d => (d.category || 'Uncategorized') === category);
        if (docs.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'explorer-detail-empty';
            empty.innerHTML = '<span>No documents in this category</span>';
            ctx.detailEl.appendChild(empty);
            return;
        }

        const list = document.createElement('div');
        list.className = 'explorer-doc-list';
        for (const doc of docs) {
            const row = document.createElement('div');
            row.className = 'explorer-doc-row';

            const icon = document.createElement('img');
            icon.src = iconPathForFile(doc.location);
            icon.className = 'explorer-doc-icon';
            row.appendChild(icon);

            const nameSpan = document.createElement('span');
            nameSpan.className = 'explorer-doc-name';
            nameSpan.textContent = doc.name;
            row.appendChild(nameSpan);

            row.addEventListener('click', () => {
                const nodeKey = `doc:${category}:${doc.name}`;
                const node = ctx.tree?.findKey(nodeKey);
                if (node) node.setActive(true);
            });

            list.appendChild(row);
        }
        ctx.detailEl.appendChild(list);
    }

    function showDocDetail(category, docName) {
        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, category);

        const doc = (ctx.docsCatalog?.documents || []).find(
            d => d.name === docName && (d.category || 'Uncategorized') === category
        );
        if (!doc) {
            ctx.detailEl.innerHTML = '<div class="explorer-detail-empty"><span>Document not found</span></div>';
            return;
        }

        const header = createDetailHeader(docName, iconPathForFile(doc.location));
        ctx.detailEl.appendChild(header);

        const info = document.createElement('div');
        info.className = 'explorer-create-form';

        const catRow = document.createElement('div');
        catRow.className = 'explorer-info-row';
        catRow.innerHTML = `<span class="explorer-info-label">Category</span><span class="explorer-info-value">${category}</span>`;
        info.appendChild(catRow);

        const typeRow = document.createElement('div');
        typeRow.className = 'explorer-info-row';
        const ext = doc.location.split('.').pop().toUpperCase();
        typeRow.innerHTML = `<span class="explorer-info-label">Type</span><span class="explorer-info-value">${ext}</span>`;
        info.appendChild(typeRow);

        ctx.detailEl.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'explorer-detail-actions';
        const openBtn = document.createElement('button');
        openBtn.className = 'explorer-btn primary';
        openBtn.textContent = 'Open Document';
        openBtn.addEventListener('click', () => {
            if (ctx.callbacks.onDocumentOpen) ctx.callbacks.onDocumentOpen(doc);
        });
        actions.appendChild(openBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'explorer-btn danger';
        deleteBtn.textContent = 'Delete Document';
        deleteBtn.style.marginLeft = 'auto';
        deleteBtn.addEventListener('click', async () => {
            if (!await modalConfirm(`Delete document "${docName}"?`)) return;
            try {
                const resp = await fetch('api/documents', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: docName, category }),
                });
                if (!resp.ok) {
                    const err = await resp.json();
                    throw new Error(err.detail || 'Failed to delete');
                }
                await reloadDocuments();
            } catch (err) {
                modalError(err.message, { title: 'Delete Failed' });
            }
        });
        actions.appendChild(deleteBtn);

        ctx.detailEl.appendChild(actions);
    }

    async function uploadDocument(nameInput, catInput, fileInput, btn, errorEl) {
        errorEl.textContent = '';
        const name = nameInput.value.trim();
        const category = catInput.value.trim() || 'Uncategorized';
        const file = fileInput.files?.[0];

        if (!name) { errorEl.textContent = 'Name is required'; return; }
        if (!file) { errorEl.textContent = 'Select a file to upload'; return; }

        btn.disabled = true;
        btn.textContent = 'Uploading...';

        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('name', name);
            formData.append('category', category);

            const resp = await fetch('api/documents/upload', {
                method: 'POST',
                body: formData,
            });

            if (!resp.ok) {
                if (resp.status === 413) throw new Error('File too large (max 100 MB)');
                const text = await resp.text();
                try {
                    const err = JSON.parse(text);
                    throw new Error(err.detail || 'Upload failed');
                } catch (e) {
                    if (e.message.includes('Upload failed') || e.message.includes('too large')) throw e;
                    throw new Error(`Upload failed (HTTP ${resp.status})`);
                }
            }

            await reloadDocuments();
        } catch (err) {
            errorEl.textContent = err.message;
            btn.disabled = false;
            btn.textContent = 'Upload Document';
        }
    }

    async function reloadDocuments() {
        try {
            const resp = await fetch('api/documents');
            ctx.docsCatalog = await resp.json();
        } catch {
            ctx.docsCatalog = { categories: {}, documents: [] };
        }

        if (!ctx.tree) return;
        const docsRoot = ctx.tree.findKey('root-docs');
        if (!docsRoot) return;

        const docs = ctx.docsCatalog.documents || [];
        const docsByCategory = {};
        for (const doc of docs) {
            const cat = doc.category || 'Uncategorized';
            if (!docsByCategory[cat]) docsByCategory[cat] = [];
            docsByCategory[cat].push(doc);
        }

        const children = Object.keys(docsByCategory).sort().map(cat => ({
            title: cat,
            key: `doccat:${cat}`,
            icon: 'fa-solid fa-folder',
            folder: true,
            expanded: false,
            children: docsByCategory[cat].map(doc => ({
                title: doc.name,
                key: `doc:${cat}:${doc.name}`,
                icon: kbDocIconForFile(doc.location),
            })),
        }));

        docsRoot.removeChildren();
        docsRoot.addChildren(children);
        docsRoot.setExpanded(true);

        docsRoot.setActive(true, { noEvents: true });
        showDocsRootDetail();
        ctx.fireSectionChange('root-docs');
    }

    return {
        showDocsRootDetail,
        showDocCategoryDetail,
        showDocDetail,
        reloadDocuments,
    };
}
