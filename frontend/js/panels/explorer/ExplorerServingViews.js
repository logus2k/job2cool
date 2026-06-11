/**
 * ExplorerServingViews - Model serving UI: Try It panel, load/unload, status.
 */

import { notify } from '../../Notify.js';
import {
    createDetailHeader, addParentLabel, addMetaRow, escapeHtml,
} from './ExplorerHelpers.js';

/**
 * @param {object} ctx - Shared explorer context.
 * @returns {object} Serving view methods.
 */
export function createServingViews(ctx) {

    function _formatBytes(bytes) {
        if (bytes == null) return '';
        const units = ['B', 'KB', 'MB', 'GB'];
        let i = 0;
        let n = bytes;
        while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
        return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
    }

    // ── Try It Panel ─────────────────────────────────────────────

    function showTryItPanel(modelName, version) {
        const jp = window.jsPanel;
        if (!jp) return;

        const panel = jp.create({
            headerTitle: `<i class="fa-solid fa-flask" style="font-size:11px;margin-right:6px"></i>Try It: ${modelName} v${version || '?'}`,
            theme: '#ffe39e filled',
            borderRadius: '5px',
            contentSize: { width: Math.min(600, window.innerWidth - 80), height: Math.min(550, window.innerHeight - 100) },
            position: 'center',
            headerControls: 'closeonly',
            content: '<div class="tryit-panel-content"></div>',
            callback: (p) => { p.content.style.backgroundColor = '#fefefe'; },
            // NOTE: no onclosed unload. Publishing is now an explicit user
            // action in the Registry view - closing the Try It panel does
            // not unload. The user controls the serving container's
            // lifecycle via the Publish / Unpublish buttons.
        });

        const container = panel.content.querySelector('.tryit-panel-content');
        container.style.cssText = 'height:100%;overflow-y:auto;padding:16px;font-size:12px';

        const statusSection = document.createElement('div');
        statusSection.style.cssText = 'margin-bottom:12px';
        statusSection.innerHTML = '<div style="color:#888;font-size:11px">Checking serving status...</div>';
        container.appendChild(statusSection);

        _buildForm(container, statusSection, modelName, version);
    }

    async function _buildForm(container, statusSection, modelName, version) {
        // Try It is only reachable after a successful Publish, so the
        // model should already be loaded. We still verify /health and
        // bail with a clear message if it isn't, rather than silently
        // re-triggering a load (that's the Publish button's job).
        let health;
        try {
            const resp = await fetch('api/serving/health');
            health = resp.ok ? await resp.json() : null;
        } catch {
            statusSection.innerHTML = '<div style="color:#c00;font-size:11px"><i class="fa-solid fa-circle-xmark" style="margin-right:4px"></i>Serving container not reachable</div>';
            return;
        }

        const mismatch = !health
            || health.status !== 'ready'
            || health.model_name !== modelName
            || String(health.version) !== String(version);

        if (mismatch) {
            statusSection.innerHTML = '<div style="color:#c8870a;font-size:11px">'
                + '<i class="fa-solid fa-circle-exclamation" style="margin-right:4px"></i>'
                + 'This version is not currently published. Publish it from the Model Registry first.'
                + '</div>';
            return;
        }

        // Show loaded status
        statusSection.innerHTML = '';
        const statusCard = document.createElement('div');
        statusCard.className = 's3-object-card';
        statusCard.style.marginBottom = '12px';
        addMetaRow(statusCard, 'Status', '<span style="color:#4caf50;font-weight:600">Ready</span>');
        addMetaRow(statusCard, 'Model', `${health.model_name} v${health.version}`);
        if (health.framework) addMetaRow(statusCard, 'Framework', health.framework);
        if (health.num_parameters != null) {
            addMetaRow(statusCard, 'Parameters', health.num_parameters.toLocaleString());
        }
        if (health.artifact_size_bytes != null) {
            addMetaRow(statusCard, 'Artifact Size', _formatBytes(health.artifact_size_bytes));
        }
        if (health.load_time != null) addMetaRow(statusCard, 'Load Time', `${health.load_time.toFixed(2)}s`);
        if (health.run_id) {
            addMetaRow(statusCard, 'Run ID', `<span class="mono">${health.run_id.substring(0, 8)}</span>`);
        }
        statusSection.appendChild(statusCard);

        // Fetch schema
        let schema;
        try {
            const resp = await fetch('api/serving/schema');
            schema = resp.ok ? await resp.json() : {};
        } catch {
            schema = {};
        }

        // Build input form
        _buildInputForm(container, schema, modelName, version);
    }

    function _buildInputForm(container, schema, modelName, version) {
        const inputs = schema.inputs || [];
        const inputFormat = schema.input_format || 'dataframe';

        const formTitle = document.createElement('div');
        formTitle.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin-bottom:8px';
        formTitle.textContent = 'Input';
        container.appendChild(formTitle);

        const inputFields = {};

        if (inputs.length && inputFormat === 'dataframe') {
            // Named fields - generate individual inputs
            for (const field of inputs) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px';
                const label = document.createElement('div');
                label.style.cssText = 'min-width:120px;flex-shrink:0';
                label.innerHTML = `<div style="font-weight:500;color:#333;font-family:var(--font-mono);font-size:11px">${escapeHtml(field.name)}</div>`
                    + `<div style="font-size:9px;color:#999">${escapeHtml(field.type)}</div>`;
                row.appendChild(label);

                const input = document.createElement('input');
                input.type = field.type === 'integer' ? 'number' : (field.type === 'float' ? 'number' : 'text');
                if (field.type === 'float') input.step = 'any';
                input.style.cssText = 'flex:1;padding:4px 8px;font-size:12px;border:0.5px solid #c8c8c8;border-radius:4px;font-family:var(--font-mono);color:#333';
                input.placeholder = field.description || field.name;
                row.appendChild(input);
                container.appendChild(row);
                inputFields[field.name] = input;
            }
        } else {
            // JSON/tensor input - use textarea
            const hint = document.createElement('div');
            hint.style.cssText = 'font-size:10px;color:#888;margin-bottom:4px';
            if (inputFormat === 'tensor') {
                hint.textContent = 'Enter tensor data as JSON array (e.g., [[1.0, 2.0, ...]])';
            } else {
                hint.textContent = 'Enter input as JSON (e.g., {"col1": val1, "col2": val2})';
            }
            container.appendChild(hint);
        }

        // JSON textarea (always available for advanced input)
        const jsonLabel = document.createElement('div');
        jsonLabel.style.cssText = 'font-weight:500;color:#555;font-size:11px;margin:8px 0 4px';
        jsonLabel.textContent = inputs.length ? 'Or paste JSON directly' : 'Input data (JSON)';
        container.appendChild(jsonLabel);

        const jsonInput = document.createElement('textarea');
        jsonInput.style.cssText = 'width:100%;height:80px;padding:8px;font-size:11px;border:0.5px solid #c8c8c8;border-radius:4px;font-family:var(--font-mono);color:#333;resize:vertical;box-sizing:border-box';

        // Pre-fill with example if available
        if (schema.example_input) {
            jsonInput.value = JSON.stringify(schema.example_input, null, 2);
        } else if (inputs.length && inputFormat === 'dataframe') {
            const example = {};
            for (const f of inputs) example[f.name] = f.type === 'float' ? 0.0 : (f.type === 'integer' ? 0 : '');
            jsonInput.value = JSON.stringify(example, null, 2);
        }
        container.appendChild(jsonInput);

        // Action row: Generate Sample (optional) + Predict + Clear, all in one line.
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'margin-top:12px;display:flex;gap:8px;align-items:stretch';
        const BTN_STYLE = 'font-size:11px;padding:6px 12px;line-height:1;display:inline-flex;align-items:center;justify-content:center';

        if (inputFormat === 'tensor' || !inputs.length) {
            const sampleBtn = document.createElement('button');
            sampleBtn.className = 'rm-btn';
            sampleBtn.style.cssText = `${BTN_STYLE};background:#e3f2fd`;
            sampleBtn.innerHTML = '<i class="fa-solid fa-dice" style="font-size:10px;margin-right:4px"></i>Generate Sample';
            sampleBtn.addEventListener('click', () => {
                // Build sample input from schema shape info
                const inputInfo = inputs[0] || {};
                const shape = inputInfo.shape || schema.input_shape || [];
                if (shape.length >= 2) {
                    // Tensor: generate random values
                    const rows = shape[shape.length - 2] || 10;
                    const cols = shape[shape.length - 1] || 1;
                    const sample = [Array.from({ length: rows }, () =>
                        Array.from({ length: cols }, () => +(Math.random() * 2 - 1).toFixed(4))
                    )];
                    jsonInput.value = JSON.stringify(sample);
                } else if (inputs.length) {
                    // DataFrame: generate from field names
                    const sample = {};
                    for (const f of inputs) {
                        sample[f.name] = f.type === 'float' ? +(Math.random() * 10).toFixed(2)
                            : f.type === 'integer' ? Math.floor(Math.random() * 100) : 'sample';
                    }
                    jsonInput.value = JSON.stringify(sample, null, 2);
                }
            });
            btnRow.appendChild(sampleBtn);
        }

        const predictBtn = document.createElement('button');
        predictBtn.className = 'rm-btn';
        predictBtn.style.cssText = BTN_STYLE;
        predictBtn.innerHTML = '<i class="fa-solid fa-play" style="font-size:10px;margin-right:4px"></i>Predict';
        btnRow.appendChild(predictBtn);

        const clearBtn = document.createElement('button');
        clearBtn.className = 'rm-btn';
        clearBtn.style.cssText = `${BTN_STYLE};background:#f0f0f0`;
        clearBtn.textContent = 'Clear';
        btnRow.appendChild(clearBtn);

        container.appendChild(btnRow);

        // Result area
        const resultTitle = document.createElement('div');
        resultTitle.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin:16px 0 8px';
        resultTitle.textContent = 'Output';
        container.appendChild(resultTitle);

        const resultArea = document.createElement('div');
        container.appendChild(resultArea);

        // History
        const historyTitle = document.createElement('div');
        historyTitle.style.cssText = 'font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;color:#666;margin:16px 0 8px;display:none';
        historyTitle.textContent = 'History';
        container.appendChild(historyTitle);

        const historyArea = document.createElement('div');
        container.appendChild(historyArea);

        const history = [];

        // Predict handler
        predictBtn.addEventListener('click', async () => {
            let inputData = {};

            // Try named fields first
            if (Object.keys(inputFields).length) {
                const hasValues = Object.values(inputFields).some(f => f.value.trim());
                if (hasValues) {
                    for (const [name, input] of Object.entries(inputFields)) {
                        const val = input.value.trim();
                        if (val) {
                            try { inputData[name] = JSON.parse(val); } catch { inputData[name] = val; }
                        }
                    }
                }
            }

            // JSON textarea overrides if it has content
            const jsonVal = jsonInput.value.trim();
            if (jsonVal && (jsonVal.startsWith('{') || jsonVal.startsWith('['))) {
                try {
                    inputData = JSON.parse(jsonVal);
                } catch (e) {
                    resultArea.innerHTML = `<div style="color:#c00;font-size:12px">Invalid JSON: ${escapeHtml(e.message)}</div>`;
                    return;
                }
            }

            if (!Object.keys(inputData).length) {
                resultArea.innerHTML = '<div style="color:#888;font-size:11px">Enter input data first</div>';
                return;
            }

            predictBtn.disabled = true;
            predictBtn.textContent = 'Predicting...';
            resultArea.innerHTML = '<div style="color:#888;font-size:11px">Running inference...</div>';

            try {
                const resp = await fetch('api/serving/predict', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: inputData }),
                });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(err.detail || `HTTP ${resp.status}`);
                }
                const result = await resp.json();
                _renderResult(resultArea, result, schema);

                // Add to history
                history.unshift({ input: inputData, result, timestamp: new Date().toLocaleTimeString() });
                _renderHistory(historyArea, historyTitle, history);

            } catch (err) {
                resultArea.innerHTML = `<div style="color:#c00;font-size:12px">${escapeHtml(err.message)}</div>`;
            }
            predictBtn.disabled = false;
            predictBtn.innerHTML = '<i class="fa-solid fa-play" style="font-size:10px;margin-right:4px"></i>Predict';
        });

        clearBtn.addEventListener('click', () => {
            for (const input of Object.values(inputFields)) input.value = '';
            jsonInput.value = '';
            resultArea.innerHTML = '';
        });
    }

    function _renderResult(container, result, schema) {
        container.innerHTML = '';
        const prediction = result.prediction;
        const format = result.format || 'unknown';
        const visualization = result.visualization || schema.output_visualization || 'value';

        // Model info
        const metaDiv = document.createElement('div');
        metaDiv.style.cssText = 'font-size:10px;color:#888;margin-bottom:8px';
        metaDiv.textContent = `${result.model_name || ''} v${result.model_version || ''} - ${format}`;
        container.appendChild(metaDiv);

        if (format === 'scalar' || visualization === 'value') {
            // Single value
            const val = document.createElement('div');
            val.style.cssText = 'font-size:20px;font-weight:700;color:#333;font-family:var(--font-mono);padding:12px;background:#f8f8f8;border-radius:4px;text-align:center';
            val.textContent = typeof prediction === 'number' ? prediction.toFixed(6) : String(prediction);
            container.appendChild(val);

        } else if (visualization === 'line_chart' && Array.isArray(prediction)) {
            // Line chart via ECharts
            _renderPredictionChart(container, prediction, result.shape);

        } else if (visualization === 'bar_chart' && Array.isArray(prediction)) {
            // Bar chart for class probabilities
            const labels = schema.class_labels || prediction.map((_, i) => `class_${i}`);
            _renderBarChart(container, prediction, labels);

        } else if (visualization === 'table' || format === 'dataframe') {
            // Table
            _renderPredictionTable(container, prediction, result.columns);

        } else {
            // Fallback: JSON
            const pre = document.createElement('pre');
            pre.style.cssText = 'padding:12px;font-size:11px;font-family:var(--font-mono);background:#f8f8f8;border:0.5px solid #e0e0e0;border-radius:4px;overflow-x:auto;white-space:pre-wrap;color:#333;max-height:200px;overflow-y:auto';
            pre.textContent = JSON.stringify(prediction, null, 2);
            container.appendChild(pre);
        }
    }

    function _renderPredictionChart(container, values, shape) {
        const chartDiv = document.createElement('div');
        chartDiv.style.cssText = 'width:100%;height:200px;margin-top:8px';
        container.appendChild(chartDiv);

        if (typeof echarts === 'undefined') {
            chartDiv.textContent = JSON.stringify(values);
            return;
        }

        const chart = echarts.init(chartDiv);
        chart.setOption({
            grid: { left: 50, right: 20, top: 20, bottom: 30 },
            xAxis: { type: 'category', data: values.map((_, i) => i), axisLabel: { fontSize: 10 } },
            yAxis: { type: 'value', axisLabel: { fontSize: 10 } },
            series: [{ type: 'line', data: values, smooth: true, lineStyle: { color: '#42a5f5' }, itemStyle: { color: '#42a5f5' } }],
            tooltip: { trigger: 'axis', textStyle: { fontSize: 11 } },
        });
        new ResizeObserver(() => chart.resize()).observe(chartDiv);
    }

    function _renderBarChart(container, values, labels) {
        const chartDiv = document.createElement('div');
        chartDiv.style.cssText = 'width:100%;height:200px;margin-top:8px';
        container.appendChild(chartDiv);

        if (typeof echarts === 'undefined') {
            chartDiv.textContent = JSON.stringify(Object.fromEntries(labels.map((l, i) => [l, values[i]])));
            return;
        }

        const chart = echarts.init(chartDiv);
        chart.setOption({
            grid: { left: 50, right: 20, top: 20, bottom: 40 },
            xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 10, rotate: 30 } },
            yAxis: { type: 'value', axisLabel: { fontSize: 10 } },
            series: [{ type: 'bar', data: values, itemStyle: { color: '#66bb6a' } }],
            tooltip: { trigger: 'axis', textStyle: { fontSize: 11 } },
        });
        new ResizeObserver(() => chart.resize()).observe(chartDiv);
    }

    function _renderPredictionTable(container, values, columns) {
        const table = document.createElement('table');
        table.style.cssText = 'width:100%;border-collapse:collapse;font-size:11px;margin-top:8px';

        if (columns) {
            const thead = document.createElement('thead');
            thead.innerHTML = '<tr>' + columns.map(c =>
                `<th style="text-align:left;padding:4px 8px;background:#bfdcff;font-weight:600;border:0.5px solid #e0e0e0">${escapeHtml(c)}</th>`
            ).join('') + '</tr>';
            table.appendChild(thead);
        }

        const tbody = document.createElement('tbody');
        const rows = Array.isArray(values[0]) ? values : [values];
        for (let i = 0; i < rows.length; i++) {
            const tr = document.createElement('tr');
            tr.style.background = i % 2 ? '#f8f8f8' : '';
            const cells = Array.isArray(rows[i]) ? rows[i] : [rows[i]];
            tr.innerHTML = cells.map(v =>
                `<td style="padding:4px 8px;border:0.5px solid #f0f0f0;font-family:var(--font-mono)">${typeof v === 'number' ? v.toFixed(6) : escapeHtml(String(v))}</td>`
            ).join('');
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        container.appendChild(table);
    }

    function _renderHistory(historyArea, historyTitle, history) {
        if (!history.length) return;
        historyTitle.style.display = '';
        historyArea.innerHTML = '';

        for (let i = 0; i < Math.min(history.length, 5); i++) {
            const entry = history[i];
            const row = document.createElement('div');
            row.style.cssText = 'padding:6px 8px;border:0.5px solid #e0e0e0;border-radius:3px;margin-bottom:4px;font-size:10px';
            const inputStr = JSON.stringify(entry.input).substring(0, 60);
            const outputStr = typeof entry.result.prediction === 'number'
                ? entry.result.prediction.toFixed(4)
                : JSON.stringify(entry.result.prediction).substring(0, 40);
            row.innerHTML = `<span style="color:#888">${entry.timestamp}</span> `
                + `<span style="font-family:var(--font-mono);color:#555">${escapeHtml(inputStr)}...</span> `
                + `<span style="color:#2e7d32;font-weight:500">-> ${escapeHtml(outputStr)}</span>`;
            historyArea.appendChild(row);
        }
    }

    // ── Load for Serving (from version detail) ───────────────────

    function showLoadButton(container, modelName, version) {
        const btn = document.createElement('button');
        btn.className = 'rm-btn';
        btn.style.cssText = 'display:flex;align-items:center;gap:6px;background:#c8e6c0';
        btn.innerHTML = '<i class="fa-solid fa-flask" style="font-size:10px"></i> Try It';
        btn.addEventListener('click', () => showTryItPanel(modelName, version));
        container.appendChild(btn);
    }

    return {
        showTryItPanel,
        showLoadButton,
    };
}
