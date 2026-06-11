/**
 * ExplorerDataViews - Data (DVC) detail views and tree data loaders.
 */

import { notify } from '../../Notify.js';
import { modalConfirm, modalError } from '../../modal.js';
import { iconPathForFile } from '../../file-icons.js';
import {
    createDetailHeader, addParentLabel, addMetaRow, escapeHtml, formatSize,
} from './ExplorerHelpers.js';

/**
 * @param {object} ctx - Shared explorer context (getters for live state).
 * @returns {object} View methods for DVC data browsing.
 */
export function createDataViews(ctx) {

    // Per-key cache of tracked-file metadata (size, hash, rootType, rootName).
    // Populated when loadDataFiles runs; consumed by showDataFileDetail.
    // Avoids relying on Wunderbaum's node.data access which was producing
    // alternating (populated vs empty) results on repeat clicks.
    const _dataFileMeta = new Map();

    async function loadDataCollections() {
        try {
            const resp = await fetch('api/dvc/data-overview');
            if (!resp.ok) return [];
            const collections = await resp.json();
            if (!collections.length) return [{ title: 'No DVC-tracked data found', key: 'data-empty', icon: 'fa-solid fa-circle-info' }];
            return collections.map(col => ({
                title: `${col.name}`,
                key: `datacol:${col.root_type}:${col.name}`,
                icon: 'fa-solid fa-clipboard-list',
                folder: true,
                lazy: true,
                _data: col,
            }));
        } catch { return []; }
    }

    async function loadDataFiles(nodeKey) {
        const rest = nodeKey.substring(8); // remove 'datacol:'
        const idx = rest.indexOf(':');
        const rootType = rest.substring(0, idx);
        const rootName = rest.substring(idx + 1);
        try {
            const resp = await fetch('api/dvc/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repo_path: `/app/${rootType === 'mount' ? 'mounts' : 'data/projects'}/${rootName}` }),
            });
            if (!resp.ok) return [];
            const data = await resp.json();
            const tracked = data.tracked_files || [];
            if (!tracked.length) return [{ title: 'No tracked files', key: 'data-empty-files', icon: 'fa-solid fa-circle-info' }];
            return tracked.map(tf => {
                const key = `datafile:${rootType}:${rootName}:${tf.path}`;
                _dataFileMeta.set(key, { ...tf, rootType, rootName });
                return {
                    title: tf.path,
                    key,
                    icon: iconPathForFile(tf.path),
                };
            });
        } catch { return []; }
    }

    function showDataFileDetail(nodeKey) {
        const rest = nodeKey.substring(9); // remove 'datafile:'
        const parts = rest.split(':');
        const rootType = parts[0];
        const rootName = parts[1];
        const filePath = parts.slice(2).join(':');
        const dvcFile = filePath + '.dvc';
        const repoPath = `/app/${rootType === 'mount' ? 'mounts' : 'data/projects'}/${rootName}`;

        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, 'Data Catalog');

        const header = createDetailHeader(filePath, iconPathForFile(filePath));
        ctx.detailEl.appendChild(header);

        // File info card (reuses s3-object-card pattern)
        const tf = _dataFileMeta.get(nodeKey) || {};
        const card = document.createElement('div');
        card.className = 's3-object-card';
        if (tf.size) addMetaRow(card, 'Size', formatSize(tf.size));
        if (tf.hash) addMetaRow(card, 'MD5', `<span style="font-family:var(--font-mono);font-size:11px">${escapeHtml(tf.hash)}</span>`);
        addMetaRow(card, 'Source', `${escapeHtml(rootName)} <span style="color:#888">(${rootType})</span>`);
        addMetaRow(card, 'DVC File', `<span style="font-family:var(--font-mono);font-size:11px">${escapeHtml(dvcFile)}</span>`);
        ctx.detailEl.appendChild(card);

        // Version history section
        const historySection = document.createElement('div');
        historySection.style.cssText = 'margin-top:16px;padding:0 8px';
        historySection.innerHTML = '<div class="s3-object-loading">Loading version history...</div>';
        ctx.detailEl.appendChild(historySection);

        fetch('api/dvc/file-history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repo_path: repoPath, dvc_file: dvcFile }),
        }).then(r => r.ok ? r.json() : { versions: [] }).then(data => {
            const versions = data.versions || [];
            historySection.innerHTML = '';

            const titleEl = document.createElement('div');
            titleEl.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin-bottom:10px';
            titleEl.textContent = `Version History (${versions.length})`;
            historySection.appendChild(titleEl);

            if (!versions.length) {
                const empty = document.createElement('div');
                empty.style.cssText = 'color:#999;font-size:12px';
                empty.textContent = 'No version history found';
                historySection.appendChild(empty);
                return;
            }

            const currentHash = tf.hash || '';
            const list = document.createElement('div');
            list.className = 's3-object-card';
            versions.forEach((v, i) => {
                const isCurrent = v.md5 && currentHash && v.md5 === currentHash;
                const dateStr = v.date ? new Date(v.date).toLocaleDateString('en-CA') : '';
                const shortHash = v.short_hash || v.commit_hash?.substring(0, 7) || '';

                const row = document.createElement('div');
                row.className = 's3-meta-row';
                row.style.cssText = 'align-items:center;gap:8px;padding:8px 12px';

                if (isCurrent) {
                    row.innerHTML += '<span style="background:#1a7f9b;color:#fff;font-size:9px;padding:1px 6px;border-radius:3px;font-weight:600;letter-spacing:0.3px;flex-shrink:0">CURRENT</span>';
                }
                row.innerHTML += `<span style="font-family:var(--font-mono);font-size:11px;color:#555;flex-shrink:0">${escapeHtml(shortHash)}</span>`;
                row.innerHTML += `<span style="flex:1;color:#333;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(v.message || '')}</span>`;
                if (v.size) row.innerHTML += `<span style="color:#888;font-size:11px;white-space:nowrap;flex-shrink:0">${formatSize(v.size)}</span>`;
                row.innerHTML += `<span style="color:#888;font-size:11px;white-space:nowrap;flex-shrink:0">${dateStr}</span>`;

                if (!isCurrent) {
                    const btn = document.createElement('button');
                    btn.className = 'info-bar-text-btn';
                    btn.title = 'Checkout this version';
                    btn.style.cssText = 'padding:2px 8px;font-size:11px;border:0.5px solid #1a7f9b;border-radius:3px;color:#1a7f9b;cursor:pointer;background:#fff;white-space:nowrap;flex-shrink:0';
                    btn.innerHTML = '<i class="fa-solid fa-clock-rotate-left" style="font-size:10px;margin-right:3px"></i>Checkout';
                    btn.addEventListener('click', async () => {
                        const ok = await modalConfirm(`Switch ${filePath} to version ${shortHash}?`, { title: 'Checkout Version' });
                        if (!ok) return;
                        btn.disabled = true;
                        btn.textContent = 'Switching...';
                        try {
                            const resp = await fetch('api/dvc/checkout-version', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ repo_path: repoPath, dvc_file: dvcFile, commit_hash: v.commit_hash }),
                            });
                            if (!resp.ok) { const err = await resp.json(); throw new Error(err.detail || 'Failed'); }
                            const result = await resp.json();
                            notify.success(result.message || 'Switched version');
                            showDataFileDetail(nodeKey);
                        } catch (err) {
                            modalError(err.message);
                            btn.disabled = false;
                            btn.innerHTML = '<i class="fa-solid fa-clock-rotate-left" style="font-size:10px;margin-right:3px"></i>Checkout';
                        }
                    });
                    row.appendChild(btn);
                }

                list.appendChild(row);
            });
            historySection.appendChild(list);
        }).catch(() => {
            historySection.innerHTML = '<div style="color:#c00;font-size:12px">Failed to load version history</div>';
        });
    }

    function showDataRootDetail() {
        ctx.detailEl.innerHTML = '';
        

        const header = createDetailHeader('Data Catalog', 'fa-solid fa-cubes-stacked');
        ctx.detailEl.appendChild(header);

        const desc = document.createElement('div');
        desc.className = 'explorer-info-row';
        desc.style.marginBottom = '12px';
        desc.style.color = 'var(--text-secondary)';
        desc.style.fontSize = '12px';
        desc.textContent = 'DVC-tracked data files across all projects. Click a file to see metadata, version history, and checkout previous versions.';
        ctx.detailEl.appendChild(desc);

        const statsEl = document.createElement('div');
        statsEl.innerHTML = '<span style="color:var(--text-tertiary);font-size:12px">Loading...</span>';
        ctx.detailEl.appendChild(statsEl);

        fetch('api/dvc/data-overview').then(r => r.json()).then(data => {
            const collections = Array.isArray(data) ? data : (data.collections || []);
            const totalFiles = collections.reduce((sum, c) => sum + (c.files?.length || 0), 0);
            const totalSize = collections.reduce((sum, c) =>
                sum + (c.files || []).reduce((s, f) => s + (f.size || 0), 0), 0);
            statsEl.innerHTML = '';
            addMetaRow(statsEl, 'Projects with tracked data', `${collections.length}`);
            addMetaRow(statsEl, 'Tracked files', `${totalFiles}`);
            if (totalSize > 0) addMetaRow(statsEl, 'Total size', formatSize(totalSize));
        }).catch(() => {
            statsEl.innerHTML = '<span style="color:var(--text-tertiary);font-size:12px">No data available</span>';
        });
    }

    let _dataHealthStatus = null;

    async function updateDataHealthBadge() {
        try {
            const projectsResp = await fetch('api/evidently/projects');
            if (!projectsResp.ok) return;
            const projects = await projectsResp.json();
            if (!projects.length) return;

            let worstStatus = 'unknown';
            let summary = '';
            for (const p of projects) {
                const resp = await fetch(`api/evidently/projects/${p.id}/data-health`);
                if (!resp.ok) continue;
                const health = await resp.json();
                if (health.status === 'red') { worstStatus = 'red'; summary = health.summary; break; }
                if (health.status === 'yellow' && worstStatus !== 'red') { worstStatus = 'yellow'; summary = health.summary; }
                if (health.status === 'green' && worstStatus === 'unknown') { worstStatus = 'green'; summary = health.summary; }
            }
            if (worstStatus === 'unknown') return;
            _dataHealthStatus = { status: worstStatus, summary };
            applyDataHealthDot();
        } catch { /* Evidently not available */ }
    }

    function applyDataHealthDot() {
        if (!_dataHealthStatus) return;
        const colorMap = { green: '#4caf50', yellow: '#ff9800', red: '#f44336' };
        const rootNode = ctx.tree?.findKey('root-data');
        if (!rootNode) return;
        const row = rootNode.getRowElem?.() || rootNode._rowElem;
        if (!row) return;
        const titleEl = row.querySelector('.wb-title');
        if (!titleEl) return;
        titleEl.querySelector('.data-health-dot')?.remove();
        const dot = document.createElement('span');
        dot.className = 'data-health-dot';
        dot.title = _dataHealthStatus.summary;
        dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${colorMap[_dataHealthStatus.status]};margin-left:6px;vertical-align:middle`;
        titleEl.appendChild(dot);
    }

    return {
        loadDataCollections,
        loadDataFiles,
        showDataFileDetail,
        showDataRootDetail,
        updateDataHealthBadge,
        applyDataHealthDot,
    };
}
