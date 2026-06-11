/**
 * DomainDocumentsTab - per-Domain document table with upload + per-row
 * Rename / Set Category / Delete + bulk multi-delete.
 *
 * Endpoints:
 *   GET    /api/graph/research/{id}/corpus
 *   POST   /api/domains/{id}/documents             (upload, multipart/form-data)
 *   PATCH  /api/domains/{id}/documents/category    ?path=&category=
 *   PATCH  /api/domains/{id}/documents/display_name?path=&display_name=
 *   DELETE /api/domains/{id}/documents             ?path=
 */

import { modalConfirm, modalError, modalForm } from '../modal.js';
import { notify } from '../Notify.js';


const ACCEPTED_EXT = ['.md', '.pdf', '.docx', '.pptx', '.html', '.htm'];


function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
}


/** Normalise a hierarchical category path. Trims each segment, drops
 *  empty ones (so `a//b` -> `a/b`), rejects ".." segments. Returns the
 *  cleaned `a/b/c` string, the empty string if the input was blank, or
 *  null if the path is structurally invalid (a non-empty input that
 *  yielded no usable segments, or contained `..`). */
function _normaliseCategoryPath(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    const segments = s.split('/').map((p) => p.trim());
    const cleaned = [];
    for (const seg of segments) {
        if (!seg) continue;             // skip empty (handles "a//b", trailing /)
        if (seg === '..' || seg === '.') return null;
        cleaned.push(seg);
    }
    if (!cleaned.length) return null;
    return cleaned.join('/');
}


function fmtDate(iso) {
    if (!iso) return '-';
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return String(iso);
    }
}


export class DomainDocumentsTab {

    constructor(ctx) {
        this._ctx = ctx;
        this._els = {};
        this._docs = [];           // current list as fetched
        this._filter = '';         // search filter
        this._selected = new Set(); // paths selected via checkbox
    }

    mount() {
        const d = this._ctx.domain;
        if (!d.has_knowledge) {
            const root = document.createElement('div');
            root.className = 'dm-card dm-card-info';
            root.innerHTML = `<div class="dm-card-body">
                This Domain is capability-only (skills + tools). It cannot store documents.
            </div>`;
            this._ctx.container.appendChild(root);
            return;
        }

        const root = document.createElement('div');
        root.className = 'dm-documents';
        root.innerHTML = `
            <div class="dm-doc-toolbar">
                <button class="rm-btn dm-btn-primary" id="dm-doc-upload">
                    <i class="fa-solid fa-upload dm-i-upload"></i>
                    <span>Upload Document...</span>
                </button>
                <input type="search" id="dm-doc-search" class="dm-input dm-doc-search" placeholder="Filter by name or folder..." />
                <div class="dm-doc-bulk" id="dm-doc-bulk" style="display:none">
                    <span id="dm-doc-bulk-count">0 selected</span>
                    <button class="rm-btn dm-btn-danger" id="dm-doc-bulk-delete">
                        <i class="fa-solid fa-trash"></i>
                        <span>Delete selected</span>
                    </button>
                </div>
                <button class="rm-btn dm-doc-refresh" id="dm-doc-refresh" title="Refresh">
                    <i class="fa-solid fa-rotate dm-i-refresh"></i>
                </button>
            </div>

            <div class="dm-doc-table-wrap">
                <table class="dm-doc-table" id="dm-doc-table">
                    <thead>
                        <tr>
                            <th class="dm-doc-th-cb"><input type="checkbox" id="dm-doc-cb-all" /></th>
                            <th>Name</th>
                            <th>Folder</th>
                            <th>Mode</th>
                            <th>Added</th>
                            <th class="dm-doc-th-actions">Actions</th>
                        </tr>
                    </thead>
                    <tbody id="dm-doc-tbody"></tbody>
                </table>
                <div class="dm-doc-empty" id="dm-doc-empty" style="display:none">
                    No documents in this Domain. Click Upload to add the first one.
                </div>
            </div>
        `;
        this._ctx.container.appendChild(root);

        this._els.root        = root;
        this._els.upload      = root.querySelector('#dm-doc-upload');
        this._els.search      = root.querySelector('#dm-doc-search');
        this._els.bulk        = root.querySelector('#dm-doc-bulk');
        this._els.bulkCount   = root.querySelector('#dm-doc-bulk-count');
        this._els.bulkDelete  = root.querySelector('#dm-doc-bulk-delete');
        this._els.refresh     = root.querySelector('#dm-doc-refresh');
        this._els.tbody       = root.querySelector('#dm-doc-tbody');
        this._els.empty       = root.querySelector('#dm-doc-empty');
        this._els.cbAll       = root.querySelector('#dm-doc-cb-all');

        this._els.upload.addEventListener('click', () => this._upload());
        this._els.search.addEventListener('input', (ev) => {
            this._filter = ev.target.value.toLowerCase();
            this._renderTable();
        });
        this._els.refresh.addEventListener('click', () => this._fetchAndRender());
        this._els.bulkDelete.addEventListener('click', () => this._bulkDelete());
        this._els.cbAll.addEventListener('change', (ev) => {
            const checked = ev.target.checked;
            const visible = this._visibleDocs();
            for (const doc of visible) {
                if (checked) this._selected.add(doc.path);
                else this._selected.delete(doc.path);
            }
            this._renderTable();
        });

        this._fetchAndRender();
    }

