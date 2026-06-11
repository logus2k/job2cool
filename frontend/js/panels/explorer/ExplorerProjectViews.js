/**
 * ExplorerProjectViews - Projects, Mounts, and generic file/dir detail views.
 */

import { notify } from '../../Notify.js';
import { modalConfirm, modalError } from '../../modal.js';
import {
    iconPathForFile, iconPath, isTextEditable, isMediaViewable,
    FOLDER_ICON, FOLDER_OPEN_ICON, FILE_ICON,
} from '../../file-icons.js';
import {
    createDetailHeader, createEditableHeader, addParentLabel, addMetaRow,
    escapeHtml, formatSize, clearActionBar, createActionBar,
} from './ExplorerHelpers.js';

/**
 * @param {object} ctx - Shared explorer context (getters for live state).
 * @returns {object} View methods for projects, mounts, files, dirs.
 */
async function buildVenvSection(projectId, onDefaultChanged) {
    const section = document.createElement('div');
    section.className = 'explorer-create-form';
    section.style.marginTop = '8px';

    const label = document.createElement('label');
    label.textContent = 'Default Environment';
    section.appendChild(label);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center';

    const select = document.createElement('select');
    select.style.cssText = 'flex:1;padding:4px 8px;font-size:12px;border:1px solid #ddd;border-radius:3px;font-family:var(--font-sans)';

    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '-- None --';
    select.appendChild(noneOpt);

    let currentDefault = null;
    try {
        const [settingsResp, envsResp] = await Promise.all([
            fetch(`api/projects/${encodeURIComponent(projectId)}/settings`),
            fetch('api/venvs'),
        ]);
        const settings = settingsResp.ok ? await settingsResp.json() : {};
        const envs = envsResp.ok ? await envsResp.json() : [];
        currentDefault = settings.default_venv?.name || '';

        for (const env of envs) {
            const opt = document.createElement('option');
            opt.value = env.name;
            opt.textContent = `${env.name} (Python ${env.python_version || '?'})`;
            opt.dataset.runtimeId = env.runtime_id || 'python/3.12';
            if (env.name === currentDefault) opt.selected = true;
            select.appendChild(opt);
        }
    } catch { /* ignore */ }

    select.addEventListener('change', async () => {
        const name = select.value;
        const selectedOpt = select.options[select.selectedIndex];
        const update = name
            ? { default_venv: { name, runtime_id: selectedOpt.dataset.runtimeId || 'python/3.12' } }
            : { default_venv: null };
        try {
            await fetch(`api/projects/${encodeURIComponent(projectId)}/settings`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(update),
            });
            notify.success(name ? `Default environment set to ${name}` : 'Default environment cleared');
            if (onDefaultChanged) onDefaultChanged(projectId, name ? { name, runtime_id: selectedOpt.dataset.runtimeId } : null);
        } catch {
            notify.error('Failed to update settings');
        }
    });

    row.appendChild(select);
    section.appendChild(row);
    return section;
}

