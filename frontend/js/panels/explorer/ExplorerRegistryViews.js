/**
 * ExplorerRegistryViews - Model Registry tree data loaders and detail views.
 */

import { notify } from '../../Notify.js';
import {
    createDetailHeader, addParentLabel, addMetaRow, escapeHtml,
} from './ExplorerHelpers.js';
import { createServingViews } from './ExplorerServingViews.js';
import { ModelDeployer } from '../../ModelDeployer.js';

/**
 * @param {object} ctx - Shared explorer context.
 * @returns {object} View methods for Model Registry browsing.
 */
export function createRegistryViews(ctx) {

    const _serving = createServingViews(ctx);

    // ── Tree Data Loaders ────────────────────────────────────────

    async function loadModels() {
        try {
            const resp = await fetch('api/registry/models');
            if (!resp.ok) return [{ title: 'Failed to load models', key: 'reg-error', icon: 'fa-solid fa-circle-exclamation' }];
            const data = await resp.json();
            const models = data.models || [];
            if (!models.length) return [{ title: 'No registered models', key: 'reg-empty', icon: 'fa-solid fa-circle-info' }];
            return models.map(m => {
                const aliasStr = Object.keys(m.aliases || {}).map(a => `@${a}`).join(' ');
                return {
                    title: m.name + (aliasStr ? ` ${aliasStr}` : ''),
                    key: `regmodel:${m.name}`,
                    icon: 'fa-solid fa-brain',
                    folder: true,
                    lazy: true,
                    _data: m,
                };
            });
        } catch { return []; }
    }

    async function loadModelVersions(nodeKey) {
        const modelName = nodeKey.substring(9); // remove 'regmodel:'
        try {
            const resp = await fetch(`api/registry/models/${encodeURIComponent(modelName)}/versions`);
            if (!resp.ok) return [];
            const data = await resp.json();
            const versions = data.versions || [];
            return versions.map(v => {
                const aliases = (v.aliases || []).map(a => `@${a}`).join(' ');
                const statusIcon = v.status === 'READY' ? 'fa-solid fa-circle-check'
                    : v.status === 'PENDING_REGISTRATION' ? 'fa-solid fa-clock'
                    : 'fa-solid fa-circle-question';
                return {
                    title: `v${v.version}${aliases ? ' ' + aliases : ''}`,
                    key: `regversion:${modelName}:${v.version}`,
                    icon: statusIcon,
                    _data: v,
                };
            });
        } catch { return []; }
    }

    // ── Detail Views ─────────────────────────────────────────────

    function showModelsRootDetail() {
        ctx.detailEl.innerHTML = '';
        const header = createDetailHeader('Model Registry', 'fa-solid fa-brain');
        ctx.detailEl.appendChild(header);

        const loading = document.createElement('div');
        loading.className = 's3-object-loading';
        loading.textContent = 'Loading models...';
        ctx.detailEl.appendChild(loading);

        fetch('api/registry/models').then(r => r.json()).then(data => {
            loading.remove();
            const models = data.models || [];

            const card = document.createElement('div');
            card.className = 's3-object-card';
            addMetaRow(card, 'Total', `${models.length} model${models.length !== 1 ? 's' : ''}`);
            ctx.detailEl.appendChild(card);

            if (models.length) {
                const titleEl = document.createElement('div');
                titleEl.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin:16px 0 8px;padding:0 8px';
                titleEl.textContent = 'Registered Models';
                ctx.detailEl.appendChild(titleEl);

                const list = document.createElement('div');
                list.className = 's3-object-card';
                for (const m of models) {
                    const row = document.createElement('div');
                    row.className = 's3-meta-row';
                    row.style.cssText = 'cursor:pointer;align-items:center;gap:8px;padding:7px 12px';
                    const aliasStr = Object.entries(m.aliases || {}).map(([a, v]) =>
                        `<span style="font-size:9px;background:#e8f5e9;color:#2e7d32;padding:1px 5px;border-radius:3px">@${escapeHtml(a)} v${v}</span>`
                    ).join(' ');
                    row.innerHTML = `<i class="fa-solid fa-brain" style="font-size:12px;color:#ab47bc;flex-shrink:0"></i>`
                        + `<span style="font-weight:500;color:#333">${escapeHtml(m.name)}</span>`
                        + `<span style="flex:1"></span>`
                        + aliasStr;
                    row.addEventListener('click', () => {
                        const node = ctx.tree?.findKey(`regmodel:${m.name}`);
                        if (node) node.setActive(true);
                    });
                    row.addEventListener('mouseenter', () => { row.style.background = '#f5f5f5'; });
                    row.addEventListener('mouseleave', () => { row.style.background = ''; });
                    list.appendChild(row);
                }
                ctx.detailEl.appendChild(list);
            }
        }).catch(() => { loading.textContent = 'Failed to load models'; });
    }

    function showModelDetail(nodeKey) {
        const modelName = nodeKey.substring(9);
        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, 'Model Registry');
        const header = createDetailHeader(modelName, 'fa-solid fa-brain');
        ctx.detailEl.appendChild(header);

        const loading = document.createElement('div');
        loading.className = 's3-object-loading';
        loading.textContent = 'Loading model details...';
        ctx.detailEl.appendChild(loading);

        Promise.all([
            fetch(`api/registry/models/${encodeURIComponent(modelName)}/versions`).then(r => r.json()),
        ]).then(([vData]) => {
            loading.remove();
            const versions = vData.versions || [];

            // Info card
            const card = document.createElement('div');
            card.className = 's3-object-card';
            addMetaRow(card, 'Model', modelName);
            addMetaRow(card, 'Versions', `${versions.length}`);

            // Show current aliases
            const allAliases = [];
            for (const v of versions) {
                for (const a of (v.aliases || [])) {
                    allAliases.push(`@${a} -> v${v.version}`);
                }
            }
            if (allAliases.length) {
                addMetaRow(card, 'Aliases', allAliases.map(a =>
                    `<span style="font-size:10px;background:#e8f5e9;color:#2e7d32;padding:1px 5px;border-radius:3px;margin-right:4px">${escapeHtml(a)}</span>`
                ).join(''));
            }
            ctx.detailEl.appendChild(card);

            // Version list
            if (versions.length) {
                const titleEl = document.createElement('div');
                titleEl.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin:16px 0 8px;padding:0 8px';
                titleEl.textContent = `Versions (${versions.length})`;
                ctx.detailEl.appendChild(titleEl);

                // Compare button (only if 2+ versions)
                if (versions.length >= 2) {
                    const compareBtn = document.createElement('button');
                    compareBtn.className = 'rm-btn';
                    compareBtn.style.cssText = 'display:flex;align-items:center;gap:6px;margin:0 8px 8px;background:#d0e8ff';
                    compareBtn.innerHTML = '<i class="fa-solid fa-code-compare" style="font-size:10px"></i> Compare Versions';
                    compareBtn.addEventListener('click', () => showComparisonPanel(modelName));
                    ctx.detailEl.appendChild(compareBtn);
                }

                const table = document.createElement('table');
                table.style.cssText = 'width:calc(100% - 16px);border-collapse:collapse;font-size:11px;margin:0 8px';
                table.innerHTML = `<thead><tr>
                    <th style="text-align:left;padding:6px 8px;background:#bfdcff;font-weight:600;border:0.5px solid #e0e0e0">Version</th>
                    <th style="text-align:left;padding:6px 8px;background:#bfdcff;font-weight:600;border:0.5px solid #e0e0e0">Aliases</th>
                    <th style="text-align:left;padding:6px 8px;background:#bfdcff;font-weight:600;border:0.5px solid #e0e0e0">Run</th>
                    <th style="text-align:left;padding:6px 8px;background:#bfdcff;font-weight:600;border:0.5px solid #e0e0e0">Created</th>
                    <th style="text-align:left;padding:6px 8px;background:#bfdcff;font-weight:600;border:0.5px solid #e0e0e0">Actions</th>
                </tr></thead>`;
                const tbody = document.createElement('tbody');

                for (const v of versions) {
                    const tr = document.createElement('tr');
                    tr.style.cssText = 'cursor:pointer';
                    tr.addEventListener('mouseenter', () => { tr.style.background = '#f5f5f5'; });
                    tr.addEventListener('mouseleave', () => { tr.style.background = ''; });

                    const aliases = (v.aliases || []).map(a =>
                        `<span style="font-size:9px;background:#e8f5e9;color:#2e7d32;padding:1px 5px;border-radius:3px">@${escapeHtml(a)}</span>`
                    ).join(' ') || '<span style="color:#ccc">-</span>';

                    let dateStr = '';
                    if (v.creation_timestamp) {
                        const d = new Date(v.creation_timestamp);
                        dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
                    }

                    tr.innerHTML = `<td style="padding:6px 8px;border:0.5px solid #f0f0f0;font-weight:600">v${v.version}</td>`
                        + `<td style="padding:6px 8px;border:0.5px solid #f0f0f0">${aliases}</td>`
                        + `<td style="padding:6px 8px;border:0.5px solid #f0f0f0"><span class="mono" style="font-size:10px">${(v.run_id || '').substring(0, 8)}</span></td>`
                        + `<td style="padding:6px 8px;border:0.5px solid #f0f0f0;color:#888">${dateStr}</td>`
                        + `<td style="padding:6px 8px;border:0.5px solid #f0f0f0"></td>`;

                    // Alias action buttons
                    const actionTd = tr.querySelector('td:last-child');
                    _renderAliasButtons(actionTd, modelName, v.version, v.aliases || [], () => {
                        showModelDetail(nodeKey); // Refresh
                        const modelNode = ctx.tree?.findKey(nodeKey);
                        if (modelNode) { modelNode.resetLazy(); modelNode.setExpanded(true); }
                    });

                    // Click row to navigate to run
                    tr.addEventListener('click', (e) => {
                        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return;
                        if (v.run_id) {
                            // Try to find the run in the tree
                            const allNodes = [];
                            ctx.tree?.visit(n => { allNodes.push(n); });
                            const runNode = allNodes.find(n => n.key?.includes(v.run_id));
                            if (runNode) runNode.setActive(true);
                        }
                    });

                    tbody.appendChild(tr);
                }
                table.appendChild(tbody);
                ctx.detailEl.appendChild(table);
            }
        }).catch(() => { loading.textContent = 'Failed to load model details'; });
    }

    function showVersionDetail(nodeKey) {
        const parts = nodeKey.substring(11).split(':'); // remove 'regversion:'
        const modelName = parts[0];
        const version = parts[1];

        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, 'Model Registry');
        const header = createDetailHeader(`${modelName} v${version}`, 'fa-solid fa-brain');
        ctx.detailEl.appendChild(header);

        const loading = document.createElement('div');
        loading.className = 's3-object-loading';
        loading.textContent = 'Loading version details...';
        ctx.detailEl.appendChild(loading);

        fetch(`api/registry/models/${encodeURIComponent(modelName)}/versions/${encodeURIComponent(version)}`)
            .then(r => r.json()).then(v => {
                loading.remove();

                const card = document.createElement('div');
                card.className = 's3-object-card';
                addMetaRow(card, 'Model', modelName);
                addMetaRow(card, 'Version', `v${v.version}`);
                addMetaRow(card, 'Status', v.status || 'READY');
                if (v.run_id) addMetaRow(card, 'Source Run', `<span class="mono" style="font-size:11px">${escapeHtml(v.run_id)}</span>`);
                if (v.source) addMetaRow(card, 'Source', `<span class="mono" style="font-size:10px">${escapeHtml(v.source)}</span>`);
                if (v.creation_timestamp) addMetaRow(card, 'Created', new Date(v.creation_timestamp).toLocaleString());
                if (v.description) addMetaRow(card, 'Description', escapeHtml(v.description));

                // Flavors
                if (v.flavors?.length) {
                    addMetaRow(card, 'Flavors', v.flavors.map(f =>
                        `<span style="font-size:10px;background:#e3f2fd;color:#1565c0;padding:1px 5px;border-radius:3px;margin-right:4px">${escapeHtml(f)}</span>`
                    ).join(''));
                }

                // Signature
                if (v.signature) {
                    try {
                        const inputs = JSON.parse(v.signature.inputs || '[]');
                        const outputs = JSON.parse(v.signature.outputs || '[]');
                        const formatSpec = (specs) => specs.map(s => {
                            if (s['tensor-spec']) {
                                const ts = s['tensor-spec'];
                                return `<span class="mono" style="font-size:10px">${ts.dtype} ${JSON.stringify(ts.shape)}</span>`;
                            }
                            return `<span class="mono" style="font-size:10px">${s.name || ''} (${s.type || ''})</span>`;
                        }).join(', ');
                        if (inputs.length) addMetaRow(card, 'Input', formatSpec(inputs));
                        if (outputs.length) addMetaRow(card, 'Output', formatSpec(outputs));
                    } catch {}
                }

                // Current aliases
                if (v.aliases?.length) {
                    addMetaRow(card, 'Aliases', v.aliases.map(a =>
                        `<span style="font-size:10px;background:#e8f5e9;color:#2e7d32;padding:2px 8px;border-radius:10px;margin-right:4px;font-weight:600">@${escapeHtml(a)}</span>`
                    ).join(''));
                }

                // Tags
                const tags = v.tags || {};
                if (Object.keys(tags).length) {
                    addMetaRow(card, 'Tags', Object.entries(tags).map(([k, val]) =>
                        `<span style="font-size:10px;background:#f3e5f5;color:#7b1fa2;padding:1px 5px;border-radius:3px;margin-right:4px">${escapeHtml(k)}=${escapeHtml(val)}</span>`
                    ).join(''));
                }
                ctx.detailEl.appendChild(card);

                // Alias management
                const aliasSection = document.createElement('div');
                aliasSection.style.cssText = 'margin:12px 8px 0;padding:8px 12px;background:#fafafa;border:0.5px solid #e0e0e0;border-radius:4px';
                const aliasTitle = document.createElement('div');
                aliasTitle.style.cssText = 'font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin-bottom:6px';
                aliasTitle.textContent = 'Assign Alias';
                aliasSection.appendChild(aliasTitle);

                const aliasRow = document.createElement('div');
                aliasRow.style.cssText = 'display:flex;align-items:center;gap:6px';
                const aliasSelect = document.createElement('select');
                aliasSelect.style.cssText = 'flex:1;padding:4px 8px;font-size:12px;border:0.5px solid #c8c8c8;border-radius:4px;color:#222';
                const currentAliases = v.aliases || [];
                for (const alias of ['champion', 'staging', 'archived']) {
                    const opt = document.createElement('option');
                    opt.value = alias;
                    opt.textContent = `@${alias}`;
                    if (currentAliases.includes(alias)) opt.selected = true;
                    aliasSelect.appendChild(opt);
                }
                aliasRow.appendChild(aliasSelect);

                const assignBtn = document.createElement('button');
                assignBtn.className = 'rm-btn';
                assignBtn.style.cssText = 'padding:4px 10px;font-size:11px';
                assignBtn.textContent = 'Assign';
                assignBtn.addEventListener('click', async () => {
                    try {
                        await fetch(`api/registry/models/${encodeURIComponent(modelName)}/versions/${encodeURIComponent(version)}/alias`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ alias: aliasSelect.value }),
                        });
                        notify.success(`Alias @${aliasSelect.value} assigned to v${version}`);
                        showVersionDetail(nodeKey); // Refresh
                        const modelNode = ctx.tree?.findKey(`regmodel:${modelName}`);
                        if (modelNode) { modelNode.resetLazy(); modelNode.setExpanded(true); }
                    } catch (e) { notify.error(e.message); }
                });
                aliasRow.appendChild(assignBtn);
                aliasSection.appendChild(aliasRow);
                ctx.detailEl.appendChild(aliasSection);

                // Navigate to source run
                if (v.run_id) {
                }

                // Deploy / Unload / Try It actions - managed as a small
                // state machine driven by the current /health response.
                const actionSection = _buildDeployActions(modelName, version);
                ctx.detailEl.appendChild(actionSection);

                // Lineage view
                showLineageView(modelName, version, ctx.detailEl);
            }).catch(() => { loading.textContent = 'Failed to load version details'; });
    }

    // ── Registration Panel ───────────────────────────────────────

    function showRegisterPanel(runId, artifactPath) {
        const jp = window.jsPanel;
        if (!jp) return;

        const panel = jp.create({
            headerTitle: '<i class="fa-solid fa-brain" style="font-size:11px;margin-right:6px"></i>Register Model',
            theme: '#ffe39e filled',
            borderRadius: '5px',
            contentSize: { width: Math.min(400, window.innerWidth - 80), height: 'auto' },
            position: 'center',
            headerControls: 'closeonly',
            content: '<div style="padding:16px;font-size:12px"></div>',
            callback: (p) => { p.content.style.backgroundColor = '#fefefe'; },
        });

        const container = panel.content.firstElementChild;

        const info = document.createElement('div');
        info.style.cssText = 'margin-bottom:12px;color:#555;font-size:11px';
        info.innerHTML = `Run: <span class="mono">${escapeHtml(runId.substring(0, 12))}</span>`
            + (artifactPath ? `<br>Artifact: <span class="mono">${escapeHtml(artifactPath)}</span>` : '');
        container.appendChild(info);

        const nameLabel = document.createElement('div');
        nameLabel.style.cssText = 'font-weight:500;color:#333;margin-bottom:4px';
        nameLabel.textContent = 'Model name';
        container.appendChild(nameLabel);

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.style.cssText = 'width:100%;padding:6px 8px;font-size:12px;border:0.5px solid #c8c8c8;border-radius:4px;color:#333;box-sizing:border-box;margin-bottom:12px';
        nameInput.placeholder = 'e.g. JenaForecaster';
        container.appendChild(nameInput);

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'rm-btn';
        cancelBtn.style.background = '#f0f0f0';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => panel.close());
        btnRow.appendChild(cancelBtn);

        const regBtn = document.createElement('button');
        regBtn.className = 'rm-btn';
        regBtn.innerHTML = '<i class="fa-solid fa-brain" style="font-size:10px;margin-right:4px"></i>Register';
        btnRow.appendChild(regBtn);
        container.appendChild(btnRow);

        const resultArea = document.createElement('div');
        resultArea.style.cssText = 'margin-top:12px';
        container.appendChild(resultArea);

        regBtn.addEventListener('click', async () => {
            const name = nameInput.value.trim();
            if (!name) { nameInput.focus(); return; }

            regBtn.disabled = true;
            regBtn.textContent = 'Registering...';
            resultArea.innerHTML = '';

            try {
                const resp = await fetch('api/registry/models/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        run_id: runId,
                        artifact_path: artifactPath || 'model',
                        model_name: name,
                    }),
                });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(err.detail || `HTTP ${resp.status}`);
                }
                const result = await resp.json();
                notify.success(`Model registered: ${name} v${result.version}`);
                panel.close();

                // Refresh models tree
                const rootNode = ctx.tree?.findKey('root-models');
                if (rootNode) { rootNode.resetLazy(); rootNode.setExpanded(true); }
            } catch (err) {
                resultArea.innerHTML = `<div style="color:#c00;font-size:12px">${escapeHtml(err.message)}</div>`;
            }
            regBtn.disabled = false;
            regBtn.innerHTML = '<i class="fa-solid fa-brain" style="font-size:10px;margin-right:4px"></i>Register';
        });

        nameInput.focus();
    }

    // ── Helpers ───────────────────────────────────────────────────

    /**
     * Build the Deploy / Unload / Try It button row for a specific model
     * version. Fetches current /health to decide the initial state,
     * wires the buttons to ModelDeployer, and listens for the
     * 'serving:model-changed' event so other views can trigger a refresh.
     *
     * @param {string} modelName
     * @param {string} version
     * @returns {HTMLElement} the container element
     */
    function _buildDeployActions(modelName, version) {
        const section = document.createElement('div');
        section.className = 'deploy-actions';
        section.style.cssText = 'margin:12px 8px 0;display:flex;flex-direction:column;gap:8px';

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:center';

        const deployBtn = document.createElement('button');
        deployBtn.className = 'rm-btn';
        deployBtn.style.cssText = 'display:flex;align-items:center;gap:6px;background:#bbdefb';
        deployBtn.innerHTML = '<i class="fa-solid fa-upload" style="font-size:10px"></i>Deploy';

        const unloadBtn = document.createElement('button');
        unloadBtn.className = 'rm-btn';
        unloadBtn.style.cssText = 'display:flex;align-items:center;gap:6px;background:#ffe0b2';
        unloadBtn.innerHTML = '<i class="fa-solid fa-circle-xmark" style="font-size:10px"></i>Unload';

        const tryBtn = document.createElement('button');
        tryBtn.className = 'rm-btn';
        tryBtn.style.cssText = 'display:flex;align-items:center;gap:6px;background:#c8e6c0';
        tryBtn.innerHTML = '<i class="fa-solid fa-flask" style="font-size:10px"></i>Try It';

        row.appendChild(deployBtn);
        row.appendChild(unloadBtn);
        row.appendChild(tryBtn);
        section.appendChild(row);

        // Status / progress card - reused for idle, deploying, and
        // deployed states. Hidden until there is something to show.
        const card = document.createElement('div');
        card.className = 'deploy-status';
        card.style.cssText = 'padding:8px 10px;border-radius:4px;font-size:11px;display:none';
        section.appendChild(card);

        // ---- state helpers ----
        const PHASE_LABELS = {
            resolving: 'Resolving model version',
            downloading: 'Downloading artifacts',
            installing_deps: 'Installing dependencies',
            loading_model: 'Loading model into memory',
        };

        const setCard = (kind, title, detail = '') => {
            const palette = {
                info:    { bg: '#e3f2fd', border: '#90caf9', fg: '#0d47a1' },
                working: { bg: '#fff8e1', border: '#ffe082', fg: '#6d4c00' },
                ok:      { bg: '#e8f5e9', border: '#a5d6a7', fg: '#1b5e20' },
                error:   { bg: '#ffebee', border: '#ef9a9a', fg: '#b71c1c' },
            }[kind] || { bg: '#eee', border: '#ccc', fg: '#333' };
            card.style.display = '';
            card.style.background = palette.bg;
            card.style.border = `0.5px solid ${palette.border}`;
            card.style.color = palette.fg;
            card.innerHTML = `<div style="font-weight:600;display:flex;align-items:center;gap:6px">${title}</div>`
                + (detail ? `<div style="margin-top:3px;font-family:var(--font-mono);font-size:10px;opacity:0.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(detail)}">${escapeHtml(detail)}</div>` : '');
        };

        const setState = (state) => {
            // state: 'idle' | 'deployed-here' | 'deployed-elsewhere' | 'deploying' | 'error'
            if (state === 'deploying') {
                deployBtn.disabled = true;
                unloadBtn.style.display = 'none';
                tryBtn.disabled = true;
                tryBtn.title = 'Deploying...';
            } else if (state === 'deployed-here') {
                deployBtn.style.display = 'none';
                unloadBtn.style.display = '';
                unloadBtn.disabled = false;
                tryBtn.disabled = false;
                tryBtn.title = '';
                setCard('ok', '<i class="fa-solid fa-circle-check"></i> Deployed and ready to test');
            } else if (state === 'deployed-elsewhere') {
                deployBtn.style.display = '';
                deployBtn.disabled = false;
                deployBtn.innerHTML = '<i class="fa-solid fa-upload" style="font-size:10px"></i>Deploy (replaces current)';
                unloadBtn.style.display = 'none';
                tryBtn.disabled = true;
                tryBtn.title = 'Deploy this version first';
            } else if (state === 'error') {
                deployBtn.style.display = '';
                deployBtn.disabled = false;
                unloadBtn.style.display = 'none';
                tryBtn.disabled = true;
                tryBtn.title = 'Deploy this version first';
            } else {
                // idle: not deployed at all
                deployBtn.style.display = '';
                deployBtn.disabled = false;
                deployBtn.innerHTML = '<i class="fa-solid fa-upload" style="font-size:10px"></i>Deploy';
                unloadBtn.style.display = 'none';
                tryBtn.disabled = true;
                tryBtn.title = 'Deploy this version first';
                card.style.display = 'none';
            }
        };

        const refreshFromHealth = async () => {
            try {
                const resp = await fetch('api/serving/health');
                if (!resp.ok) { setState('idle'); return; }
                const h = await resp.json();
                if (h.status === 'ready'
                        && h.model_name === modelName
                        && String(h.version) === String(version)) {
                    setState('deployed-here');
                } else if (h.status === 'ready' && h.model_name) {
                    setState('deployed-elsewhere');
                } else {
                    setState('idle');
                }
            } catch {
                setState('idle');
            }
        };
        refreshFromHealth();

        // React to changes from other views
        const onChanged = () => refreshFromHealth();
        document.addEventListener('serving:model-changed', onChanged);
        // Best-effort cleanup: when this detail section is removed from the
        // DOM, drop the listener.
        const obs = new MutationObserver(() => {
            if (!document.body.contains(section)) {
                document.removeEventListener('serving:model-changed', onChanged);
                obs.disconnect();
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });

        // ---- button handlers ----
        deployBtn.addEventListener('click', async () => {
            setState('deploying');
            setCard('working', '<i class="fa-solid fa-spinner fa-spin"></i> Deploying...', 'Starting');
            const deployer = new ModelDeployer({
                onPhase: (phase, detail) => {
                    const label = PHASE_LABELS[phase] || phase || 'Working';
                    setCard('working', `<i class="fa-solid fa-spinner fa-spin"></i> ${label}`, detail || '');
                },
                onReady: () => {
                    document.dispatchEvent(new CustomEvent('serving:model-changed'));
                },
                onError: (msg) => {
                    setCard('error', '<i class="fa-solid fa-circle-exclamation"></i> Deploy failed', msg);
                },
            });
            try {
                await deployer.deploy(modelName, version);
                // onReady + serving:model-changed will refresh state, but
                // do a direct call in case the event round-trip races
                // this handler.
                refreshFromHealth();
            } catch (err) {
                setState('error');
                notify.error(`Deploy failed: ${err.message}`);
            }
        });

        unloadBtn.addEventListener('click', async () => {
            unloadBtn.disabled = true;
            const deployer = new ModelDeployer();
            try {
                await deployer.unload();
                document.dispatchEvent(new CustomEvent('serving:model-changed'));
                refreshFromHealth();
            } catch (err) {
                notify.error(`Unload failed: ${err.message}`);
                unloadBtn.disabled = false;
            }
        });

        tryBtn.addEventListener('click', () => {
            _serving.showTryItPanel(modelName, version);
        });

        return section;
    }

    function _renderAliasButtons(td, modelName, version, currentAliases, onRefresh) {
        const select = document.createElement('select');
        select.style.cssText = 'padding:2px 4px;font-size:10px;border:0.5px solid #c8c8c8;border-radius:3px;color:#222';
        const currentAlias = currentAliases.length ? currentAliases[0] : '';
        if (!currentAlias) select.innerHTML = '<option value="">Set alias...</option>';
        for (const alias of ['champion', 'staging', 'archived']) {
            const opt = document.createElement('option');
            opt.value = alias;
            opt.textContent = `@${alias}`;
            if (currentAliases.includes(alias)) opt.selected = true;
            select.appendChild(opt);
        }
        select.addEventListener('change', async () => {
            if (!select.value) return;
            try {
                await fetch(`api/registry/models/${encodeURIComponent(modelName)}/versions/${encodeURIComponent(version)}/alias`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ alias: select.value }),
                });
                notify.success(`@${select.value} -> v${version}`);
                onRefresh();
            } catch (e) { notify.error(e.message); }
        });
        td.appendChild(select);
    }

    // ── Lineage View ───────────────────────────────────────────────

    function showLineageView(modelName, version, targetEl) {
        const el = targetEl || ctx.detailEl;
        const lineageSection = document.createElement('div');
        lineageSection.style.cssText = 'margin:16px 0;padding:0 8px';

        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin-bottom:10px';
        titleEl.textContent = 'Lineage';
        lineageSection.appendChild(titleEl);

        const loading = document.createElement('div');
        loading.className = 's3-object-loading';
        loading.textContent = 'Loading lineage...';
        lineageSection.appendChild(loading);
        el.appendChild(lineageSection);

        fetch(`api/registry/models/${encodeURIComponent(modelName)}/versions/${encodeURIComponent(version)}/lineage`)
            .then(r => r.json()).then(result => {
                loading.remove();
                const lin = result.lineage || {};
                _renderLineageChain(lineageSection, lin);
            }).catch(() => { loading.textContent = 'Failed to load lineage'; });
    }

    function _renderLineageChain(container, lin) {
        const chain = document.createElement('div');
        chain.style.cssText = 'display:flex;flex-direction:column;gap:2px';

        const layers = [
            { key: 'data', icon: 'fa-solid fa-database', color: '#26a69a', label: 'Data (DVC)',
              items: [
                  { label: 'Hash', value: lin.data?.dvc_data_hash },
                  { label: 'File', value: lin.data?.dvc_data_file },
              ]},
            { key: 'config', icon: 'fa-solid fa-sliders', color: '#42a5f5', label: 'Config (Hydra)',
              items: [
                  { label: 'Hash', value: lin.config?.hydra_config_hash },
              ]},
            { key: 'code', icon: 'fa-solid fa-code-branch', color: '#7e57c2', label: 'Code (Git)',
              items: [
                  { label: 'Commit', value: lin.code?.git_commit ? lin.code.git_commit.substring(0, 7) : '' },
                  { label: 'Branch', value: lin.code?.snapshot_branch },
                  { label: 'Snapshot', value: lin.code?.snapshot_name },
              ]},
            { key: 'run', icon: 'fa-solid fa-vial', color: '#ef5350', label: 'Run (MLflow)',
              items: [
                  { label: 'ID', value: lin.run?.run_id ? lin.run.run_id.substring(0, 8) : '' },
                  { label: 'Name', value: lin.run?.run_name },
                  { label: 'Status', value: lin.run?.status },
              ],
              onClick: () => {
                  if (lin.run?.run_id) {
                      const allNodes = [];
                      ctx.tree?.visit(n => { allNodes.push(n); });
                      const runNode = allNodes.find(n => n.key?.includes(lin.run.run_id));
                      if (runNode) runNode.setActive(true);
                  }
              }},
            { key: 'model', icon: 'fa-solid fa-brain', color: '#ab47bc', label: 'Model (Registry)',
              items: [
                  { label: 'Name', value: lin.model?.name },
                  { label: 'Version', value: lin.model?.version ? `v${lin.model.version}` : '' },
                  { label: 'Aliases', value: (lin.model?.aliases || []).map(a => `@${a}`).join(', ') },
              ]},
        ];

        // Add pipeline layer if present
        if (lin.pipeline?.dag_id) {
            layers.splice(3, 0, {
                key: 'pipeline', icon: 'fa-solid fa-diagram-project', color: '#ff9800', label: 'Pipeline (Airflow)',
                items: [
                    { label: 'DAG', value: lin.pipeline.dag_id },
                    { label: 'Run', value: lin.pipeline.dag_run_id },
                ],
            });
        }

        for (let i = 0; i < layers.length; i++) {
            const layer = layers[i];
            const hasData = layer.items.some(it => it.value);

            const node = document.createElement('div');
            node.style.cssText = `display:flex;align-items:flex-start;gap:10px;padding:8px 12px;background:#fefefe;border:0.5px solid #e0e0e0;border-radius:4px;${layer.onClick ? 'cursor:pointer;' : ''}${!hasData ? 'opacity:0.4;' : ''}`;
            if (layer.onClick) {
                node.addEventListener('click', layer.onClick);
                node.addEventListener('mouseenter', () => { node.style.background = '#f5f5f5'; });
                node.addEventListener('mouseleave', () => { node.style.background = '#fefefe'; });
            }

            node.innerHTML = `<i class="${layer.icon}" style="font-size:14px;color:${layer.color};margin-top:2px;flex-shrink:0;width:18px;text-align:center"></i>`
                + `<div style="flex:1;min-width:0">`
                + `<div style="font-weight:600;font-size:11px;color:#333;margin-bottom:2px">${layer.label}</div>`
                + layer.items.filter(it => it.value).map(it =>
                    `<div style="font-size:10px;color:#666"><span style="color:#999;margin-right:4px">${it.label}:</span><span class="mono">${escapeHtml(String(it.value))}</span></div>`
                ).join('')
                + (hasData ? '' : '<div style="font-size:10px;color:#999">Not tracked</div>')
                + `</div>`;
            chain.appendChild(node);

            // Arrow between layers
            if (i < layers.length - 1) {
                const arrow = document.createElement('div');
                arrow.style.cssText = 'text-align:center;color:#333333;font-size:12px;line-height:1';
                arrow.innerHTML = '<i class="fa-solid fa-down-long"></i>';
                chain.appendChild(arrow);
            }
        }
        container.appendChild(chain);
    }

    // ── Model Comparison ─────────────────────────────────────────

    function showComparisonPanel(modelName) {
        const jp = window.jsPanel;
        if (!jp) return;

        const panel = jp.create({
            headerTitle: `<i class="fa-solid fa-code-compare" style="font-size:11px;margin-right:6px"></i>Compare: ${modelName}`,
            theme: '#ffe39e filled',
            borderRadius: '5px',
            contentSize: { width: Math.min(700, window.innerWidth - 80), height: Math.min(500, window.innerHeight - 100) },
            position: 'center',
            headerControls: 'closeonly',
            content: '<div class="compare-panel-content"></div>',
            callback: (p) => { p.content.style.backgroundColor = '#fefefe'; },
        });

        const container = panel.content.querySelector('.compare-panel-content');
        container.style.cssText = 'height:100%;overflow-y:auto;padding:16px;font-size:12px';

        // Version selectors
        const selectRow = document.createElement('div');
        selectRow.style.cssText = 'display:flex;gap:12px;margin-bottom:16px;align-items:center';

        const labelA = document.createElement('span');
        labelA.style.cssText = 'font-weight:500;color:#2e7d32';
        labelA.textContent = 'Version A:';
        selectRow.appendChild(labelA);
        const selectA = document.createElement('select');
        selectA.style.cssText = 'padding:4px 8px;font-size:12px;border:0.5px solid #c8c8c8;border-radius:4px';
        selectRow.appendChild(selectA);

        const labelB = document.createElement('span');
        labelB.style.cssText = 'font-weight:500;color:#1565c0;margin-left:12px';
        labelB.textContent = 'Version B:';
        selectRow.appendChild(labelB);
        const selectB = document.createElement('select');
        selectB.style.cssText = 'padding:4px 8px;font-size:12px;border:0.5px solid #c8c8c8;border-radius:4px';
        selectRow.appendChild(selectB);

        const compareBtn = document.createElement('button');
        compareBtn.className = 'rm-btn';
        compareBtn.style.marginLeft = 'auto';
        compareBtn.textContent = 'Compare';
        selectRow.appendChild(compareBtn);
        container.appendChild(selectRow);

        const resultArea = document.createElement('div');
        container.appendChild(resultArea);

        // Load versions
        fetch(`api/registry/models/${encodeURIComponent(modelName)}/versions`).then(r => r.json()).then(data => {
            const versions = data.versions || [];
            for (const v of versions) {
                const optA = document.createElement('option');
                optA.value = v.version;
                optA.textContent = `v${v.version}`;
                selectA.appendChild(optA);
                const optB = document.createElement('option');
                optB.value = v.version;
                optB.textContent = `v${v.version}`;
                selectB.appendChild(optB);
            }
            if (versions.length >= 2) selectB.value = versions[1].version;
        });

        compareBtn.addEventListener('click', async () => {
            const va = selectA.value;
            const vb = selectB.value;
            if (!va || !vb || va === vb) { notify.info('Select two different versions'); return; }

            compareBtn.disabled = true;
            compareBtn.textContent = 'Comparing...';
            resultArea.innerHTML = '';

            try {
                const resp = await fetch('api/registry/models/compare', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model_name: modelName, version_a: va, version_b: vb }),
                });
                if (!resp.ok) throw new Error('Failed to compare');
                const result = await resp.json();
                _renderComparisonResult(resultArea, result);
            } catch (err) {
                resultArea.innerHTML = `<div style="color:#c00">${escapeHtml(err.message)}</div>`;
            }
            compareBtn.disabled = false;
            compareBtn.textContent = 'Compare';
        });
    }

    function _renderComparisonResult(container, result) {
        // Metrics diff table
        if (result.metrics_diff?.length) {
            const titleEl = document.createElement('div');
            titleEl.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin-bottom:6px';
            titleEl.textContent = 'Metrics';
            container.appendChild(titleEl);

            const table = document.createElement('table');
            table.style.cssText = 'width:100%;border-collapse:collapse;font-size:11px;margin-bottom:16px';
            table.innerHTML = `<thead><tr>
                <th style="text-align:left;padding:6px 8px;background:#bfdcff;font-weight:600;border:0.5px solid #e0e0e0">Key</th>
                <th style="text-align:left;padding:6px 8px;background:#e8f5e9;font-weight:600;border:0.5px solid #e0e0e0">v${result.version_a}</th>
                <th style="text-align:left;padding:6px 8px;background:#e3f2fd;font-weight:600;border:0.5px solid #e0e0e0">v${result.version_b}</th>
                <th style="text-align:right;padding:6px 8px;background:#bfdcff;font-weight:600;border:0.5px solid #e0e0e0">Delta</th>
            </tr></thead>`;
            const tbody = document.createElement('tbody');
            for (const m of result.metrics_diff) {
                const tr = document.createElement('tr');
                const changed = m.delta != null && m.delta !== 0;
                tr.style.background = changed ? '#fff8e1' : '';
                const deltaStr = m.delta != null
                    ? `<span style="color:${m.delta > 0 ? '#f44336' : '#4caf50'};font-family:var(--font-mono)">${m.delta > 0 ? '↑' : '↓'} ${Math.abs(m.delta).toFixed(6)}</span>`
                    : '-';
                tr.innerHTML = `<td style="padding:6px 8px;border:0.5px solid #f0f0f0;font-weight:500">${escapeHtml(m.key)}</td>`
                    + `<td style="padding:6px 8px;border:0.5px solid #f0f0f0;font-family:var(--font-mono)">${m.a != null ? (typeof m.a === 'number' ? m.a.toFixed(6) : m.a) : '-'}</td>`
                    + `<td style="padding:6px 8px;border:0.5px solid #f0f0f0;font-family:var(--font-mono)">${m.b != null ? (typeof m.b === 'number' ? m.b.toFixed(6) : m.b) : '-'}</td>`
                    + `<td style="text-align:right;padding:6px 8px;border:0.5px solid #f0f0f0">${deltaStr}</td>`;
                tbody.appendChild(tr);
            }
            table.appendChild(tbody);
            container.appendChild(table);
        }

        // Params diff table
        const changedParams = (result.params_diff || []).filter(p => p.changed);
        if (changedParams.length) {
            const titleEl = document.createElement('div');
            titleEl.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin-bottom:6px';
            titleEl.textContent = `Parameters (${changedParams.length} changed)`;
            container.appendChild(titleEl);

            const table = document.createElement('table');
            table.style.cssText = 'width:100%;border-collapse:collapse;font-size:11px;margin-bottom:16px';
            table.innerHTML = `<thead><tr>
                <th style="text-align:left;padding:6px 8px;background:#bfdcff;font-weight:600;border:0.5px solid #e0e0e0">Key</th>
                <th style="text-align:left;padding:6px 8px;background:#e8f5e9;font-weight:600;border:0.5px solid #e0e0e0">v${result.version_a}</th>
                <th style="text-align:left;padding:6px 8px;background:#e3f2fd;font-weight:600;border:0.5px solid #e0e0e0">v${result.version_b}</th>
            </tr></thead>`;
            const tbody = document.createElement('tbody');
            for (const p of changedParams) {
                const tr = document.createElement('tr');
                tr.style.background = '#fff8e1';
                tr.innerHTML = `<td style="padding:6px 8px;border:0.5px solid #f0f0f0;font-weight:500">${escapeHtml(p.key)}</td>`
                    + `<td style="padding:6px 8px;border:0.5px solid #f0f0f0;font-family:var(--font-mono)">${escapeHtml(String(p.a ?? '-'))}</td>`
                    + `<td style="padding:6px 8px;border:0.5px solid #f0f0f0;font-family:var(--font-mono)">${escapeHtml(String(p.b ?? '-'))}</td>`;
                tbody.appendChild(tr);
            }
            table.appendChild(tbody);
            container.appendChild(table);
        }

        // Lineage diff
        const linA = result.lineage_a || {};
        const linB = result.lineage_b || {};
        const diffs = [];
        if (linA.data?.dvc_data_hash !== linB.data?.dvc_data_hash) diffs.push('Data version changed');
        if (linA.config?.hydra_config_hash !== linB.config?.hydra_config_hash) diffs.push('Config changed');
        if (linA.code?.git_commit !== linB.code?.git_commit) diffs.push('Code changed');

        if (diffs.length) {
            const titleEl = document.createElement('div');
            titleEl.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin-bottom:6px';
            titleEl.textContent = 'Lineage Differences';
            container.appendChild(titleEl);
            const diffList = document.createElement('div');
            diffList.className = 's3-object-card';
            for (const d of diffs) {
                const row = document.createElement('div');
                row.className = 's3-meta-row';
                row.style.cssText = 'padding:6px 12px;gap:8px';
                row.innerHTML = `<i class="fa-solid fa-circle-exclamation" style="font-size:10px;color:#ff9800"></i><span style="color:#333">${escapeHtml(d)}</span>`;
                diffList.appendChild(row);
            }
            container.appendChild(diffList);
        }
    }

    return {
        loadModels,
        loadModelVersions,
        showModelsRootDetail,
        showModelDetail,
        showVersionDetail,
        showRegisterPanel,
        showLineageView,
        showComparisonPanel,
    };
}
