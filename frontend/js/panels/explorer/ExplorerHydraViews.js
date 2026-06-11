/**
 * ExplorerHydraViews - Hydra Configuration detail views and tree data loaders.
 */

import {
    createDetailHeader, addParentLabel, addMetaRow, escapeHtml,
} from './ExplorerHelpers.js';

/**
 * @param {object} ctx - Shared explorer context (getters for live state).
 *   ctx._renderKvGrid is set by the MLflow module and used here for parameter grids.
 * @returns {object} View methods for Hydra configuration browsing.
 */
export function createHydraViews(ctx) {

    function showHydraConfigDetail(projectId) {
        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, 'Configuration');

        const header = createDetailHeader('Configuration', 'static/vendor/icons/hydra.svg');
        ctx.detailEl.appendChild(header);

        const loading = document.createElement('div');
        loading.className = 's3-object-loading';
        loading.textContent = 'Loading config...';
        ctx.detailEl.appendChild(loading);

        fetch(`api/hydra/schema/${encodeURIComponent(projectId)}`).then(r => r.json()).then(schema => {
            loading.remove();

            // Info card
            const card = document.createElement('div');
            card.className = 's3-object-card';
            addMetaRow(card, 'Config Dir', schema.config_dir || '-');
            addMetaRow(card, 'Config File', schema.config_name ? `${schema.config_name}.yaml` : '-');
            const groupCount = Object.keys(schema.groups || {}).length;
            addMetaRow(card, 'Groups', groupCount > 0 ? `${groupCount}` : 'None (flat config)');
            addMetaRow(card, 'Parameters', `${(schema.schema || []).length}`);
            ctx.detailEl.appendChild(card);

            // Config groups summary
            if (groupCount > 0) {
                const title = document.createElement('div');
                title.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin:16px 0 8px;padding:0 8px';
                title.textContent = 'Config Groups';
                ctx.detailEl.appendChild(title);

                const list = document.createElement('div');
                list.className = 's3-object-card';
                for (const [group, info] of Object.entries(schema.groups)) {
                    const row = document.createElement('div');
                    row.className = 's3-meta-row';
                    row.style.cssText = 'align-items:center;gap:8px;padding:7px 12px';
                    row.innerHTML = `<img src="static/vendor/icons/hydra.svg" style="width:14px;height:14px;flex-shrink:0">`
                        + `<span style="font-weight:500;color:#333">${escapeHtml(group)}</span>`
                        + `<span style="flex:1"></span>`
                        + `<span style="font-size:11px;color:#888">${info.options.length} option${info.options.length !== 1 ? 's' : ''}`
                        + `${info.default ? ` (default: ${escapeHtml(info.default)})` : ''}</span>`;
                    list.appendChild(row);
                }
                ctx.detailEl.appendChild(list);
            }

            // Schema entries (flat config parameters)
            if (schema.schema?.length) {
                ctx._renderKvGrid(ctx.detailEl, 'Parameters', schema.schema.map(s => [
                    s.key,
                    `<span style="color:#888;font-size:10px;margin-right:4px">${s.type}</span> ${escapeHtml(String(s.default ?? ''))}`,
                ]), false);
            }

            // Compose button
            const composeSection = document.createElement('div');
            composeSection.style.cssText = 'margin-top:16px;padding:0 8px';

            const composeBtn = document.createElement('button');
            composeBtn.className = 'rm-btn';
            composeBtn.style.cssText = 'display:flex;align-items:center;gap:6px';
            composeBtn.innerHTML = '<i class="fa-solid fa-play" style="font-size:10px"></i> Compose Config';
            composeBtn.addEventListener('click', () => _showComposePanel(projectId, schema));
            composeSection.appendChild(composeBtn);

            const suggestBtn = document.createElement('button');
            suggestBtn.className = 'rm-btn';
            suggestBtn.style.cssText = 'display:flex;align-items:center;gap:6px;background:#c8e6c0;margin-top:6px';
            suggestBtn.innerHTML = '<i class="fa-solid fa-comment" style="font-size:10px"></i> Suggest Sweep';
            suggestBtn.addEventListener('click', () => {
                document.dispatchEvent(new CustomEvent('ask-assistant', {
                    detail: { message: `Based on the Hydra configuration for project "${projectId}", suggest a hyperparameter sweep strategy. Which parameters should I vary and what ranges would you recommend?` }
                }));
            });
            composeSection.appendChild(suggestBtn);

            ctx.detailEl.appendChild(composeSection);

        }).catch(() => {
            loading.textContent = 'Failed to load config';
        });
    }

    function showHydraGroupDetail(projectId, group) {
        ctx.detailEl.innerHTML = '';
        addParentLabel(ctx.detailEl, 'Configuration');
        const header = createDetailHeader(group, 'static/vendor/icons/hydra.svg');
        ctx.detailEl.appendChild(header);

        const loading = document.createElement('div');
        loading.className = 's3-object-loading';
        loading.textContent = 'Loading group...';
        ctx.detailEl.appendChild(loading);

        fetch(`api/hydra/schema/${encodeURIComponent(projectId)}`).then(r => r.json()).then(schema => {
            loading.remove();
            const info = (schema.groups || {})[group] || {};
            const options = info.options || [];
            const defaultOpt = info.default;

            const card = document.createElement('div');
            card.className = 's3-object-card';
            addMetaRow(card, 'Group', group);
            addMetaRow(card, 'Options', `${options.length}`);
            if (defaultOpt) addMetaRow(card, 'Default', defaultOpt);
            ctx.detailEl.appendChild(card);

            if (options.length) {
                const title = document.createElement('div');
                title.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin:16px 0 8px;padding:0 8px';
                title.textContent = 'Options';
                ctx.detailEl.appendChild(title);

                const list = document.createElement('div');
                list.className = 's3-object-card';
                for (const opt of options) {
                    const isDefault = opt === defaultOpt;
                    const row = document.createElement('div');
                    row.className = 's3-meta-row';
                    row.style.cssText = 'align-items:center;gap:8px;padding:7px 12px';
                    row.innerHTML = `<i class="fa-solid ${isDefault ? 'fa-star' : 'fa-file-code'}" style="font-size:12px;color:${isDefault ? '#f0c040' : '#42a5f5'};flex-shrink:0"></i>`
                        + `<span style="font-weight:500;color:#333">${escapeHtml(opt)}</span>`
                        + (isDefault ? '<span style="font-size:10px;color:#888;margin-left:4px">(default)</span>' : '');
                    row.addEventListener('mouseenter', () => { row.style.background = '#f5f5f5'; });
                    row.addEventListener('mouseleave', () => { row.style.background = ''; });
                    list.appendChild(row);
                }
                ctx.detailEl.appendChild(list);
            }
        }).catch(() => { loading.textContent = 'Failed to load group'; });
    }

    /**
     * Open the Configuration Composer as a floating panel.
     *
     * The Composer supports two modes (Hydra unification plan D10-D14):
     *  - Local Baseline: reads schema from project's config/ folder.
     *  - Experiment Run: reads schema from an archived MLflow run bundle.
     *
     * The mode is a state of the Composer itself. Toggling mode previews
     * different sources; notebook metadata is only updated when the user
     * clicks Apply (D13).
     */
    function _showComposePanel(projectId, initialSchema, currentSelections = null, onSelectionsChange = null, opts = {}) {
        const offset = (window._composeCount = (window._composeCount || 0) + 1);

        const panel = jsPanel.create({
            headerTitle: '<img src="static/vendor/icons/hydra.svg" style="width:14px;height:14px;vertical-align:middle;margin-right:6px">Configuration Composer',
            theme: '#ffe39e filled',
            borderRadius: '5px',
            contentSize: { width: Math.min(900, window.innerWidth - 80), height: Math.min(560, window.innerHeight - 100) },
            position: { my: 'center', at: 'center', offsetX: offset * 20, offsetY: offset * 20 },
            headerControls: 'closeonly',
            content: '<div class="compose-panel-content"></div>',
            callback: (p) => { p.content.style.backgroundColor = '#fefefe'; },
            onclosed: () => { window._composeCount = Math.max(0, (window._composeCount || 1) - 1); },
        });

        const root = panel.content.querySelector('.compose-panel-content');
        root.className = 'compose-panel-content';
        root.style.cssText = 'height:100%;display:flex;flex-direction:column;padding:16px;font-size:12px;overflow:hidden;gap:8px';

        // Normalize the incoming selections once - the Composer keeps them
        // in memory and only commits to notebook metadata on Apply.
        const normalizedInitial = _normalizeSelections(currentSelections);

        // Parse the notebook's current baseline source so we can pre-select
        // the right mode on open (D14).
        const notebookUid = opts.notebookUid || null;
        const initialBaselineSource = opts.baselineSource || 'project://config/';
        const initialModeIsMlflow = initialBaselineSource.startsWith('mlflow://');
        const initialRunId = initialModeIsMlflow
            ? initialBaselineSource.substring('mlflow://'.length).replace(/^\/+|\/+$/g, '')
            : '';

        // ── Header: baseline source label + mode toggle ───────────
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap';
        root.appendChild(header);

        const sourceLabel = document.createElement('div');
        sourceLabel.style.cssText = 'font-size:11px;color:#555';
        header.appendChild(sourceLabel);

        const modeWrap = document.createElement('div');
        modeWrap.style.cssText = 'display:inline-flex;border:0.5px solid #c8c8c8;border-radius:4px;overflow:hidden;font-size:11px';
        header.appendChild(modeWrap);

        const modeLocalBtn = document.createElement('button');
        modeLocalBtn.type = 'button';
        modeLocalBtn.textContent = 'Local Baseline';
        modeLocalBtn.style.cssText = 'border:none;padding:4px 10px;cursor:pointer;background:#fff;color:#333';
        modeWrap.appendChild(modeLocalBtn);

        const modeMlflowBtn = document.createElement('button');
        modeMlflowBtn.type = 'button';
        modeMlflowBtn.textContent = 'Experiment Run';
        modeMlflowBtn.style.cssText = 'border:none;padding:4px 10px;cursor:pointer;background:#fff;color:#333';
        modeWrap.appendChild(modeMlflowBtn);

        const expSelect = document.createElement('select');
        expSelect.style.cssText = 'padding:3px 6px;font-size:11px;border:0.5px solid #c8c8c8;border-radius:3px;color:#222;min-width:160px';
        expSelect.innerHTML = '<option value="">-- Experiment --</option>';
        header.appendChild(expSelect);

        const runSelect = document.createElement('select');
        runSelect.style.cssText = 'padding:3px 6px;font-size:11px;border:0.5px solid #c8c8c8;border-radius:3px;color:#222;min-width:180px';
        runSelect.innerHTML = '<option value="">-- Run --</option>';
        header.appendChild(runSelect);

        const applyBtn = document.createElement('button');
        applyBtn.className = 'rm-btn';
        applyBtn.innerHTML = '<i class="fa-solid fa-check" style="font-size:10px;margin-right:4px"></i>Apply to Notebook';
        applyBtn.title = 'Write the current selections to the notebook metadata';
        applyBtn.style.cssText = 'margin-left:auto';
        applyBtn.disabled = true;  // Disabled until the body has a form to collect values from
        if (!onSelectionsChange) {
            applyBtn.title = 'Open a notebook to apply selections';
        }
        header.appendChild(applyBtn);

        // ── Body: two-column layout (controls + yaml preview) ────
        const body = document.createElement('div');
        body.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:row;gap:16px;overflow:hidden';
        root.appendChild(body);

        const leftCol = document.createElement('div');
        leftCol.style.cssText = 'flex:1;min-width:0;overflow-y:auto';
        body.appendChild(leftCol);

        const rightCol = document.createElement('div');
        rightCol.style.cssText = 'flex:1;min-width:0;overflow-y:auto;display:flex;flex-direction:column';
        body.appendChild(rightCol);

        // ── State shared by the body builder ─────────────────────
        // `state` is the Composer's current view on the config. It is NOT
        // persisted until the user clicks Apply.
        const state = {
            mode: initialModeIsMlflow ? 'mlflow' : 'local',
            schema: initialSchema,           // current schema (from the active source)
            selections: normalizedInitial,   // { group_selections, overrides }
            runId: initialRunId,
            experimentId: '',                // not known on initial open; backfilled
            lastComposed: null,              // last successful compose() result
            bundleValidation: null,          // hash match check from load-bundle
            // Archived selections from the currently-loaded run (for RUN mode).
            // Snapshotted on bundle load so the badge can detect "modified".
            // Null in Local mode.
            archivedSelections: null,
        };

        // References to the latest body controls (replaced on rebuild)
        let bodyRefs = {
            groupSelects: {},
            overrideInputs: {},
            doCompose: () => {},
        };

        function _updateSourceLabel() {
            if (state.mode === 'local') {
                sourceLabel.innerHTML = 'Baseline: <span style="font-weight:600;color:#333">Local</span>';
            } else if (state.runId) {
                const short = state.runId.substring(0, 6);
                sourceLabel.innerHTML = `Baseline: <span style="font-weight:600;color:#7b1fa2">Run ${escapeHtml(short)}</span>`;
            } else {
                sourceLabel.innerHTML = 'Baseline: <span style="font-weight:600;color:#888">(select a run)</span>';
            }
        }

        function _updateModeButtons() {
            const active = 'background:#ffe39e;color:#1a1a1a';
            const inactive = 'background:#fff;color:#333';
            modeLocalBtn.setAttribute('style', `border:none;padding:4px 10px;cursor:pointer;${state.mode === 'local' ? active : inactive}`);
            modeMlflowBtn.setAttribute('style', `border:none;padding:4px 10px;cursor:pointer;${state.mode === 'mlflow' ? active : inactive}`);
            const disabled = state.mode !== 'mlflow';
            expSelect.disabled = disabled;
            runSelect.disabled = disabled;
        }

        function _updateApplyButtonEnabled() {
            // Apply is only meaningful when the body has a real form
            // (not the "pick a run" prompt). Additionally, in Experiment
            // Run mode the user must have selected an actual run.
            if (!onSelectionsChange) {
                applyBtn.disabled = true;
                return;
            }
            const hasForm = Object.keys(bodyRefs.groupSelects || {}).length > 0
                         || Object.keys(bodyRefs.overrideInputs || {}).length > 0;
            if (!hasForm) {
                applyBtn.disabled = true;
                return;
            }
            if (state.mode === 'mlflow' && !state.runId) {
                applyBtn.disabled = true;
                return;
            }
            applyBtn.disabled = false;
        }

        async function _loadExperimentsList() {
            try {
                const resp = await fetch(`api/hydra/experiments/${encodeURIComponent(projectId)}`);
                if (!resp.ok) {
                    expSelect.innerHTML = '<option value="">-- (MLflow unavailable) --</option>';
                    return;
                }
                const data = await resp.json();
                expSelect.innerHTML = '<option value="">-- Experiment --</option>';
                for (const exp of data.experiments || []) {
                    const opt = document.createElement('option');
                    opt.value = exp.experiment_id;
                    opt.textContent = exp.name;
                    expSelect.appendChild(opt);
                }
            } catch (e) {
                expSelect.innerHTML = '<option value="">-- (MLflow unavailable) --</option>';
            }
        }

        async function _loadRunsList(experimentId) {
            runSelect.innerHTML = '<option value="">-- Run --</option>';
            if (!experimentId) return;
            try {
                const resp = await fetch(`api/hydra/runs/${encodeURIComponent(projectId)}/${encodeURIComponent(experimentId)}`);
                if (!resp.ok) return;
                const data = await resp.json();
                for (const r of data.runs || []) {
                    const opt = document.createElement('option');
                    opt.value = r.run_id;
                    const short = r.run_id.substring(0, 6);
                    opt.textContent = `${r.run_name} (${short})`;
                    runSelect.appendChild(opt);
                }
            } catch {}
        }

        async function _loadArchivedBundle(runId) {
            if (!notebookUid) {
                _renderBodyError('Experiment Run mode requires a notebook with a notebook_uid. Open a notebook first and make sure it has been saved with Hydra metadata at least once.');
                return;
            }
            try {
                const resp = await fetch('api/hydra/load-bundle', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ run_id: runId, notebook_uid: notebookUid }),
                });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({ detail: 'Unknown error' }));
                    _renderBodyError(`Failed to load bundle: ${err.detail || resp.status}`);
                    return;
                }
                const data = await resp.json();
                state.schema = data.schema;
                state.selections = _normalizeSelections(data.saved_selections);
                state.archivedSelections = _normalizeSelections(data.saved_selections);
                state.bundleValidation = data.validation || null;
                state.runId = runId;
                if (data.experiment_id) {
                    state.experimentId = data.experiment_id;
                }
                _updateSourceLabel();
                _renderBody();
            } catch (e) {
                _renderBodyError(`Failed to load bundle: ${e.message}`);
            }
        }

        async function _switchToLocal() {
            // Toggling to Local mode is preview-only (D13). We keep
            // state.runId and state.experimentId so that switching back
            // to Experiment Run restores the previous selection.
            state.mode = 'local';
            state.bundleValidation = null;
            try {
                const resp = await fetch(`api/hydra/schema/${encodeURIComponent(projectId)}`);
                if (resp.ok) state.schema = await resp.json();
            } catch {}
            _updateSourceLabel();
            _updateModeButtons();
            _renderBody();
        }

        async function _switchToMlflow() {
            state.mode = 'mlflow';
            _updateSourceLabel();
            _updateModeButtons();
            // Disable Apply immediately - the body is about to be replaced
            // with a prompt (or re-rendered) and we don't want a stale
            // enabled state during the async load below.
            bodyRefs = { groupSelects: {}, overrideInputs: {}, doCompose: () => {} };
            _updateApplyButtonEnabled();

            // Always refresh the experiments list on (re-)entry so stale
            // entries from earlier sessions get cleared and new runs appear.
            await _loadExperimentsList();

            // Restore the previously-selected experiment (if we remember it)
            // so the user sees exactly what they were looking at before.
            if (state.experimentId) {
                expSelect.value = state.experimentId;
                await _loadRunsList(state.experimentId);
                if (state.runId) {
                    runSelect.value = state.runId;
                }
            }

            // If there is no run yet selected, show a prompt.
            if (!state.runId) {
                _renderBodyPrompt('Select an experiment and a run from the dropdowns above to load its archived Hydra baseline.');
            } else {
                // We have a run - re-render the body against the cached/loaded
                // archived schema without re-fetching the bundle.
                _renderBody();
            }
        }

        modeLocalBtn.addEventListener('click', () => _switchToLocal());
        modeMlflowBtn.addEventListener('click', () => _switchToMlflow());

        expSelect.addEventListener('change', () => {
            state.experimentId = expSelect.value;
            _loadRunsList(state.experimentId);
        });
        runSelect.addEventListener('change', () => {
            if (runSelect.value) _loadArchivedBundle(runSelect.value);
        });

        applyBtn.addEventListener('click', () => {
            if (!onSelectionsChange) return;
            if (applyBtn.disabled) return;
            const groupSelections = {};
            for (const [g, sel] of Object.entries(bodyRefs.groupSelects)) {
                groupSelections[g] = sel.value;
            }
            const overrides = {};
            for (const [key, { input, original }] of Object.entries(bodyRefs.overrideInputs)) {
                if (input.value !== original) overrides[key] = input.value;
            }
            const baseline_source = state.mode === 'mlflow' && state.runId
                ? `mlflow://${state.runId}`
                : 'project://config/';
            // Pass the archived selections snapshot in RUN mode so the
            // notebook can detect "modified" state without a round-trip
            // to the backend every time the badge refreshes.
            const archived_selections = state.mode === 'mlflow'
                ? state.archivedSelections
                : null;
            onSelectionsChange({
                group_selections: groupSelections,
                overrides: overrides,
                baseline_source: baseline_source,
                archived_selections: archived_selections,
            });
            // Optional: visual ack
            const orig = applyBtn.innerHTML;
            applyBtn.innerHTML = '<i class="fa-solid fa-check" style="font-size:10px;margin-right:4px"></i>Applied';
            setTimeout(() => { applyBtn.innerHTML = orig; }, 1200);
        });

        function _renderBodyPrompt(message) {
            leftCol.innerHTML = '';
            rightCol.innerHTML = '';
            const div = document.createElement('div');
            div.style.cssText = 'color:#666;font-size:12px;padding:12px';
            div.textContent = message;
            leftCol.appendChild(div);
            bodyRefs = { groupSelects: {}, overrideInputs: {}, doCompose: () => {} };
            _updateApplyButtonEnabled();
        }

        function _renderBodyError(message) {
            leftCol.innerHTML = '';
            rightCol.innerHTML = '';
            const div = document.createElement('div');
            div.style.cssText = 'color:#c00;font-size:12px;padding:12px;border:0.5px solid #fbb;border-radius:4px;background:#fff5f5';
            div.textContent = message;
            leftCol.appendChild(div);
            bodyRefs = { groupSelects: {}, overrideInputs: {}, doCompose: () => {} };
            _updateApplyButtonEnabled();
        }

        function _renderBody() {
            const schema = state.schema;
            const selections = state.selections;

            // Early bail-out if schema is empty
            if (!schema || !schema.has_config) {
                _renderBodyError('No Hydra config found for this source.');
                return;
            }

            leftCol.innerHTML = '';
            rightCol.innerHTML = '';

            // Drift warning (from bundle load validation)
            if (state.bundleValidation && !state.bundleValidation.ok) {
                const warnDiv = document.createElement('div');
                warnDiv.style.cssText = 'color:#b26500;font-size:11px;padding:6px 8px;border:0.5px solid #f3c274;border-radius:4px;background:#fff7e6;margin-bottom:10px';
                const expected = state.bundleValidation.expected_hash || '(none)';
                const actual = state.bundleValidation.actual_hash || '(none)';
                warnDiv.innerHTML = `<b>Validation mismatch</b> on load - recomposed hash does not equal archived hash.<br>` +
                    `<span style="font-family:var(--font-mono);font-size:10px">expected: ${escapeHtml(expected)}<br>actual: ${escapeHtml(actual)}</span>`;
                leftCol.appendChild(warnDiv);
            }

            const savedGroupSelections = selections.group_selections || {};
            const savedOverrides = selections.overrides || {};

            // Group selectors
            const groups = schema.groups || {};
            const groupSelects = {};
            if (Object.keys(groups).length) {
                const groupTitle = document.createElement('div');
                groupTitle.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin-bottom:8px';
                groupTitle.textContent = 'Config Groups';
                leftCol.appendChild(groupTitle);

                for (const [group, info] of Object.entries(groups)) {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px';
                    const label = document.createElement('span');
                    label.style.cssText = 'font-weight:500;min-width:100px;color:#333';
                    label.textContent = group;
                    row.appendChild(label);
                    const select = document.createElement('select');
                    select.style.cssText = 'flex:1;padding:4px 8px;font-size:12px;border:0.5px solid #c8c8c8;border-radius:4px;color:#222';
                    for (const opt of info.options) {
                        const o = document.createElement('option');
                        o.value = opt;
                        o.textContent = opt + (info.default === opt ? ' (default)' : '');
                        select.appendChild(o);
                    }
                    // Pick the active option AFTER all options are attached.
                    // Saved selections may reference names that no longer
                    // exist in the schema (e.g. a group option was renamed
                    // or the config was restructured). Validate against the
                    // current options and fall back to the schema default if
                    // the saved value is invalid.
                    const saved = savedGroupSelections[group];
                    const active = (saved && info.options.includes(saved))
                        ? saved
                        : info.default;
                    if (active) select.value = active;
                    row.appendChild(select);
                    leftCol.appendChild(row);
                    groupSelects[group] = select;
                }
            }

            // Override inputs
            const overrideTitle = document.createElement('div');
            overrideTitle.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin:12px 0 8px';
            overrideTitle.textContent = 'Overrides';
            leftCol.appendChild(overrideTitle);

            const overrideInputs = {};
            for (const entry of (schema.schema || [])) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px';
                const label = document.createElement('span');
                label.style.cssText = 'font-size:11px;min-width:140px;color:#555;font-family:var(--font-mono)';
                label.textContent = entry.key;
                label.title = `Type: ${entry.type}`;
                row.appendChild(label);
                const input = document.createElement('input');
                input.type = 'text';
                input.style.cssText = 'flex:1;padding:3px 6px;font-size:12px;border:0.5px solid #c8c8c8;border-radius:3px;font-family:var(--font-mono);color:#333';
                const schemaDefault = entry.type === 'list' ? JSON.stringify(entry.default) : String(entry.default ?? '');
                input.value = schemaDefault;
                input.placeholder = `${entry.type}`;
                if (Object.prototype.hasOwnProperty.call(savedOverrides, entry.key)) {
                    input.value = String(savedOverrides[entry.key]);
                }
                row.appendChild(input);
                leftCol.appendChild(row);
                overrideInputs[entry.key] = { input, original: schemaDefault };
            }

            // Templates section (only for local baseline; templates live in the
            // local .noted/ folder so they do not apply to archived runs)
            if (state.mode === 'local') {
                _renderTemplatesSection(leftCol, projectId, groupSelects, overrideInputs);
            }

            // Compose button + source files + YAML preview
            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'margin-top:16px;display:flex;gap:8px';
            const composeBtn = document.createElement('button');
            composeBtn.className = 'rm-btn';
            composeBtn.innerHTML = '<i class="fa-solid fa-play" style="font-size:10px;margin-right:4px"></i>Compose';
            btnRow.appendChild(composeBtn);

            const copyBtn = document.createElement('button');
            copyBtn.className = 'rm-btn';
            copyBtn.style.background = '#d0e8ff';
            copyBtn.innerHTML = '<i class="fa-regular fa-copy" style="font-size:10px;margin-right:4px"></i>Copy YAML';
            copyBtn.style.display = 'none';
            btnRow.appendChild(copyBtn);
            leftCol.appendChild(btnRow);

            const sourceArea = document.createElement('div');
            sourceArea.style.cssText = 'margin-top:12px';
            leftCol.appendChild(sourceArea);

            const yamlTitle = document.createElement('div');
            yamlTitle.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin-bottom:8px';
            yamlTitle.textContent = 'Resolved Config';
            rightCol.appendChild(yamlTitle);

            const yamlArea = document.createElement('div');
            yamlArea.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column';
            rightCol.appendChild(yamlArea);

            async function doCompose() {
                composeBtn.disabled = true;
                composeBtn.textContent = 'Composing...';
                yamlArea.innerHTML = '';
                sourceArea.innerHTML = '';

                const selections = {};
                for (const [group, select] of Object.entries(groupSelects)) {
                    selections[group] = select.value;
                }
                const overrides = {};
                for (const [key, { input, original }] of Object.entries(overrideInputs)) {
                    if (input.value !== original) {
                        overrides[key] = input.value;
                    }
                }

                // Keep state.selections up to date so subsequent rebuilds
                // preserve user edits
                state.selections = {
                    group_selections: selections,
                    overrides: overrides,
                };

                try {
                    // In Local mode we call the existing compose endpoint.
                    // In MLflow mode we call compose-mlflow which composes
                    // against the cached archived baseline, honoring user
                    // tweaks. Both return the same shape.
                    let data;
                    if (state.mode === 'local') {
                        const resp = await fetch('api/hydra/compose', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                project_id: projectId,
                                overrides: Object.keys(overrides).length ? overrides : null,
                                group_selections: Object.keys(selections).length ? selections : null,
                            }),
                        });
                        if (!resp.ok) {
                            const err = await resp.json();
                            throw new Error(err.detail || 'Failed');
                        }
                        data = await resp.json();
                    } else {
                        const resp = await fetch('api/hydra/compose-mlflow', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                run_id: state.runId,
                                notebook_uid: notebookUid,
                                overrides: Object.keys(overrides).length ? overrides : null,
                                group_selections: Object.keys(selections).length ? selections : null,
                            }),
                        });
                        if (!resp.ok) {
                            const err = await resp.json();
                            throw new Error(err.detail || 'Failed');
                        }
                        data = await resp.json();
                    }
                    state.lastComposed = data;

                    // YAML preview
                    const pre = document.createElement('pre');
                    pre.style.cssText = 'flex:1;padding:5px;font-size:12px;font-family:var(--font-mono);border:0.5px solid #e0e0e0;border-radius:4px;overflow:auto;white-space:pre-wrap;word-break:break-word;min-height:0';
                    const code = document.createElement('code');
                    code.className = 'language-yaml';
                    code.textContent = data.yaml || '';
                    pre.appendChild(code);
                    yamlArea.appendChild(pre);
                    if (typeof hljs !== 'undefined') hljs.highlightElement(code);

                    // Source files (only in local mode; MLflow-mode source names
                    // refer to archived paths which may confuse users)
                    const sources = data.sources || {};
                    if (Object.keys(sources).length) {
                        const srcTitle = document.createElement('div');
                        srcTitle.style.cssText = 'font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin:0 0 4px';
                        srcTitle.textContent = 'Source Files';
                        sourceArea.appendChild(srcTitle);
                        const srcList = document.createElement('div');
                        srcList.style.cssText = 'font-size:11px;line-height:1.6;font-family:var(--font-mono)';
                        for (const [key, file] of Object.entries(sources)) {
                            const row = document.createElement('div');
                            const color = file === 'override' ? '#ff9800' : '#1976d2';
                            row.innerHTML = `<span style="color:#333;font-weight:500">${escapeHtml(key)}</span> <span style="color:#aaa">&larr;</span> <span style="color:${color}">${escapeHtml(file)}</span>`;
                            srcList.appendChild(row);
                        }
                        sourceArea.appendChild(srcList);
                    }

                    // Hash
                    const hashEl = document.createElement('div');
                    hashEl.style.cssText = 'font-size:11px;color:#666;margin-top:8px';
                    hashEl.innerHTML = `Hash: <span class="mono">${escapeHtml(data.hash || '')}</span>`;
                    sourceArea.appendChild(hashEl);

                    copyBtn.style.display = '';
                    copyBtn.onclick = () => {
                        navigator.clipboard.writeText(data.yaml || '').then(() => {
                            copyBtn.innerHTML = '<i class="fa-solid fa-check" style="font-size:10px;margin-right:4px"></i>Copied';
                            setTimeout(() => {
                                copyBtn.innerHTML = '<i class="fa-regular fa-copy" style="font-size:10px;margin-right:4px"></i>Copy YAML';
                            }, 1500);
                        });
                    };
                } catch (err) {
                    yamlArea.innerHTML = `<div style="color:#c00;font-size:12px">${escapeHtml(err.message)}</div>`;
                }
                composeBtn.disabled = false;
                composeBtn.innerHTML = '<i class="fa-solid fa-play" style="font-size:10px;margin-right:4px"></i>Compose';
            }

            composeBtn.addEventListener('click', doCompose);
            for (const select of Object.values(groupSelects)) {
                select.addEventListener('change', doCompose);
            }
            for (const { input } of Object.values(overrideInputs)) {
                input.addEventListener('change', doCompose);
            }

            bodyRefs = { groupSelects, overrideInputs, doCompose };
            _updateApplyButtonEnabled();
            doCompose();
        }

        // Kick off the initial render
        _updateSourceLabel();
        _updateModeButtons();
        if (state.mode === 'mlflow' && state.runId) {
            // Load the archived bundle for the notebook's pinned run.
            // Sequence: fetch the bundle first so we learn the experiment_id,
            // then populate the experiment dropdown and the run dropdown
            // with the right selections.
            (async () => {
                await _loadExperimentsList();
                await _loadArchivedBundle(state.runId);
                if (state.experimentId) {
                    expSelect.value = state.experimentId;
                    await _loadRunsList(state.experimentId);
                    runSelect.value = state.runId;
                }
            })();
        } else if (state.mode === 'mlflow') {
            _loadExperimentsList();
            _renderBodyPrompt('Select an experiment and a run from the dropdowns above to load its archived Hydra baseline.');
        } else {
            _renderBody();
        }
    }

    /** Normalize currentSelections to { group_selections, overrides }. */
    function _normalizeSelections(currentSelections) {
        if (currentSelections && (currentSelections.group_selections || currentSelections.overrides)) {
            return {
                group_selections: currentSelections.group_selections || {},
                overrides: currentSelections.overrides || {},
            };
        }
        // Legacy flat format
        return {
            group_selections: currentSelections || {},
            overrides: {},
        };
    }

    /** Render the Templates section (save/load/delete) into a container. */
    function _renderTemplatesSection(leftCol, projectId, groupSelects, overrideInputs) {
        const tplTitle = document.createElement('div');
        tplTitle.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin:12px 0 8px';
        tplTitle.textContent = 'Templates';
        leftCol.appendChild(tplTitle);

        const tplRow = document.createElement('div');
        tplRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:8px';
        const tplSelect = document.createElement('select');
        tplSelect.style.cssText = 'flex:1;padding:4px 8px;font-size:12px;border:0.5px solid #c8c8c8;border-radius:4px;color:#222';
        tplSelect.innerHTML = '<option value="">-- Select template --</option>';
        tplRow.appendChild(tplSelect);

        const tplLoadBtn = document.createElement('button');
        tplLoadBtn.className = 'rm-btn';
        tplLoadBtn.style.cssText = 'background:#d0e8ff;padding:4px 8px';
        tplLoadBtn.innerHTML = '<i class="fa-solid fa-download" style="font-size:10px"></i>';
        tplLoadBtn.title = 'Load template';
        tplRow.appendChild(tplLoadBtn);

        const tplSaveBtn = document.createElement('button');
        tplSaveBtn.className = 'rm-btn';
        tplSaveBtn.style.cssText = 'background:#c8e6c0;padding:4px 8px';
        tplSaveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk" style="font-size:10px"></i>';
        tplSaveBtn.title = 'Save as template';
        tplRow.appendChild(tplSaveBtn);

        const tplDelBtn = document.createElement('button');
        tplDelBtn.className = 'rm-btn';
        tplDelBtn.style.cssText = 'background:#ffcdd2;padding:4px 8px';
        tplDelBtn.innerHTML = '<i class="fa-solid fa-trash" style="font-size:10px"></i>';
        tplDelBtn.title = 'Delete template';
        tplRow.appendChild(tplDelBtn);

        leftCol.appendChild(tplRow);

        async function refreshTemplates() {
            try {
                const resp = await fetch(`api/hydra/templates/${encodeURIComponent(projectId)}`);
                if (!resp.ok) return;
                const data = await resp.json();
                const current = tplSelect.value;
                tplSelect.innerHTML = '<option value="">-- Select template --</option>';
                for (const t of data.templates || []) {
                    const opt = document.createElement('option');
                    opt.value = t.name;
                    opt.textContent = t.name + (t.description ? ` - ${t.description}` : '');
                    tplSelect.appendChild(opt);
                }
                if (current) tplSelect.value = current;
            } catch {}
        }
        refreshTemplates();

        tplLoadBtn.addEventListener('click', async () => {
            const name = tplSelect.value;
            if (!name) return;
            try {
                const resp = await fetch(`api/hydra/templates/${encodeURIComponent(projectId)}/${encodeURIComponent(name)}`);
                if (!resp.ok) return;
                const tpl = await resp.json();
                for (const [group, val] of Object.entries(tpl.group_selections || {})) {
                    if (groupSelects[group]) groupSelects[group].value = val;
                }
                for (const [key, val] of Object.entries(tpl.overrides || {})) {
                    if (overrideInputs[key]) overrideInputs[key].input.value = String(val);
                }
            } catch {}
        });

        tplSaveBtn.addEventListener('click', async () => {
            const name = prompt('Template name:');
            if (!name) return;
            const desc = prompt('Description (optional):') || '';
            const selections = {};
            for (const [group, select] of Object.entries(groupSelects)) selections[group] = select.value;
            const overrides = {};
            for (const [key, { input, original }] of Object.entries(overrideInputs)) {
                if (input.value !== original) overrides[key] = input.value;
            }
            try {
                await fetch(`api/hydra/templates/${encodeURIComponent(projectId)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, description: desc, group_selections: selections, overrides }),
                });
                await refreshTemplates();
                tplSelect.value = name.replace(/ /g, '_').replace(/\//g, '_');
            } catch {}
        });

        tplDelBtn.addEventListener('click', async () => {
            const name = tplSelect.value;
            if (!name) return;
            if (!confirm(`Delete template "${name}"?`)) return;
            try {
                await fetch(`api/hydra/templates/${encodeURIComponent(projectId)}/${encodeURIComponent(name)}`, { method: 'DELETE' });
                await refreshTemplates();
            } catch {}
        });
    }

    async function openComposePanel(projectId, currentSelections = null, onSelectionsChange = null, opts = {}) {
        try {
            const resp = await fetch(`api/hydra/schema/${encodeURIComponent(projectId)}`);
            if (!resp.ok) return;
            const schema = await resp.json();
            if (!schema.has_config) return;
            _showComposePanel(projectId, schema, currentSelections, onSelectionsChange, opts);
        } catch {}
    }

    return {
        showHydraConfigDetail,
        showHydraGroupDetail,
        openComposePanel,
    };
}