    destroy() {
        this._els = {};
        this._docs = [];
        this._selected.clear();
    }

    // ── Data ────────────────────────────────────────────────────────

    async _fetchAndRender() {
        const id = this._ctx.domain.domain_id;
        try {
            const r = await fetch(
                `api/graph/research/${encodeURIComponent(id)}/corpus`,
                { cache: 'no-store' },
            );
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            this._docs = data.documents || [];
            this._renderTable();
        } catch (e) {
            this._ctx.showError(`Could not list documents: ${e.message}`);
        }
    }

    _visibleDocs() {
        const f = this._filter;
        if (!f) return this._docs;
        return this._docs.filter((d) => {
            const name = (d.display_name || d.basename || (d.path || '').split('/').pop() || '').toLowerCase();
            const cat = (d.category || '').toLowerCase();
            const path = (d.path || '').toLowerCase();
            return name.indexOf(f) !== -1 || cat.indexOf(f) !== -1 || path.indexOf(f) !== -1;
        });
    }

    _renderTable() {
        const tbody = this._els.tbody;
        tbody.innerHTML = '';

        const docs = this._visibleDocs();
        if (!docs.length) {
            this._els.empty.style.display = '';
            this._els.empty.textContent = this._docs.length
                ? 'No documents match the current filter.'
                : 'No documents in this Domain. Click Upload to add the first one.';
        } else {
            this._els.empty.style.display = 'none';
            for (const doc of docs) {
                tbody.appendChild(this._renderRow(doc));
            }
        }

        // Bulk-select header state
        const visible = docs;
        const allSelected = visible.length > 0 && visible.every((d) => this._selected.has(d.path));
        this._els.cbAll.checked = allSelected;
        this._els.cbAll.indeterminate = !allSelected && visible.some((d) => this._selected.has(d.path));

        this._refreshBulkBar();
    }

