import { notify } from './Notify.js';
import { modalConfirm, modalError } from './modal.js';
import { openProjectTerminal } from './ProjectTerminal.js';

/**
 * GitPanel — Sidebar "Source Control" view.
 * Multi-repo aware: discovers git repos across projects & mounts,
 * shows a repo selector dropdown with change-count badge.
 *
 * Sections: Author · Remote (GitHub) · Branches · Changes (commit) · History
 */
export class GitPanel {
    constructor() {
        this._repos = [];           // discovered repos from /api/files/git/repos
        this._activeRepoPath = localStorage.getItem('git_active_repo') || null;
        this._status = null;
        this._branches = null;
        this._remoteBranches = null;
        this._credentials = null;
        this._onCommitOpen = null;
        this._onFileDiscarded = null;
        this._onStatusRefreshed = null;
        this._onDvcStatusRefreshed = null;
        this._socket = null;
        this._dvcStatus = null;
        this._tags = null;

        // Persist section open/close across refreshes
        this._projectsOpen = true;
        this._authorOpen   = true;
        this._repoOpen     = true;
        this._remoteOpen   = true;
        this._changesOpen  = true;
        this._historyOpen  = true;
        this._dvcOpen      = true;
        this._tagsOpen     = true;

        // Author inputs
        this._nameInput  = null;
        this._emailInput = null;

        this._el = document.createElement('div');
        this._el.className = 'git-panel';
        this._build();
    }

    get element() { return this._el; }
    get titleElement() { return this._topbar; }

    setOnCommitOpen(cb) { this._onCommitOpen = cb; }
    setOnFileDiscarded(cb) { this._onFileDiscarded = cb; }
    setOnStatusRefreshed(cb) { this._onStatusRefreshed = cb; }
    setOnDvcStatusRefreshed(cb) { this._onDvcStatusRefreshed = cb; }
    setSocket(socket) { this._socket = socket; }
    get repos() { return this._repos; }

    /** Build a terminal action for modalError - reusable across all error handlers. */
    _terminalAction() {
        if (!this._socket || !this._activeRepoPath) return [];
        const label = this._activeRepoPath.split('/').pop();
        const socket = this._socket;
        const cwd = this._activeRepoPath;
        return [{ label: 'Open Terminal', icon: 'fa-solid fa-terminal', onClick: () => openProjectTerminal(socket, cwd, label) }];
    }

    /** Called by app.js — kept for backward compat but now triggers repo discovery. */
    setProject(projectId) {
        if (projectId) {
            this._activeProjectId = projectId;
            // Still need filesystem path for repo selection; get from repos list
            fetch('api/files/git/repos').then(r => r.json()).then(repos => {
                const match = repos.find(r => r.name === projectId || r.abs_path?.includes(projectId));
                if (match) {
                    this._activeRepoPath = match.abs_path;
                    localStorage.setItem('git_active_repo', match.abs_path);
                }
            }).catch(() => {});
        }
        this._discoverAndRefresh();
    }

    activate() { this._discoverAndRefresh(); }
    refresh()  { this._discoverAndRefresh(); }

    // --- Skeleton ---

