/**
 * MetricsPanel - Live training metrics chart using jsPanel + Apache ECharts.
 * Receives metric data points via Socket.IO and renders real-time line charts.
 *
 * View modes:
 *   - Split (default): one chart per time-series metric (2+ points), 2-column grid
 *   - Combined: all time-series metrics overlaid on one chart
 *   - Summary: table with all metrics (latest value, min, max, count)
 *
 * Each chart and the summary table have a copy-to-clipboard button.
 */

export class MetricsPanel {
    constructor() {
        this._panel = null;
        this._bodyEl = null;
        this._charts = [];       // ECharts instances for resize/dispose
        this._chartsByKey = {};  // metric key -> ECharts instance (for split live update)
        this._traces = {};       // key -> { x: [], y: [] }
        this._traceOrder = [];   // ordered list of metric keys
        this._runId = null;
        this._autoOpened = false;
        this._viewMode = 'split'; // 'split' | 'combined' | 'summary'
    }

    get isOpen() { return !!this._panel; }

    /** Time-series keys (2+ data points). */
    get _tsKeys() { return this._traceOrder.filter(k => this._traces[k].x.length >= 2); }

    toggle() {
        if (this._panel) { this.close(); } else { this.open(); }
    }

    open() {
        if (this._panel) { this._panel.front(); return; }
        const offset = (this._positionOffset || 0) * 25;
        this._panel = jsPanel.create({
            headerTitle: '<i class="fa-solid fa-chart-simple" style="color:#42a5f5;margin-right:6px"></i>Live Metrics',
            theme: 'none',
            borderRadius: '5px',
            border: '1px solid var(--border-color)',
            panelSize: { width: 784, height: 420 },
            position: { my: 'center', at: 'center', offsetX: offset, offsetY: offset },
            boxShadow: 3,
            headerControls: { minimize: 'remove', smallify: 'remove', normalize: 'remove', maximize: 'remove' },
            addCloseControl: 1,
            onclosed: () => { this._disposeCharts(); this._panel = null; this._bodyEl = null; },
            callback: (panel) => this._buildContent(panel)
        });
    }

    close() {
        if (this._panel) { this._panel.close(); this._panel = null; this._bodyEl = null; }
    }

    clear() {
        this._traces = {};
        this._traceOrder = [];
        this._runId = null;
        this._autoOpened = false;
        if (this._infoEl) this._infoEl.textContent = '';
        this._renderView();
    }

    /**
     * Load historical metric data from MLflow (called from Explorer run detail).
     * Each call spawns a new independent panel so runs can be compared side by side.
     */
    loadHistory(runId, runName, metricsMap) {
        const histPanel = new MetricsPanel();
        histPanel._traces = {};
        histPanel._traceOrder = [];
        histPanel._runId = runId;
        const shortId = runId.substring(0, 8);
        histPanel._historyTitle = `${runName || 'Metrics'} (${shortId})`;

        for (const [key, history] of Object.entries(metricsMap)) {
            histPanel._traces[key] = { x: [], y: [] };
            histPanel._traceOrder.push(key);
            for (const point of history) {
                histPanel._traces[key].x.push(point.step);
                histPanel._traces[key].y.push(point.value);
            }
        }

        // Offset position so panels don't stack exactly
        MetricsPanel._historyCount = (MetricsPanel._historyCount || 0) + 1;
        histPanel._positionOffset = MetricsPanel._historyCount;
        histPanel.open();
    }

    // ── Incoming data ──────────────────────────────────────────────

    onMetricUpdate(metric) {
        if (!metric || metric.value == null) return;

        if (!this._panel) { this.open(); this._autoOpened = true; }

        // New run - reset
        if (metric.run_id && metric.run_id !== this._runId) {
            this._traces = {};
            this._traceOrder = [];
            this._runId = metric.run_id;
            this._totalEpochs = null;
            if (this._progressRow) this._progressRow.style.display = 'none';
        }

        const key = metric.key;
        const step = metric.step != null ? metric.step : (this._traces[key] ? this._traces[key].x.length : 0);
        const value = metric.value;

        if (!this._traces[key]) {
            this._traces[key] = { x: [], y: [] };
            this._traceOrder.push(key);
        }
        this._traces[key].x.push(step);
        this._traces[key].y.push(value);

        this._liveUpdate(key);

        this._updateInfoBar();
        this._updateProgress(metric);
    }

    // ── Panel chrome ───────────────────────────────────────────────

