/**
 * DecorationService — provides status decorations (dots) for explorer tree nodes.
 *
 * Maintains a Map<nodeKey, decoration> built from git status data.
 * Bubbles file-level decorations up to ancestor directories and project/mount roots.
 * Designed to be extensible for DVC and other decoration sources.
 */

const STATUS_COLORS = {
    modified:  '#c8870a',
    changed:   '#c8870a',
    added:     '#2ea44f',
    untracked: '#2ea44f',
    deleted:   '#c74e39',
    renamed:   '#6b5acd',
};

const STATUS_PRIORITY = { deleted: 3, modified: 2, changed: 2, renamed: 1, added: 1, untracked: 0 };

const STATUS_LETTERS = {
    modified:  'M',
    changed:   'M',
    added:     'A',
    untracked: 'U',
    deleted:   'D',
    renamed:   'R',
};

// DVC decorations — higher priority so they win over git for data files
const DVC_COLORS = {
    tracked: '#1a7f9b',   // teal — DVC-tracked and in sync
    changed: '#c8870a',   // amber — DVC-tracked but changed
    new:     '#6b5acd',   // purple — newly tracked, not yet pushed
};
const DVC_PRIORITY = { changed: 5, new: 4, tracked: 3 };
const DVC_LETTERS = { tracked: 'T', changed: 'M', new: 'N' };

export class DecorationService {
    /**
     * @param {function} onUpdate - called when decorations change; triggers tree repaint
     */
    constructor(onUpdate) {
        /** @type {Map<string, {source:string, status:string, color:string, ancestor:boolean}>} */
        this._decorations = new Map();
        /** @type {Map<string, Set<string>>} repo → set of node keys, for efficient cleanup */
        this._repoKeys = new Map();
        this._onUpdate = onUpdate || (() => {});
    }

    /**
     * Fetch git status for all repos and rebuild decoration map.
     * Called at startup and on manual refresh.
     */
    async refreshAll() {
        try {
            const [repoRes, rootsRes] = await Promise.all([
                fetch('api/files/git/repos'),
                fetch('api/files/'),
            ]);
            if (!repoRes.ok) return;

            const repos = await repoRes.json();
            const roots = rootsRes.ok ? await rootsRes.json() : {};

            // Build a name→root_type map from projects+mounts
            const nameMap = new Map();
            for (const p of (roots.projects || [])) {
                const name = p.id || p.name;
                nameMap.set(`/app/data/projects/${name}`, { root_type: 'project', root_name: name });
            }
            for (const m of (roots.mounts || [])) {
                nameMap.set(`/app/mounts/${m.name}`, { root_type: 'mount', root_name: m.name });
            }

            // Fetch status for each git repo in parallel
            const statusPromises = repos.map(async (repo) => {
                const info = nameMap.get(repo.abs_path) || {
                    root_type: repo.root_type || 'project',
                    root_name: repo.root_name || repo.label,
                };
                try {
                    const res = await fetch('api/git/repo/status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ repo_path: repo.abs_path }),
                    });
                    if (!res.ok) return;
                    const status = await res.json();
                    this._applyRepoStatus(repo.abs_path, info, status);
                } catch { /* skip failed repos */ }
            });

            await Promise.allSettled(statusPromises);

            // Fetch DVC status for each repo in parallel
            const dvcPromises = repos.map(async (repo) => {
                const info = nameMap.get(repo.abs_path) || {
                    root_type: repo.root_type || 'project',
                    root_name: repo.root_name || repo.label,
                };
                try {
                    const res = await fetch('api/dvc/status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ repo_path: repo.abs_path }),
                    });
                    if (!res.ok) return;
                    const dvcData = await res.json();
                    if (dvcData.initialized) {
                        this._applyDvcRepoStatus(repo.abs_path, info, dvcData);
                    }
                } catch { /* skip */ }
            });
            await Promise.allSettled(dvcPromises);

            this._onUpdate();

