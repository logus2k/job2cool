/**
 * DomainSettingsTab - inline-edit display name + description, plus
 * read-only resource info and a Delete-Domain action (when allowed).
 *
 * Endpoints:
 *   PATCH  /api/domains/{id}?name=...&description=...
 *   DELETE /api/domains/{id}
 */

import { modalConfirm } from '../modal.js';
import { notify } from '../Notify.js';


function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
}


export class DomainSettingsTab {

    constructor(ctx) {
        this._ctx = ctx;
        this._els = {};
        this._dirty = false;
    }

    mount() {
        const d = this._ctx.domain;

        const root = document.createElement('div');
        root.className = 'dm-settings';

        // Editable card
        const editCard = document.createElement('div');
        editCard.className = 'dm-card';
        editCard.innerHTML = `
            <div class="dm-card-head"><span class="dm-card-title">General</span></div>
            <div class="dm-card-body">
                <div class="dm-form-row">
                    <label for="dm-set-name">Display name</label>
                    <input type="text" id="dm-set-name" class="dm-input" value="${escapeHtml(d.name || '')}" />
                </div>
                <div class="dm-form-row">
                    <label for="dm-set-desc">Description</label>
                    <textarea id="dm-set-desc" class="dm-input" rows="3">${escapeHtml(d.description || '')}</textarea>
                </div>
                <div class="dm-form-actions">
                    <button class="rm-btn dm-btn-primary" id="dm-set-save" disabled>Save changes</button>
                    <span class="dm-form-status" id="dm-set-status"></span>
                </div>
            </div>
        `;
        root.appendChild(editCard);

        // Read-only resource info card
        const infoCard = document.createElement('div');
        infoCard.className = 'dm-card';
        infoCard.innerHTML = `
            <div class="dm-card-head"><span class="dm-card-title">Resources</span></div>
            <div class="dm-card-body">
                <div class="dm-info-row"><span>Domain id</span><span class="dm-mono">${escapeHtml(d.domain_id)}</span></div>
                <div class="dm-info-row"><span>Pinned</span><span>${d.pinned ? 'Yes (cannot be deactivated)' : 'No'}</span></div>
                <div class="dm-info-row"><span>Has knowledge</span><span>${d.has_knowledge ? 'Yes (vector + graph)' : 'No (skills/tools only)'}</span></div>
                ${d.has_knowledge ? `
                <div class="dm-info-row"><span>Corpus collection</span><span class="dm-mono">${escapeHtml(d.corpus_collection || '-')}</span></div>
                <div class="dm-info-row"><span>ArcadeDB project</span><span class="dm-mono">${escapeHtml(d.arcadedb_project_id || '-')}</span></div>
                ` : ''}
            </div>
        `;
        root.appendChild(infoCard);

        // Danger zone (only when deletable)
        if (d.deletable !== false) {
            const danger = document.createElement('div');
            danger.className = 'dm-card dm-card-danger';
            danger.innerHTML = `
                <div class="dm-card-head"><span class="dm-card-title">Danger zone</span></div>
                <div class="dm-card-body">
                    <p class="dm-danger-text">
                        Permanently remove this Domain, its ChromaDB collections,
                        and its ArcadeDB project. Source files in
                        <code>data/kb_sources/</code> remain on disk.
                    </p>
                    <button class="rm-btn dm-btn-danger" id="dm-set-delete">
                        <i class="fa-solid fa-trash"></i>
                        <span>Delete Domain</span>
                    </button>

                </div>
            `;
            root.appendChild(danger);
        }

        this._ctx.container.appendChild(root);

        // Refs
        this._els.root   = root;
        this._els.name   = root.querySelector('#dm-set-name');
        this._els.desc   = root.querySelector('#dm-set-desc');
        this._els.save   = root.querySelector('#dm-set-save');
        this._els.status = root.querySelector('#dm-set-status');
        this._els.del    = root.querySelector('#dm-set-delete');

        // Wire dirty tracking + save
        const initialName = d.name || '';
        const initialDesc = d.description || '';
        const onChange = () => {
            this._dirty = (this._els.name.value !== initialName)
                       || (this._els.desc.value !== initialDesc);
            this._els.save.disabled = !this._dirty;
            if (this._dirty) this._els.status.textContent = '';
        };
        this._els.name.addEventListener('input', onChange);
        this._els.desc.addEventListener('input', onChange);
        this._els.save.addEventListener('click', () => this._save());
        if (this._els.del) this._els.del.addEventListener('click', () => this._delete());
    }

    destroy() {
        this._els = {};
        this._dirty = false;
    }

    async _save() {
        const id = this._ctx.domain.domain_id;
        const params = new URLSearchParams();
        const name = this._els.name.value.trim();
        if (name) params.set('name', name);
        // Always send description so it can be cleared.
        params.set('description', this._els.desc.value);
        this._els.save.disabled = true;
        this._els.status.textContent = 'Saving...';
        try {
            const r = await fetch(
                `api/domains/${encodeURIComponent(id)}?${params.toString()}`,
                { method: 'PATCH' },
            );
            if (!r.ok) {
                const detail = await r.text().catch(() => '');
                throw new Error(`HTTP ${r.status}: ${detail.slice(0, 200)}`);
            }
            this._dirty = false;
            this._els.status.textContent = 'Saved.';
            notify.info('Domain updated.');
            // Tell parent to refresh the registry + repaint left list + header.
            if (this._ctx.onDomainMutated) this._ctx.onDomainMutated();
        } catch (e) {
            this._els.save.disabled = false;
            this._els.status.textContent = '';
            this._ctx.showError(`Save failed: ${e.message}`);
        }
    }

    async _delete() {
        const d = this._ctx.domain;
        const ok = await modalConfirm(
            `Delete Domain "${d.name || d.domain_id}"? This drops its ChromaDB collections AND its ArcadeDB project. Source files in data/kb_sources/ stay on disk.`,
            { title: 'Delete Domain', confirmText: 'Delete', cancelText: 'Cancel' },
        );
        if (!ok) return;
        try {
            const r = await fetch(`api/domains/${encodeURIComponent(d.domain_id)}`, { method: 'DELETE' });
            if (!r.ok) {
                const detail = await r.text().catch(() => '');
                throw new Error(`HTTP ${r.status}: ${detail.slice(0, 200)}`);
            }
            notify.info(`Deleted Domain: ${d.domain_id}`);
            if (this._ctx.onDomainDeleted) this._ctx.onDomainDeleted();
        } catch (e) {
            this._ctx.showError(`Delete failed: ${e.message}`);
        }
    }
}