    _renderRow(doc) {
        const tr = document.createElement('tr');
        const path = doc.path || '';
        const filename = doc.basename || path.split('/').pop() || path;
        const display = doc.display_name || filename;
        const isSelected = this._selected.has(path);
        if (isSelected) tr.classList.add('is-selected');

        // Checkbox
        const tdCb = document.createElement('td');
        tdCb.className = 'dm-doc-td-cb';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = isSelected;
        cb.addEventListener('change', () => {
            if (cb.checked) this._selected.add(path);
            else this._selected.delete(path);
            tr.classList.toggle('is-selected', cb.checked);
            this._refreshBulkBar();
        });
        tdCb.appendChild(cb);
        tr.appendChild(tdCb);

        // Name + path
        const tdName = document.createElement('td');
        tdName.className = 'dm-doc-td-name';
        const nameDiv = document.createElement('div');
        nameDiv.className = 'dm-doc-name';
        nameDiv.textContent = display;
        if (doc.exists === false) {
            const missing = document.createElement('span');
            missing.className = 'dm-doc-missing';
            missing.title = 'File missing on disk';
            missing.innerHTML = ' <i class="fa-solid fa-file-circle-exclamation dm-i-warn"></i>';
            nameDiv.appendChild(missing);
        }
        tdName.appendChild(nameDiv);
        const sub = document.createElement('div');
        sub.className = 'dm-doc-path';
        sub.textContent = path;
        tdName.appendChild(sub);
        tr.appendChild(tdName);

        // Category
        const tdCat = document.createElement('td');
        tdCat.textContent = doc.category || '-';
        tr.appendChild(tdCat);

        // Mode
        const tdMode = document.createElement('td');
        const modeBadge = document.createElement('span');
        modeBadge.className = 'dm-doc-mode dm-doc-mode-' + (doc.mode || 'read_store');
        modeBadge.textContent = doc.mode === 'read_only' ? 'read-only' : 'read & store';
        tdMode.appendChild(modeBadge);
        tr.appendChild(tdMode);

        // Added at
        const tdAdded = document.createElement('td');
        tdAdded.className = 'dm-mono';
        tdAdded.textContent = fmtDate(doc.added_at);
        tr.appendChild(tdAdded);

        // Actions - icons match the Explorer context-menu canonical set
        // (fa-pen-to-square for Rename, fa-tag for Set Category, fa-trash
        // for Delete) with the same colour palette.
        const tdAct = document.createElement('td');
        tdAct.className = 'dm-doc-td-actions';
        tdAct.appendChild(this._iconBtn('fa-pen-to-square', 'Rename', () => this._rename(doc), { iconClass: 'dm-i-edit' }));
        tdAct.appendChild(this._iconBtn('fa-tag', 'Set Folder', () => this._setCategory(doc), { iconClass: 'dm-i-tag' }));
        tdAct.appendChild(this._iconBtn('fa-trash', 'Delete', () => this._deleteOne(doc), { btnClass: 'dm-icon-btn-danger', iconClass: 'dm-i-delete' }));
        tr.appendChild(tdAct);

        return tr;
    }

    _iconBtn(icon, title, handler, opts = {}) {
        const btn = document.createElement('button');
        btn.className = 'dm-icon-btn ' + (opts.btnClass || '');
        btn.title = title;
        btn.innerHTML = `<i class="fa-solid ${icon} ${opts.iconClass || ''}"></i>`;
        btn.addEventListener('click', handler);
        return btn;
    }

    _refreshBulkBar() {
        const n = this._selected.size;
        if (n > 0) {
            this._els.bulk.style.display = '';
            this._els.bulkCount.textContent = `${n} selected`;
        } else {
            this._els.bulk.style.display = 'none';
        }
    }

    // ── Actions ─────────────────────────────────────────────────────

    /** Fetch the chunking-profile catalog from the noted backend
     *  (which proxies noted-rag). Cached on `this` after the first
     *  call. Returns {default_profile, profiles[]} or a soft-fallback
     *  {default_profile: '', profiles: []} when noted-rag is
     *  unreachable — caller skips the dropdown in that case so the
     *  upload still works against the server-side default profile. */
    async _loadChunkingProfiles() {
        if (this._chunkingProfilesCache) return this._chunkingProfilesCache;
        try {
            const r = await fetch('api/rag/chunking-profiles');
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            this._chunkingProfilesCache = {
                default_profile: data.default_profile || '',
                profiles: Array.isArray(data.profiles) ? data.profiles : [],
            };
        } catch (e) {
            console.warn('[DomainDocumentsTab] chunking-profiles fetch failed:', e);
            this._chunkingProfilesCache = { default_profile: '', profiles: [] };
        }
        return this._chunkingProfilesCache;
    }