            // Async: fetch DVC cloud status for sync icons (non-blocking)
            this._fetchCloudStatus(repos, nameMap);
        } catch { /* fail silently */ }
    }

    /**
     * Update decorations for a single repo using status data from GitPanel.
     * @param {string} repoPath - absolute repo path
     * @param {{root_type:string, root_name:string}} repoInfo
     * @param {{files:Array}} statusData - response from /api/git/repo/status
     */
    updateRepoStatus(repoPath, repoInfo, statusData) {
        this._applyRepoStatus(repoPath, repoInfo, statusData);
        this._onUpdate();
    }

    /**
     * Get decoration for a node key, or null.
     */
    getDecoration(nodeKey) {
        return this._decorations.get(nodeKey) || null;
    }

    /**
     * Short tooltip text for a decoration. Used on hover.
     */
    getStatusTooltip(deco) {
        if (!deco) return '';
        if (deco.source === 'dvc') {
            if (deco.status === 'changed') return 'DVC: changed (not re-added)';
            if (deco.status === 'new') return 'DVC: new (not pushed)';
            if (deco.syncIcon === 'cloud-up') return 'DVC: tracked, not pushed';
            if (deco.syncIcon === 'cloud-check') return 'DVC: tracked, pushed';
            return 'DVC: tracked';
        }
        const gitLabels = {
            modified: 'Modified',
            changed: 'Modified',
            added: 'Added',
            untracked: 'Untracked',
            deleted: 'Deleted',
            renamed: 'Renamed',
        };
        return gitLabels[deco.status] || 'Changed';
    }

    /**
     * Clear all decorations.
     */
    clear() {
        this._decorations.clear();
        this._repoKeys.clear();
    }

    /**
     * Update DVC decorations for a single repo.
     * @param {string} repoPath - absolute repo path
     * @param {{root_type:string, root_name:string}} repoInfo
     * @param {{initialized:boolean, tracked_files:Array, changed_files:Array}} dvcData
     */
    updateDvcStatus(repoPath, repoInfo, dvcData) {
        this._applyDvcRepoStatus(repoPath, repoInfo, dvcData);
        this._onUpdate();
    }

    // ── Internal ──────────────────────────────────────────────────────

    _applyRepoStatus(repoPath, repoInfo, statusData) {
        // Remove old keys for this repo
        const oldKeys = this._repoKeys.get(repoPath);
        if (oldKeys) {
            for (const k of oldKeys) this._decorations.delete(k);
        }

        const newKeys = new Set();
        const { root_name } = repoInfo;
        // Tree nodes always use 'p'/'project:' prefixes, even for mounts.
        const prefix = 'p';
        const files = statusData?.files || [];

        // Track highest-priority status per ancestor for color bubbling
        const ancestorPriority = new Map(); // key → { priority, status }

        for (const f of files) {
            const filePath = f.path;
            const status = f.label || 'modified';
            const color = STATUS_COLORS[status] || STATUS_COLORS.modified;
            const fileKey = `${prefix}file:${root_name}:${filePath}`;

            // Direct file decoration
            const letter = STATUS_LETTERS[status] || '';
            this._decorations.set(fileKey, { source: 'git', status, color, letter, ancestor: false });
            newKeys.add(fileKey);

            // Bubble up to ancestor directories
            const parts = filePath.split('/');
            for (let i = parts.length - 1; i >= 1; i--) {
                const dirPath = parts.slice(0, i).join('/');
                const dirKey = `${prefix}dir:${root_name}:${dirPath}`;
                const pri = STATUS_PRIORITY[status] ?? 0;
                const existing = ancestorPriority.get(dirKey);
                if (!existing || pri > existing.priority) {
                    ancestorPriority.set(dirKey, { priority: pri, status, color });
                }
                newKeys.add(dirKey);
            }

            // Bubble up to project/mount root (tree uses 'project:' for both)
            const rootKey = `project:${root_name}`;
            const pri = STATUS_PRIORITY[status] ?? 0;
            const existing = ancestorPriority.get(rootKey);
            if (!existing || pri > existing.priority) {
                ancestorPriority.set(rootKey, { priority: pri, status, color });
            }
            newKeys.add(rootKey);
        }

        // Apply ancestor decorations
        for (const [key, { status, color }] of ancestorPriority) {
            this._decorations.set(key, { source: 'git', status, color, ancestor: true });
        }

        this._repoKeys.set(repoPath, newKeys);
    }

    _applyDvcRepoStatus(repoPath, repoInfo, dvcData) {
        if (!dvcData?.initialized) return;

        const dvcRepoKey = `dvc:${repoPath}`;
        const oldKeys = this._repoKeys.get(dvcRepoKey);
        if (oldKeys) {
            for (const k of oldKeys) {
                const existing = this._decorations.get(k);
                // Only remove DVC-sourced decorations
                if (existing && existing.source === 'dvc') this._decorations.delete(k);
            }
        }

        const newKeys = new Set();
        const { root_name } = repoInfo;
        // Tree nodes always use 'p'/'project:' prefixes, even for mounts.
        const prefix = 'p';

        // Build a set of changed DVC file paths for quick lookup
        const changedSet = new Set();
        for (const c of (dvcData.changed_files || [])) {
            // changed_files items have dvc_file like "data/train.csv.dvc"
            const base = (c.dvc_file || '').replace(/\.dvc$/, '');
            if (base) changedSet.add(base);
        }

        const ancestorPriority = new Map();

        for (const tf of (dvcData.tracked_files || [])) {
            const filePath = tf.path;
            const isChanged = changedSet.has(filePath);
            const status = isChanged ? 'changed' : 'tracked';
            const color = isChanged ? DVC_COLORS.changed : DVC_COLORS.tracked;
            const fileKey = `${prefix}file:${root_name}:${filePath}`;
            const priority = DVC_PRIORITY[status] ?? 0;

            // DVC decorations overwrite git for the same key (data files are .gitignored)
            const letter = DVC_LETTERS[status] || '';
            this._decorations.set(fileKey, { source: 'dvc', status, color, letter, ancestor: false });
            newKeys.add(fileKey);

            // Bubble to ancestor directories
            const parts = filePath.split('/');
            for (let i = parts.length - 1; i >= 1; i--) {
                const dirPath = parts.slice(0, i).join('/');
                const dirKey = `${prefix}dir:${root_name}:${dirPath}`;
                const existing = ancestorPriority.get(dirKey);
                if (!existing || priority > existing.priority) {
                    ancestorPriority.set(dirKey, { priority, status, color });
                }
                newKeys.add(dirKey);
            }

            // Bubble to root (tree uses 'project:' for both)
            const rootKey = `project:${root_name}`;
            const existing = ancestorPriority.get(rootKey);
            if (!existing || priority > existing.priority) {
                ancestorPriority.set(rootKey, { priority, status, color });
            }
            newKeys.add(rootKey);
        }

        // Apply ancestor decorations — only overwrite if DVC priority is higher
        for (const [key, { status, color, priority }] of ancestorPriority) {
            const existing = this._decorations.get(key);
            if (!existing || existing.source === 'dvc' ||
                (DVC_PRIORITY[status] ?? 0) > (STATUS_PRIORITY[existing.status] ?? 0)) {
                this._decorations.set(key, { source: 'dvc', status, color, ancestor: true });
            }
        }

        this._repoKeys.set(dvcRepoKey, newKeys);
    }

    async _fetchCloudStatus(repos, nameMap) {
        try {
            const promises = repos.map(async (repo) => {
                const info = nameMap.get(repo.abs_path) || {
                    root_type: repo.root_type || 'project',
                    root_name: repo.root_name || repo.label,
                };
                try {
                    const res = await fetch('api/dvc/cloud-status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ repo_path: repo.abs_path }),
                    });
                    if (!res.ok) return;
                    const data = await res.json();
                    const notPushed = data.files || {};
                    const { root_name } = info;

                    // Update existing DVC decorations with sync icon
                    for (const [key, deco] of this._decorations) {
                        if (deco.source !== 'dvc' || deco.ancestor) continue;
                        // Extract file path from key like "pfile:project:data/train.csv"
                        const match = key.match(/^[mp]file:(.+?):(.+)$/);
                        if (!match || match[1] !== root_name) continue;
                        const filePath = match[2];
                        deco.syncIcon = (filePath in notPushed) ? 'cloud-up' : 'cloud-check';
                    }
                } catch { /* skip */ }
            });
            await Promise.allSettled(promises);
            this._onUpdate();
        } catch { /* non-critical */ }
    }
}
