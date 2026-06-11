/**
 * ExplorerEnvViews - Environment and runtime detail views,
 * environment creation, package management, and persistent terminals.
 */

import { getTerminalTheme, onTerminalThemeChange } from '../../TerminalThemes.js';
import { notify } from '../../Notify.js';
import { modalConfirm, modalError } from '../../modal.js';
import {
    createDetailHeader, addParentLabel, escapeHtml, formatSize,
    createActionBar, clearActionBar,
} from './ExplorerHelpers.js';

/**
 * @param {object} ctx - Shared explorer context (getters for live state).
 * @returns {object} View methods for environments and runtimes.
 */
export function createEnvViews(ctx) {

    function showEnvsRootDetail() {
        ctx.detailEl.innerHTML = '';
        

        const header = createDetailHeader('Environments', 'fa-solid fa-layer-group');
        ctx.detailEl.appendChild(header);

        buildEnvCreateForm(ctx.detailEl);
    }

    function showRuntimeDetail(runtimeId, displayName) {
        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, 'Environments');

        const header = createDetailHeader(displayName || runtimeId, 'fa-solid fa-layer-group');
        ctx.detailEl.appendChild(header);

        buildEnvCreateForm(ctx.detailEl, runtimeId);
    }

    function buildEnvCreateForm(container, preselectedRuntimeId = null) {
        const form = document.createElement('div');
        form.className = 'explorer-create-form';

        // Runtime selector (hidden when a specific runtime node was clicked)
        const runtimeSelect = document.createElement('select');
        runtimeSelect.className = 'explorer-select';
        const runtimes = ctx.runtimes || [];

        if (!preselectedRuntimeId && runtimes.length > 1) {
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = 'Select Interpreter';
            placeholder.disabled = true;
            placeholder.selected = true;
            runtimeSelect.appendChild(placeholder);
        }

        for (const rt of runtimes) {
            const opt = document.createElement('option');
            opt.value = rt.runtime_id;
            opt.textContent = rt.display_name;
            if (rt.runtime_id === preselectedRuntimeId) opt.selected = true;
            runtimeSelect.appendChild(opt);
        }

        if (!preselectedRuntimeId && runtimes.length > 1) {
            form.appendChild(runtimeSelect);
        } else {
            // Pre-selected or single runtime - keep hidden select for form logic
            runtimeSelect.style.display = 'none';
            form.appendChild(runtimeSelect);
        }

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.spellcheck = false;
        nameInput.placeholder = 'Environment name (e.g. ml-env)';
        form.appendChild(nameInput);

        const errorEl = document.createElement('div');
        errorEl.className = 'explorer-form-error';
        form.appendChild(errorEl);

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';

        const createBtn = document.createElement('button');
        createBtn.className = 'explorer-btn primary';
        createBtn.textContent = 'Create Environment';
        createBtn.disabled = !runtimeSelect.value;

        const updateCreateBtn = () => {
            createBtn.disabled = !runtimeSelect.value || !nameInput.value.trim();
        };
        runtimeSelect.addEventListener('change', updateCreateBtn);
        nameInput.addEventListener('input', updateCreateBtn);

        const copyBtn = document.createElement('button');
        copyBtn.className = 'explorer-btn inverted';
        copyBtn.textContent = 'Copy Output';
        copyBtn.title = 'Copy terminal output to clipboard';
        copyBtn.addEventListener('click', () => {
            const term = termArea._term;
            if (!term) return;
            const lines = [];
            for (let i = 0; i < term.buffer.active.length; i++) {
                lines.push(term.buffer.active.getLine(i)?.translateToString(true) ?? '');
            }
            navigator.clipboard.writeText(lines.join('\n').trimEnd());
        });

        const termArea = document.createElement('div');
        termArea.className = 'env-create-term';
        termArea.style.display = 'flex';

        createBtn.addEventListener('click', () => createEnv(nameInput, runtimeSelect, createBtn, errorEl, termArea));
        btnRow.append(createBtn, copyBtn);
        form.appendChild(btnRow);
        form.appendChild(termArea);

        // Make form expand so terminal fills remaining space
        form.style.flex = '1';
        form.style.minHeight = '0';
        container.style.overflowY = 'hidden';
        container.style.paddingBottom = '0';

        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') createBtn.click();
        });

        container.appendChild(form);
        nameInput.focus();

        // Initialize inline terminal immediately
        initCreateTerminal(termArea);
    }

    /** Initialize the inline terminal for the env creation form. */
    async function initCreateTerminal(termArea) {
        const termContainer = document.createElement('div');
        const inlineTheme = getTerminalTheme();
        termContainer.style.cssText = `width:100%;height:100%;background:${inlineTheme.background};`;
        termArea.appendChild(termContainer);

        await Promise.all([
            document.fonts.load('12px "MesloLGS NF"'),
            document.fonts.load('bold 12px "MesloLGS NF"'),
        ]).catch(() => {});

        const term = new Terminal({
            convertEol: false,
            cursorBlink: false,
            disableStdin: true,
            fontSize: 12,
            fontFamily: '"MesloLGS NF", "JetBrains Mono", "Fira Code", "Consolas", monospace',
            theme: { ...inlineTheme, cursor: 'transparent' },
            cols: 120, scrollback: 1000, allowProposedApi: true,
        });
        onTerminalThemeChange((t) => {
            term.options.theme = { ...t, cursor: 'transparent' };
            termContainer.style.background = t.background;
        });
        term.open(termContainer);
        term.writeln('\x1b[38;2;206;206;206mWaiting for commands...\x1b[0m');

        const fitTerminal = () => {
            const dims = term._core._renderService.dimensions;
            if (!dims || !dims.css?.cell?.height || !dims.css?.cell?.width) return;
            const cols = Math.max(20, Math.floor(termContainer.clientWidth / dims.css.cell.width));
            const rows = Math.max(4, Math.floor(termContainer.clientHeight / dims.css.cell.height));
            if (rows !== term.rows || cols !== term.cols) term.resize(cols, rows);
        };
        const resizeObs = new ResizeObserver(() => fitTerminal());
        resizeObs.observe(termArea);
        fitTerminal();

        // Store on the termArea element so createEnv can reuse it
        termArea._term = term;
    }

    async function showEnvDetail(envName, runtimeId, displayName) {
        ctx.detailEl.innerHTML = '';
        ctx.detailEl.style.overflowY = 'hidden';
        addParentLabel(ctx.detailEl, displayName || runtimeId);

        const header = createDetailHeader(envName, 'fa-solid fa-cube');
        ctx.detailEl.appendChild(header);

        const isSelected = ctx.activeVenvName === envName;
        const isActive = isSelected && ctx.kernelRunning;

        // Status tag - only show when this env is selected for the current notebook
        if (isSelected) {
            const statusTag = document.createElement('span');
            statusTag.className = isActive ? 'explorer-env-tag active' : 'explorer-env-tag inactive';
            statusTag.textContent = isActive ? 'ACTIVE' : 'INACTIVE';
            ctx.detailEl.appendChild(statusTag);
        }

        const actions = document.createElement('div');
        actions.className = 'explorer-detail-actions';

        if (!isSelected) {
            const selectBtn = document.createElement('button');
            selectBtn.className = 'explorer-btn primary';
            selectBtn.textContent = 'Activate Environment';
            selectBtn.addEventListener('click', () => {
                ctx.activeVenvName = envName;
                if (ctx.callbacks.onVenvSelect) {
                    ctx.callbacks.onVenvSelect({ name: envName, runtimeId, displayName });
                }
                showEnvDetail(envName, runtimeId, displayName);
            });
            actions.appendChild(selectBtn);
        }

        const delBtn = document.createElement('button');
        delBtn.className = 'explorer-btn danger';
        delBtn.textContent = 'Delete Environment';
        delBtn.style.marginLeft = 'auto';
        delBtn.addEventListener('click', async () => {
            if (!await modalConfirm(`Delete environment "${envName}"?`)) return;
            try {
                await fetch(`api/envs/${runtimeId}/${envName}`, { method: 'DELETE' });
                const delKey = `${runtimeId}:${envName}`;
                const termState = ctx.envTerminals[delKey];
                if (termState) {
                    if (termState.panel) try { termState.panel.close(); } catch (e) {}
                    if (termState.termOpened) termState.term.dispose();
                    delete ctx.envTerminals[delKey];
                }
                delete ctx.activeInstalls[delKey];
                if (ctx.callbacks.onVenvDeleted) {
                    ctx.callbacks.onVenvDeleted(envName);
                }
                const envNode = ctx.tree.findKey(`env:${runtimeId}:${envName}`);
                if (envNode) envNode.remove();
                ctx.showWelcomeDetail();
            } catch (err) {
                modalError(err.message);
            }
        });
        actions.appendChild(delBtn);

        ctx.detailEl.appendChild(actions);

        // Packages section - inline
        const pkgSection = document.createElement('div');
        pkgSection.className = 'explorer-pkg-section';

        const pkgLabel = document.createElement('div');
        pkgLabel.className = 'explorer-pkg-section-label';
        pkgLabel.textContent = 'Package Management';
        pkgSection.appendChild(pkgLabel);

        const loading = document.createElement('div');
        loading.className = 'venv-loading';
        loading.innerHTML = '<div class="spinner"></div><span>Loading packages...</span>';
        pkgSection.appendChild(loading);
        ctx.detailEl.appendChild(pkgSection);

        const apiBase = `api/envs/${runtimeId}/${envName}/packages`;

        try {
            const resp = await fetch(apiBase);
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed to load packages');
            }
            const packages = await resp.json();

            loading.remove();

            // Install area
            const textarea = document.createElement('textarea');
            textarea.className = 'package-install-textarea';
            textarea.spellcheck = false;
            textarea.rows = 2;
            const isJS = runtimeId?.startsWith('javascript');
            const isR = runtimeId?.startsWith('r/');
            textarea.placeholder = isJS
                ? 'Package names (e.g., lodash express)'
                : isR
                    ? 'Package names (e.g., dplyr ggplot2 tidyr)'
                    : 'Package names, pip commands, or requirements.txt content';
            pkgSection.appendChild(textarea);

            const installRow = document.createElement('div');
            installRow.className = 'package-install-actions';

            const installBtn = document.createElement('button');
            installBtn.className = 'explorer-btn primary';
            installBtn.textContent = 'Install';

            // Installer: uv for Python, pnpm for JS, renv for R.
            // No dropdown needed — one installer per language.
            const installer = isJS ? 'pnpm' : isR ? 'renv' : 'uv';

            installBtn.addEventListener('click', () =>
                doInstall(textarea, installBtn, envName, runtimeId, installer)
            );

            textarea.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    installBtn.click();
                }
            });

            const termKey = `${runtimeId}:${envName}`;
            const terminalBtn = document.createElement('button');
            terminalBtn.className = 'explorer-btn inverted';
            terminalBtn.dataset.termToggle = termKey;

            // Determine initial button state
            const existingTerm = ctx.envTerminals[termKey];
            terminalBtn.textContent = existingTerm?.panel ? 'Close Terminal' : 'Open Terminal';
            terminalBtn.onclick = () => toggleEnvTerminal(termKey, envName);

            const countLabel = document.createElement('span');
            countLabel.className = 'package-count';
            countLabel.textContent = `${packages.length} packages`;

            installRow.append(countLabel, terminalBtn, installBtn);
            pkgSection.appendChild(installRow);

            // Reconnect cancel button if an install is actively running
            const activeInstall = ctx.activeInstalls[termKey];
            if (activeInstall && !activeInstall.done) {
                if (!activeInstall.cancelled) {
                    installBtn.style.display = 'none';
                    const cancelBtn = document.createElement('button');
                    cancelBtn.className = 'explorer-btn danger';
                    cancelBtn.textContent = 'Cancel Installation';
                    cancelBtn.addEventListener('click', () => activeInstall.doCancel());
                    installRow.appendChild(cancelBtn);
                }
            }

            // Filter
            if (packages.length > 10) {
                const filterInput = document.createElement('input');
                filterInput.type = 'text';
                filterInput.className = 'package-filter-input';
                filterInput.placeholder = 'Filter packages...';
                filterInput.addEventListener('input', () => {
                    const q = filterInput.value.toLowerCase();
                    for (const li of list.children) {
                        const name = li.querySelector('.package-name')?.textContent?.toLowerCase() || '';
                        li.style.display = name.includes(q) ? '' : 'none';
                    }
                });
                pkgSection.appendChild(filterInput);
            }

            // Package list
            const list = document.createElement('ul');
            list.className = 'package-list';
            for (const pkg of packages) {
                const li = document.createElement('li');
                li.className = 'package-item';

                const name = document.createElement('span');
                name.className = 'package-name';
                name.textContent = pkg.name;

                const version = document.createElement('span');
                version.className = 'package-version';
                version.textContent = pkg.version;

                li.append(name, version);

                const removeBtn = document.createElement('button');
                removeBtn.className = 'package-remove-btn';
                removeBtn.textContent = '\u00d7';
                // Don't allow uninstalling core packages that the env
                // depends on (renv for R, pip/setuptools for Python)
                const protectedPkgs = ['renv', 'pip', 'setuptools'];
                if (protectedPkgs.includes(pkg.name)) {
                    removeBtn.disabled = true;
                    removeBtn.style.opacity = '0';
                    removeBtn.style.cursor = 'default';
                } else {
                    removeBtn.title = `Uninstall ${pkg.name}`;
                    removeBtn.addEventListener('click', async () => {
                        if (!await modalConfirm(`Uninstall ${pkg.name}?`)) return;
                        try {
                            const resp = await fetch(apiBase, {
                                method: 'DELETE',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ packages: [pkg.name] })
                            });
                            if (!resp.ok) throw new Error('Failed to uninstall');
                            showEnvDetail(envName, runtimeId, displayName);
                        } catch (err) {
                            modalError(err.message, { title: 'Uninstall Failed' });
                        }
                    });
                }
                li.appendChild(removeBtn);

                list.appendChild(li);
            }
            pkgSection.appendChild(list);

        } catch (err) {
            loading.innerHTML = `<span>Error: ${err.message}</span>`;
        }

    }

    async function createEnv(nameInput, runtimeSelect, createBtn, errorEl, termArea) {
        const name = nameInput.value.trim();
        const runtimeId = runtimeSelect.value;
        if (!name || !runtimeId) return;
        errorEl.textContent = '';

        createBtn.disabled = true;
        createBtn.textContent = 'Creating...';

        // Reuse the existing inline terminal
        const term = termArea._term;
        if (!term) return;
        term.clear();

        let hasError = false;
        try {
            const resp = await fetch('api/envs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ runtime_id: runtimeId, name })
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed to create environment');
            }
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const text = decoder.decode(value, { stream: true });
                if (text.includes('[ERROR]')) hasError = true;
                term.write(text);
            }
            if (!hasError) {
                const runtimeNode = ctx.tree.findKey(`runtime:${runtimeId}`);
                if (runtimeNode) {
                    runtimeNode.addChildren([{
                        title: name,
                        key: `env:${runtimeId}:${name}`,
                        icon: 'fa-solid fa-cube',
                    }]);
                    runtimeNode.setExpanded(true);
                }
                nameInput.value = '';
            }
        } catch (err) {
            errorEl.textContent = err.message;
            hasError = true;
        } finally {
            createBtn.disabled = false;
            createBtn.textContent = 'Create Environment';
        }
    }

    // --- Persistent environment terminal ---

    /** Get or create a persistent terminal for an environment. */
    function getOrCreateEnvTerminal(termKey, envName) {
        if (ctx.envTerminals[termKey]) return ctx.envTerminals[termKey];

        const termContainer = document.createElement('div');
        const persistTheme = getTerminalTheme();
        termContainer.style.cssText = `width:100%;height:100%;background:${persistTheme.background};`;

        const term = new Terminal({
            convertEol: false,
            cursorBlink: false,
            disableStdin: true,
            fontSize: 12,
            fontFamily: '"MesloLGS NF", "JetBrains Mono", "Fira Code", "Consolas", monospace',
            theme: { ...persistTheme, cursor: 'transparent' },
            cols: 120, scrollback: 5000, allowProposedApi: true,
        });
        onTerminalThemeChange((t) => {
            term.options.theme = { ...t, cursor: 'transparent' };
            termContainer.style.background = t.background;
        });

        const fitTerminal = () => {
            const core = term._core;
            if (!core?._renderService) return;
            const dims = core._renderService.dimensions;
            if (!dims?.css?.cell?.height || !dims?.css?.cell?.width) return;
            const cols = Math.max(20, Math.floor(termContainer.clientWidth / dims.css.cell.width));
            const rows = Math.max(1, Math.floor(termContainer.clientHeight / dims.css.cell.height));
            if (rows !== term.rows || cols !== term.cols) term.resize(cols, rows);
        };

        const state = { term, termContainer, termOpened: false, panel: null, hasContent: false };

        state.openPanel = async () => {
            if (state.panel) { state.panel.front(); return; }
            if (!state.termOpened) {
                await Promise.all([
                    document.fonts.load('12px "MesloLGS NF"'),
                    document.fonts.load('bold 12px "MesloLGS NF"'),
                ]).catch(() => {});
            }
            const floatingPanel = jsPanel.create({
                headerTitle: `Terminal - ${envName}`,
                theme: 'none', borderRadius: '5px',
                border: '1px solid var(--border-color)', boxShadow: 3,
                setStatus: 'normalized',
                position: { my: 'center', at: 'center' },
                panelSize: { width: 990, height: 450 },
                headerControls: { minimize: 'remove', smallify: 'remove', normalize: 'remove', maximize: 'remove' },
                onclosed: () => {
                    state.panel = null;
                    syncTermToggleBtn(termKey);
                },
                callback: (panel) => {
                    panel.classList.add('terminal-panel');
                    panel.style.background = persistTheme.background || '#040404';
                    panel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: false });
                    panel.content.appendChild(termContainer);
                    if (!state.termOpened) {
                        term.open(termContainer);
                        state.termOpened = true;
                        if (!state.hasContent) {
                            term.writeln('\x1b[38;2;206;206;206mWaiting for commands...\x1b[0m');
                        }
                    }
                    const resizeObs = new ResizeObserver(() => fitTerminal());
                    resizeObs.observe(panel.content);
                    panel.__resizeObs = resizeObs;
                    fitTerminal();
                },
            });
            state.panel = floatingPanel;
            syncTermToggleBtn(termKey);
        };

        state.closePanel = () => {
            if (!state.panel) return;
            if (state.panel.__resizeObs) state.panel.__resizeObs.disconnect();
            state.panel.close();
            state.panel = null;
            syncTermToggleBtn(termKey);
        };

        ctx.envTerminals[termKey] = state;
        return state;
    }

    /** Toggle the terminal panel for an environment. */
    function toggleEnvTerminal(termKey, envName) {
        const state = getOrCreateEnvTerminal(termKey, envName);
        if (state.panel) {
            state.closePanel();
        } else {
            state.openPanel();
        }
    }

    /** Sync the terminal toggle button text with panel state. */
    function syncTermToggleBtn(termKey) {
        const btn = ctx.detailEl?.querySelector?.(`[data-term-toggle="${termKey}"]`);
        if (!btn) return;
        const state = ctx.envTerminals[termKey];
        btn.textContent = state?.panel ? 'Close Terminal' : 'Open Terminal';
    }

    // --- Install helper ---

    async function doInstall(textarea, installBtn, envName, runtimeId, installer = 'uv') {
        const tokens = parseInstallInput(textarea.value);
        if (!tokens.length) return;
        const termKey = `${runtimeId}:${envName}`;

        // Get or create the persistent terminal for this env
        const termState = getOrCreateEnvTerminal(termKey, envName);
        const { term } = termState;

        // Mark that the terminal has real content now
        if (!termState.hasContent) {
            // Clear the "Waiting for commands..." placeholder
            if (termState.termOpened) term.clear();
            termState.hasContent = true;
        }

        // Track install state
        const installState = { cancelled: false, done: false, doCancel: null };
        ctx.activeInstalls[termKey] = installState;

        // Swap Install for Cancel button
        installBtn.style.display = 'none';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'explorer-btn danger';
        cancelBtn.textContent = 'Cancel Installation';
        installBtn.parentNode.insertBefore(cancelBtn, installBtn.nextSibling);

        // Open terminal panel and reset title
        await termState.openPanel();
        setTerminalPanelTitle(termState, envName, null);

        const installLabel = installer === 'pnpm' ? 'pnpm add' :
            installer === 'uv' ? 'uv pip install' : 'pip install';
        term.writeln(`\x1b[1m> ${installLabel} ${tokens.join(' ')}\x1b[0m\r\n`);

        const apiBase = `api/envs/${runtimeId}/${envName}/packages`;
        let hasError = false;

        installState.doCancel = async () => {
            if (installState.cancelled) return;
            installState.cancelled = true;
            cancelBtn.disabled = true;
            cancelBtn.textContent = 'Cancelling...';
            await fetch(`${apiBase}/cancel`, { method: 'POST' }).catch(() => {});
        };

        cancelBtn.addEventListener('click', installState.doCancel);

        term.attachCustomKeyEventHandler((e) => {
            if (e.type === 'keydown' && e.ctrlKey && e.key === 'c') {
                installState.doCancel();
                return false;
            }
            return true;
        });

        try {
            const resp = await fetch(apiBase, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ packages: tokens, installer })
            });

            if (!resp.ok) {
                const result = await resp.json().catch(() => ({}));
                term.writeln(`\r\n\x1b[31m${result.detail || 'Install failed'}\x1b[0m`);
                hasError = true;
            } else {
                const reader = resp.body.getReader();
                const decoder = new TextDecoder();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const text = decoder.decode(value, { stream: true });
                    if (text.includes('[ERROR]')) hasError = true;
                    term.write(text);
                }
                if (!hasError && !installState.cancelled) {
                    textarea.value = '';
                    term.writeln('\r\n\x1b[32m\u2713 Installation complete\x1b[0m');
                    setTerminalPanelTitle(termState, envName, 'done');
                    notify.success(`${envName}: packages installed successfully`);
                    // Refresh package list
                    showEnvDetail(envName, runtimeId, ctx.getDisplayName(runtimeId));
                    return;
                }
            }
        } catch (err) {
            term.writeln(`\r\n\x1b[31mError: ${err.message}\x1b[0m`);
            hasError = true;
        } finally {
            if (installState.cancelled) {
                term.writeln('\r\n\x1b[33m\u2717 Installation cancelled\x1b[0m');
                setTerminalPanelTitle(termState, envName, 'cancelled');
                notify.error(`${envName}: installation cancelled`);
            } else if (hasError) {
                term.writeln('\r\n\x1b[31m\u2717 Installation failed\x1b[0m');
                setTerminalPanelTitle(termState, envName, 'failed');
                notify.error(`${envName}: installation failed`);
            }
            installState.done = true;
            // Restore Install button if it's still in the DOM
            if (cancelBtn.parentNode) {
                cancelBtn.remove();
                installBtn.style.display = '';
            }
        }
    }

    function setTerminalPanelTitle(termState, envName, status) {
        if (!termState.panel) return;
        const statusLabel = status === 'done' ? '\u2713 done'
            : status === 'failed' ? '\u2717 failed'
            : status === 'cancelled' ? '\u2717 cancelled'
            : '';
        termState.panel.setHeaderTitle(`Terminal - ${envName} ${statusLabel}`);
    }

    function parseInstallInput(text) {
        let cleaned = text.replace(/^\s*(uv\s+pip|uv\s+install|pip3?|python\s+-m\s+pip)\s+install\s*/i, '');
        const tokens = [];
        for (const line of cleaned.split('\n')) {
            const stripped = line.replace(/#.*$/, '').trim();
            if (!stripped) continue;
            if (stripped.startsWith('-r ') || stripped.startsWith('--requirement')) continue;
            tokens.push(...stripped.split(/\s+/));
        }
        return tokens;
    }

    // -- Public API --

    return {
        showEnvsRootDetail,
        showRuntimeDetail,
        buildEnvCreateForm,
        initCreateTerminal,
        showEnvDetail,
        createEnv,
        getOrCreateEnvTerminal,
        toggleEnvTerminal,
        syncTermToggleBtn,
        doInstall,
        setTerminalPanelTitle,
        parseInstallInput,
    };
}