    async _upload() {
        const d = this._ctx.domain;
        const profiles = await this._loadChunkingProfiles();
        const profileOptions = (profiles.profiles || []).map(p => ({
            value: p.id, label: p.name,
        }));
        const profileDefault = profiles.default_profile || '';
        const fields = [
            { key: 'mode', label: 'Mode', type: 'select',
              options: [
                  { value: 'read_store', label: 'Read & Store (visible + indexed in vector + graph)' },
                  { value: 'read_only',  label: 'Read-only (visible, NOT indexed in vector or graph)' },
              ],
              defaultValue: 'read_store' },
        ];
        // Only show the profile dropdown if the proxy returned a non-empty
        // catalog. If noted-rag is unreachable or the file is empty, fall
        // back silently to the default (no UI element shown).
        if (profileOptions.length) {
            fields.push({
                key: 'chunking_profile', label: 'Chunking profile (vector index only)',
                type: 'select', options: profileOptions, defaultValue: profileDefault,
            });
        }
        fields.push(
            { key: 'category', label: 'Folder (optional, e.g. Manuals/Technical)',
              placeholder: 'e.g. Manuals/Technical or Reports', required: false },
            { key: 'file', label: `Document file(s) - hold Ctrl/Cmd to pick several (${ACCEPTED_EXT.join(', ')})`,
              type: 'file', accept: ACCEPTED_EXT.join(','), multiple: true },
        );
        const result = await modalForm(fields,
            { title: `Upload to ${d.name || d.domain_id}`, confirmText: 'Upload' });
        if (!result || !result.file) return;
        const files = Array.isArray(result.file) ? result.file : [result.file];
        if (!files.length) return;
        for (const f of files) {
            const ext = ('.' + (f.name.split('.').pop() || '')).toLowerCase();
            if (!ACCEPTED_EXT.includes(ext)) {
                modalError(`"${f.name}": unsupported extension ${ext}. Accepted: ${ACCEPTED_EXT.join(', ')}`);
                return;
            }
        }
        const mode = result.mode === 'read_only' ? 'read_only' : 'read_store';
        const category = (result.category || '').trim();
        const chunkingProfile = (result.chunking_profile || '').trim();
        const total = files.length;
        if (total > 1) notify.info(`Uploading ${total} files to ${d.domain_id}...`);
        let succeeded = 0;
        let failed = 0;
        for (const f of files) {
            try {
                const fd = new FormData();
                fd.append('file', f);
                const url = `api/domains/${encodeURIComponent(d.domain_id)}/documents?mode=${encodeURIComponent(mode)}` +
                            (category ? `&category=${encodeURIComponent(category)}` : '') +
                            (chunkingProfile ? `&chunking_profile=${encodeURIComponent(chunkingProfile)}` : '');
                const r = await fetch(url, { method: 'POST', body: fd });
                if (!r.ok) {
                    const err = await r.json().catch(() => ({}));
                    throw new Error(err.detail || `HTTP ${r.status}`);
                }
                succeeded++;
                if (total === 1) notify.success(`"${f.name}" added to ${d.domain_id}.`);
            } catch (e) {
                failed++;
                notify.error(`"${f.name}" upload failed: ${e.message}`);
            }
        }
        if (total > 1) {
            const tone = failed === 0 ? 'success' : (succeeded === 0 ? 'error' : 'warning');
            notify[tone](`${succeeded}/${total} files queued${failed ? ` (${failed} failed)` : ''}.`);
        }
        await this._fetchAndRender();
    }