    _build() {
        this._topbar = document.createElement('div');
        this._topbar.className = 'git-panel-topbar';

        // Left actions group
        const leftGroup = document.createElement('div');
        leftGroup.className = 'git-topbar-actions';

        // Terminal button
        this._terminalBtn = document.createElement('button');
        this._terminalBtn.className = 'git-panel-topbar-btn';
        this._terminalBtn.title = 'Open Terminal';
        this._terminalBtn.innerHTML = '<i class="fa-solid fa-window-maximize" style="font-size:12px;color:#6fa374"></i>';
        this._terminalBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._socket && this._activeRepoPath) {
                const label = this._activeRepoPath.split('/').pop();
                openProjectTerminal(this._socket, this._activeRepoPath, label);
            }
        });

        // Refresh button
        this._refreshBtn = document.createElement('button');
        this._refreshBtn.className = 'git-panel-topbar-btn';
        this._refreshBtn.title = 'Refresh';
        this._refreshBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;
        this._refreshBtn.addEventListener('click', (e) => { e.stopPropagation(); this._discoverAndRefresh(); });

        leftGroup.append(this._terminalBtn, this._refreshBtn);

        // Right status group: LED + label
        const rightGroup = document.createElement('div');
        rightGroup.className = 'git-topbar-status';

        this._connLed = document.createElement('span');
        this._connLed.className = 'git-topbar-led';

        this._connLabel = document.createElement('span');
        this._connLabel.className = 'git-topbar-conn-label';

        rightGroup.append(this._connLed, this._connLabel);

        this._topbar.append(leftGroup, rightGroup);

        // Repo selector (now used inside the Projects section, not in topbar)
        this._repoSelect = document.createElement('select');
        this._repoSelect.className = 'git-repo-select';
        this._repoSelect.addEventListener('change', () => {
            this._activeRepoPath = this._repoSelect.value || null;
            localStorage.setItem('git_active_repo', this._activeRepoPath || '');
            this._refreshActiveRepo();
        });

        this._changeBadge = document.createElement('span');
        this._changeBadge.className = 'git-repo-badge';
        this._changeBadge.style.display = 'none';

        this._body = document.createElement('div');
        this._body.className = 'git-panel-body';

        // _topbar is exposed via titleElement — sidebar injects it into the title bar
        this._el.appendChild(this._body);
    }

    _updateTopbarStatus() {
        const remoteUrl = this._status?.remote || '';
        const hasPat = this._credentials?.has_pat || false;
        if (remoteUrl) {
            let host = '';
            try {
                const u = new URL(remoteUrl);
                host = u.hostname;
            } catch {
                host = remoteUrl.includes('github.com') ? 'github.com'
                     : remoteUrl.includes('gitlab.com') ? 'gitlab.com' : '';
            }
            this._connLed.className = 'git-topbar-led connected';
            this._connLabel.textContent = host || 'Remote';
            this._connLabel.title = hasPat ? `${remoteUrl} (PAT saved)` : remoteUrl;
        } else {
            this._connLed.className = 'git-topbar-led disconnected';
            this._connLabel.textContent = 'No remote';
            this._connLabel.title = '';
        }
    }

    // --- Repo discovery + refresh ---

    async _discoverAndRefresh() {
        try {
            const [repoRes, rootsRes] = await Promise.all([
                fetch('api/files/git/repos'),
                fetch('api/files/'),
            ]);
            this._repos = repoRes.ok ? await repoRes.json() : [];

            // Include non-git projects/mounts so they can be initialized
            if (rootsRes.ok) {
                const roots = await rootsRes.json();
                const gitPaths = new Set(this._repos.map(r => r.abs_path));
                // Mark existing repos as git-initialized
                for (const r of this._repos) r.is_git = true;
                for (const p of (roots.projects || [])) {
                    const name = p.id || p.name;
                    const abs = `/app/data/projects/${name}`;
                    if (!gitPaths.has(abs)) {
                        this._repos.push({ abs_path: abs, root_type: 'project',
                            root_name: name, label: name, has_changes: false, is_git: false });
                    }
                }
                for (const m of (roots.mounts || [])) {
                    const abs = `/app/mounts/${m.name}`;
                    if (!gitPaths.has(abs)) {
                        this._repos.push({ abs_path: abs, root_type: 'mount',
                            root_name: m.name, label: m.name, has_changes: false, is_git: false });
                    }
                }
            }
        } catch (e) {
            this._repos = [];
        }

        this._buildRepoSelector();

        // Always refresh the active repo (or show projects-only view)
        this._refreshActiveRepo();
    }

    _buildRepoSelector() {
        if (this._repos.length === 0) {
            this._activeRepoPath = null;
            return;
        }

        // If saved repo no longer exists, pick first git repo (or first overall)
        const paths = this._repos.map(r => r.abs_path);
        if (!this._activeRepoPath || !paths.includes(this._activeRepoPath)) {
            const firstGit = this._repos.find(r => r.is_git !== false);
            this._activeRepoPath = firstGit ? firstGit.abs_path : paths[0];
            localStorage.setItem('git_active_repo', this._activeRepoPath);
        }
    }

    // --- Active repo refresh ---

    async _refreshActiveRepo() {
        if (!this._activeRepoPath) {
            this._body.innerHTML = '';
            this._body.appendChild(this._buildProjectsSection());
            this._connLabel.textContent = '';
            this._connLabel.className = 'git-topbar-conn-label';
            return;
        }

        // Check if selected repo is actually a git repo
        const activeRepo = this._repos.find(r => r.abs_path === this._activeRepoPath);
        if (activeRepo && activeRepo.is_git === false) {
            this._body.innerHTML = '';
            this._body.appendChild(this._buildProjectsSection());
            this._connLabel.textContent = '';
            this._connLabel.className = 'git-topbar-conn-label';
            return;
        }

        const rp = this._activeRepoPath;
        try {
            const [statusRes, branchRes, remoteBranchRes, credRes, tagRes] = await Promise.all([
                this._postJson('api/git/repo/status', { repo_path: rp }),
                this._postJson('api/git/repo/branches', { repo_path: rp }),
                this._postJson('api/git/repo/remote-branches', { repo_path: rp }),
                this._postJson('api/git/repo/credentials', { repo_path: rp }),
                this._postJson('api/git/repo/tags', { repo_path: rp }),
            ]);
            this._status = statusRes;
            this._branches = branchRes || { branches: [], current: null };
            this._remoteBranches = remoteBranchRes || { branches: [] };
            this._credentials = credRes || { has_pat: false, pat_hint: '' };
            this._tags = tagRes || { tags: [] };
        } catch (e) {
            this._body.innerHTML = '';
            this._body.appendChild(this._buildProjectsSection());
            this._renderError(e.message);
            return;
        }
        this._renderBody();

        // Notify decoration service of updated status
        if (this._onStatusRefreshed && this._status) {
            const activeRepo = this._repos.find(r => r.abs_path === this._activeRepoPath);
            if (activeRepo) {
                this._onStatusRefreshed(this._activeRepoPath, {
                    root_type: activeRepo.root_type || 'project',
                    root_name: activeRepo.root_name || activeRepo.label,
                }, this._status);
            }
        }

        // Fetch DVC status (non-blocking — section updates after)
        this._fetchDvcStatus();
    }

    async _fetchDvcStatus() {
        const rp = this._activeRepoPath;
        if (!rp) return;
        try {
            this._dvcStatus = await this._postJson('api/dvc/status', { repo_path: rp });
        } catch {
            this._dvcStatus = null;
        }

        // Render/update DVC section
        const existing = this._body.querySelector('.git-dvc-section-wrap');
        const newSection = this._buildDvcSection();
        if (existing) {
            existing.replaceWith(newSection);
        } else {
            this._body.appendChild(newSection);
        }

        // Notify decoration service
        if (this._onDvcStatusRefreshed && this._dvcStatus) {
            const activeRepo = this._repos.find(r => r.abs_path === this._activeRepoPath);
            if (activeRepo) {
                this._onDvcStatusRefreshed(this._activeRepoPath, {
                    root_type: activeRepo.root_type || 'project',
                    root_name: activeRepo.root_name || activeRepo.label,
                }, this._dvcStatus);
            }
        }
    }

    async _postJson(url, body) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            let msg = `HTTP ${res.status}`;
            if (typeof err.detail === 'string') msg = err.detail;
            else if (Array.isArray(err.detail)) msg = err.detail.map(d => d.msg || JSON.stringify(d)).join('; ');
            throw new Error(msg);
        }
        return res.json();
    }

    // --- Rendering ---

    async _renderNoRepo() {
        this._body.innerHTML = '';

        // Fetch available directories to offer git init
        let projects = [], mounts = [];
        try {
            const res = await fetch('api/files/');
            if (res.ok) {
                const data = await res.json();
                projects = data.projects || [];
                mounts = data.mounts || [];
            }
        } catch {}

        const dirs = [
            ...projects.map(p => ({ label: p.id, path: p.path })),
            ...mounts.map(m => ({ label: m.name, path: m.path })),
        ];

        if (dirs.length === 0) {
            const el = document.createElement('div');
            el.className = 'git-panel-empty';
            el.textContent = 'No projects or mounts found. Create a project first.';
            this._body.appendChild(el);
            return;
        }

        const msg = document.createElement('div');
        msg.className = 'git-panel-empty';
        msg.textContent = 'No git repositories found. Initialize one:';
        this._body.appendChild(msg);

        const list = document.createElement('div');
        list.className = 'git-init-list';
        for (const dir of dirs) {
            const row = document.createElement('div');
            row.className = 'git-init-row';

            const label = document.createElement('span');
            label.className = 'git-init-label';
            label.textContent = dir.label;

            const btn = document.createElement('button');
            btn.className = 'git-init-btn';
            btn.textContent = 'Init';
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.textContent = 'Initializing…';
                try {
                    const res = await fetch('api/git/repo/init', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ repo_path: dir.path }),
                    });
                    if (!res.ok) throw new Error(await res.text());
                    this._activeRepoPath = dir.path;
                    localStorage.setItem('git_active_repo', dir.path);
                    this._discoverAndRefresh();
                } catch (e) {
                    btn.disabled = false;
                    btn.textContent = 'Init';
                    modalError(e.message, { title: 'Init Failed' });
                }
            });

            row.append(label, btn);
            list.appendChild(row);
        }
        this._body.appendChild(list);
    }

    _renderBody() {
        this._body.innerHTML = '';

        // Projects section is always shown first
        this._body.appendChild(this._buildProjectsSection());

        this._updateTopbarStatus();

        if (!this._status?.initialized) {
            this._renderNotInit();
            return;
        }

        this._body.append(
            this._buildAuthorSection(),
            this._buildRemoteSection(),
            this._buildRepositorySection(),
            this._buildTagsSection(),
            this._buildChangesSection(),
            this._buildHistorySection(),
        );
    }

    _renderNotInit() {
        const msg = document.createElement('div');
        msg.className = 'git-panel-empty';
        msg.textContent = 'This directory is not a git repository.';

        const btn = document.createElement('button');
        btn.className = 'git-init-btn';
        btn.textContent = 'Initialize Repository';
        btn.addEventListener('click', () => this._initRepo());

        msg.appendChild(btn);
        this._body.appendChild(msg);
    }

    _renderInitPrompt(repo) {
        this._body.innerHTML = '';
        const msg = document.createElement('div');
        msg.className = 'git-panel-empty';
        msg.textContent = `"${repo.label}" is not a git repository.`;

        const btn = document.createElement('button');
        btn.className = 'git-init-btn';
        btn.style.marginTop = '8px';
        btn.textContent = 'Initialize Repository';
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = 'Initializing…';
            try {
                const res = await fetch('api/git/repo/init', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ repo_path: repo.abs_path }),
                });
                if (!res.ok) throw new Error(await res.text());
                this._activeRepoPath = repo.abs_path;
                localStorage.setItem('git_active_repo', repo.abs_path);
                this._discoverAndRefresh();
            } catch (e) {
                btn.disabled = false;
                btn.textContent = 'Initialize Repository';
                modalError(e.message, { title: 'Init Failed' });
            }
        });

        msg.appendChild(btn);
        this._body.appendChild(msg);
    }

    _renderError(msg) {
        this._body.innerHTML = '';
        const el = document.createElement('div');
        el.className = 'git-panel-empty';
        el.textContent = `Error: ${msg}`;
        this._body.appendChild(el);
    }

    // --- Section builder helper ---

    _buildSection(title, openKey, contentBuilder) {
        const wrap = document.createElement('div');

        const header = document.createElement('div');
        header.className = 'git-section-header';
        const chevron = document.createElement('span');
        chevron.className = `git-section-chevron ${this[openKey] ? 'open' : ''}`;
        chevron.textContent = '▶';
        header.append(chevron, title);

        const body = document.createElement('div');
        body.className = 'git-section-body';
        body.style.display = this[openKey] ? '' : 'none';
        contentBuilder(body);

        header.addEventListener('click', () => {
            this[openKey] = !this[openKey];
            chevron.classList.toggle('open', this[openKey]);
            body.style.display = this[openKey] ? '' : 'none';
        });

        wrap.append(header, body);
        return wrap;
    }

    // --- Projects section (repo selector) ---

    _buildProjectsSection() {
        const changedCount = this._repos.filter(r => r.has_changes).length;
        const title = changedCount > 0 ? `Projects (${changedCount})` : 'Projects';

        return this._buildSection(title, '_projectsOpen', (body) => {
            body.className += ' git-projects-section';

            // Repo list — each repo as a clickable row
            for (const repo of this._repos) {
                const row = document.createElement('div');
                row.className = 'git-project-row' +
                    (repo.abs_path === this._activeRepoPath ? ' active' : '');

                const icon = document.createElement('i');
                icon.className = repo.is_git !== false
                    ? 'fa-solid fa-code-branch' : 'fa-solid fa-folder';
                row.appendChild(icon);

                const label = document.createElement('span');
                label.className = 'git-project-label';
                label.textContent = repo.label;
                row.appendChild(label);

                if (repo.has_changes) {
                    const badge = document.createElement('span');
                    badge.className = 'git-project-badge';
                    badge.innerHTML = `<svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="#c07a00"/></svg>`;
                    row.appendChild(badge);
                }

                if (repo.is_git === false) {
                    const initBtn = document.createElement('button');
                    initBtn.className = 'git-project-init-btn';
                    initBtn.textContent = 'Init';
                    initBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        initBtn.disabled = true;
                        initBtn.textContent = '...';
                        try {
                            const res = await fetch('api/git/repo/init', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ repo_path: repo.abs_path }),
                            });
                            if (!res.ok) throw new Error(await res.text());
                            this._activeRepoPath = repo.abs_path;
                            localStorage.setItem('git_active_repo', repo.abs_path);
                            this._discoverAndRefresh();
                        } catch (err) {
                            initBtn.disabled = false;
                            initBtn.textContent = 'Init';
                            modalError(err.message, { title: 'Init Failed' });
                        }
                    });
                    row.appendChild(initBtn);
                }

                row.addEventListener('click', () => {
                    this._activeRepoPath = repo.abs_path;
                    localStorage.setItem('git_active_repo', repo.abs_path || '');
                    this._refreshActiveRepo();
                });

                body.appendChild(row);
            }

            if (this._repos.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'git-panel-empty';
                empty.style.padding = '8px 0';
                empty.textContent = 'No projects or mounts found.';
                body.appendChild(empty);
            }
        });
    }

    // --- 3.1 Author ---

    _buildAuthorSection() {
        return this._buildSection('Author', '_authorOpen', (body) => {
            body.className += ' git-author-section';

            this._nameInput = document.createElement('input');
            this._nameInput.className = 'git-author-input';
            this._nameInput.type = 'text';
            this._nameInput.placeholder = 'Name';
            this._nameInput.spellcheck = false;
            this._nameInput.value = localStorage.getItem('git_author_name') || '';
            this._nameInput.addEventListener('change', () =>
                localStorage.setItem('git_author_name', this._nameInput.value.trim()));

            this._emailInput = document.createElement('input');
            this._emailInput.className = 'git-author-input';
            this._emailInput.type = 'text';
            this._emailInput.placeholder = 'Email';
            this._emailInput.spellcheck = false;
            this._emailInput.value = localStorage.getItem('git_author_email') || '';
            this._emailInput.addEventListener('change', () =>
                localStorage.setItem('git_author_email', this._emailInput.value.trim()));

            const row = document.createElement('div');
            row.className = 'git-author-row';
            row.append(this._nameInput, this._emailInput);
            body.appendChild(row);
        });
    }

    // --- 3.2 Repository (Branches) ---

    _buildRepositorySection() {
        return this._buildSection('Branches', '_repoOpen', (body) => {
            body.className += ' git-repo-section';

            const localBranches = this._branches?.branches || [];
            const remoteBranches = this._remoteBranches?.branches || [];
            const current = this._branches?.current || this._status?.branch || '';

            // Branch row: selector + new-branch toggle
            const branchRow = document.createElement('div');
            branchRow.className = 'git-branch-row';

            const branchIcon = document.createElement('span');
            branchIcon.className = 'git-branch-icon';
            branchIcon.innerHTML = `<i class="fa-solid fa-code-branch"></i>`;

            const branchSelect = document.createElement('select');
            branchSelect.className = 'git-branch-select';

            if (localBranches.length === 0) {
                const opt = document.createElement('option');
                opt.textContent = current || 'main';
                branchSelect.appendChild(opt);
            } else {
                for (const b of localBranches) {
                    const opt = document.createElement('option');
                    opt.value = b;
                    opt.textContent = b;
                    if (b === current) opt.selected = true;
                    branchSelect.appendChild(opt);
                }
            }

            // Remote branches (filtered: skip those that match a local branch)
            const localSet = new Set(localBranches);
            const uniqueRemote = remoteBranches.filter(rb => {
                const short = rb.replace(/^origin\//, '');
                return !localSet.has(short);
            });
            if (uniqueRemote.length > 0) {
                const group = document.createElement('optgroup');
                group.label = 'Remote';
                for (const rb of uniqueRemote) {
                    const opt = document.createElement('option');
                    opt.value = rb;
                    opt.textContent = rb;
                    group.appendChild(opt);
                }
                branchSelect.appendChild(group);
            }

            branchSelect.addEventListener('change', () => {
                const val = branchSelect.value;
                const branch = val.startsWith('origin/') ? val.replace(/^origin\//, '') : val;
                this._checkout(branch, branchSelect);
            });

            const newBtn = document.createElement('button');
            newBtn.className = 'git-new-branch-btn';
            newBtn.title = 'New branch';
            newBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

            branchRow.append(branchIcon, branchSelect, newBtn);
            body.appendChild(branchRow);

            // Inline new-branch form (hidden by default)
            const newForm = document.createElement('div');
            newForm.className = 'git-new-branch-form';
            newForm.style.display = 'none';

            const newInput = document.createElement('input');
            newInput.className = 'git-author-input';
            newInput.type = 'text';
            newInput.placeholder = 'Branch name…';
            newInput.spellcheck = false;

            const createBtn = document.createElement('button');
            createBtn.className = 'git-commit-btn';
            createBtn.textContent = 'Create';

            newForm.append(newInput, createBtn);
            body.appendChild(newForm);

            newBtn.addEventListener('click', () => {
                const visible = newForm.style.display !== 'none';
                newForm.style.display = visible ? 'none' : '';
                if (!visible) newInput.focus();
            });

            createBtn.addEventListener('click', () =>
                this._createBranch(newInput.value.trim(), newInput, createBtn, newForm));

            newInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this._createBranch(newInput.value.trim(), newInput, createBtn, newForm);
                if (e.key === 'Escape') { newForm.style.display = 'none'; newInput.value = ''; }
            });
        });
    }

    // --- 3.3 Remote (GitHub) ---

    _buildRemoteSection() {
        const remoteUrl = this._status?.remote || '';
        const hasPat = this._credentials?.has_pat || false;
        const ahead = this._status?.ahead || 0;
        const behind = this._status?.behind || 0;

        return this._buildSection('Remote', '_remoteOpen', (body) => {
            body.className += ' git-remote-section';

            // Remote URL input
            const urlRow = document.createElement('div');
            urlRow.className = 'git-remote-row';

            const urlInput = document.createElement('input');
            urlInput.className = 'git-author-input';
            urlInput.type = 'text';
            urlInput.placeholder = 'https://github.com/user/repo.git';
            urlInput.spellcheck = false;
            urlInput.value = remoteUrl;

            const urlSaveBtn = document.createElement('button');
            urlSaveBtn.className = 'git-remote-save-btn';
            urlSaveBtn.title = 'Save remote URL';
            urlSaveBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
            urlSaveBtn.addEventListener('click', () => this._saveRemote(urlInput, urlSaveBtn));

            urlRow.append(urlInput, urlSaveBtn);
            body.appendChild(urlRow);

            // PAT input
            const patRow = document.createElement('div');
            patRow.className = 'git-remote-row';

            const patInput = document.createElement('input');
            patInput.className = 'git-author-input';
            patInput.type = 'password';
            patInput.placeholder = hasPat ? `PAT saved (${this._credentials.pat_hint})` : 'Personal Access Token';
            patInput.spellcheck = false;
            patInput.autocomplete = 'off';

            const patSaveBtn = document.createElement('button');
            patSaveBtn.className = 'git-remote-save-btn';
            patSaveBtn.title = 'Save PAT';
            patSaveBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
            patSaveBtn.addEventListener('click', () => this._savePat(patInput, patSaveBtn));

            patRow.append(patInput, patSaveBtn);
            body.appendChild(patRow);

            // Push / Pull / Fetch buttons
            const actionRow = document.createElement('div');
            actionRow.className = 'git-remote-actions';

            const fetchBtn = this._makeRemoteBtn('Fetch', _ICONS.fetch, () => this._doFetch(fetchBtn));
            const pullSplit = this._makePullSplitBtn(behind);
            const pushBtn = this._makeRemoteBtn(
                `Push${ahead ? ` (${ahead})` : ''}`,
                _ICONS.push,
                () => this._doPush(pushBtn),
                ahead > 0 ? 'git-badge-ahead' : ''
            );

            actionRow.append(fetchBtn, pullSplit, pushBtn);
            body.appendChild(actionRow);

            // Status line
            if (remoteUrl) {
                const statusLine = document.createElement('div');
                statusLine.className = 'git-remote-status';
                const parts = [];
                if (ahead) parts.push(`${ahead} ahead`);
                if (behind) parts.push(`${behind} behind`);
                statusLine.textContent = parts.length
                    ? parts.join(', ')
                    : 'Up to date';
                if (ahead || behind) statusLine.classList.add('has-changes');
                body.appendChild(statusLine);
            }
        });
    }

    _makePullSplitBtn(behind) {
        const wrapper = document.createElement('div');
        wrapper.className = 'git-split-btn-wrapper';
        if (behind > 0) wrapper.classList.add('git-badge-behind');

        const mainBtn = document.createElement('button');
        mainBtn.className = 'git-remote-btn git-split-main';
        mainBtn.innerHTML = `${_ICONS.pull}<span>Pull${behind ? ` (${behind})` : ''}</span>`;
        mainBtn.addEventListener('click', () => this._doPull(mainBtn, 'ff-only'));

        const chevron = document.createElement('button');
        chevron.className = 'git-remote-btn git-split-chevron';
        chevron.innerHTML = '<i class="fa-solid fa-chevron-down" style="font-size:8px"></i>';

        const menu = document.createElement('div');
        menu.className = 'git-split-menu';
        menu.style.display = 'none';

        const options = [
            { label: 'Pull', strategy: 'ff-only' },
            { label: 'Pull --rebase', strategy: 'rebase' },
            { label: 'Pull --merge', strategy: 'merge' },
        ];
        for (const opt of options) {
            const item = document.createElement('div');
            item.className = 'git-split-menu-item';
            item.textContent = opt.label;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                menu.style.display = 'none';
                this._doPull(mainBtn, opt.strategy);
            });
            menu.appendChild(item);
        }

        chevron.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.style.display = menu.style.display === 'none' ? '' : 'none';
        });

        // Close menu on outside click
        const closeMenu = (e) => {
            if (!wrapper.contains(e.target)) menu.style.display = 'none';
        };
        document.addEventListener('click', closeMenu);

        wrapper.append(mainBtn, chevron, menu);
        return wrapper;
    }

    _makeRemoteBtn(label, icon, onClick, badgeClass = '') {
        const btn = document.createElement('button');
        btn.className = `git-remote-btn${badgeClass ? ` ${badgeClass}` : ''}`;
        btn.innerHTML = `${icon}<span>${label}</span>`;
        btn.addEventListener('click', onClick);
        return btn;
    }

    // --- Tags section ---

    _buildTagsSection() {
        return this._buildSection('Tags', '_tagsOpen', (body) => {
            body.className += ' git-tags-section';

            const tags = this._tags?.tags || [];

            // New tag form row
            const formRow = document.createElement('div');
            formRow.className = 'git-branch-row';

            const tagIcon = document.createElement('span');
            tagIcon.className = 'git-branch-icon';
            tagIcon.innerHTML = '<i class="fa-solid fa-tag"></i>';

            const tagInput = document.createElement('input');
            tagInput.className = 'git-author-input';
            tagInput.type = 'text';
            tagInput.placeholder = 'Tag name…';
            tagInput.spellcheck = false;
            tagInput.style.flex = '1';

            const createBtn = document.createElement('button');
            createBtn.className = 'git-new-branch-btn';
            createBtn.title = 'Create tag';
            createBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

            const doCreate = async () => {
                const name = tagInput.value.trim();
                if (!name) { tagInput.focus(); return; }
                createBtn.disabled = true;
                try {
                    await this._postJson('api/git/repo/create-tag', {
                        repo_path: this._activeRepoPath,
                        tag: name,
                    });
                    tagInput.value = '';
                    notify.success(`Tag "${name}" created`);
                    this._refreshActiveRepo();
                } catch (e) {
                    notify.error(`Create tag failed: ${e.message}`);
                    createBtn.disabled = false;
                }
            };
            createBtn.addEventListener('click', doCreate);
            tagInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') doCreate();
            });

            formRow.append(tagIcon, tagInput, createBtn);
            body.appendChild(formRow);

            // Tag list
            if (tags.length > 0) {
                const list = document.createElement('div');
                list.className = 'git-file-list';
                list.style.padding = '4px 0';
                for (const t of tags) {
                    const row = document.createElement('div');
                    row.className = 'git-file-row';

                    const icon = document.createElement('i');
                    icon.className = 'fa-solid fa-tag';
                    icon.style.cssText = 'font-size: 11px; margin-right: 6px; color: var(--text-secondary);';
                    row.appendChild(icon);

                    const name = document.createElement('span');
                    name.className = 'git-file-name';
                    name.textContent = t.name;
                    row.appendChild(name);

                    if (t.date_relative) {
                        const date = document.createElement('span');
                        date.className = 'git-file-badge';
                        date.textContent = t.date_relative;
                        row.appendChild(date);
                    }

                    const delBtn = document.createElement('button');
                    delBtn.className = 'git-tag-delete-btn';
                    delBtn.title = `Delete tag "${t.name}"`;
                    delBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                    delBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        if (!await modalConfirm(`Delete tag "${t.name}"?`)) return;
                        try {
                            await this._postJson('api/git/repo/delete-tag', {
                                repo_path: this._activeRepoPath,
                                tag: t.name,
                            });
                            notify.success(`Tag "${t.name}" deleted`);
                            this._refreshActiveRepo();
                        } catch (err) {
                            notify.error(`Delete tag failed: ${err.message}`);
                        }
                    });
                    row.appendChild(delBtn);

                    list.appendChild(row);
                }
                body.appendChild(list);
            } else {
                const empty = document.createElement('div');
                empty.style.cssText = 'color: var(--text-secondary); font-size: 11px; padding: 4px 6px;';
                empty.textContent = 'No tags';
                body.appendChild(empty);
            }
        });
    }

    // --- DVC Data section ---

    _buildDvcSection() {
        const dvc = this._dvcStatus;
        const trackedCount = dvc?.tracked_files?.length || 0;
        const title = trackedCount > 0 ? `Data · DVC (${trackedCount})` : 'Data · DVC';

        const wrap = this._buildSection(title, '_dvcOpen', (body) => {
            body.className += ' git-dvc-section';

            // Status line
            const statusLine = document.createElement('div');
            statusLine.className = 'git-remote-status';
            if (dvc?.initialized) {
                statusLine.textContent = trackedCount > 0
                    ? `${trackedCount} tracked file${trackedCount !== 1 ? 's' : ''}`
                    : 'DVC initialized — no tracked files';
            } else {
                statusLine.textContent = 'Not initialized (auto-init on first track)';
            }
            body.appendChild(statusLine);

            // Push / Pull buttons
            const actionRow = document.createElement('div');
            actionRow.className = 'git-remote-actions';

            const pullBtn = this._makeRemoteBtn('Pull', _ICONS.pull, async () => {
                pullBtn.disabled = true;
                try {
                    await this._postJson('api/dvc/pull', { repo_path: this._activeRepoPath });
                    notify.success('DVC pull complete');
                } catch (e) {
                    modalError(e.message, { title: 'DVC Pull Failed', actions: this._terminalAction() });
                }
                pullBtn.disabled = false;
                this._fetchDvcStatus();
            });

            const pushBtn = this._makeRemoteBtn('Push', _ICONS.push, async () => {
                pushBtn.disabled = true;
                try {
                    await this._postJson('api/dvc/push', { repo_path: this._activeRepoPath });
                    notify.success('DVC push complete');
                } catch (e) {
                    modalError(e.message, { title: 'DVC Push Failed', actions: this._terminalAction() });
                }
                pushBtn.disabled = false;
                this._fetchDvcStatus();
            });

            actionRow.append(pullBtn, pushBtn);
            body.appendChild(actionRow);

            // Tracked files list
            if (dvc?.tracked_files?.length > 0) {
                const list = document.createElement('div');
                list.className = 'git-file-list';
                for (const tf of dvc.tracked_files) {
                    const row = document.createElement('div');
                    row.className = 'git-file-row';
                    const icon = document.createElement('i');
                    icon.className = 'fa-solid fa-database';
                    icon.style.color = '#1a7f9b';
                    icon.style.fontSize = '11px';
                    icon.style.marginRight = '6px';
                    row.appendChild(icon);
                    const name = document.createElement('span');
                    name.className = 'git-file-name';
                    name.textContent = tf.path;
                    row.appendChild(name);
                    if (tf.size) {
                        const size = document.createElement('span');
                        size.className = 'git-file-badge';
                        size.textContent = this._formatSize(tf.size);
                        row.appendChild(size);
                    }
                    list.appendChild(row);
                }
                body.appendChild(list);
            }

            // Changed files indicator
            if (dvc?.changed_files?.length > 0) {
                const changeLabel = document.createElement('div');
                changeLabel.className = 'git-remote-status has-changes';
                changeLabel.textContent = `${dvc.changed_files.length} changed`;
                body.appendChild(changeLabel);
            }
        });

        wrap.classList.add('git-dvc-section-wrap');
        return wrap;
    }

    _formatSize(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }

    // --- 3.4 Changes ---

    _buildChangesSection() {
        const files = this._status?.files || [];
        const wrap = this._buildSection(`Changes (${files.length})`, '_changesOpen', (body) => {
            body.className += ' git-changes-section';

            // Commit message
            const msgInput = document.createElement('textarea');
            msgInput.className = 'git-commit-input';
            msgInput.placeholder = 'Commit message…';
            msgInput.spellcheck = false;

            // Commit button
            const commitBtn = document.createElement('button');
            commitBtn.className = 'git-commit-btn';
            commitBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-2px"><polyline points="20 6 9 17 4 12"/></svg>Commit`;
            commitBtn.style.width = '100%';
            commitBtn.disabled = true;

            msgInput.addEventListener('input', () => {
                commitBtn.disabled = !msgInput.value.trim();
            });

            commitBtn.addEventListener('click', () =>
                this._doCommit(msgInput, commitBtn));

            body.append(msgInput, commitBtn);

            // File list
            const list = document.createElement('div');
            list.className = 'git-files-list';
            if (files.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'git-panel-empty';
                empty.style.padding = '8px 16px';
                empty.textContent = 'No changes';
                list.appendChild(empty);
            } else {
                for (const f of files) list.appendChild(this._buildFileItem(f));
            }
            body.appendChild(list);
        });

        // Add discard-all and refresh buttons to the Changes section header
        const header = wrap.firstElementChild;

        const discardAllBtn = document.createElement('button');
        discardAllBtn.className = 'git-panel-topbar-btn';
        discardAllBtn.title = 'Discard All Changes';
        discardAllBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`;
        discardAllBtn.style.marginLeft = 'auto';
        if (files.length === 0) discardAllBtn.style.display = 'none';
        discardAllBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._discardAllFiles(files);
        });
        header.appendChild(discardAllBtn);

        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'git-panel-topbar-btn';
        refreshBtn.title = 'Refresh';
        refreshBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;
        refreshBtn.addEventListener('click', (e) => { e.stopPropagation(); this._discoverAndRefresh(); });
        header.appendChild(refreshBtn);

        return wrap;
    }

    _buildFileItem(f) {
        const item = document.createElement('div');
        item.className = 'git-file-item';

        const iconEl = document.createElement('img');
        iconEl.className = 'git-file-icon';
        iconEl.src = _fileIcon(f.path);

        const pathEl = document.createElement('span');
        pathEl.className = 'git-file-path';
        pathEl.textContent = f.path;
        pathEl.title = f.path;

        const statusEl = document.createElement('span');
        statusEl.className = `git-file-status ${f.label}`;
        statusEl.textContent = _statusChar(f);
        statusEl.title = f.label;

        item.append(iconEl, pathEl, statusEl);

        item.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this._showFileContextMenu(ev, f);
        });

        return item;
    }

    _showFileContextMenu(ev, f) {
        // Dismiss any existing menu
        if (this._contextMenu) {
            this._contextMenu.remove();
            this._contextMenu = null;
        }

        const menu = document.createElement('div');
        menu.className = 'explorer-context-menu';

        // Discard Changes
        const discardItem = document.createElement('div');
        discardItem.className = 'explorer-context-menu-item danger';
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-rotate-left';
        icon.style.marginRight = '8px';
        icon.style.width = '14px';
        icon.style.textAlign = 'center';
        discardItem.append(icon, document.createTextNode('Discard Changes'));
        discardItem.addEventListener('click', () => {
            this._dismissFileContextMenu();
            this._discardFile(f.path);
        });
        menu.appendChild(discardItem);

        document.body.appendChild(menu);
        this._contextMenu = menu;

        // Position within viewport
        const rect = menu.getBoundingClientRect();
        let x = ev.clientX;
        let y = ev.clientY;
        if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
        if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';

        const dismiss = (e) => {
            if (e.type === 'keydown' && e.key !== 'Escape') return;
            if (e.type === 'mousedown' && menu.contains(e.target)) return;
            this._dismissFileContextMenu();
        };
        this._dismissFileContextMenu = () => {
            if (this._contextMenu) {
                this._contextMenu.remove();
                this._contextMenu = null;
            }
            document.removeEventListener('mousedown', dismiss, true);
            document.removeEventListener('keydown', dismiss, true);
        };
        requestAnimationFrame(() => {
            document.addEventListener('mousedown', dismiss, true);
            document.addEventListener('keydown', dismiss, true);
        });
    }

    async _discardFile(filePath) {
        const shortName = filePath.includes('/') ? filePath.split('/').pop() : filePath;
        const confirmed = await modalConfirm(
            `Discard changes to "${shortName}"? This will revert the file to its last committed state. Untracked files will be deleted.`,
            { title: 'Discard Changes', confirmText: 'Discard' }
        );
        if (!confirmed) return;

        try {
            await this._postJson('api/git/repo/discard', {
                repo_path: this._activeRepoPath,
                files: [filePath],
            });
            notify.success(`Discarded changes to ${shortName}`);
            if (this._onFileDiscarded) this._onFileDiscarded([filePath]);
            this._discoverAndRefresh();
        } catch (err) {
            modalError('Discard Failed', err.message, this._terminalAction());
        }
    }

    async _discardAllFiles(files) {
        const count = files.length;
        const confirmed = await modalConfirm(
            `Discard all ${count} changed file${count > 1 ? 's' : ''}? This cannot be undone.`,
            { title: 'Discard All Changes', confirmText: 'Discard All' }
        );
        if (!confirmed) return;

        try {
            await this._postJson('api/git/repo/discard', {
                repo_path: this._activeRepoPath,
                files: files.map(f => f.path),
            });
            const paths = files.map(f => f.path);
            notify.success(`Discarded all changes`);
            if (this._onFileDiscarded) this._onFileDiscarded(paths);
            this._discoverAndRefresh();
        } catch (err) {
            modalError('Discard Failed', err.message, this._terminalAction());
        }
    }

    // --- 3.5 History ---

    _buildHistorySection() {
        return this._buildSection('History', '_historyOpen', (body) => {
            body.className += ' git-history-section';
            this._loadHistory(body);
        });
    }

    async _loadHistory(container) {
        try {
            const data = await this._postJson('api/git/repo/log', {
                repo_path: this._activeRepoPath,
            });

            if (data.commits.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'git-panel-empty';
                empty.style.padding = '8px 16px';
                empty.textContent = 'No commits yet';
                container.appendChild(empty);
                return;
            }
            const list = document.createElement('div');
            list.className = 'git-history-list';
            for (const commit of data.commits) list.appendChild(this._buildCommitItem(commit));
            container.appendChild(list);
        } catch {
            const err = document.createElement('div');
            err.className = 'git-panel-empty';
            err.style.padding = '8px 16px';
            err.textContent = 'Failed to load history';
            container.appendChild(err);
        }
    }

    _buildCommitItem(commit) {
        const item = document.createElement('div');
        item.className = 'git-commit-item';

        const hash = document.createElement('span');
        hash.className = 'git-commit-hash';
        hash.textContent = commit.short_hash;

        const msg = document.createElement('span');
        msg.className = 'git-commit-msg';
        msg.textContent = commit.message;
        msg.title = commit.message;

        const meta = document.createElement('span');
        meta.className = 'git-commit-meta';
        meta.textContent = commit.date_relative;
        meta.title = commit.date;

        const row = document.createElement('div');
        row.className = 'git-commit-row';
        row.append(hash, msg, meta);
        item.appendChild(row);

        item.addEventListener('click', () =>
            this._onCommitOpen?.(this._activeRepoPath, commit));
        return item;
    }

    // --- Actions (all use path-based endpoints) ---

    async _doCommit(msgInput, commitBtn) {
        const msg = msgInput.value.trim();
        if (!msg) return;
        commitBtn.disabled = true;
        commitBtn.textContent = 'Committing…';
        try {
            await this._postJson('api/git/repo/commit', {
                repo_path: this._activeRepoPath,
                message: msg,
                author_name:  this._nameInput?.value.trim()  || null,
                author_email: this._emailInput?.value.trim() || null,
            });
            msgInput.value = '';
            commitBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-2px"><polyline points="20 6 9 17 4 12"/></svg>Committed!`;
            setTimeout(() => { commitBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-2px"><polyline points="20 6 9 17 4 12"/></svg>Commit`; }, 1500);
            this._discoverAndRefresh();
        } catch (e) {
            commitBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-2px"><polyline points="20 6 9 17 4 12"/></svg>Commit`;
            commitBtn.disabled = false;
            modalError(e.message, { title: 'Commit Failed', actions: this._terminalAction() });
        }
    }

    async _checkout(branch, select) {
        try {
            await this._postJson('api/git/repo/checkout', {
                repo_path: this._activeRepoPath,
                branch,
            });
            this._refreshActiveRepo();
        } catch (e) {
            modalError(e.message, { title: 'Checkout Failed', actions: this._terminalAction() });
            if (this._branches?.current) select.value = this._branches.current;
        }
    }

    async _createBranch(name, input, btn, form) {
        if (!name) { input.focus(); return; }
        btn.disabled = true;
        btn.textContent = 'Creating…';
        try {
            await this._postJson('api/git/repo/create-branch', {
                repo_path: this._activeRepoPath,
                branch: name,
            });
            input.value = '';
            form.style.display = 'none';
            this._refreshActiveRepo();
        } catch (e) {
            btn.disabled = false;
            btn.textContent = 'Create';
            modalError(e.message, { title: 'Create Branch Failed', actions: this._terminalAction() });
        }
    }

    async _initRepo() {
        // For init, we still need the old project-based endpoint or a new path-based one.
        // For now, use git init directly via the repo status path.
        // Actually, we don't have a path-based init. Let's do a simple fetch.
        try {
            const res = await fetch('api/git/repo/init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repo_path: this._activeRepoPath }),
            });
            if (!res.ok) throw new Error(await res.text());
            this._discoverAndRefresh();
        } catch (e) {
            modalError(e.message, { title: 'Init Failed' });
        }
    }

    // --- Remote actions ---

    async _saveRemote(input, btn) {
        const url = input.value.trim();
        if (!url) { input.focus(); return; }
        btn.disabled = true;
        try {
            const res = await fetch('api/git/repo/remotes', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repo_path: this._activeRepoPath, url }),
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || res.statusText);
            }
            btn.disabled = false;
            this._flashBtn(btn, 'Saved');
            this._refreshActiveRepo();
        } catch (e) {
            btn.disabled = false;
            modalError(e.message, { title: 'Set Remote Failed', actions: this._terminalAction() });
        }
    }

    async _savePat(input, btn) {
        const pat = input.value.trim();
        if (!pat) { input.focus(); return; }
        btn.disabled = true;
        try {
            const res = await fetch('api/git/repo/credentials', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repo_path: this._activeRepoPath, pat }),
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || res.statusText);
            }
            input.value = '';
            btn.disabled = false;
            this._flashBtn(btn, 'Saved');
            this._refreshActiveRepo();
        } catch (e) {
            btn.disabled = false;
            modalError(e.message, { title: 'Save PAT Failed', actions: this._terminalAction() });
        }
    }

    async _doFetch(btn) {
        btn.disabled = true;
        const orig = btn.innerHTML;
        btn.innerHTML = `${_ICONS.fetch}<span>Fetching…</span>`;
        try {
            await this._postJson('api/git/repo/fetch', {
                repo_path: this._activeRepoPath,
            });
            btn.innerHTML = orig;
            btn.disabled = false;
            this._refreshActiveRepo();
        } catch (e) {
            btn.innerHTML = orig;
            btn.disabled = false;
            modalError(e.message, { title: 'Fetch Failed', actions: this._terminalAction() });
        }
    }

    async _doPull(btn, strategy = 'ff-only') {
        btn.disabled = true;
        const orig = btn.innerHTML;
        btn.innerHTML = `${_ICONS.pull}<span>Pulling…</span>`;
        try {
            await this._postJson('api/git/repo/pull', {
                repo_path: this._activeRepoPath,
                strategy,
            });
            btn.innerHTML = orig;
            btn.disabled = false;
            this._refreshActiveRepo();
        } catch (e) {
            btn.innerHTML = orig;
            btn.disabled = false;
            modalError(e.message, { title: 'Pull Failed', actions: this._terminalAction() });
        }
    }

    async _doPush(btn) {
        btn.disabled = true;
        const orig = btn.innerHTML;
        btn.innerHTML = `${_ICONS.push}<span>Pushing…</span>`;
        try {
            await this._postJson('api/git/repo/push', {
                repo_path: this._activeRepoPath,
            });
            btn.innerHTML = orig;
            btn.disabled = false;
            this._refreshActiveRepo();
        } catch (e) {
            btn.innerHTML = orig;
            btn.disabled = false;
            modalError(e.message, { title: 'Push Failed', actions: this._terminalAction() });
        }
    }

    _flashBtn(btn, text) {
        const orig = btn.innerHTML;
        btn.innerHTML = `<span style="font-size:10px">${text}</span>`;
        setTimeout(() => { btn.innerHTML = orig; }, 1200);
    }
}

