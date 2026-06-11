/**
 * ExplorerContextMenu - Right-click context menu system and all
 * CRUD actions triggered from the menu.
 */

import { notify } from '../../Notify.js';
import { modalConfirm, modalPrompt, modalError } from '../../modal.js';
import { openProjectTerminal } from '../../ProjectTerminal.js';
import { isTextEditable } from '../../file-icons.js';
import { domainState } from '../../domain-state.js';

/** Extensions considered DVC-trackable (data / model / media / archive files). */
const DVC_TRACKABLE_EXTENSIONS = new Set([
    'csv', 'parquet', 'feather', 'arrow', 'tsv',
    'h5', 'hdf5', 'pkl', 'pickle', 'joblib', 'npy', 'npz',
    'pt', 'pth', 'onnx', 'safetensors', 'pb', 'tflite', 'model', 'bin', 'tfrecord',
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tiff', 'tif', 'svg',
    'mp4', 'avi', 'mov', 'mkv', 'wav', 'mp3', 'flac', 'ogg',
    'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
    'db', 'sqlite', 'sqlite3',
]);

function isDvcTrackable(fileName) {
    const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
    return DVC_TRACKABLE_EXTENSIONS.has(ext);
}

/** Normalise a hierarchical category path (e.g. "Manuals/Technical/noted").
 *  Trims each segment, drops empty ones (so `a//b` -> `a/b`), rejects
 *  ".." and "." segments. Returns the cleaned path, the empty string if
 *  the input was blank (= uncategorised), or null if the input is
 *  structurally invalid. Mirrors the helper in DomainDocumentsTab so the
 *  two Set-Category entry points behave identically. */
function _normaliseCategoryPath(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    const segments = s.split('/').map((p) => p.trim());
    const cleaned = [];
    for (const seg of segments) {
        if (!seg) continue;
        if (seg === '..' || seg === '.') return null;
        cleaned.push(seg);
    }
    if (!cleaned.length) return null;
    return cleaned.join('/');
}

/**
 * @param {object} ctx - Shared explorer context (getters for live state).
 * @returns {object} Context menu methods.
 */