    async _rename(doc) {
        const filename = doc.basename || (doc.path || '').split('/').pop() || doc.path;
        const result = await modalForm(
            [
                { key: 'display_name', label: 'Display name (empty = use filename)',
                  defaultValue: doc.display_name || '',
                  placeholder: filename,
                  required: false },
            ],
            { title: `Rename: ${filename}`, confirmText: 'Save' },
        );
        if (!result) return;
        const name = (result.display_name || '').trim();
        const id = this._ctx.domain.domain_id;
        const params = new URLSearchParams({ path: doc.path, display_name: name });
        try {
            const r = await fetch(
                `api/domains/${encodeURIComponent(id)}/documents/display_name?${params.toString()}`,
                { method: 'PATCH' },
            );
            if (!r.ok) {
                const detail = await r.text().catch(() => '');
                throw new Error(`HTTP ${r.status}: ${detail.slice(0, 200)}`);
            }
            notify.success(name ? `Renamed to "${name}"` : 'Display name cleared');
            await this._fetchAndRender();
        } catch (e) {
            this._ctx.showError(`Rename failed: ${e.message}`);
        }
    }

    async _setCategory(doc) {
        const filename = doc.basename || (doc.path || '').split('/').pop() || doc.path;
        const result = await modalForm(
            [
                { key: 'category', label: 'Folder path (use / for nested folders, e.g. Manuals/Technical/noted; empty = unfiled)',
                  defaultValue: doc.category || '',
                  placeholder: 'e.g. Manuals/Technical or Reports',
                  required: false },
            ],
            { title: `Set Folder: ${filename}`, confirmText: 'Save' },
        );
        if (!result) return;
        const cat = _normaliseCategoryPath(result.category);
        if (cat === null) {
            modalError('Invalid folder path. Use letters/numbers and "/" between segments; no empty segments, no leading/trailing slashes, no "..".');
            return;
        }
        const id = this._ctx.domain.domain_id;
        const params = new URLSearchParams({ path: doc.path, category: cat });
        try {
            const r = await fetch(
                `api/domains/${encodeURIComponent(id)}/documents/category?${params.toString()}`,
                { method: 'PATCH' },
            );
            if (!r.ok) {
                const detail = await r.text().catch(() => '');
                throw new Error(`HTTP ${r.status}: ${detail.slice(0, 200)}`);
            }
            notify.success(`Folder set to ${cat || '(unfiled)'}`);
            await this._fetchAndRender();
        } catch (e) {
            this._ctx.showError(`Update failed: ${e.message}`);
        }
    }

    async _deleteOne(doc) {
        const filename = doc.basename || (doc.path || '').split('/').pop() || doc.path;
        const note = doc.uploaded
            ? ' The uploaded file will be DELETED from disk.'
            : ' The file on disk is left alone (canonical doc).';
        const ok = await modalConfirm(
            `Remove "${filename}" from this Domain?${note}`,
            { title: 'Delete Document', confirmText: 'Delete' },
        );
        if (!ok) return;
        await this._deleteByPath([doc.path]);
    }

    async _bulkDelete() {
        const paths = Array.from(this._selected);
        if (!paths.length) return;
        const ok = await modalConfirm(
            `Remove ${paths.length} document(s) from this Domain? Uploaded files will be DELETED from disk; canonical files are left alone.`,
            { title: 'Delete Documents', confirmText: 'Delete' },
        );
        if (!ok) return;
        await this._deleteByPath(paths);
    }

    async _deleteByPath(paths) {
        const id = this._ctx.domain.domain_id;
        let succeeded = 0;
        let failed = 0;
        for (const p of paths) {
            try {
                const url = `api/domains/${encodeURIComponent(id)}/documents?path=${encodeURIComponent(p)}`;
                const r = await fetch(url, { method: 'DELETE' });
                if (!r.ok) {
                    const err = await r.json().catch(() => ({}));
                    throw new Error(err.detail || `HTTP ${r.status}`);
                }
                this._selected.delete(p);
                succeeded++;
            } catch (e) {
                failed++;
                notify.error(`Delete "${p}" failed: ${e.message}`);
            }
        }
        if (succeeded > 0) {
            const tone = failed === 0 ? 'success' : 'warning';
            notify[tone](`Removed ${succeeded} document(s)${failed ? ` (${failed} failed)` : ''}.`);
        }
        await this._fetchAndRender();
    }
}