export function createProjectViews(ctx) {

    // ── Projects Root ───────────────────────────────────────────────

    function showProjectsRootDetail() {
        ctx.detailEl.innerHTML = '';
        

        const header = createDetailHeader('Projects', 'fa-solid fa-folder');
        ctx.detailEl.appendChild(header);

        const form = document.createElement('div');
        form.className = 'explorer-create-form';

        const label = document.createElement('label');
        label.textContent = 'New Project';
        form.appendChild(label);

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'Project name';
        form.appendChild(nameInput);

        const errorEl = document.createElement('div');
        errorEl.className = 'explorer-form-error';
        form.appendChild(errorEl);

        const createBtn = document.createElement('button');
        createBtn.className = 'explorer-btn primary';
        createBtn.textContent = 'Create Project';
        createBtn.addEventListener('click', () => createProject(nameInput, createBtn, errorEl));
        form.appendChild(createBtn);

        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') createBtn.click();
        });

        ctx.detailEl.appendChild(form);

        // Clone from GitHub
        const cloneForm = document.createElement('div');
        cloneForm.className = 'explorer-create-form';
        cloneForm.style.marginTop = '16px';

        const cloneLabel = document.createElement('label');
        cloneLabel.textContent = 'Clone from GitHub';
        cloneForm.appendChild(cloneLabel);

        const cloneUrlInput = document.createElement('input');
        cloneUrlInput.type = 'text';
        cloneUrlInput.placeholder = 'https://github.com/user/repo.git';
        cloneUrlInput.spellcheck = false;
        cloneForm.appendChild(cloneUrlInput);

        const cloneNameInput = document.createElement('input');
        cloneNameInput.type = 'text';
        cloneNameInput.placeholder = 'Project name (optional)';
        cloneNameInput.spellcheck = false;
        cloneForm.appendChild(cloneNameInput);

        const clonePatInput = document.createElement('input');
        clonePatInput.type = 'password';
        clonePatInput.placeholder = 'PAT (optional, for private repos)';
        clonePatInput.spellcheck = false;
        clonePatInput.autocomplete = 'off';
        cloneForm.appendChild(clonePatInput);

        const cloneErrorEl = document.createElement('div');
        cloneErrorEl.className = 'explorer-form-error';
        cloneForm.appendChild(cloneErrorEl);

        const cloneBtn = document.createElement('button');
        cloneBtn.className = 'explorer-btn primary';
        cloneBtn.textContent = 'Clone Repository';
        cloneBtn.addEventListener('click', () =>
            cloneRepo(cloneUrlInput, cloneNameInput, clonePatInput, cloneBtn, cloneErrorEl));
        cloneForm.appendChild(cloneBtn);

        cloneUrlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') cloneBtn.click();
        });

        ctx.detailEl.appendChild(cloneForm);
        nameInput.focus();
    }

    async function cloneRepo(urlInput, nameInput, patInput, btn, errorEl) {
        const url = urlInput.value.trim();
        if (!url) { errorEl.textContent = 'Repository URL is required'; return; }

        // Derive project name from URL if not provided
        let projectId = nameInput.value.trim();
        if (!projectId) {
            const match = url.match(/\/([^\/]+?)(?:\.git)?$/);
            projectId = match ? match[1] : '';
        }
        if (!projectId) { errorEl.textContent = 'Could not determine project name'; return; }

        errorEl.textContent = '';
        btn.disabled = true;
        btn.textContent = 'Cloning\u2026';

        try {
            const res = await fetch('api/git/clone', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url,
                    project_id: projectId,
                    pat: patInput.value.trim() || null,
                }),
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || res.statusText);
            }
            urlInput.value = '';
            nameInput.value = '';
            patInput.value = '';
            btn.textContent = 'Cloned!';
            setTimeout(() => { btn.textContent = 'Clone Repository'; btn.disabled = false; }, 1500);
            ctx.loadTree();
        } catch (e) {
            errorEl.textContent = e.message;
            btn.textContent = 'Clone Repository';
            btn.disabled = false;
        }
    }

    // ── Mounts ──────────────────────────────────────────────────────

    function showMountsRootDetail() {
        ctx.detailEl.innerHTML = '';
        

        const header = createDetailHeader('Mounts', 'fa-solid fa-hard-drive');
        ctx.detailEl.appendChild(header);

        const form = document.createElement('div');
        form.className = 'explorer-create-form';

        const label = document.createElement('label');
        label.textContent = 'Add Mount';
        form.appendChild(label);

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'Mount name (e.g. my-data)';
        nameInput.spellcheck = false;
        form.appendChild(nameInput);

        const pathInput = document.createElement('input');
        pathInput.type = 'text';
        pathInput.placeholder = 'Host path (e.g. /home/user/datasets)';
        pathInput.spellcheck = false;
        form.appendChild(pathInput);

        const errorEl = document.createElement('div');
        errorEl.className = 'explorer-form-error';
        form.appendChild(errorEl);

        const infoEl = document.createElement('div');
        infoEl.className = 'explorer-form-info';
        infoEl.textContent = 'After adding, update docker-compose.yml and restart the container.';
        form.appendChild(infoEl);

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex; gap:8px; align-items:center;';

        const addBtn = document.createElement('button');
        addBtn.className = 'explorer-btn primary';
        addBtn.textContent = 'Add Mount';
        addBtn.addEventListener('click', () => addMount(nameInput, pathInput, addBtn, errorEl));
        btnRow.appendChild(addBtn);

        form.appendChild(btnRow);
        ctx.detailEl.appendChild(form);

        // Show current mounts config
        showMountsConfig();
    }

    async function showMountsConfig() {
        try {
            const resp = await fetch('api/files/mounts/config');
            if (!resp.ok) return;
            const data = await resp.json();
            const mounts = data.mounts || [];
            if (mounts.length === 0) return;

            const section = document.createElement('div');
            section.className = 'explorer-create-form';
            section.style.marginTop = '12px';

            const label = document.createElement('label');
            label.textContent = 'Configured Mounts';
            section.appendChild(label);

            for (const m of mounts) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:4px 0; font-size:12px;';

                const info = document.createElement('span');
                info.style.cssText = 'flex:1; font-family:var(--font-mono); font-size:11px;';
                info.textContent = `${m.name} \u2192 ${m.host_path}`;
                row.appendChild(info);

                const removeBtn = document.createElement('button');
                removeBtn.className = 'explorer-btn danger';
                removeBtn.textContent = 'Remove';
                removeBtn.style.fontSize = '10px';
                removeBtn.style.padding = '2px 6px';
                removeBtn.addEventListener('click', async () => {
                    if (!await modalConfirm(`Remove mount "${m.name}"?`)) return;
                    try {
                        const resp = await fetch('api/files/mounts/config', {
                            method: 'DELETE',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: m.name }),
                        });
                        if (!resp.ok) {
                            const err = await resp.json();
                            throw new Error(err.detail || 'Failed to remove mount');
                        }
                        showMountsRootDetail();
                    } catch (err) {
                        modalError(err.message);
                    }
                });
                row.appendChild(removeBtn);

                section.appendChild(row);
            }

            ctx.detailEl.appendChild(section);
        } catch { /* ignore */ }
    }

    async function addMount(nameInput, pathInput, btn, errorEl) {
        const name = nameInput.value.trim();
        const hostPath = pathInput.value.trim();
        if (!name) { errorEl.textContent = 'Mount name is required'; return; }
        if (!hostPath) { errorEl.textContent = 'Host path is required'; return; }

        errorEl.textContent = '';
        btn.disabled = true;
        btn.textContent = 'Adding...';

        try {
            const resp = await fetch('api/files/mounts/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, host_path: hostPath }),
            });
            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.detail || 'Failed to add mount');
            }
            nameInput.value = '';
            pathInput.value = '';
            // Refresh the mounts detail
            showMountsRootDetail();
            notify.success(`Mount "${name}" added. Update docker-compose.yml and restart the container.`);
        } catch (err) {
            errorEl.textContent = err.message;
        } finally {
            btn.disabled = false;
            btn.textContent = 'Add Mount';
        }
    }

    function showMountDetail(mountName) {
        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, 'Mounts');

        const header = createDetailHeader(mountName, 'fa-solid fa-hard-drive');
        ctx.detailEl.appendChild(header);

        const form = document.createElement('div');
        form.className = 'explorer-create-form';

        const label = document.createElement('label');
        label.textContent = 'New File or Folder';
        form.appendChild(label);

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'Name (e.g. train.ipynb, utils.py, data/)';
        nameInput.spellcheck = false;
        form.appendChild(nameInput);

        const errorEl = document.createElement('div');
        errorEl.className = 'explorer-form-error';
        form.appendChild(errorEl);

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex; gap:8px; align-items:center;';

        const createFileBtn = document.createElement('button');
        createFileBtn.className = 'explorer-btn primary';
        createFileBtn.textContent = 'Create File';
        createFileBtn.addEventListener('click', () =>
            createFileOrDir('mount', mountName, '', nameInput, false, errorEl));
        btnRow.appendChild(createFileBtn);

        const createDirBtn = document.createElement('button');
        createDirBtn.className = 'explorer-btn primary';
        createDirBtn.textContent = 'Create Folder';
        createDirBtn.addEventListener('click', () =>
            createFileOrDir('mount', mountName, '', nameInput, true, errorEl));
        btnRow.appendChild(createDirBtn);

        const importBtn = document.createElement('button');
        importBtn.className = 'explorer-btn primary';
        importBtn.textContent = 'Import Notebook';
        importBtn.addEventListener('click', () => importNotebook(mountName, errorEl));
        btnRow.appendChild(importBtn);

        form.appendChild(btnRow);

        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') createFileBtn.click();
        });

        ctx.detailEl.appendChild(form);

        // Default Environment section
        buildVenvSection(mountName, ctx.callbacks.onProjectDefaultVenvChanged).then(section => {
            ctx.detailEl.appendChild(section);
        });

        nameInput.focus();
    }

    // ── Generic file/dir detail views ───────────────────────────────

    function showDirDetail(rootType, rootName, relPath) {
        ctx.detailEl.innerHTML = '';
        const parentLabel = rootType === 'project' ? rootName : `Mounts / ${rootName}`;
        addParentLabel(ctx.detailEl, parentLabel);

        const dirName = relPath.split('/').pop();
        const header = createDetailHeader(dirName, FOLDER_ICON);
        ctx.detailEl.appendChild(header);

        // Create file/folder form
        const form = document.createElement('div');
        form.className = 'explorer-create-form';

        const label = document.createElement('label');
        label.textContent = 'New File or Folder';
        form.appendChild(label);

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'Name (add / suffix for folder)';
        nameInput.spellcheck = false;
        form.appendChild(nameInput);

        const errorEl = document.createElement('div');
        errorEl.className = 'explorer-form-error';
        form.appendChild(errorEl);

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex; gap:8px;';

        const createFileBtn = document.createElement('button');
        createFileBtn.className = 'explorer-btn primary';
        createFileBtn.textContent = 'Create File';
        createFileBtn.addEventListener('click', () =>
            createFileOrDir(rootType, rootName, relPath, nameInput, false, errorEl));
        btnRow.appendChild(createFileBtn);

        const createDirBtn = document.createElement('button');
        createDirBtn.className = 'explorer-btn primary';
        createDirBtn.textContent = 'Create Folder';
        createDirBtn.addEventListener('click', () =>
            createFileOrDir(rootType, rootName, relPath, nameInput, true, errorEl));
        btnRow.appendChild(createDirBtn);

        form.appendChild(btnRow);
        ctx.detailEl.appendChild(form);

        // Delete folder button
        const dangerRow = document.createElement('div');
        dangerRow.className = 'explorer-detail-actions';
        dangerRow.style.marginTop = '12px';

        const delBtn = document.createElement('button');
        delBtn.className = 'explorer-btn danger';
        delBtn.textContent = 'Delete Folder';
        delBtn.style.marginLeft = 'auto';
        delBtn.addEventListener('click', async () => {
            if (!await modalConfirm(`Delete folder "${dirName}" and all its contents?`)) return;
            try {
                const resp = await fetch(
                    `api/files/${rootType}/${encodeURIComponent(rootName)}?path=${encodeURIComponent(relPath)}`,
                    { method: 'DELETE' }
                );
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(err.detail || 'Failed to delete');
                }
                const prefix = rootType === 'project' ? 'p' : 'm';
                const node = ctx.tree.findKey(`${prefix}dir:${rootName}:${relPath}`);
                if (node) node.remove();
                ctx.showWelcomeDetail();
            } catch (err) {
                modalError(err.message);
            }
        });
        dangerRow.appendChild(delBtn);
        ctx.detailEl.appendChild(dangerRow);
    }

    async function showDvcFileDetail(rootType, rootName, relPath) {
        ctx.detailEl.innerHTML = '';
        const parentLabel = rootType === 'project' ? rootName : `Mounts / ${rootName}`;
        addParentLabel(ctx.detailEl, parentLabel);

        const fileName = relPath.split('/').pop();
        const dataFileName = fileName.replace(/\.dvc$/, '');

        const header = createDetailHeader(dataFileName, 'fa-solid fa-database');
        ctx.detailEl.appendChild(header);


        const repoPath = rootType === 'mount'
            ? `/app/mounts/${rootName}`
            : `/app/data/projects/${rootName}`;

        try {
            const res = await fetch('api/dvc/file-history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repo_path: repoPath, dvc_file: relPath }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed to fetch version history');
            }
            const data = await res.json();
            const versions = data.versions || [];

            if (versions.length === 0) {
                const empty = document.createElement('div');
                empty.style.cssText = 'color: var(--text-secondary); font-size: 12px; padding: 8px 0;';
                empty.textContent = 'No version history found.';
                ctx.detailEl.appendChild(empty);
                return;
            }

            // Read current .dvc file md5 to identify the active version
            let currentMd5 = null;
            try {
                const catRes = await fetch(`api/files/${rootType}/${encodeURIComponent(rootName)}/read?path=${encodeURIComponent(relPath)}`);
                if (catRes.ok) {
                    const catData = await catRes.json();
                    const content = catData.content || '';
                    const match = content.match(/md5:\s*([a-f0-9]+)/);
                    if (match) currentMd5 = match[1];
                }
            } catch { /* ignore */ }

            const title = document.createElement('div');
            title.className = 's3-meta-section-title';
            title.textContent = 'Version History';
            ctx.detailEl.appendChild(title);

            const list = document.createElement('div');
            list.className = 'dvc-version-list';

            for (let i = 0; i < versions.length; i++) {
                const v = versions[i];
                const isCurrent = currentMd5 ? v.md5 === currentMd5 : i === 0;

                const row = document.createElement('div');
                row.className = 'dvc-version-row';

                const topLine = document.createElement('div');
                topLine.style.cssText = 'display:flex;align-items:center;gap:8px';

                const commitLine = document.createElement('div');
                commitLine.className = 'dvc-version-commit';
                commitLine.style.flex = '1';
                commitLine.innerHTML = `<span class="dvc-version-hash">${v.short_hash}</span> ${escapeHtml(v.message)}`;
                topLine.appendChild(commitLine);

                if (isCurrent) {
                    const badge = document.createElement('span');
                    badge.className = 'dvc-version-current';
                    badge.textContent = 'Current';
                    topLine.appendChild(badge);
                } else {
                    const checkoutBtn = document.createElement('button');
                    checkoutBtn.className = 'explorer-btn small';
                    checkoutBtn.innerHTML = '<i class="fa-solid fa-clock-rotate-left"></i> Checkout';
                    checkoutBtn.addEventListener('click', async () => {
                        const confirmed = await modalConfirm(
                            `Switch ${dataFileName} to version from ${v.short_hash}?`,
                            `This will replace the current data file with the version from "${v.message}" (${v.date_relative}). The .dvc pointer will appear as modified in git.`
                        );
                        if (!confirmed) return;
                        checkoutBtn.disabled = true;
                        checkoutBtn.textContent = 'Switching...';
                        try {
                            const res = await fetch('api/dvc/checkout-version', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    repo_path: repoPath,
                                    dvc_file: relPath,
                                    commit_hash: v.commit_hash,
                                }),
                            });
                            if (!res.ok) {
                                const err = await res.json().catch(() => ({}));
                                throw new Error(err.detail || 'Checkout failed');
                            }
                            const result = await res.json();
                            const msg = result.pulled
                                ? `Switched to ${v.short_hash} (pulled from remote)`
                                : `Switched to ${v.short_hash}`;
                            notify.success(msg);
                            // Re-render to update current badge
                            showDvcFileDetail(rootType, rootName, relPath);
                            // Refresh decorations
                            if (ctx.decorationService) ctx.decorationService.refresh();
                        } catch (err) {
                            notify.error(err.message);
                            checkoutBtn.disabled = false;
                            checkoutBtn.innerHTML = '<i class="fa-solid fa-clock-rotate-left"></i> Checkout';
                        }
                    });
                    topLine.appendChild(checkoutBtn);
                }
                row.appendChild(topLine);

                const metaLine = document.createElement('div');
                metaLine.className = 'dvc-version-meta';
                const parts = [];
                if (v.size) parts.push(formatSize(v.size));
                if (v.md5) parts.push(`md5: ${v.md5.substring(0, 8)}\u2026`);
                parts.push(v.date_relative);
                parts.push(v.author);
                metaLine.textContent = parts.join(' \u00b7 ');
                row.appendChild(metaLine);

                list.appendChild(row);
            }
            ctx.detailEl.appendChild(list);
        } catch (err) {
            const errEl = document.createElement('div');
            errEl.style.cssText = 'color: var(--danger); font-size: 12px; padding: 8px 0;';
            errEl.textContent = err.message;
            ctx.detailEl.appendChild(errEl);
        }
    }

    async function showFileDetail(rootType, rootName, relPath) {
        ctx.detailEl.innerHTML = '';
        const parentLabel = rootType === 'project' ? rootName : `Mounts / ${rootName}`;
        addParentLabel(ctx.detailEl, parentLabel);

        const fileName = relPath.split('/').pop();
        const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';

        const header = createDetailHeader(fileName, iconPathForFile(fileName));
        ctx.detailEl.appendChild(header);

        const actions = document.createElement('div');
        actions.className = 'explorer-detail-actions';

        // Open button for notebooks and source files
        if (ext === 'ipynb') {
            const openBtn = document.createElement('button');
            openBtn.className = 'explorer-btn primary';
            openBtn.textContent = 'Open Notebook';
            openBtn.addEventListener('click', () => {
                if (ctx.callbacks.onNotebookSelect) {
                    const projectId = rootName;
                    ctx.callbacks.onNotebookSelect(projectId, relPath);
                }
            });
            actions.appendChild(openBtn);
        } else if (isTextEditable(fileName)) {
            const openBtn = document.createElement('button');
            openBtn.className = 'explorer-btn primary';
            openBtn.textContent = 'Open File';
            openBtn.addEventListener('click', () => {
                if (ctx.callbacks.onSrcFileSelect) {
                    const projectId = rootName;
                    ctx.callbacks.onSrcFileSelect(projectId, relPath);
                }
            });
            actions.appendChild(openBtn);
        } else if (isMediaViewable(fileName)) {
            const openBtn = document.createElement('button');
            openBtn.className = 'explorer-btn primary';
            openBtn.textContent = 'Open File';
            openBtn.addEventListener('click', () => {
                if (ctx.callbacks.onMediaFileSelect) {
                    const projectId = rootName;
                    const hostPath = rootType === 'mount' ? ctx.mountHostPaths[rootName] : undefined;
                    ctx.callbacks.onMediaFileSelect(projectId, relPath, hostPath);
                }
            });
            actions.appendChild(openBtn);
        }

        // Delete button
        const delBtn = document.createElement('button');
        delBtn.className = 'explorer-btn danger';
        delBtn.textContent = 'Delete';
        delBtn.style.marginLeft = 'auto';
        delBtn.addEventListener('click', async () => {
            if (!await modalConfirm(`Delete "${fileName}"?`)) return;
            try {
                const resp = await fetch(
                    `api/files/${rootType}/${encodeURIComponent(rootName)}?path=${encodeURIComponent(relPath)}`,
                    { method: 'DELETE' }
                );
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(err.detail || 'Failed to delete');
                }
                const prefix = rootType === 'project' ? 'p' : 'm';
                const node = ctx.tree.findKey(`${prefix}file:${rootName}:${relPath}`);
                if (node) node.remove();
                ctx.showWelcomeDetail();
            } catch (err) {
                modalError(err.message);
            }
        });
        actions.appendChild(delBtn);
        ctx.detailEl.appendChild(actions);

        // File info
        try {
            const resp = await fetch(
                `api/files/${rootType}/${encodeURIComponent(rootName)}/read?path=${encodeURIComponent(relPath)}`
            );
            if (!resp.ok) return;
            const fileData = await resp.json();

            const infoGrid = document.createElement('div');
            infoGrid.className = 'explorer-nb-info';

            const rows = [];
            if (fileData.size != null) {
                const kb = (fileData.size / 1024).toFixed(1);
                rows.push(['Size', `${kb} KB`]);
            }
            if (fileData.modified) {
                const date = new Date(fileData.modified * 1000);
                rows.push(['Modified', date.toLocaleString()]);
            }
            if (fileData.encoding) {
                rows.push(['Type', fileData.encoding === 'notebook' ? 'Jupyter Notebook'
                    : fileData.encoding === 'base64' ? (fileData.mime || 'Binary')
                    : 'Text']);
            }

            for (const [label, value] of rows) {
                const row = document.createElement('div');
                row.className = 'explorer-nb-info-row';
                row.innerHTML = `<span class="explorer-nb-info-label">${label}</span><span class="explorer-nb-info-value">${value}</span>`;
                infoGrid.appendChild(row);
            }
            ctx.detailEl.appendChild(infoGrid);
        } catch { /* optional info */ }
    }

    async function createFileOrDir(rootType, rootName, parentPath, nameInput, isDir, errorEl) {
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        errorEl.textContent = '';

        const relPath = parentPath ? `${parentPath}/${name}` : name;
        try {
            const resp = await fetch(`api/files/${rootType}/${encodeURIComponent(rootName)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: relPath, is_dir: isDir }),
            });
            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.detail || 'Failed to create');
            }
            nameInput.value = '';
            // Refresh the parent directory in the tree
            const prefix = rootType === 'project' ? 'p' : 'm';
            const parentKey = parentPath
                ? `${prefix}dir:${rootName}:${parentPath}`
                : (rootType === 'project' ? `project:${rootName}` : `mount:${rootName}`);
            const parentNode = ctx.tree.findKey(parentKey);
            if (parentNode) {
                parentNode.resetLazy();
                await parentNode.setExpanded(true);
            }
        } catch (err) {
            errorEl.textContent = err.message;
        }
    }

    // ── Project Detail ──────────────────────────────────────────────

    function showProjectDetail(projectId) {
        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, 'Projects');

        const header = createEditableHeader(projectId, 'fa-solid fa-folder-open', async (newName) => {
            return renameProject(projectId, newName);
        });
        ctx.detailEl.appendChild(header);

        const form = document.createElement('div');
        form.className = 'explorer-create-form';

        const label = document.createElement('label');
        label.textContent = 'New File or Folder';
        form.appendChild(label);

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'Name (e.g. train.ipynb, utils.py, data/)';
        nameInput.spellcheck = false;
        form.appendChild(nameInput);

        const errorEl = document.createElement('div');
        errorEl.className = 'explorer-form-error';
        form.appendChild(errorEl);

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex; gap:8px; align-items:center;';

        const createFileBtn = document.createElement('button');
        createFileBtn.className = 'explorer-btn primary';
        createFileBtn.textContent = 'Create File';
        createFileBtn.addEventListener('click', () =>
            createFileOrDir('project', projectId, '', nameInput, false, errorEl));
        btnRow.appendChild(createFileBtn);

        const createDirBtn = document.createElement('button');
        createDirBtn.className = 'explorer-btn primary';
        createDirBtn.textContent = 'Create Folder';
        createDirBtn.addEventListener('click', () =>
            createFileOrDir('project', projectId, '', nameInput, true, errorEl));
        btnRow.appendChild(createDirBtn);

        const importBtn = document.createElement('button');
        importBtn.className = 'explorer-btn primary';
        importBtn.textContent = 'Import Notebook';
        importBtn.addEventListener('click', () => importNotebook(projectId, errorEl));
        btnRow.appendChild(importBtn);

        const delBtn = document.createElement('button');
        delBtn.className = 'explorer-btn danger';
        delBtn.style.marginLeft = 'auto';
        delBtn.textContent = 'Delete Project';
        delBtn.addEventListener('click', async () => {
            if (!await modalConfirm(`Delete project "${projectId}" and all its notebooks?`)) return;
            try {
                const resp = await fetch(`api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(err.detail || 'Failed to delete project');
                }
                const projectNode = ctx.tree.findKey(`project:${projectId}`);
                if (projectNode) projectNode.remove();
                if (ctx.callbacks.onProjectDeleted) {
                    ctx.callbacks.onProjectDeleted(projectId);
                }
                ctx.showWelcomeDetail();
            } catch (err) {
                modalError(err.message);
            }
        });
        btnRow.appendChild(delBtn);

        form.appendChild(btnRow);

        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') createBtn.click();
        });

        ctx.detailEl.appendChild(form);

        // Default Environment section
        buildVenvSection(projectId, ctx.callbacks.onProjectDefaultVenvChanged).then(section => {
            ctx.detailEl.appendChild(section);
        });

        nameInput.focus();
    }

    // ── Notebook Detail ─────────────────────────────────────────────

    async function showNotebookDetail(projectId, notebookName) {
        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, projectId);

        const header = createEditableHeader(notebookName, iconPathForFile(notebookName), async (newName) => {
            return renameNotebook(projectId, notebookName, newName);
        });
        ctx.detailEl.appendChild(header);

        const actions = document.createElement('div');
        actions.className = 'explorer-detail-actions';

        const openBtn = document.createElement('button');
        openBtn.className = 'explorer-btn primary';
        openBtn.textContent = 'Open Notebook';
        openBtn.addEventListener('click', () => {
            if (ctx.callbacks.onNotebookSelect) {
                ctx.callbacks.onNotebookSelect(projectId, notebookName);
            }
        });
        actions.appendChild(openBtn);

        const exportBtn = document.createElement('button');
        exportBtn.className = 'explorer-btn primary';
        exportBtn.textContent = 'Export Notebook';
        exportBtn.addEventListener('click', async () => {
            try {
                const resp = await fetch(
                    `api/projects/${encodeURIComponent(projectId)}/notebooks/${encodeURIComponent(notebookName)}`
                );
                if (!resp.ok) throw new Error('Failed to fetch notebook');
                const content = await resp.json();
                const json = JSON.stringify(content, null, 2);
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = notebookName;
                a.click();
                URL.revokeObjectURL(url);
            } catch (err) {
                modalError(err.message, { title: 'Export Failed' });
            }
        });
        actions.appendChild(exportBtn);

        const delBtn = document.createElement('button');
        delBtn.className = 'explorer-btn danger';
        delBtn.textContent = 'Delete Notebook';
        delBtn.style.marginLeft = 'auto';
        delBtn.addEventListener('click', async () => {
            if (!await modalConfirm(`Delete notebook "${notebookName}"?`)) return;
            try {
                const resp = await fetch(
                    `api/projects/${encodeURIComponent(projectId)}/notebooks/${encodeURIComponent(notebookName)}`,
                    { method: 'DELETE' }
                );
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(err.detail || 'Failed to delete notebook');
                }
                const nbNode = ctx.tree.findKey(`notebook:${projectId}:${notebookName}`);
                if (nbNode) nbNode.remove();
                if (ctx.callbacks.onNotebookDeleted) {
                    ctx.callbacks.onNotebookDeleted(projectId, notebookName);
                }
                ctx.showWelcomeDetail();
            } catch (err) {
                modalError(err.message);
            }
        });
        actions.appendChild(delBtn);

        ctx.detailEl.appendChild(actions);

        // Fetch and display summary
        try {
            const resp = await fetch(
                `api/projects/${encodeURIComponent(projectId)}/notebooks/${encodeURIComponent(notebookName)}/summary`
            );
            if (!resp.ok) return;
            const summary = await resp.json();

            const infoGrid = document.createElement('div');
            infoGrid.className = 'explorer-nb-info';

            const rows = [];
            if (summary.cells_total != null) {
                rows.push(['Cells', `${summary.cells_total} (${summary.code_cells} code, ${summary.markdown_cells} markdown)`]);
            }
            if (summary.language) {
                const langText = summary.language_version
                    ? `${summary.language} ${summary.language_version}`
                    : summary.language;
                rows.push(['Language', langText]);
            }
            if (summary.kernel) {
                rows.push(['Kernel', summary.kernel]);
            }
            if (summary.size != null) {
                const kb = (summary.size / 1024).toFixed(1);
                rows.push(['Size', `${kb} KB`]);
            }
            if (summary.modified) {
                const date = new Date(summary.modified * 1000);
                rows.push(['Modified', date.toLocaleString()]);
            }

            for (const [label, value] of rows) {
                const row = document.createElement('div');
                row.className = 'explorer-nb-info-row';
                row.innerHTML = `<span class="explorer-nb-info-label">${label}</span><span class="explorer-nb-info-value">${value}</span>`;
                infoGrid.appendChild(row);
            }

            ctx.detailEl.appendChild(infoGrid);

            // Description preview (first markdown cell, rendered as HTML)
            if (summary.description) {
                const descEl = document.createElement('div');
                descEl.className = 'explorer-nb-description';
                descEl.innerHTML = marked.parse(summary.description);
                ctx.detailEl.appendChild(descEl);
            }
        } catch {
            // Summary is optional - fail silently
        }

    }

    // ── Src Folder / File Detail ────────────────────────────────────

    function showSrcFolderDetail(projectId) {
        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, projectId);

        const header = createDetailHeader('src', 'fa-solid fa-folder');
        ctx.detailEl.appendChild(header);

        // New Python File form
        const form = document.createElement('div');
        form.className = 'explorer-create-form';

        const label = document.createElement('label');
        label.textContent = 'New Python File';
        form.appendChild(label);

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'Filename (without .py)';
        nameInput.spellcheck = false;
        form.appendChild(nameInput);

        const errorEl = document.createElement('div');
        errorEl.className = 'explorer-form-error';
        form.appendChild(errorEl);

        const createBtn = document.createElement('button');
        createBtn.className = 'explorer-btn primary';
        createBtn.textContent = 'Create File';
        createBtn.addEventListener('click', () => createSrcFile(projectId, nameInput, createBtn, errorEl));
        form.appendChild(createBtn);

        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') createBtn.click();
        });

        ctx.detailEl.appendChild(form);
        nameInput.focus();
    }

    function showSrcFileDetail(projectId, filename) {
        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, projectId);

        const header = createEditableHeader(filename, iconPathForFile(filename), async (newName) => {
            return renameSrcFile(projectId, filename, newName);
        });
        ctx.detailEl.appendChild(header);

        const actions = document.createElement('div');
        actions.className = 'explorer-detail-actions';

        const openBtn = document.createElement('button');
        openBtn.className = 'explorer-btn primary';
        openBtn.textContent = 'Open File';
        openBtn.addEventListener('click', () => {
            if (ctx.callbacks.onSrcFileSelect) {
                ctx.callbacks.onSrcFileSelect(projectId, filename);
            }
        });
        actions.appendChild(openBtn);

        const delBtn = document.createElement('button');
        delBtn.className = 'explorer-btn danger';
        delBtn.textContent = 'Delete File';
        delBtn.style.marginLeft = 'auto';
        delBtn.addEventListener('click', async () => {
            if (!await modalConfirm(`Delete "${filename}"?`)) return;
            try {
                const resp = await fetch(
                    `api/projects/${encodeURIComponent(projectId)}/src/${encodeURIComponent(filename)}`,
                    { method: 'DELETE' }
                );
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(err.detail || 'Failed to delete file');
                }
                const node = ctx.tree.findKey(`srcfile:${projectId}:${filename}`);
                if (node) node.remove();
                ctx.showWelcomeDetail();
            } catch (err) {
                modalError(err.message);
            }
        });
        actions.appendChild(delBtn);

        ctx.detailEl.appendChild(actions);
    }

    // ── Create Actions ──────────────────────────────────────────────

    async function createProject(nameInput, createBtn, errorEl) {
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        errorEl.textContent = '';
        createBtn.disabled = true;
        createBtn.textContent = 'Creating...';
        try {
            const resp = await fetch('api/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ project_id: name })
            });
            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.detail || 'Failed to create project');
            }
            // Add to tree
            const projectsRoot = ctx.tree.findKey('root-projects');
            if (projectsRoot) {
                projectsRoot.addChildren([{
                    title: name,
                    key: `project:${name}`,
                    icon: 'fa-solid fa-clipboard-list',
                    folder: true,
                    lazy: true,
                }]);
                projectsRoot.setExpanded(true);
            }
            nameInput.value = '';
            // Show the new project's detail
            showProjectDetail(name);
            const newNode = ctx.tree.findKey(`project:${name}`);
            if (newNode) newNode.setActive(true, { noEvents: true });
            if (ctx.callbacks.onProjectCreated) ctx.callbacks.onProjectCreated(name);
        } catch (err) {
            errorEl.textContent = err.message;
        } finally {
            createBtn.disabled = false;
            createBtn.textContent = 'Create Project';
        }
    }

    async function createNotebook(projectId, nameInput, createBtn, errorEl, externalPath = null) {
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        errorEl.textContent = '';
        createBtn.disabled = true;
        createBtn.textContent = 'Creating...';
        try {
            const body = { name };
            if (externalPath) body.external_path = externalPath;
            const resp = await fetch(`api/projects/${encodeURIComponent(projectId)}/notebooks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.detail || 'Failed to create notebook');
            }
            const nbName = name.endsWith('.ipynb') ? name : name + '.ipynb';
            // Add to tree under project
            const projectNode = ctx.tree.findKey(`project:${projectId}`);
            if (projectNode) {
                projectNode.addChildren([{
                    title: nbName,
                    key: `notebook:${projectId}:${nbName}`,
                    icon: 'fa-solid fa-file',
                }]);
                projectNode.setExpanded(true);
            }
            // Open it
            if (ctx.callbacks.onNotebookSelect) {
                ctx.callbacks.onNotebookSelect(projectId, nbName);
            }
        } catch (err) {
            errorEl.textContent = err.message;
        } finally {
            createBtn.disabled = false;
            createBtn.textContent = 'Create Notebook';
        }
    }

    async function createSrcFile(projectId, nameInput, createBtn, errorEl) {
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        errorEl.textContent = '';
        createBtn.disabled = true;
        createBtn.textContent = 'Creating...';
        try {
            const resp = await fetch(`api/projects/${encodeURIComponent(projectId)}/src`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.detail || 'Failed to create file');
            }
            const result = await resp.json();
            const filename = result.name;
            // Add to tree under src/ folder
            const srcNode = ctx.tree.findKey(`srcfolder:${projectId}`);
            if (srcNode) {
                srcNode.addChildren([{
                    title: filename,
                    key: `srcfile:${projectId}:${filename}`,
                    icon: iconPathForFile(filename),
                }]);
                srcNode.setExpanded(true);
            }
            // Open it
            if (ctx.callbacks.onSrcFileSelect) {
                ctx.callbacks.onSrcFileSelect(projectId, filename);
            }
        } catch (err) {
            errorEl.textContent = err.message;
        } finally {
            createBtn.disabled = false;
            createBtn.textContent = 'Create File';
        }
    }

    async function renameSrcFile(projectId, oldName, newName) {
        if (!newName.endsWith('.py')) newName += '.py';
        const resp = await fetch(
            `api/projects/${encodeURIComponent(projectId)}/src/${encodeURIComponent(oldName)}/rename`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ new_name: newName })
            }
        );
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to rename file');
        }
        // Update tree node
        const node = ctx.tree.findKey(`srcfile:${projectId}:${oldName}`);
        if (node) {
            node.title = newName;
            node.key = `srcfile:${projectId}:${newName}`;
            node.update();
        }
        // Refresh detail with new name
        showSrcFileDetail(projectId, newName);
        const newNode = ctx.tree.findKey(`srcfile:${projectId}:${newName}`);
        if (newNode) newNode.setActive(true, { noEvents: true });
    }

    function importNotebook(projectId, errorEl) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.ipynb';
        input.addEventListener('change', async () => {
            const file = input.files[0];
            if (!file) return;
            errorEl.textContent = '';
            try {
                const text = await file.text();
                const content = JSON.parse(text);
                if (!content.cells || !Array.isArray(content.cells)) {
                    throw new Error('Invalid notebook: missing cells array');
                }
                const name = file.name.replace(/\.ipynb$/, '');
                const resp = await fetch(`api/projects/${encodeURIComponent(projectId)}/notebooks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, content })
                });
                if (!resp.ok) {
                    const err = await resp.json();
                    throw new Error(err.detail || 'Failed to import notebook');
                }
                const nbName = name.endsWith('.ipynb') ? name : name + '.ipynb';
                const projectNode = ctx.tree.findKey(`project:${projectId}`);
                if (projectNode) {
                    projectNode.addChildren([{
                        title: nbName,
                        key: `notebook:${projectId}:${nbName}`,
                        icon: 'fa-solid fa-file',
                    }]);
                    projectNode.setExpanded(true);
                }
                if (ctx.callbacks.onNotebookSelect) {
                    ctx.callbacks.onNotebookSelect(projectId, nbName);
                }
            } catch (err) {
                errorEl.textContent = err.message;
            }
        });
        input.click();
    }

    // ── Rename Actions ──────────────────────────────────────────────

    async function renameProject(oldId, newId) {
        const resp = await fetch(`api/projects/${encodeURIComponent(oldId)}/rename`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ new_id: newId })
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to rename project');
        }
        // Update tree node
        const node = ctx.tree.findKey(`project:${oldId}`);
        if (node) {
            node.title = newId;
            node.key = `project:${newId}`;
            node.update();
            // Update child keys to reflect new project name
            node.visit(child => {
                if (child.key) {
                    child.key = child.key
                        .replace(`pfile:${oldId}:`, `pfile:${newId}:`)
                        .replace(`pdir:${oldId}:`, `pdir:${newId}:`);
                }
            });
        }
        if (ctx.callbacks.onProjectRenamed) {
            ctx.callbacks.onProjectRenamed(oldId, newId);
        }
        // Refresh detail with new name
        showProjectDetail(newId);
        const newNode = ctx.tree.findKey(`project:${newId}`);
        if (newNode) newNode.setActive(true, { noEvents: true });
    }

    async function renameNotebook(projectId, oldName, newName) {
        if (!newName.endsWith('.ipynb')) newName += '.ipynb';
        const resp = await fetch(
            `api/projects/${encodeURIComponent(projectId)}/notebooks/${encodeURIComponent(oldName)}/rename`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ new_name: newName })
            }
        );
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to rename notebook');
        }
        // Update tree node
        const node = ctx.tree.findKey(`notebook:${projectId}:${oldName}`);
        if (node) {
            node.title = newName;
            node.key = `notebook:${projectId}:${newName}`;
            node.update();
        }
        if (ctx.callbacks.onNotebookRenamed) {
            ctx.callbacks.onNotebookRenamed(projectId, oldName, newName);
        }
        // Refresh detail with new name
        showNotebookDetail(projectId, newName);
        const newNode = ctx.tree.findKey(`notebook:${projectId}:${newName}`);
        if (newNode) newNode.setActive(true, { noEvents: true });
    }

    // ── Public API ──────────────────────────────────────────────────

    return {
        showProjectsRootDetail,
        cloneRepo,
        showMountsRootDetail,
        showMountsConfig,
        addMount,
        showMountDetail,
        showDirDetail,
        showDvcFileDetail,
        showFileDetail,
        createFileOrDir,
        showProjectDetail,
        showNotebookDetail,
        showSrcFolderDetail,
        showSrcFileDetail,
        createProject,
        createNotebook,
        createSrcFile,
        renameSrcFile,
        importNotebook,
        renameProject,
        renameNotebook,
    };
}
