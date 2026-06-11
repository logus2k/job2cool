/**
 * ExplorerStorageViews - Storage (MinIO/S3) detail views and tree data loaders.
 */

import { iconPathForFile, FOLDER_ICON } from '../../file-icons.js';
import {
    createDetailHeader, addParentLabel, addMetaRow, escapeHtml, formatSize,
} from './ExplorerHelpers.js';

/**
 * @param {object} ctx - Shared explorer context (getters for live state).
 * @returns {object} View methods for MinIO storage browsing.
 */
export function createStorageViews(ctx) {

    async function loadStorageBuckets() {
        try {
            const resp = await fetch('api/minio/buckets');
            if (!resp.ok) return [];
            const data = await resp.json();
            return (data.buckets || []).map(b => ({
                title: b.name,
                key: `bucket:${b.name}`,
                icon: 'fa-solid fa-bucket',
                folder: true,
                lazy: true,
            }));
        } catch {
            return [];
        }
    }

    async function loadStorageObjects(nodeKey) {
        let bucket, prefix;
        if (nodeKey.startsWith('bucket:')) {
            bucket = nodeKey.substring(7);
            prefix = '';
        } else {
            const rest = nodeKey.substring(9);
            const idx = rest.indexOf(':');
            bucket = rest.substring(0, idx);
            prefix = rest.substring(idx + 1);
        }
        try {
            const resp = await fetch('api/minio/objects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bucket, prefix }),
            });
            if (!resp.ok) return [];
            const data = await resp.json();
            const nodes = [];
            for (const f of (data.folders || [])) {
                nodes.push({
                    title: f.name,
                    key: `s3folder:${bucket}:${f.prefix}`,
                    icon: FOLDER_ICON,
                    folder: true,
                    lazy: true,
                });
            }
            for (const obj of (data.objects || [])) {
                nodes.push({
                    title: obj.name,
                    key: `s3obj:${bucket}:${obj.key}`,
                    icon: iconPathForFile(obj.name),
                });
            }
            return nodes;
        } catch {
            return [];
        }
    }

    function showStorageRootDetail() {
        ctx.detailEl.innerHTML = '';
        

        const header = createDetailHeader('Storage', 'fa-solid fa-database');
        ctx.detailEl.appendChild(header);

        const desc = document.createElement('div');
        desc.className = 'explorer-info-row';
        desc.style.marginBottom = '12px';
        desc.style.color = 'var(--text-secondary)';
        desc.style.fontSize = '12px';
        desc.textContent = 'MinIO object storage - browse buckets and objects pushed via DVC or uploaded directly.';
        ctx.detailEl.appendChild(desc);

        const statsEl = document.createElement('div');
        statsEl.className = 'storage-stats';
        statsEl.innerHTML = '<span style="color:var(--text-tertiary);font-size:12px">Loading...</span>';
        ctx.detailEl.appendChild(statsEl);

        fetch('api/minio/buckets').then(async (resp) => {
            if (!resp.ok) {
                statsEl.innerHTML = '<span style="color:#c74e39;font-size:12px">Failed to connect to MinIO</span>';
                return;
            }
            const data = await resp.json();
            const buckets = data.buckets || [];
            statsEl.innerHTML = '';
            const countRow = document.createElement('div');
            countRow.className = 'explorer-info-row';
            countRow.innerHTML = `<span class="explorer-info-label">Buckets (${buckets.length})</span>`;
            statsEl.appendChild(countRow);

            for (const b of buckets) {
                const row = document.createElement('div');
                row.className = 'storage-bucket-row';
                row.innerHTML = `<i class="fa-solid fa-bucket storage-bucket-icon"></i><span>${escapeHtml(b.name)}</span>`;
                statsEl.appendChild(row);

                fetch('api/minio/bucket-stats', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ bucket: b.name }),
                }).then(async (r) => {
                    if (!r.ok) return;
                    const stats = await r.json();
                    const badge = document.createElement('span');
                    badge.className = 'storage-bucket-stats';
                    badge.textContent = `${stats.total_objects} objects - ${formatSize(stats.total_size)}`;
                    row.appendChild(badge);
                }).catch(() => {});
            }
        }).catch(() => {
            statsEl.innerHTML = '<span style="color:#c74e39;font-size:12px">Failed to connect to MinIO</span>';
        });
    }

    async function showBucketDetail(bucketName) {
        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, 'Storage');

        const header = createDetailHeader(bucketName, 'fa-solid fa-bucket');
        ctx.detailEl.appendChild(header);

        const card = document.createElement('div');
        card.className = 's3-object-card';
        card.innerHTML = '<div class="s3-object-loading">Loading stats...</div>';
        ctx.detailEl.appendChild(card);

        try {
            const resp = await fetch('api/minio/bucket-stats', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bucket: bucketName }),
            });
            if (!resp.ok) throw new Error('Failed');
            const stats = await resp.json();
            card.innerHTML = '';

            const rows = [
                ['Objects', `${stats.total_objects}`],
                ['Total Size', formatSize(stats.total_size)],
            ];
            for (const [label, value] of rows) {
                const row = document.createElement('div');
                row.className = 's3-meta-row';
                row.innerHTML =
                    `<span class="s3-meta-label">${label}</span>` +
                    `<span class="s3-meta-value">${value}</span>`;
                card.appendChild(row);
            }
        } catch {
            card.innerHTML = '<div class="s3-object-loading" style="color:#c74e39">Failed to load stats</div>';
        }
    }

    function showS3FolderDetail(nodeKey) {
        const rest = nodeKey.substring(9);
        const idx = rest.indexOf(':');
        const bucket = rest.substring(0, idx);
        const prefix = rest.substring(idx + 1);
        const folderName = prefix.replace(/\/$/, '').split('/').pop();

        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, bucket);

        const header = createDetailHeader(folderName, 'fa-solid fa-folder');
        ctx.detailEl.appendChild(header);

        const card = document.createElement('div');
        card.className = 's3-object-card';

        const rows = [
            ['Bucket', escapeHtml(bucket), ''],
            ['Prefix', escapeHtml(prefix), 'mono'],
        ];
        for (const [label, value, cls] of rows) {
            const row = document.createElement('div');
            row.className = 's3-meta-row';
            row.innerHTML =
                `<span class="s3-meta-label">${label}</span>` +
                `<span class="s3-meta-value${cls ? ' ' + cls : ''}">${value}</span>`;
            card.appendChild(row);
        }

        ctx.detailEl.appendChild(card);
    }

    async function showS3ObjectDetail(nodeKey) {
        const rest = nodeKey.substring(6);
        const idx = rest.indexOf(':');
        const bucket = rest.substring(0, idx);
        const objKey = rest.substring(idx + 1);
        const objName = objKey.split('/').pop();

        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, bucket);

        const header = createDetailHeader(objName, iconPathForFile(objName));
        ctx.detailEl.appendChild(header);

        const card = document.createElement('div');
        card.className = 's3-object-card';
        card.innerHTML = '<div class="s3-object-loading">Loading metadata...</div>';
        ctx.detailEl.appendChild(card);

        try {
            const resp = await fetch('api/minio/object-metadata', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bucket, key: objKey }),
            });
            if (!resp.ok) throw new Error('Failed');
            const meta = await resp.json();
            card.innerHTML = '';

            const rows = [
                ['Bucket', escapeHtml(bucket), ''],
                ['Key', escapeHtml(objKey), 'mono'],
                ['Size', formatSize(meta.size), ''],
                ['Content Type', escapeHtml(meta.content_type || 'unknown'), ''],
                ['Modified', meta.modified ? new Date(meta.modified).toLocaleString() : '-', ''],
                ['ETag', escapeHtml(meta.etag), 'mono'],
            ];

            for (const [label, value, cls] of rows) {
                const row = document.createElement('div');
                row.className = 's3-meta-row';
                row.innerHTML =
                    `<span class="s3-meta-label">${label}</span>` +
                    `<span class="s3-meta-value${cls ? ' ' + cls : ''}">${value}</span>`;
                card.appendChild(row);
            }

            const customMeta = meta.metadata || {};
            const customKeys = Object.keys(customMeta);
            if (customKeys.length > 0) {
                const sep = document.createElement('div');
                sep.className = 's3-meta-section-title';
                sep.textContent = 'Custom Metadata';
                card.appendChild(sep);
                for (const k of customKeys) {
                    const row = document.createElement('div');
                    row.className = 's3-meta-row';
                    row.innerHTML =
                        `<span class="s3-meta-label">${escapeHtml(k)}</span>` +
                        `<span class="s3-meta-value">${escapeHtml(customMeta[k])}</span>`;
                    card.appendChild(row);
                }
            }
        } catch {
            card.innerHTML = '<div class="s3-object-loading" style="color:#c74e39">Failed to load metadata</div>';
        }
    }

    return {
        loadStorageBuckets,
        loadStorageObjects,
        showStorageRootDetail,
        showBucketDetail,
        showS3FolderDetail,
        showS3ObjectDetail,
    };
}