// --- SVG Icons for remote buttons ---

const _ICONS = {
    fetch: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
    pull:  `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
    push:  `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
};

// --- Helpers ---

function _statusChar(f) {
    if (f.label === 'untracked') return '?';
    if (f.label === 'added')     return 'A';
    if (f.label === 'deleted')   return 'D';
    if (f.label === 'renamed')   return 'R';
    if (f.label === 'modified')  return 'M';
    return '~';
}

function _fileIcon(path) {
    const ICON_BASE = 'static/vendor/icons/';
    const name = path.split('/').pop();
    const ext  = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    if (name === '.gitignore' || name === '.gitattributes') return ICON_BASE + 'git.svg';
    const map = {
        'py':'python', 'ipynb':'notebook', 'pdf':'pdf',
        'md':'markdown', 'txt':'text', 'rst':'text',
        'json':'json', 'yaml':'yaml', 'yml':'yaml',
        'toml':'toml', 'cfg':'config', 'ini':'config',
        'js':'javascript', 'ts':'typescript',
        'css':'css', 'html':'html', 'htm':'html', 'sh':'shell',
        'png':'image', 'jpg':'image', 'jpeg':'image',
        'gif':'image', 'svg':'image', 'webp':'image',
        'csv':'csv',
    };
    return ICON_BASE + (map[ext] || 'file') + '.svg';
}