export function createContextMenu(ctx) {
    let _menuEl = null;
    let _dismissFn = null;

    function dismissContextMenu() {
        if (_menuEl) {
            _menuEl.remove();
            _menuEl = null;
        }
        if (_dismissFn) {
            document.removeEventListener('mousedown', _dismissFn, true);
            document.removeEventListener('keydown', _dismissFn, true);
            window.removeEventListener('blur', _dismissFn);
            _dismissFn = null;
        }
    }

    async function showContextMenu(ev, node) {
        dismissContextMenu();

        const key = node.key || '';
        const items = await buildContextMenuItems(key, node);
        if (items.length === 0) return;

        const menu = document.createElement('div');
        menu.className = 'explorer-context-menu';

        for (const item of items) {
            if (item.separator) {
                const sep = document.createElement('div');
                sep.className = 'explorer-context-menu-sep';
                menu.appendChild(sep);
                continue;
            }
            const row = document.createElement('div');
            row.className = 'explorer-context-menu-item' + (item.danger ? ' danger' : '');
            if (item.icon) {
                if (item.icon.endsWith('.svg')) {
                    const img = document.createElement('img');
                    img.src = item.icon;
                    img.style.cssText = 'width:14px;height:14px;vertical-align:middle';
                    row.appendChild(img);
                } else {
                    const icon = document.createElement('i');
                    icon.className = item.icon;
                    if (item.iconColor) icon.style.color = item.iconColor;
                    row.appendChild(icon);
                }
            }
            row.appendChild(document.createTextNode(item.label));
            row.addEventListener('click', () => {
                dismissContextMenu();
                item.action();
            });
            menu.appendChild(row);
        }

        document.body.appendChild(menu);
        _menuEl = menu;

        // Position: ensure menu stays within viewport
        const rect = menu.getBoundingClientRect();
        let x = ev.clientX;
        let y = ev.clientY;
        if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
        if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';

        // Dismiss on click outside or Escape
        _dismissFn = (e) => {
            if (e.type === 'keydown' && e.key !== 'Escape') return;
            if (e.type === 'mousedown' && menu.contains(e.target)) return;
            dismissContextMenu();
        };
        setTimeout(() => {
            document.addEventListener('mousedown', _dismissFn, true);
            document.addEventListener('keydown', _dismissFn, true);
            window.addEventListener('blur', _dismissFn);
        }, 0);
    }

    async function buildContextMenuItems(key, node) {
        const items = [];

        // Root sections
        if (key === 'root-projects') {
            items.push({
                label: 'New Project...', icon: 'fa-solid fa-folder-plus', iconColor: '#66bb6a',
                action: async () => {
                    const { modalPrompt, modalError } = await import('../../modal.js');
                    const name = await modalPrompt('Project name', { title: 'Create Project' });
                    if (!name) return;
                    try {
                        const resp = await fetch('api/projects', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ project_id: name }),
                        });
                        if (!resp.ok) { const err = await resp.json(); throw new Error(err.detail || 'Failed'); }
                        const rootNode = ctx.tree?.findKey('root-projects');
                        if (rootNode) {
                            rootNode.addChildren([{
                                title: name,
                                key: `project:${name}`,
                                icon: 'fa-solid fa-clipboard-list',
                                folder: true,
                                lazy: true,
                            }]);
                            rootNode.setExpanded(true);
                        }
                        notify.success(`Project "${name}" created`);
                    } catch (err) { modalError(err.message); }
                },
            });
            items.push({
                label: 'Clone from GitHub...', icon: 'fa-brands fa-github', iconColor: '#333',
                action: async () => {
                    const { modalForm, modalError } = await import('../../modal.js');
                    const result = await modalForm([
                        { key: 'url', label: 'Repository URL', placeholder: 'https://github.com/user/repo.git' },
                        { key: 'name', label: 'Project name (optional)', placeholder: 'Auto-detected from URL' },
                        { key: 'pat', label: 'PAT (optional, for private repos)', type: 'password', placeholder: 'Personal Access Token' },
                    ], { title: 'Clone from GitHub' });
                    if (!result) return;
                    const url = (result.url || '').trim();
                    if (!url) { modalError('Repository URL is required'); return; }
                    let projectId = (result.name || '').trim();
                    if (!projectId) {
                        const match = url.match(/\/([^\/]+?)(?:\.git)?$/);
                        projectId = match ? match[1] : '';
                    }
                    if (!projectId) { modalError('Could not determine project name'); return; }
                    try {
                        const resp = await fetch('api/git/clone', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url, project_id: projectId, pat: (result.pat || '').trim() || null }),
                        });
                        if (!resp.ok) { const err = await resp.json(); throw new Error(err.detail || 'Failed'); }
                        const rootNode = ctx.tree?.findKey('root-projects');
                        if (rootNode) {
                            rootNode.addChildren([{
                                title: projectId,
                                key: `project:${projectId}`,
                                icon: 'fa-solid fa-clipboard-list',
                                folder: true,
                                lazy: true,
                            }]);
                            rootNode.setExpanded(true);
                        }
                        notify.success(`Repository cloned as "${projectId}"`);
                    } catch (err) { modalError(err.message); }
                },
            });
            return items;
        }
        if (key === 'root-mounts') {
            items.push({
                label: 'Add Mount...', icon: 'fa-solid fa-hard-drive', iconColor: '#42a5f5',
                action: async () => {
                    const { modalForm, modalError } = await import('../../modal.js');
                    const result = await modalForm([
                        { key: 'name', label: 'Mount name', placeholder: 'my_project' },
                        { key: 'host_path', label: 'Host path', placeholder: '/home/user/project' },
                    ], { title: 'Add Mount', confirmText: 'Add' });
                    if (!result) return;
                    try {
                        const resp = await fetch('api/files/mounts/config', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(result),
                        });
                        if (!resp.ok) { const err = await resp.json(); throw new Error(err.detail || 'Failed'); }
                        notify.success(`Mount "${result.name}" added. Restart container to apply.`);
                    } catch (err) { modalError(err.message); }
                },
            });
            return items;
        }

        // Project root node (internal or mounted)
        if (key.startsWith('project:')) {
            const projectId = key.substring(8);
            const source = ctx.projectSources?.[projectId] || 'internal';
            const rootType = source === 'mount' ? 'mount' : 'project';
            items.push({
                label: 'New File', icon: 'fa-solid fa-file-circle-plus',
                action: () => ctxCreateEntry(rootType, projectId, '', false, node),
            });
            items.push({
                label: 'New Folder', icon: 'fa-solid fa-folder-plus',
                action: () => ctxCreateEntry(rootType, projectId, '', true, node),
            });
            items.push({
                label: 'Upload File', icon: 'fa-solid fa-upload',
                action: () => ctx.triggerUpload(rootType, projectId, ''),
            });
            items.push({
                label: 'New DAG from Template', icon: 'fa-solid fa-diagram-project', iconColor: '#ff9800',
                action: () => _showDagTemplateDialog(projectId),
            });
            items.push({ separator: true });
            items.push({
                label: 'Rename Project', icon: 'fa-solid fa-pen',
                action: () => ctxRenameInline(node, async (newName) => ctx.views.project.renameProject(projectId, newName)),
            });
            items.push({
                label: 'Delete Project', icon: 'fa-solid fa-trash', danger: true,
                action: () => ctxDeleteProject(projectId, node),
            });
            return items;
        }

        // Mount root node
        if (key.startsWith('mount:')) {
            const mountName = key.substring(6);
            items.push({
                label: 'New File', icon: 'fa-solid fa-file-circle-plus',
                action: () => ctxCreateEntry('mount', mountName, '', false, node),
            });
            items.push({
                label: 'New Folder', icon: 'fa-solid fa-folder-plus',
                action: () => ctxCreateEntry('mount', mountName, '', true, node),
            });
            items.push({
                label: 'Upload File', icon: 'fa-solid fa-upload',
                action: () => ctx.triggerUpload('mount', mountName, ''),
            });
            items.push({
                label: 'New DAG from Template', icon: 'fa-solid fa-diagram-project', iconColor: '#ff9800',
                action: () => _showDagTemplateDialog(mountName),
            });
            return items;
        }

        // Directory nodes (pdir: / mdir:)
        if (key.startsWith('pdir:') || key.startsWith('mdir:')) {
            const { rootType, rootName, relPath } = ctx.parseFileKey(key);
            items.push({
                label: 'New File', icon: 'fa-solid fa-file-circle-plus',
                action: () => ctxCreateEntry(rootType, rootName, relPath, false, node),
            });
            items.push({
                label: 'New Folder', icon: 'fa-solid fa-folder-plus',
                action: () => ctxCreateEntry(rootType, rootName, relPath, true, node),
            });
            items.push({
                label: 'Upload File', icon: 'fa-solid fa-upload',
                action: () => ctx.triggerUpload(rootType, rootName, relPath),
            });
            // Hydra view toggle for config directories at project root
            const HYDRA_DIR_NAMES = ['config', 'conf', 'configs'];
            if (!relPath.includes('/') && HYDRA_DIR_NAMES.includes(relPath)) {
                items.push({ separator: true });
                const hydraEnabled = ctx.hydraViewEnabled?.[rootName] || false;
                items.push({
                    label: hydraEnabled ? 'Disable Hydra View' : 'Enable Hydra View',
                    icon: 'static/vendor/icons/hydra.svg',
                    action: async () => {
                        const newVal = !hydraEnabled;
                        try {
                            await fetch(`api/hydra/view/${encodeURIComponent(rootName)}`, {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ enabled: newVal }),
                            });
                            if (ctx.hydraViewEnabled) ctx.hydraViewEnabled[rootName] = newVal;
                            // Update folder icon
                            const treeNode = ctx.tree?.findKey(key);
                            if (treeNode) {
                                treeNode.icon = newVal ? 'static/vendor/icons/hydra.svg' : 'fa-solid fa-folder';
                                treeNode.update();
                                treeNode.setActive(true);
                            }
                            notify.success(newVal ? 'Hydra View enabled' : 'Hydra View disabled');
                        } catch (err) {
                            notify.error('Failed to update Hydra view setting');
                        }
                    },
                });
            }
            items.push({ separator: true });
            items.push({
                label: 'Rename', icon: 'fa-solid fa-pen',
                action: () => ctxRenameEntry(rootType, rootName, relPath, node),
            });
            items.push({
                label: 'Delete Folder', icon: 'fa-solid fa-trash', danger: true,
                action: () => ctxDeleteEntry(rootType, rootName, relPath, node),
            });
            return items;
        }

        // File nodes (pfile: / mfile:)
        if (key.startsWith('pfile:') || key.startsWith('mfile:')) {
            const { rootType, rootName, relPath } = ctx.parseFileKey(key);
            const fileName = relPath.split('/').pop();

            if (fileName.endsWith('.ipynb')) {
                const projectId = rootName;
                items.push({
                    label: 'Open Notebook', icon: 'fa-solid fa-book-open',
                    action: () => { if (ctx.callbacks.onNotebookSelect) ctx.callbacks.onNotebookSelect(projectId, relPath); },
                });
            } else if (isTextEditable(fileName)) {
                const projectId = rootName;
                const hostPath = rootType === 'mount' ? ctx.mountHostPaths[rootName] : undefined;
                items.push({
                    label: 'Open File', icon: 'fa-solid fa-up-right-from-square',
                    action: () => { if (ctx.callbacks.onSrcFileSelect) ctx.callbacks.onSrcFileSelect(projectId, relPath, hostPath); },
                });
            }

            items.push({ separator: true });
            items.push({
                label: 'Rename', icon: 'fa-solid fa-pen',
                action: () => ctxRenameEntry(rootType, rootName, relPath, node),
            });
            items.push({
                label: 'Delete', icon: 'fa-solid fa-trash', danger: true,
                action: () => ctxDeleteEntry(rootType, rootName, relPath, node),
            });

            // Run Python files with venv
            if (fileName.endsWith('.py')) {
                items.push({ separator: true });
                items.push({
                    label: 'Run with venv', icon: 'fa-solid fa-play', iconColor: '#4caf50',
                    action: () => ctxRunPythonFile(rootType, rootName, relPath),
                });
            }

            if (isDvcTrackable(fileName)) {
                const deco = ctx.decorationService?.getDecoration(key);
                const isDvcTracked = deco?.source === 'dvc';
                const isDvcChanged = isDvcTracked && deco.status === 'changed';

                items.push({ separator: true });
                if (!isDvcTracked) {
                    items.push({
                        label: 'Track with DVC', icon: 'fa-solid fa-database', iconColor: '#1a7f9b',
                        action: () => ctxTrackWithDvc(rootType, rootName, relPath),
                    });
                } else {
                    if (isDvcChanged) {
                        items.push({
                            label: 'Update DVC tracking', icon: 'fa-solid fa-rotate', iconColor: '#c8870a',
                            action: () => ctxTrackWithDvc(rootType, rootName, relPath),
                        });
                    }
                    items.push({
                        label: 'Untrack from DVC', icon: 'fa-solid fa-link-slash', iconColor: '#78909c',
                        action: () => ctxUntrackFromDvc(rootType, rootName, relPath),
                    });
                }
            }

            return items;
        }

        // Knowledge Base root and category nodes
        // Data Catalog file nodes (always DVC-tracked)
        if (key.startsWith('datafile:')) {
            const rest = key.substring(9);
            const parts = rest.split(':');
            const rootType = parts[0];
            const rootName = parts[1];
            const relPath = parts.slice(2).join(':');

            // Fetch fresh DVC status so the menu reflects current state regardless
            // of whether the project tree has been expanded (which is what primes
            // the DecorationService cache at startup).
            const repoPath = rootType === 'mount'
                ? `/app/mounts/${rootName}`
                : `/app/data/projects/${rootName}`;
            let isDvcChanged = false;
            try {
                const res = await fetch('api/dvc/status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ repo_path: repoPath }),
                });
                if (res.ok) {
                    const data = await res.json();
                    const dvcFile = relPath + '.dvc';
                    isDvcChanged = (data.changed_files || []).some(c => c.dvc_file === dvcFile);
                }
            } catch { /* fall through - show only Untrack */ }

            if (isDvcChanged) {
                items.push({
                    label: 'Update DVC tracking', icon: 'fa-solid fa-rotate', iconColor: '#c8870a',
                    action: () => ctxTrackWithDvc(rootType, rootName, relPath),
                });
            }
            items.push({
                label: 'Untrack from DVC', icon: 'fa-solid fa-link-slash', iconColor: '#78909c',
                action: () => ctxUntrackFromDvc(rootType, rootName, relPath),
            });
            return items;
        }

        // Knowledge Base root and the Domains branch: convenience entry to
        // upload a document. The modal asks which Domain to target.
        // Knowledge Base entry points to the unified upload flow:
        //  - root-docs / kb-domains / kb-documents: modal asks which Domain
        //  - per-Domain root (kb-domain:<id>): Domain pre-selected
        if (key === 'root-docs' || key === 'kb-domains' || key === 'kb-documents'
            || /^kb-domain:[^:]+$/.test(key)) {
            // Domain root nodes get a "Manage Domain..." entry that opens the
            // master-detail Domain Manager pre-scoped to that Domain. The
            // generic root nodes (root-docs / kb-domains / kb-documents) open
            // it without a pre-selection so the user picks from the left list.
            items.push({
                label: 'Manage Domain...', icon: 'fa-solid fa-landmark', iconColor: '#5e8aaf',
                action: () => openDomainManager(node),
            });
            items.push({
                label: 'Upload Document...', icon: 'fa-solid fa-upload', iconColor: '#78909c',
                action: () => uploadDocumentToDomain(node),
            });
            return items;
        }

        // Per-Domain Knowledge Graph branch: rebuild only (uploads happen
        // on the per-Domain root or Documents node - vector + graph share
        // one ingest path).
        if (/^kb-domain:[^:]+:graph$/.test(key)) {
            items.push({
                label: 'Rebuild Graph', icon: 'fa-solid fa-rotate', iconColor: '#ff8800',
                action: () => triggerGraphRebuild(node),
            });
            return items;
        }

        // Top-level Documents file leaf: per-file metadata edit
        // (rename + category). Key shape: kb-documents:doc:<id>:<path>
        if (key.startsWith('kb-documents:doc:')) {
            items.push({
                label: 'Rename...', icon: 'fa-solid fa-pen-to-square', iconColor: '#81c784',
                action: () => renameDocument(node),
            });
            items.push({
                label: 'Set Folder...', icon: 'fa-solid fa-tag', iconColor: '#81c784',
                action: () => setDocumentCategory(node),
            });
            return items;
        }

        // Individual document node under Graph -> Documents - remove from corpus
        if (key.startsWith('kb-graph-doc:')) {
            items.push({
                label: 'Delete Document', icon: 'fa-solid fa-trash', iconColor: '#ef5350',
                danger: true,
                action: () => deleteGraphCorpusDocument(key, node),
            });
            return items;
        }

        // Embeddings source node - remove the document (file stays on disk)
        if (key.startsWith('emb:src:')) {
            items.push({
                label: 'Remove Document', icon: 'fa-solid fa-trash', iconColor: '#ef5350',
                danger: true,
                action: () => removeEmbeddingSource(key, node),
            });
            return items;
        }

        // Document nodes (doc:)
        if (key.startsWith('doc:')) {
            const rest = key.substring(4);
            const colonIdx = rest.indexOf(':');
            const category = rest.substring(0, colonIdx);
            const docName = rest.substring(colonIdx + 1);
            items.push({
                label: 'Open Document', icon: 'fa-solid fa-book-open',
                action: () => {
                    const doc = (ctx.docsCatalog?.documents || []).find(
                        d => d.name === docName && (d.category || 'Uncategorized') === category
                    );
                    if (doc && ctx.callbacks.onDocumentOpen) ctx.callbacks.onDocumentOpen(doc);
                },
            });
            items.push({ separator: true });
            items.push({
                label: 'Rename', icon: 'fa-solid fa-pen',
                action: () => ctxRenameDocument(docName, category, node),
            });
            items.push({
                label: 'Delete Document', icon: 'fa-solid fa-trash', danger: true,
                action: () => ctxDeleteDocument(docName, category, node),
            });
            return items;
        }

        // MLflow experiment nodes
        // DAG run nodes
        if (key.startsWith('dagrun:')) {
            const parts = key.substring(7).split(':');
            const dagId = parts[0];
            const dagRunId = parts.slice(1).join(':');
            items.push({
                label: 'Delete DAG Run', icon: 'fa-solid fa-trash', danger: true,
                action: async () => {
                    const confirmed = await modalConfirm(
                        `Delete DAG run "${dagRunId}"?`,
                        { title: 'Delete DAG Run', confirmText: 'Delete', cancelText: 'Cancel' }
                    );
                    if (!confirmed) return;
                    try {
                        const resp = await fetch(`api/airflow/dags/${encodeURIComponent(dagId)}/runs/${encodeURIComponent(dagRunId)}`, {
                            method: 'DELETE',
                        });
                        if (!resp.ok) throw new Error((await resp.json()).detail || 'Failed');
                        notify.success('DAG run deleted');
                        const parent = node?.parent;
                        if (parent && parent.lazy) {
                            parent.resetLazy();
                            parent.setExpanded(true);
                        } else if (node) {
                            node.remove();
                        }
                    } catch (err) {
                        notify.error(`Failed to delete: ${err.message}`);
                    }
                },
            });
            return items;
        }

        // Registered model nodes
        if (key.startsWith('regmodel:')) {
            const modelName = key.substring(9);
            items.push({
                label: 'Delete Model', icon: 'fa-solid fa-trash', danger: true,
                action: async () => {
                    if (!await modalConfirm(`Delete model "${modelName}" and all its versions?`)) return;
                    try {
                        const resp = await fetch(`api/registry/models/${encodeURIComponent(modelName)}`, {
                            method: 'DELETE',
                        });
                        if (!resp.ok) throw new Error((await resp.json()).detail || 'Failed');
                        notify.success('Model deleted');
                        const parent = node?.parent;
                        if (parent && parent.lazy) {
                            parent.resetLazy();
                            parent.setExpanded(true);
                        }
                    } catch (err) {
                        notify.error(`Failed to delete: ${err.message}`);
                    }
                },
            });
            return items;
        }

        // Model version nodes
        if (key.startsWith('regversion:')) {
            const parts = key.substring(11).split(':');
            const modelName = parts[0];
            const version = parts[1];
            items.push({
                label: `Delete Version v${version}`, icon: 'fa-solid fa-trash', danger: true,
                action: async () => {
                    if (!await modalConfirm(`Delete version v${version} of "${modelName}"?`)) return;
                    try {
                        const resp = await fetch(`api/registry/models/${encodeURIComponent(modelName)}/versions/${encodeURIComponent(version)}`, {
                            method: 'DELETE',
                        });
                        if (!resp.ok) throw new Error((await resp.json()).detail || 'Failed');
                        notify.success(`Version v${version} deleted`);
                        const parent = node?.parent;
                        if (parent && parent.lazy) {
                            parent.resetLazy();
                            parent.setExpanded(true);
                        }
                    } catch (err) {
                        notify.error(`Failed to delete: ${err.message}`);
                    }
                },
            });
            return items;
        }

        if (key.startsWith('experiment:')) {
            const experimentId = key.substring(11);
            items.push({
                label: 'Delete Experiment', icon: 'fa-solid fa-trash', danger: true,
                action: () => ctxDeleteExperiment(experimentId, node),
            });
            return items;
        }

        // MLflow run nodes
        if (key.startsWith('mlrun:')) {
            const rest = key.substring(6);
            const idx = rest.indexOf(':');
            const experimentId = rest.substring(0, idx);
            const runId = rest.substring(idx + 1);
            const isRunning = node.icon && node.icon.includes('fa-circle-play');
            if (isRunning) {
                items.push({
                    label: 'Stop Run', icon: 'fa-solid fa-circle-stop', iconColor: '#ff9800',
                    action: () => ctxStopRun(runId, experimentId, node),
                });
                items.push({ separator: true });
            }
            items.push({
                label: 'Delete Run', icon: 'fa-solid fa-trash', danger: true,
                action: () => ctxDeleteRun(runId, experimentId, node),
            });
            return items;
        }

        // Environment nodes
        if (key.startsWith('env:')) {
            const parts = key.replace('env:', '').split(':');
            const runtimeId = parts[0];
            const envName = parts.slice(1).join(':');
            items.push({
                label: 'Activate', icon: 'fa-solid fa-play',
                action: () => {
                    ctx.activeVenvName = envName;
                    ctx.activeVenvRuntimeId = runtimeId;
                    if (ctx.callbacks.onVenvSelect) {
                        ctx.callbacks.onVenvSelect({
                            name: envName, runtimeId,
                            displayName: ctx.getDisplayName(runtimeId),
                        });
                    }
                },
            });
            items.push({ separator: true });
            items.push({
                label: 'Delete Environment', icon: 'fa-solid fa-trash', danger: true,
                action: () => ctxDeleteEnv(envName, runtimeId, node),
            });
            return items;
        }

        return items;
    }

    // ── Context menu actions ────────────────────────────────────────

    async function ctxCreateEntry(rootType, rootName, parentPath, isDir, parentNode) {
        const name = await modalPrompt(isDir ? 'New folder name:' : 'New file name:', { title: isDir ? 'New Folder' : 'New File' });
        if (!name) return;

        const relPath = parentPath ? `${parentPath}/${name}` : name;
        fetch(`api/files/${rootType}/${encodeURIComponent(rootName)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: relPath, is_dir: isDir }),
        }).then(async (resp) => {
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                notify.error(err.detail || 'Failed to create');
                return;
            }
            notify.success(`Created ${isDir ? 'folder' : 'file'}: ${name}`);
            if (parentNode) {
                if (parentNode.isExpanded()) await parentNode.setExpanded(false);
                parentNode.resetLazy();
                await parentNode.setExpanded(true);
            }
        }).catch(err => notify.error(err.message));
    }

    async function ctxDeleteEntry(rootType, rootName, relPath, node) {
        const name = relPath.split('/').pop();

        // Check if this file is DVC-tracked
        const repoPath = `/app/${rootType === 'mount' ? 'mounts' : 'data/projects'}/${rootName}`;
        let isDvcTracked = false;
        try {
            const resp = await fetch('api/dvc/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repo_path: repoPath }),
            });
            if (resp.ok) {
                const data = await resp.json();
                isDvcTracked = (data.tracked_files || []).some(f => f.path === relPath);
            }
        } catch { /* ignore */ }

        const msg = isDvcTracked
            ? `"${name}" is tracked by DVC. This will remove DVC tracking, delete the data file, and stage changes in Git. Continue?`
            : `Delete "${name}"?`;
        if (!await modalConfirm(msg)) return;

        if (isDvcTracked) {
            try {
                const dvcFile = relPath + '.dvc';
                const resp = await fetch('api/dvc/remove', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ repo_path: repoPath, rel_path: dvcFile }),
                });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    notify.error(err.detail || 'Failed to remove DVC tracking');
                    return;
                }
                // Remove .dvc node from tree if visible
                const prefix = rootType === 'project' ? 'p' : 'm';
                const dvcNode = ctx.tree?.findKey(`${prefix}file:${rootName}:${dvcFile}`);
                if (dvcNode) dvcNode.remove();
                const parent = node?.parent;
                if (node) node.remove();
                if (parent) parent.setActive(true);
                notify.success(`Removed DVC tracking for "${name}"`);
            } catch (err) {
                notify.error(err.message);
            }
        } else {
            fetch(`api/files/${rootType}/${encodeURIComponent(rootName)}?path=${encodeURIComponent(relPath)}`, {
                method: 'DELETE',
            }).then(async (resp) => {
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    notify.error(err.detail || 'Failed to delete');
                    return;
                }
                const parent = node?.parent;
                if (node) node.remove();
                if (parent) parent.setActive(true);
                else ctx.showWelcomeDetail();
            }).catch(err => notify.error(err.message));
        }
    }

    async function ctxRenameEntry(rootType, rootName, relPath, node) {
        const oldName = relPath.split('/').pop();
        const newName = await modalPrompt('Rename to:', { title: 'Rename', defaultValue: oldName });
        if (!newName || newName === oldName) return;

        // Check if DVC-tracked
        const repoPath = `/app/${rootType === 'mount' ? 'mounts' : 'data/projects'}/${rootName}`;
        let isDvcTracked = false;
        try {
            const resp = await fetch('api/dvc/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repo_path: repoPath }),
            });
            if (resp.ok) {
                const data = await resp.json();
                isDvcTracked = (data.tracked_files || []).some(f => f.path === relPath);
            }
        } catch { /* ignore */ }

        if (isDvcTracked) {
            try {
                const dir = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/') + 1) : '';
                const newRelPath = dir + newName;
                const resp = await fetch('api/dvc/rename', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ repo_path: repoPath, old_dvc_file: relPath + '.dvc', new_rel_path: newRelPath }),
                });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    notify.error(err.detail || 'Failed to rename');
                    return;
                }
                // Refresh parent to show updated files (new .dvc file, renamed data file)
                const parent = node?.parent;
                if (parent) {
                    parent.resetLazy();
                    parent.setExpanded(true);
                }
                notify.success(`Renamed "${oldName}" to "${newName}"`);
            } catch (err) {
                notify.error(err.message);
            }
        } else {
            fetch(`api/files/${rootType}/${encodeURIComponent(rootName)}/rename?path=${encodeURIComponent(relPath)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ new_name: newName }),
            }).then(async (resp) => {
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    notify.error(err.detail || 'Failed to rename');
                    return;
                }
                const data = await resp.json();
                node.title = newName;
                const prefix = node.key.substring(0, node.key.indexOf(':'));
                node.key = `${prefix}:${rootName}:${data.new_path}`;
                node.update();
                if (node.key.startsWith('pdir:') || node.key.startsWith('mdir:')) {
                    node.resetLazy();
                }
            }).catch(err => notify.error(err.message));
        }
    }

    function _terminalAction(repoPath) {
        const socket = ctx.callbacks.getSocket?.();
        if (!socket || !repoPath) return [];
        const label = repoPath.split('/').pop();
        return [{ label: 'Open Terminal', icon: 'fa-solid fa-terminal', onClick: () => openProjectTerminal(socket, repoPath, label) }];
    }

    async function ctxTrackWithDvc(rootType, rootName, relPath) {
        const fileName = relPath.split('/').pop();
        const repoPath = rootType === 'mount'
            ? `/app/mounts/${rootName}`
            : `/app/data/projects/${rootName}`;

        try {
            const res = await fetch('api/dvc/track', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repo_path: repoPath, rel_path: relPath }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                const termActions = _terminalAction(repoPath);
                modalError(err.detail || `Failed to track ${fileName} with DVC`, { title: 'DVC Track Failed', actions: termActions });
                return;
            }
            notify.success(`${fileName} tracked with DVC`);
            if (ctx.decorationService) ctx.decorationService.refreshAll();
        } catch (e) {
            const termActions = _terminalAction(repoPath);
            modalError(e.message, { title: 'DVC Track Failed', actions: termActions });
        }
    }

    async function ctxUntrackFromDvc(rootType, rootName, relPath) {
        const fileName = relPath.split('/').pop();
        const repoPath = rootType === 'mount'
            ? `/app/mounts/${rootName}`
            : `/app/data/projects/${rootName}`;

        const ok = await modalConfirm(
            `Stop tracking "${fileName}" with DVC? The data file stays on disk and will be re-added to git.`,
            { title: 'Untrack from DVC' }
        );
        if (!ok) return;

        try {
            const res = await fetch('api/dvc/remove', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repo_path: repoPath, rel_path: relPath, delete_data: false }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                const termActions = _terminalAction(repoPath);
                modalError(err.detail || `Failed to untrack ${fileName}`, { title: 'DVC Untrack Failed', actions: termActions });
                return;
            }
            notify.success(`${fileName} untracked from DVC`);
            if (ctx.decorationService) ctx.decorationService.refreshAll();
        } catch (e) {
            const termActions = _terminalAction(repoPath);
            modalError(e.message, { title: 'DVC Untrack Failed', actions: termActions });
        }
    }

    async function ctxRenameInline(node, onRename) {
        const oldName = node.title;
        const newName = await modalPrompt('Rename to:', { title: 'Rename', defaultValue: oldName });
        if (!newName || newName === oldName) return;
        onRename(newName).catch(err => notify.error(err.message));
    }

    async function ctxDeleteProject(projectId, node) {
        if (!await modalConfirm(`Delete project "${projectId}" and all its contents?`)) return;

        fetch(`api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
            .then(async (resp) => {
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    notify.error(err.detail || 'Failed to delete project');
                    return;
                }
                if (node) node.remove();
                if (ctx.callbacks.onProjectDeleted) ctx.callbacks.onProjectDeleted(projectId);
                ctx.showWelcomeDetail();
            }).catch(err => notify.error(err.message));
    }

    async function ctxDeleteEnv(envName, runtimeId, node) {
        if (!await modalConfirm(`Delete environment "${envName}"?`)) return;

        fetch(`api/envs/${encodeURIComponent(runtimeId)}/${encodeURIComponent(envName)}`, { method: 'DELETE' })
            .then(async (resp) => {
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    notify.error(err.detail || 'Failed to delete environment');
                    return;
                }
                if (node) node.remove();
                if (ctx.callbacks.onVenvDeleted) ctx.callbacks.onVenvDeleted(envName);
                ctx.showWelcomeDetail();
            }).catch(err => notify.error(err.message));
    }

    async function ctxStopRun(runId, experimentId, node) {
        if (!await modalConfirm('Stop this run? It will be marked as FINISHED.')) return;
        fetch(`api/mlflow/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' })
            .then(async (resp) => {
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    notify.error(err.detail || 'Failed to stop run');
                    return;
                }
                notify.success('Run stopped');
                if (node) node.icon = 'fa-solid fa-circle-stop';
                node?.update();
                ctx.views.external.showMlrunDetail(node.key);
            }).catch(err => notify.error(err.message));
    }

    async function ctxDeleteRun(runId, experimentId, node) {
        if (!await modalConfirm('Delete this run? This cannot be undone.')) return;
        fetch(`api/mlflow/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' })
            .then(async (resp) => {
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    notify.error(err.detail || 'Failed to delete run');
                    return;
                }
                notify.success('Run deleted');
                if (node) node.remove();
                const expNode = ctx.tree?.findKey(`experiment:${experimentId}`);
                if (expNode) expNode.setActive(true);
            }).catch(err => notify.error(err.message));
    }

    async function ctxDeleteExperiment(experimentId, node) {
        const name = node?.title || experimentId;
        if (!await modalConfirm(`Delete experiment "${name}"? All runs will be archived.`)) return;
        fetch(`api/mlflow/experiments/${encodeURIComponent(experimentId)}`, { method: 'DELETE' })
            .then(async (resp) => {
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    notify.error(err.detail || 'Failed to delete experiment');
                    return;
                }
                notify.success('Experiment deleted');
                if (node) node.remove();
                ctx.views.external.showExperimentsRootDetail();
            }).catch(err => notify.error(err.message));
    }

    async function ctxRenameDocument(docName, category, node) {
        const newName = await modalPrompt('Rename document:', { title: 'Rename Document', defaultValue: docName });
        if (!newName || newName === docName) return;

        fetch('api/documents/rename', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: docName, category, new_name: newName }),
        }).then(async (resp) => {
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                notify.error(err.detail || 'Failed to rename document');
                return;
            }
            await ctx.views.external.reloadDocuments();
        }).catch(err => notify.error(err.message));
    }

    async function ctxDeleteDocument(docName, category, node) {
        if (!await modalConfirm(`Delete document "${docName}"?`)) return;

        fetch('api/documents', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: docName, category }),
        }).then(async (resp) => {
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                notify.error(err.detail || 'Failed to delete document');
                return;
            }
            await ctx.views.external.reloadDocuments();
        }).catch(err => notify.error(err.message));
    }

    // ── Assistant / Embeddings ─────────────────────────────────────────

    /** Refresh per-Domain Vector subtrees after an upload or remove. The
     *  legacy `assistant-embeddings` flat node was replaced by per-Domain
     *  `kb-domain:<id>:vector` branches; we visit and reset each one that
     *  Wunderbaum has loaded. Per explorer_issues_and_guidelines.md this
     *  is the safe refresh shape for lazy nodes. */
    function refreshEmbeddingsTree() {
        const tree = ctx.tree;
        if (!tree) return;
        tree.visit?.((node) => {
            const key = node.key || '';
            if (/^kb-domain:[^:]+:vector$/.test(key) && node.lazy) {
                try { node.resetLazy(); } catch {}
            }
        });
    }

    /** Open an EventSource stream for ingest progress. Updates the toast
     *  on each terminal-or-changed event; refreshes the tree on done.
     *  Kept as a helper for any future per-Domain ingest stream UX. */
    function streamIngestProgress(jobId, filename) {
        let evt;
        try {
            evt = new EventSource(`api/rag/ingest/stream/${encodeURIComponent(jobId)}`);
        } catch {
            // Browser without EventSource - fall back to a single status check.
            fetch(`api/rag/ingest/status/${encodeURIComponent(jobId)}`)
                .then(r => r.json()).then(p => {
                    if (p.status === 'done') {
                        notify.success(`Indexed ${filename} (${p.indexed ?? 0} new chunks)`);
                        refreshEmbeddingsTree();
                    } else if (p.status === 'error') {
                        notify.error(`Ingest failed: ${p.error || 'unknown'}`);
                    }
                });
            return;
        }
        evt.onmessage = (msg) => {
            let payload;
            try { payload = JSON.parse(msg.data); } catch { return; }
            const s = payload.status;
            if (s === 'done') {
                const indexed = payload.indexed ?? 0;
                const skipped = payload.skipped_unchanged ?? 0;
                notify.success(`Indexed ${filename} (${indexed} new chunks, ${skipped} unchanged)`);
                evt.close();
                refreshEmbeddingsTree();
            } else if (s === 'error') {
                notify.error(`Ingest failed: ${payload.error || 'unknown'}`);
                evt.close();
            } else if (s === 'timeout') {
                notify.warning(`Ingest is taking longer than expected; check the Embeddings node later.`);
                evt.close();
            } else if (s === 'unavailable' || s === 'not_found') {
                notify.error(`Lost track of ingest job: ${s}`);
                evt.close();
            }
            // Intermediate "running" status: silent (avoid toast spam).
        };
        evt.onerror = () => {
            notify.error('Ingest progress stream lost; check the Embeddings node manually.');
            try { evt.close(); } catch {}
        };
    }

    /** Refresh per-Domain Graph subtrees (Communities + Documents) and the
     *  per-Domain Vector subtree after a corpus change. The tree was
     *  reshaped to per-Domain branches (kb-domain:<id>:graph:comm,
     *  kb-domain:<id>:graph:docs, kb-domain:<id>:vector,
     *  kb-domain:<id>:docs); we visit every loaded lazy node whose key
     *  matches one of those shapes and reset it. */
    function refreshGraphTree() {
        const tree = ctx.tree;
        if (!tree) return;
        const PATTERNS = [
            /^kb-domain:[^:]+:graph:comm$/,
            /^kb-domain:[^:]+:graph:docs$/,
            /^kb-domain:[^:]+:vector$/,
            /^kb-domain:[^:]+:docs$/,
        ];
        tree.visit?.((node) => {
            const key = node.key || '';
            if (PATTERNS.some((re) => re.test(key)) && node.lazy) {
                try { node.resetLazy(); } catch {}
            }
        });
    }

    /** Extract `<domain_id>` from a per-Domain node key.
     * Returns null if the key isn't a `kb-domain:...` shape. */
    function _domainIdFromKey(key) {
        if (!key || !key.startsWith('kb-domain:')) return null;
        const rest = key.substring('kb-domain:'.length);
        const colonIdx = rest.indexOf(':');
        return colonIdx === -1 ? rest : rest.substring(0, colonIdx);
    }

    /** Open the Domain Manager panel scoped to the Domain the menu was
     *  triggered on. Generic Knowledge Base root nodes (root-docs,
     *  kb-domains, kb-documents) open it without a pre-selection so the
     *  user picks from the left list. */
    function openDomainManager(node) {
        const presetDomain = _domainIdFromKey(node?.key) || null;
        const app = ctx.app;
        if (app && typeof app.showKnowledgeBaseManager === 'function') {
            app.showKnowledgeBaseManager(presetDomain);
        }
    }

    async function uploadDocumentToDomain(node) {
        const { modalForm } = await import('../../modal.js');
        // Pre-select the Domain when the menu was triggered on a per-Domain
        // node. Falls back to the first knowledge Domain otherwise.
        const presetDomain = _domainIdFromKey(node?.key) || domainState.getFirstKnowledgeDomain();
        const domains = domainState.getDomains().filter((k) => k.has_knowledge);
        const domainOptions = domains.map((k) => ({
            value: k.domain_id,
            label: k.domain_id === presetDomain ? `${k.name || k.domain_id} (selected)` : (k.name || k.domain_id),
        }));
        // Accepted formats mirror corpus.add_uploaded_file's whitelist:
        // .md (md_scanner) + .pdf/.docx/.pptx/.html/.htm (Docling).
        const ACCEPTED = ['.md', '.pdf', '.docx', '.pptx', '.html', '.htm'];
        const result = await modalForm([
            { key: 'domain_id', label: 'Destination Knowledge Base', type: 'select',
              options: domainOptions, defaultValue: presetDomain },
            { key: 'mode', label: 'Mode', type: 'select',
              options: [
                  { value: 'read_store', label: 'Read & Store (visible + indexed in vector + graph)' },
                  { value: 'read_only',  label: 'Read-only (visible, NOT indexed in vector or graph)' },
              ],
              defaultValue: 'read_store' },
            { key: 'category', label: 'Folder (optional, e.g. Manuals/Technical - nested folders in the Documents tree)',
              placeholder: 'e.g. Manuals/Technical or Reports', required: false },
            { key: 'file', label: 'Document file(s) - hold Ctrl/Cmd to pick several (.md, .pdf, .docx, .pptx, .html)',
              type: 'file', accept: ACCEPTED.join(','), multiple: true },
        ], { title: 'Upload Document(s)' });
        if (!result || !result.file || !result.file.length) return;
        const files = Array.isArray(result.file) ? result.file : [result.file];
        const targetDomain = result.domain_id || presetDomain;
        const mode = (result.mode === 'read_only') ? 'read_only' : 'read_store';
        const category = (result.category || '').trim();

        // Validate extensions up front; reject the whole batch if any file
        // has an unsupported extension (clearer than half-uploading).
        for (const f of files) {
            const ext = ('.' + (f.name.split('.').pop() || '')).toLowerCase();
            if (!ACCEPTED.includes(ext)) {
                modalError(`"${f.name}": unsupported extension ${ext}. Accepted: ${ACCEPTED.join(', ')}`);
                return;
            }
        }

        // Sequential POSTs: each returns 202 immediately, server-side
        // queues per-Domain by the rebuild lock so client-side parallelism
        // wouldn't help. Sequential keeps the UI feedback ordered.
        let succeeded = 0;
        let failed = 0;
        const total = files.length;
        if (total > 1) {
            notify.info(`Uploading ${total} files to ${targetDomain}...`);
        }
        for (const file of files) {
            try {
                const formData = new FormData();
                formData.append('file', file);
                const resp = await fetch(
                    `api/domains/${targetDomain}/documents?mode=${encodeURIComponent(mode)}` +
                    (category ? `&category=${encodeURIComponent(category)}` : ''),
                    { method: 'POST', body: formData },
                );
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(err.detail || `HTTP ${resp.status}`);
                }
                succeeded++;
                if (total === 1) {
                    const data = await resp.json();
                    const ext = (data.graph_extract && data.graph_extract.status) || 'queued';
                    notify.success(
                        `"${file.name}" added to ${targetDomain}. Background extraction ${ext}; ` +
                        `watch progress in the Knowledge Base Monitor.`,
                    );
                }
            } catch (err) {
                failed++;
                notify.error(`"${file.name}" upload failed: ${err.message}`);
            }
        }
        if (total > 1) {
            const tone = failed === 0 ? 'success' : (succeeded === 0 ? 'error' : 'warning');
            notify[tone](
                `${succeeded}/${total} files queued to ${targetDomain}` +
                (failed ? ` (${failed} failed)` : '') +
                '. Server processes them sequentially; watch progress in the Knowledge Base Monitor.',
            );
        }
        refreshGraphTree();
        // Auto-open the Monitor on the Domain we just uploaded to, so the
        // user sees the extraction phases for the right Domain (not whatever
        // the active set defaults to).
        if (succeeded > 0) {
            const app = ctx.app;
            if (app && typeof app.showKnowledgeBaseMonitor === 'function') {
                app.showKnowledgeBaseMonitor(targetDomain);
            }
        }
    }

    /** Edit the `category` metadata of a single document. Pure manifest
     *  update - does not re-index, doesn't move the file. The Documents
     *  tree re-groups by the new category on refresh. */
    async function setDocumentCategory(node) {
        const data = node?.data || {};
        // Same key-as-source-of-truth fallback as renameDocument; see
        // that function's comment for the why.
        const m = (node?.key || '').match(/^kb-documents:doc:([^:]+):(.+)$/);
        const domainId = data.domain_id || (m ? m[1] : null);
        const path = data.path || (m ? m[2] : null);
        if (!domainId || !path) {
            modalError('Internal: doc node has no domain_id/path');
            return;
        }
        const { modalForm } = await import('../../modal.js');
        const result = await modalForm(
            [
                { key: 'category', label: 'Folder path (use / for nested folders, e.g. Manuals/Technical/noted; empty = unfiled)',
                  defaultValue: data.category || '',
                  placeholder: 'e.g. Manuals/Technical or Reports',
                  required: false },
            ],
            { title: `Set Folder: ${path}`, confirmText: 'Save' },
        );
        if (!result) return;
        const cat = _normaliseCategoryPath(result.category);
        if (cat === null) {
            modalError('Invalid folder path. Use letters/numbers and "/" between segments; no empty segments, no leading/trailing slashes, no "..".');
            return;
        }
        try {
            const params = new URLSearchParams({ path, category: cat });
            const r = await fetch(
                `api/domains/${encodeURIComponent(domainId)}/documents/category?${params.toString()}`,
                { method: 'PATCH' },
            );
            if (!r.ok) {
                const detail = await r.text().catch(() => '');
                throw new Error(`HTTP ${r.status}: ${detail.slice(0, 200)}`);
            }
            notify.success(`"${path}" folder set to ${cat || '(unfiled)'}`);
            // Refresh the top-level Documents subtree so the file moves
            // into its new category bucket.
            const tree = ctx.tree;
            const docsNode = tree?.findKey?.('kb-documents');
            if (docsNode && docsNode.lazy) {
                try { docsNode.resetLazy(); } catch {}
            }
        } catch (e) {
            modalError(`Update failed: ${e.message}`);
        }
    }

    /** Edit the user-friendly `display_name` of a document. Pure metadata
     *  update - the file on disk and all DB ids stay tied to the original
     *  `path`. The Documents tree shows display_name when set, basename
     *  otherwise. Empty input clears the override. */
    async function renameDocument(node) {
        const data = node?.data || {};
        // Key shape: kb-documents:doc:<domain_id>:<path> - parse it as
        // the source of truth so a stale node.data (Wunderbaum sometimes
        // hands back a node whose data wasn't preserved) doesn't block
        // the action.
        const m = (node?.key || '').match(/^kb-documents:doc:([^:]+):(.+)$/);
        const domainId = data.domain_id || (m ? m[1] : null);
        const path = data.path || (m ? m[2] : null);
        if (!domainId || !path) {
            modalError('Internal: doc node has no domain_id/path');
            return;
        }
        const filename = (path || '').split('/').pop();
        const { modalForm } = await import('../../modal.js');
        // Pre-fill with the current display_name if set, otherwise with
        // the filename. This way the user edits in place rather than
        // typing from scratch. Saving with the filename still effectively
        // means "use filename" (the tree renders the same string either
        // way), and clearing the field still routes through the
        // empty-string clear path on the backend.
        const result = await modalForm(
            [
                { key: 'display_name', label: 'Display name (empty = use filename)',
                  defaultValue: data.display_name || filename,
                  placeholder: filename,
                  required: false },
            ],
            { title: `Rename: ${filename}`, confirmText: 'Save' },
        );
        if (!result) return;
        const name = (result.display_name || '').trim();
        try {
            const params = new URLSearchParams({ path, display_name: name });
            const r = await fetch(
                `api/domains/${encodeURIComponent(domainId)}/documents/display_name?${params.toString()}`,
                { method: 'PATCH' },
            );
            if (!r.ok) {
                const detail = await r.text().catch(() => '');
                throw new Error(`HTTP ${r.status}: ${detail.slice(0, 200)}`);
            }
            notify.success(name
                ? `"${filename}" renamed to "${name}"`
                : `"${filename}" display name cleared`);
            // Update the node in place instead of resetLazy() on the
            // parent (which would collapse the whole `kb-documents`
            // subtree and lose the user's expansion state). Keep
            // node.data in sync so subsequent renames pre-fill from
            // the new display_name. The mode badge convention is
            // preserved — see corpus-doc node construction in
            // ExplorerPanel.js (kb-documents:doc:* leaves).
            const baseTitle = (name || filename);
            const modeBadge = (node.data && node.data.mode === 'read_only')
                ? ' [read-only]' : '';
            node.title = baseTitle + modeBadge;
            if (node.data) node.data.display_name = name;
            try { node.update(); } catch {}
        } catch (e) {
            modalError(`Rename failed: ${e.message}`);
        }
    }

    async function deleteGraphCorpusDocument(nodeKey, node) {
        const path = nodeKey.substring('kb-graph-doc:'.length);
        const data = node?.data || {};
        const fileWarning = data.uploaded
            ? ' The uploaded file will be DELETED from disk.'
            : ' The file on disk is left alone (canonical doc).';
        const ok = await modalConfirm(
            `Remove "${path}" from the Knowledge Graph corpus?${fileWarning}\n\n` +
            `Its entries in the graph will be removed on the next rebuild.`,
            { title: 'Delete Document from Corpus', confirmText: 'Delete' }
        );
        if (!ok) return;
        try {
            const url = `api/graph/research/${domainState.getFirstKnowledgeDomain()}/corpus?path=${encodeURIComponent(path)}`;
            const resp = await fetch(url, { method: 'DELETE' });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || `Delete failed (HTTP ${resp.status})`);
            }
            const result = await resp.json();
            const filePart = result.file_deleted ? '; file deleted' : '';
            notify.success(`Removed from corpus${filePart}. Trigger Rebuild Graph for the change to take effect.`);
            refreshGraphTree();
        } catch (err) {
            modalError(err.message);
        }
    }

    async function triggerGraphRebuild(node) {
        // The Rebuild Graph item is attached only to `kb-domain:<id>:graph`
        // keys, so the per-node domain id is always available. Falling back
        // to first-knowledge-domain here would silently target the wrong
        // Domain when the user right-clicks Software Agents but eu_ai sorts
        // first alphabetically.
        const targetDomain = _domainIdFromKey(node && node.key);
        if (!targetDomain) {
            modalError('Internal: Rebuild Graph triggered with no Domain in scope');
            return;
        }
        const domainLabel = (node && node.title) || targetDomain;
        const ok = await modalConfirm(
            `Rebuild the Knowledge Graph for "${domainLabel}"?\n\n` +
            'This will rescan the corpus, re-extract entities via Gemma, recompute communities + summaries, ' +
            'and atomically swap into ArcadeDB.\n\n' +
            'You can monitor progress via View > Knowledge Base Monitor.',
            { title: `Rebuild Knowledge Graph: ${domainLabel}`, confirmText: 'Rebuild' }
        );
        if (!ok) return;
        try {
            // Fire and forget - the rebuild runs synchronously server-side and
            // takes minutes. We don't await the response. Open the monitor
            // panel immediately so the user can watch the phases tick by.
            fetch(`api/graph/research/${targetDomain}/rebuild`, { method: 'POST' }).catch(() => {});
            notify.success(`Graph rebuild started for ${domainLabel}. Open View > Knowledge Base Monitor to watch progress.`);
            const app = ctx.app;
            if (app && typeof app.showKnowledgeBaseMonitor === 'function') {
                app.showKnowledgeBaseMonitor(targetDomain);
            }
        } catch (err) {
            modalError(err.message);
        }
    }

    async function removeEmbeddingSource(nodeKey, node) {
        const sourceB64 = nodeKey.substring('emb:src:'.length);
        const name = node?.title || 'this document';
        const ok = await modalConfirm(
            `Remove "${name}"? Its chunks will be dropped from the index. The file on disk is left alone.`,
            { title: 'Remove Document', confirmText: 'Remove' }
        );
        if (!ok) return;
        try {
            const resp = await fetch(`api/rag/sources/${encodeURIComponent(sourceB64)}`, { method: 'DELETE' });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || `Delete failed (HTTP ${resp.status})`);
            }
            const data = await resp.json();
            notify.success(`Removed ${name} (${data.deleted_chunks ?? 0} chunks dropped)`);
            refreshEmbeddingsTree();
        } catch (err) {
            modalError(err.message);
        }
    }

    /** Custom modal: file picker + tag input + LIVE chip preview.
     *  Uses jsPanel directly because modalForm has no per-field render
     *  hook for the live preview. Resolves with {file, tags[]} or null. */
    function openEmbeddingUploadModal() {
        const MAX_TAGS = 10;
        return new Promise((resolve) => {
            let resolved = false;
            jsPanel.modal.create({
                headerTitle: 'Upload document to Embeddings',
                contentSize: { width: 520, height: 'auto' },
                position: 'center',
                dragit: false, resizeit: false,
                headerControls: 'closeonly',
                border: '1px solid var(--border-color, #444)',
                borderRadius: '6px',
                theme: 'none',
                boxShadow: 4,
                onclosed: [() => {
                    // Remove the dim backdrop jsPanel left behind. modal.js's
                    // built-in helpers do this via _cleanupBackdrops; this
                    // bespoke modal has to do it inline.
                    document.querySelectorAll('.jsPanel-modal-backdrop').forEach(el => el.remove());
                    if (!resolved) resolve(null);
                    return true;
                }],
                footerToolbar: `
                    <div style="display:flex;justify-content:flex-end;gap:8px;padding:8px 16px;width:100%">
                        <button class="modal-btn modal-cancel">Cancel</button>
                        <button class="modal-btn modal-confirm" disabled>Upload</button>
                    </div>`,
                callback: (panel) => {
                    const wrap = document.createElement('div');
                    wrap.style.cssText = 'padding:16px 20px;display:flex;flex-direction:column;gap:14px';
                    wrap.innerHTML = `
                        <div>
                            <label style="display:block;font-size:12px;color:var(--text-secondary,#aaa);margin-bottom:4px">Markdown file</label>
                            <input type="file" accept=".md,.markdown" style="width:100%;padding:6px 8px;font-size:13px;border:1px solid var(--border-color,#444);border-radius:4px;background:var(--bg-secondary,#2a2a2a);color:var(--text-primary,#ccc);box-sizing:border-box" />
                        </div>
                        <div>
                            <label style="display:block;font-size:12px;color:var(--text-secondary,#aaa);margin-bottom:4px">Tags (space-separated, max ${MAX_TAGS})</label>
                            <input type="text" placeholder="e.g. user-manual onboarding tutorial" style="width:100%;padding:6px 8px;font-size:13px;border:1px solid var(--border-color,#444);border-radius:4px;background:var(--bg-secondary,#2a2a2a);color:var(--text-primary,#ccc);outline:none;box-sizing:border-box" />
                            <div data-role="preview" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;min-height:22px"></div>
                            <div data-role="hint" style="font-size:11px;color:var(--text-secondary,#888);margin-top:4px">Type tags above to preview. At least one tag required.</div>
                        </div>`;
                    panel.content.innerHTML = '';
                    panel.content.appendChild(wrap);

                    const fileInput = wrap.querySelector('input[type="file"]');
                    const tagInput = wrap.querySelector('input[type="text"]');
                    const previewEl = wrap.querySelector('[data-role="preview"]');
                    const hintEl = wrap.querySelector('[data-role="hint"]');
                    const confirmBtn = panel.footer.querySelector('.modal-confirm');
                    const cancelBtn = panel.footer.querySelector('.modal-cancel');

                    function parsedTags() {
                        const seen = [];
                        for (const tok of tagInput.value.split(/\s+/)) {
                            const t = tok.trim();
                            if (t && !seen.includes(t)) seen.push(t);
                        }
                        return seen;
                    }

                    function refreshState() {
                        const tags = parsedTags();
                        previewEl.innerHTML = tags.map((t, i) => {
                            const tooMany = i >= MAX_TAGS;
                            const bg = tooMany ? '#5a2a2e' : 'var(--bg-tertiary, #333)';
                            const color = tooMany ? '#f85149' : 'var(--text-primary, #ddd)';
                            const border = tooMany ? '1px solid #f85149' : '1px solid var(--border-color, #444)';
                            return `<span style="background:${bg};color:${color};border:${border};border-radius:10px;padding:2px 8px;font-size:11px;font-family:ui-monospace,monospace">${esc(t)}</span>`;
                        }).join('');
                        const file = fileInput.files?.[0] || null;
                        let valid = true; let hint = '';
                        if (!file) { valid = false; hint = 'Choose a markdown file.'; }
                        else if (!tags.length) { valid = false; hint = 'At least one tag is required.'; }
                        else if (tags.length > MAX_TAGS) { valid = false; hint = `Too many tags (${tags.length}/${MAX_TAGS}). Trim the list.`; }
                        else { hint = `${tags.length} tag${tags.length === 1 ? '' : 's'} - ready to upload "${file.name}".`; }
                        hintEl.textContent = hint;
                        hintEl.style.color = valid ? 'var(--text-secondary,#888)' : '#f85149';
                        confirmBtn.disabled = !valid;
                    }

                    function esc(s) {
                        return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                    }

                    fileInput.addEventListener('change', refreshState);
                    tagInput.addEventListener('input', refreshState);
                    tagInput.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter' && !confirmBtn.disabled) { confirmBtn.click(); }
                        if (e.key === 'Escape') panel.close();
                    });
                    cancelBtn.addEventListener('click', () => panel.close());
                    confirmBtn.addEventListener('click', () => {
                        const tags = parsedTags();
                        const file = fileInput.files?.[0] || null;
                        if (!file || !tags.length || tags.length > MAX_TAGS) return;
                        resolved = true;
                        resolve({ file, tags });
                        panel.close();
                    });

                    refreshState();
                    setTimeout(() => fileInput.focus(), 50);
                },
            });
        });
    }

    // ── Public API ──────────────────────────────────────────────────

    return {
        dismissContextMenu,
        showContextMenu,
        // Exposed for top bar actions and detail views
        ctxCreateEntry,
        ctxDeleteEntry,
        ctxRenameEntry,
        ctxDeleteProject,
        ctxDeleteEnv,
        ctxStopRun,
        ctxDeleteRun,
        ctxDeleteExperiment,
        ctxDeleteDocument,
        // Exposed so the top-level Tools menu can trigger the same unified
        // upload flow used by the right-click context menus on per-Domain
        // nodes. Single ingest endpoint covers vector + graph; the modal
        // asks for destination Domain + mode (read_only / read_store).
        uploadDocumentToDomain,
    };

    async function ctxRunPythonFile(rootType, rootName, relPath) {
        const socket = ctx.callbacks.getSocket?.();
        if (!socket) { notify.error('No connection to server'); return; }

        if (!ctx.activeVenvName) {
            notify.warning('Activate a environment first');
            return;
        }

        const repoPath = rootType === 'mount'
            ? `/app/mounts/${rootName}`
            : `/app/data/projects/${rootName}`;
        const fileName = relPath.split('/').pop();
        const pythonCmd = `/app/data/environments/${ctx.activeVenvRuntimeId || 'python/3.12'}/${ctx.activeVenvName}/bin/python`;
        const label = `${fileName} (${ctx.activeVenvName})`;
        const command = `${pythonCmd} ${relPath}`;

        openProjectTerminal(socket, repoPath, label, {
            initialCommand: command,
            panelIcon: 'fa-play',
            panelIconColor: '#4caf50',
        });
    }

    // ── DAG Template Dialog ──────────────────────────────────────

    async function _showDagTemplateDialog(projectId) {
        const { modalForm, modalError } = await import('../../modal.js');

        // Fetch templates
        let templates = [];
        try {
            const resp = await fetch('api/airflow/templates');
            if (resp.ok) {
                const data = await resp.json();
                templates = data.templates || [];
            }
        } catch {}

        if (!templates.length) {
            templates = [
                { key: 'blank', label: 'Blank DAG' },
                { key: 'training', label: 'Training Pipeline' },
                { key: 'data', label: 'Data Pipeline' },
                { key: 'parallel', label: 'Parallel Pipeline' },
            ];
        }

        const fields = [
            {
                key: 'dag_id',
                label: 'DAG ID',
                placeholder: 'my_training_pipeline',
                required: true,
            },
            {
                key: 'template',
                label: 'Template',
                type: 'select',
                options: templates.map(t => ({ value: t.key, label: t.label + (t.description ? ` - ${t.description}` : '') })),
                required: true,
            },
        ];

        const result = await modalForm(fields, { title: 'New DAG from Template', confirmText: 'Create' });
        if (!result) return;

        try {
            const resp = await fetch('api/airflow/dags/create-from-template', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    project_id: projectId,
                    template: result.template,
                    dag_id: result.dag_id,
                }),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed');
            }
            const data = await resp.json();
            notify.success(`DAG created: ${data.path}`);

            // Refresh the project tree node to show new file
            const projectKey = `project:${projectId}`;
            const projectNode = ctx.tree?.findKey(projectKey);
            if (projectNode) {
                projectNode.resetLazy();
                projectNode.setExpanded(true);
            }
        } catch (err) {
            modalError(err.message);
        }
    }
}