    _buildContent(panel) {
        const content = panel.content;
        content.innerHTML = '';
        content.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;border-radius:0 0 5px 5px;';

        // Toolbar
        const toolbar = document.createElement('div');
        toolbar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 12px;border-bottom:1px solid var(--border-color,#eee);flex-shrink:0';

        this._infoEl = document.createElement('span');
        this._infoEl.style.cssText = 'font-size:11px;color:#333333;font-family:var(--font-mono,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1';
        toolbar.appendChild(this._infoEl);

        const btnActive = 'background:#4a90d9;color:#fefefe;border:none';
        const btnInactive = 'background:#ffffff;color:#616161;border:0.5px solid #cecece';

        const modes = [
            { id: 'split', label: 'Split' },
            { id: 'combined', label: 'Combined' },
            { id: 'summary', label: 'Summary' },
        ];
        this._modeButtons = {};
        for (const m of modes) {
            const btn = document.createElement('button');
            btn.className = 'explorer-btn';
            btn.textContent = m.label;
            btn.style.cssText = this._viewMode === m.id ? btnActive : btnInactive;
            btn.addEventListener('click', () => this._setViewMode(m.id));
            toolbar.appendChild(btn);
            this._modeButtons[m.id] = btn;
        }


        content.appendChild(toolbar);

        // Epoch progress bar (shown when epoch-like metrics are detected)
        this._progressRow = document.createElement('div');
        this._progressRow.style.cssText = 'display:none;padding:4px 12px;flex-shrink:0;border-bottom:1px solid var(--border-color,#eee)';
        this._progressRow.innerHTML =
            '<div style="display:flex;align-items:center;gap:8px;font-size:10px;color:#555">'
            + '<span class="epoch-label" style="font-family:var(--font-mono);white-space:nowrap">Epoch 0</span>'
            + '<div style="flex:1;height:6px;background:#e0e0e0;border-radius:3px;overflow:hidden">'
            + '<div class="epoch-bar" style="height:100%;background:#42a5f5;border-radius:3px;width:0;transition:width 0.3s"></div></div>'
            + '<span class="epoch-pct" style="font-family:var(--font-mono);white-space:nowrap"></span>'
            + '</div>';
        content.appendChild(this._progressRow);
        this._totalEpochs = null;

        // Body
        this._bodyEl = document.createElement('div');
        this._bodyEl.style.cssText = 'flex:1;min-height:0;overflow:hidden';
        content.appendChild(this._bodyEl);

        // Resize observer on the panel content - fires when jsPanel is resized
        this._resizeObs = new ResizeObserver(() => {
            for (const chart of this._charts) {
                if (!chart.isDisposed()) chart.resize();
            }
        });
        this._resizeObs.observe(content);

        // Defer rendering to next frame so the panel has its final dimensions
        requestAnimationFrame(() => {
            // Apply history title if loaded from Explorer
            if (this._historyTitle) {
                panel.setHeaderTitle(
                    `<i class="fa-solid fa-chart-simple" style="color:#42a5f5;margin-right:6px"></i>${this._historyTitle}`
                );
                this._historyTitle = null;
            }
            this._renderView();
            this._updateInfoBar();
        });
    }

    _setViewMode(mode) {
        this._viewMode = mode;
        const active = 'background:#4a90d9;color:#fefefe;border:none';
        const inactive = 'background:#ffffff;color:#616161;border:0.5px solid #cecece';
        for (const [id, btn] of Object.entries(this._modeButtons)) {
            btn.style.cssText = id === mode ? active : inactive;
        }
        this._renderView();
    }

    _updateInfoBar() {
        if (!this._infoEl) return;
        const parts = this._traceOrder.map(k => {
            const vals = this._traces[k].y;
            const v = vals[vals.length - 1];
            return `${k}: ${Number.isInteger(v) ? v : v.toFixed(4)}`;
        });
        this._infoEl.textContent = parts.join('  |  ');
    }

    _updateProgress(metric) {
        if (!this._progressRow) return;

        // Detect total_epochs from a logged param (passed as a metric with key 'total_epochs' or 'epochs')
        if (metric.key === 'total_epochs' || metric.key === 'epochs') {
            this._totalEpochs = Math.round(metric.value);
        }

        // Find current epoch from the first real training metric's step count
        // Skip total_epochs/epochs which are single-value params, not per-epoch metrics
        const SKIP_KEYS = new Set(['total_epochs', 'epochs']);
        const epochKey = this._traceOrder.find(k => !SKIP_KEYS.has(k));
        if (!epochKey) return;
        const steps = this._traces[epochKey]?.x;
        if (!steps?.length) return;
        const currentEpoch = steps[steps.length - 1] || steps.length;

        // Show progress bar
        this._progressRow.style.display = '';
        const label = this._progressRow.querySelector('.epoch-label');
        const bar = this._progressRow.querySelector('.epoch-bar');
        const pct = this._progressRow.querySelector('.epoch-pct');

        if (this._totalEpochs && this._totalEpochs > 0) {
            const progress = Math.min(100, (currentEpoch / this._totalEpochs) * 100);
            label.textContent = `Epoch ${currentEpoch} / ${this._totalEpochs}`;
            bar.style.width = `${progress}%`;
            pct.textContent = `${Math.round(progress)}%`;
        } else {
            label.textContent = `Epoch ${currentEpoch}`;
            bar.style.width = '0';
            pct.textContent = '';
        }
    }

    _disposeCharts() {
        for (const chart of this._charts) {
            if (!chart.isDisposed()) chart.dispose();
        }
        this._charts = [];
        this._chartsByKey = {};
    }

    // ── View rendering ─────────────────────────────────────────────

    _renderView() {
        if (!this._bodyEl) return;
        this._disposeCharts();
        this._bodyEl.innerHTML = '';
        this._bodyEl.style.overflow = this._viewMode === 'summary' ? 'auto' : 'hidden';

        if (this._viewMode === 'split') this._renderSplit();
        else if (this._viewMode === 'combined') this._renderCombined();
        else this._renderSummary();
    }

    // ── Split view ─────────────────────────────────────────────────

    _renderSplit() {
        const keys = this._tsKeys;
        if (!keys.length) {
            this._bodyEl.innerHTML = '<div style="padding:24px;text-align:center;color:#999">No time-series metrics yet</div>';
            return;
        }

        const rows = Math.ceil(keys.length / 2);
        const grid = document.createElement('div');
        grid.style.cssText = `display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;height:100%;grid-template-rows:repeat(${rows}, 1fr)`;

        const pending = [];
        for (const key of keys) {
            const wrapper = this._createChartWrapper(key);
            const chartEl = wrapper.querySelector('.metrics-chart');
            grid.appendChild(wrapper);
            pending.push({ chartEl, key });
        }
        this._bodyEl.appendChild(grid);

        // Defer chart init so grid cells have resolved dimensions
        requestAnimationFrame(() => {
            for (const { chartEl, key } of pending) {
                const chart = echarts.init(chartEl);
                this._charts.push(chart);
                this._chartsByKey[key] = chart;
                chart.setOption(this._singleChartOption(key));
            }
        });
    }

    _singleChartOption(key) {
        const t = this._traces[key];
        return {
            animation: false,
            grid: { left: 46, right: 47, top: 38, bottom: 43, containLabel: false },
            title: { text: key, left: 'center', top: 2, textStyle: { fontSize: 11, color: '#333', fontWeight: 500 } },
            tooltip: {
                trigger: 'axis',
                textStyle: { fontSize: 11 },
                axisPointer: { lineStyle: { color: '#a0d8a0', type: 'dashed', width: 2 } },
                formatter: (params) => {
                    const p = params[0];
                    return `Step ${p.data[0]}<br/>${p.marker} ${p.seriesName}: <b>${p.data[1].toFixed(6)}</b>`;
                }
            },
            xAxis: { type: 'value', name: 'Step', nameTextStyle: { fontSize: 9 }, axisLabel: { fontSize: 9 },
                     splitLine: { lineStyle: { color: 'rgba(128,128,128,0.2)' } } },
            yAxis: { type: 'value', axisLabel: { fontSize: 9 },
                     splitLine: { lineStyle: { color: 'rgba(128,128,128,0.2)' } } },
            series: [{
                type: 'line', name: key, data: t.x.map((x, i) => [x, t.y[i]]),
                symbol: 'circle', symbolSize: 4, lineStyle: { width: 2 },
                itemStyle: { borderWidth: 0 },
                emphasis: { itemStyle: { color: '#f4a0a0', borderColor: '#e06060', borderWidth: 2, shadowBlur: 6, shadowColor: 'rgba(224,96,96,0.4)' } }
            }],
            backgroundColor: '#fefefe',
            textStyle: { color: '#333333' }
        };
    }

    // ── Combined view ──────────────────────────────────────────────

    _renderCombined() {
        const keys = this._tsKeys;
        if (!keys.length) {
            this._bodyEl.innerHTML = '<div style="padding:24px;text-align:center;color:#999">No time-series metrics yet</div>';
            return;
        }

        const wrapper = this._createChartWrapper('All Metrics');
        wrapper.style.height = '100%';
        const chartEl = wrapper.querySelector('.metrics-chart');
        this._bodyEl.appendChild(wrapper);

        const chart = echarts.init(chartEl);
        this._charts.push(chart);

        const series = keys.map(key => {
            const t = this._traces[key];
            return {
                name: key, type: 'line',
                data: t.x.map((x, i) => [x, t.y[i]]),
                symbol: 'circle', symbolSize: 4, lineStyle: { width: 2 },
                itemStyle: { borderWidth: 0 },
                emphasis: { itemStyle: { color: '#f4a0a0', borderColor: '#e06060', borderWidth: 2, shadowBlur: 6, shadowColor: 'rgba(224,96,96,0.4)' } }
            };
        });

        chart.setOption({
            animation: false,
            grid: { left: 50, right: 60, top: 34, bottom: 70, containLabel: false },
            xAxis: { type: 'value', name: 'Step',
                     splitLine: { lineStyle: { color: 'rgba(128,128,128,0.2)' } } },
            yAxis: { type: 'value',
                     splitLine: { lineStyle: { color: 'rgba(128,128,128,0.2)' } } },
            legend: { bottom: 4, textStyle: { fontSize: 11 } },
            tooltip: {
                trigger: 'axis',
                textStyle: { fontSize: 11 },
                axisPointer: { lineStyle: { color: '#a0d8a0', type: 'dashed', width: 2 } },
                formatter: (params) => {
                    let html = `Step ${params[0].data[0]}`;
                    for (const p of params) {
                        html += `<br/>${p.marker} ${p.seriesName}: <b>${p.data[1].toFixed(6)}</b>`;
                    }
                    return html;
                }
            },
            series,
            backgroundColor: '#fefefe',
            textStyle: { color: '#333333' }
        });
    }

    // ── Summary table view ─────────────────────────────────────────

    _renderSummary() {
        if (!this._traceOrder.length) {
            this._bodyEl.innerHTML = '<div style="padding:24px;text-align:center;color:#999">No metrics yet</div>';
            return;
        }

        const container = document.createElement('div');
        container.style.cssText = 'padding:12px 17px 17px 17px;height:100%;overflow:auto;background:#fefefe';

        const copyRow = document.createElement('div');
        copyRow.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:8px';
        const tableCopyBtn = this._createCopyBtn(() => this._copyTable());
        tableCopyBtn.title = 'Copy table';
        tableCopyBtn.style.cssText = 'opacity:1;position:relative';
        copyRow.appendChild(tableCopyBtn);
        container.appendChild(copyRow);

        const table = document.createElement('table');
        table.className = 'metrics-summary-table';
        table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;font-family:var(--font-mono,monospace);color:#333333';

        const thead = document.createElement('thead');
        const hr = document.createElement('tr');
        for (const h of ['Metric', 'Latest', 'Min', 'Max', 'Steps']) {
            const th = document.createElement('th');
            th.textContent = h;
            th.style.cssText = 'text-align:left;padding:6px 10px;border-bottom:2px solid #4a90d9;font-weight:600;white-space:nowrap';
            hr.appendChild(th);
        }
        thead.appendChild(hr);
        table.appendChild(thead);

        this._tableBody = document.createElement('tbody');
        this._tableRowEls = {};
        for (const key of this._traceOrder) {
            this._tableBody.appendChild(this._createTableRow(key));
        }
        table.appendChild(this._tableBody);
        container.appendChild(table);
        this._bodyEl.appendChild(container);
    }

    _createTableRow(key) {
        const vals = this._traces[key].y;
        const latest = vals[vals.length - 1];
        const tr = document.createElement('tr');
        tr.style.cssText = 'border-bottom:1px solid #eee';
        const cells = {};
        const tdStyle = 'padding:5px 10px;white-space:nowrap';
        const nameTd = document.createElement('td');
        nameTd.textContent = key;
        nameTd.style.cssText = tdStyle;
        tr.appendChild(nameTd);
        for (const col of ['latest', 'min', 'max', 'steps']) {
            const td = document.createElement('td');
            td.style.cssText = tdStyle;
            cells[col] = td;
            tr.appendChild(td);
        }
        cells.latest.textContent = latest.toFixed(4);
        cells.min.textContent = Math.min(...vals).toFixed(4);
        cells.max.textContent = Math.max(...vals).toFixed(4);
        cells.steps.textContent = String(vals.length);
        this._tableRowEls[key] = cells;
        return tr;
    }

    _updateTableRow(key) {
        const cells = this._tableRowEls[key];
        if (!cells) return;
        const vals = this._traces[key].y;
        cells.latest.textContent = vals[vals.length - 1].toFixed(4);
        cells.min.textContent = Math.min(...vals).toFixed(4);
        cells.max.textContent = Math.max(...vals).toFixed(4);
        cells.steps.textContent = String(vals.length);
    }

    // ── Live update (avoids full rebuild) ──────────────────────────

    _liveUpdate(key) {
        if (!this._bodyEl) return;

        const t = this._traces[key];
        const isNew = t.x.length === 1;
        const justBecameTS = t.x.length === 2;

        if (this._viewMode === 'summary') {
            if (this._tableRowEls && this._tableRowEls[key]) {
                this._updateTableRow(key);
            } else if (this._tableBody) {
                // New metric appeared - add a row
                this._tableBody.appendChild(this._createTableRow(key));
            }
            return;
        }

        if (isNew || justBecameTS) {
            this._renderView();
            return;
        }

        if (this._viewMode === 'split') {
            const chart = this._chartsByKey?.[key];
            if (chart && !chart.isDisposed()) {
                const series = chart.getOption().series;
                series[0].data.push([t.x[t.x.length - 1], t.y[t.y.length - 1]]);
                chart.setOption({ series });
            }
        } else if (this._viewMode === 'combined') {
            const chart = this._charts[0];
            if (!chart || chart.isDisposed()) return;
            const tsKeys = this._tsKeys;
            const idx = tsKeys.indexOf(key);
            if (idx >= 0) {
                const series = chart.getOption().series;
                series[idx].data.push([t.x[t.x.length - 1], t.y[t.y.length - 1]]);
                chart.setOption({ series });
            }
        }
    }

    // ── Chart wrapper with copy button ─────────────────────────────

    static get COPY_SVG() {
        return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" fill="#a8d8a0"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    }

    _createChartWrapper(label) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'position:relative;min-height:0;min-width:0;display:flex;flex-direction:column;overflow:hidden';

        const chartEl = document.createElement('div');
        chartEl.className = 'metrics-chart';
        chartEl.style.cssText = 'flex:1;min-height:0;width:100%;overflow:hidden';
        wrapper.appendChild(chartEl);

        const copyBtn = this._createCopyBtn(() => this._copyChart(chartEl));
        copyBtn.title = `Copy ${label}`;
        copyBtn.style.cssText += ';position:absolute;top:4px;right:4px;opacity:0;z-index:2';
        wrapper.addEventListener('mouseenter', () => copyBtn.style.opacity = '1');
        wrapper.addEventListener('mouseleave', () => copyBtn.style.opacity = '0');
        wrapper.appendChild(copyBtn);

        return wrapper;
    }

    _createCopyBtn(onClick) {
        const btn = document.createElement('button');
        btn.className = 'cell-copy-btn';
        btn.innerHTML = MetricsPanel.COPY_SVG;
        btn.style.cssText = 'opacity:1;position:relative';
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await onClick();
            const tip = document.createElement('span');
            tip.className = 'cell-copy-toast';
            tip.textContent = 'Copied';
            btn.appendChild(tip);
            setTimeout(() => tip.remove(), 1200);
        });
        return btn;
    }

    // ── Copy helpers ───────────────────────────────────────────────

    async _copyChart(chartEl) {
        try {
            const instance = echarts.getInstanceByDom(chartEl);
            if (!instance) return;
            const dataUrl = instance.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fefefe' });
            const resp = await fetch(dataUrl);
            const blob = await resp.blob();
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        } catch (e) {
            console.error('Chart copy failed:', e);
        }
    }

    async _copyTable() {
        if (!this._traceOrder.length) return;
        try {
            const lines = ['Metric\tLatest\tMin\tMax\tSteps'];
            for (const key of this._traceOrder) {
                const vals = this._traces[key].y;
                lines.push(`${key}\t${vals[vals.length - 1].toFixed(4)}\t${Math.min(...vals).toFixed(4)}\t${Math.max(...vals).toFixed(4)}\t${vals.length}`);
            }
            const tsv = lines.join('\n');
            const htmlRows = lines.map((line, i) => {
                const tag = i === 0 ? 'th' : 'td';
                return '<tr>' + line.split('\t').map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
            }).join('');
            const html = `<table>${htmlRows}</table>`;

            await navigator.clipboard.write([new ClipboardItem({
                'text/plain': new Blob([tsv], { type: 'text/plain' }),
                'text/html': new Blob([html], { type: 'text/html' }),
            })]);
        } catch (e) {
            console.error('Table copy failed:', e);
        }
    }
}
