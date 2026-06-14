/* Architecture / service-map diagram for the Help & Support area.
 * A hand-authored, data-driven SVG (fits a ~1000x800 panel) showing the
 * containers job2cool actually depends on AT REQUEST TIME, grouped by tier,
 * with a health dot per container that recolors green / orange / red / grey.
 *
 * Scope: job2cool's own dependency set only. noted's platform infra
 * (Airflow / Postgres / Redis / MLflow / MinIO / Evidently / model-serving)
 * powers KB *ingestion* and is NOT on job2cool's request path, so it is
 * deliberately excluded.
 *
 * Public API (window.JOB2COOL_ARCHITECTURE):
 *   render(rootEl, {onRefresh})  -> draws toolbar + SVG into rootEl
 *   setHealth(map)               -> map[containerId] = 'ok'|'degraded'|'down'|'unknown'
 *   setStatusText(s)             -> right-aligned "last checked …" line
 *   NODES                        -> the node model (ids = docker container names)
 *
 * No external library, no timers (event-driven per project rule): health is
 * fetched on open and on an explicit Refresh click by the host view. */
(function () {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const W = 1000, H = 800;

  const STATUS = {
    ok:       { fill: '#22c55e', label: 'Healthy' },
    degraded: { fill: '#f59e0b', label: 'Degraded' },
    down:     { fill: '#ef4444', label: 'Down' },
    unknown:  { fill: '#cbd5e1', label: 'Unknown' },
  };
  const NET = {
    app:     '#f5c518', // the app itself (gold)
    edge:    '#64748b', // proxy / identity
    noted:   '#3b82f6', // noted-network
    logus2k: '#8b5cf6', // logus2k_network (voice)
    mcp:     '#14b8a6', // mcp_internal
  };

  // --- node model: id (= container name), placement, network, probe flag -----
  const NODES = {
    'job2cool-backend': { x: 385, y: 178, w: 230, h: 64, net: 'app',     label: 'job2cool-backend', sub: 'App orchestrator · FastAPI', port: ':4920', probe: false, big: true },

    'proxy_server':     { x: 292, y: 80,  w: 180, h: 54, net: 'edge',    label: 'proxy_server',  sub: 'nginx · public origin · auth', port: ':80/443', probe: false },
    'oauth2-proxy':     { x: 528, y: 80,  w: 180, h: 54, net: 'edge',    label: 'oauth2-proxy',  sub: 'Google auth → X-Forwarded-*', port: '—', probe: false },

    'agent_server':     { x: 138, y: 284, w: 160, h: 64, net: 'noted',   label: 'agent_server',  sub: 'LLM API · gemma-4 · ma2-dpo', port: ':7701', probe: true },
    'kb-service':       { x: 326, y: 284, w: 160, h: 64, net: 'noted',   label: 'kb-service',    sub: 'KB gateway · /rag /graph', port: ':4940', probe: true },
    'mcp-service':      { x: 514, y: 284, w: 160, h: 64, net: 'mcp',     label: 'mcp-service',   sub: 'Tools / Skills host', port: ':4950', probe: true },
    'noted-tools':      { x: 702, y: 284, w: 160, h: 64, net: 'noted',   label: 'noted-tools',   sub: 'MCP user-tools · optional', port: ':7702', probe: true },

    'websearch_server': { x: 820, y: 378, w: 152, h: 48, net: 'mcp',     label: 'websearch_server', sub: 'web_search backend · Camoufox', port: ':4960', probe: true, sm: true },

    'noted-rag':        { x: 218, y: 474, w: 168, h: 58, net: 'noted',   label: 'noted-rag',     sub: 'Vector retrieval · ChromaDB', port: ':8201', probe: true },
    'noted-graph':      { x: 416, y: 474, w: 168, h: 58, net: 'noted',   label: 'noted-graph',   sub: 'Knowledge-graph retrieval ⚡', port: ':5523', probe: true },
    'noted':            { x: 614, y: 474, w: 168, h: 58, net: 'noted',   label: 'noted',         sub: 'KB / document files', port: ':8123', probe: true },

    'llama-vision':     { x: 270, y: 580, w: 240, h: 58, net: 'noted',   label: 'llama-vision',  sub: 'GPU host · gemma-4 + bge-m3 + reranker', port: ':8500', probe: true },
    'noted-arcadedb':   { x: 560, y: 580, w: 170, h: 58, net: 'noted',   label: 'noted-arcadedb', sub: 'Graph persistence', port: ':2480', probe: true },

    'stt_server':       { x: 220, y: 686, w: 160, h: 54, net: 'logus2k', label: 'stt_server',    sub: 'Speech-to-text', port: ':2700', probe: true },
    'tts_server':       { x: 420, y: 686, w: 160, h: 54, net: 'logus2k', label: 'tts_server',    sub: 'Text-to-speech', port: ':7700', probe: true },
    'avatar_server':    { x: 620, y: 686, w: 160, h: 54, net: 'logus2k', label: 'avatar_server', sub: 'Talking avatar', port: ':7800', probe: true },
  };

  // Group/tier labels (small caps above each cluster).
  const GROUPS = [
    { x: 292, y: 72,  t: 'Edge & Identity' },
    { x: 385, y: 170, t: 'Application' },
    { x: 138, y: 276, t: 'Direct dependencies' },
    { x: 820, y: 370, t: 'mcp tool backend' },
    { x: 218, y: 466, t: 'KB engine stack · via kb-service' },
    { x: 270, y: 572, t: 'Model & graph store' },
  ];

  // Faint enclosing panel for the voice cluster.
  const PANELS = [
    { x: 206, y: 678, w: 580, h: 70, t: 'Voice · via proxy origin' },
  ];

  // --- edges (call paths). via:'left' routes through a left side channel.
  // gapY forces the horizontal-run y for an elbow (to clear other nodes). -----
  const EDGES = [
    { a: 'oauth2-proxy', b: 'proxy_server', side: true },          // auth_request
    { a: 'proxy_server', b: 'job2cool-backend' },
    { a: 'job2cool-backend', b: 'agent_server' },
    { a: 'job2cool-backend', b: 'kb-service' },
    { a: 'job2cool-backend', b: 'mcp-service' },
    { a: 'job2cool-backend', b: 'noted-tools', dashed: true },     // optional
    { a: 'mcp-service', b: 'websearch_server', dashed: true, gapY: 368 },
    { a: 'kb-service', b: 'noted-rag' },
    { a: 'kb-service', b: 'noted-graph' },
    { a: 'kb-service', b: 'noted' },
    { a: 'agent_server', b: 'llama-vision', via: 'left' },
    { a: 'noted-rag', b: 'llama-vision' },
    { a: 'noted-graph', b: 'noted-arcadedb' },
  ];

  const LEFT_CH = 44;

  function el(name, attrs, text) {
    const n = document.createElementNS(SVGNS, name);
    for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }
  const cx = n => n.x + n.w / 2;

  function edgePath(e) {
    const a = NODES[e.a], b = NODES[e.b];
    if (e.side) {
      const y = a.y + a.h / 2;
      const x1 = Math.min(a.x + a.w, b.x), x2 = Math.max(a.x + a.w, b.x);
      return `M ${x1} ${y} L ${x2} ${y}`;
    }
    if (e.via === 'left') {
      const ax = a.x, ay = a.y + a.h / 2, bx = b.x, by = b.y + b.h / 2;
      return `M ${ax} ${ay} L ${LEFT_CH} ${ay} L ${LEFT_CH} ${by} L ${bx} ${by}`;
    }
    const ax = cx(a), ay = a.y + a.h, bx = cx(b), by = b.y;
    const my = e.gapY != null ? e.gapY : (ay + by) / 2;
    return `M ${ax} ${ay} L ${ax} ${my} L ${bx} ${my} L ${bx} ${by}`;
  }

  function drawNode(svg, id, n) {
    const g = el('g', {});
    g.appendChild(el('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 11,
      fill: '#ffffff', stroke: n.big ? '#e7c948' : '#e5e9f0', 'stroke-width': n.big ? 2 : 1.2,
      filter: 'url(#nshadow)' }));
    g.appendChild(el('rect', { x: n.x, y: n.y, width: 5, height: n.h, rx: 2.5, fill: NET[n.net] || '#cbd5e1' }));
    const lx = n.x + 15;
    g.appendChild(el('text', { x: lx, y: n.y + (n.sm ? 19 : (n.big ? 27 : 25)), class: n.big ? 'n-l big' : 'n-l' }, n.label));
    g.appendChild(el('text', { x: lx, y: n.y + (n.sm ? 34 : (n.big ? 44 : 41)), class: 'n-s' }, n.sub));
    if (!n.sm) g.appendChild(el('text', { x: lx, y: n.y + n.h - 9, class: 'n-p' }, n.port));
    const dr = n.sm ? 5 : 6, dx = n.x + n.w - (n.sm ? 13 : 16), dy = n.y + (n.sm ? 13 : 16);
    g.appendChild(el('circle', { cx: dx, cy: dy, r: dr + 2, fill: '#fff' }));
    g.appendChild(el('circle', { id: 'adot-' + id, cx: dx, cy: dy, r: dr, fill: STATUS.unknown.fill,
      'data-probe': n.probe ? '1' : '0' }));
    if (!n.probe) g.appendChild(el('circle', { cx: dx, cy: dy, r: dr, fill: 'none', stroke: '#94a3b8',
      'stroke-width': 1, 'stroke-dasharray': '2 1.6' }));
    svg.appendChild(g);
  }

  function buildSVG() {
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', class: 'arch-svg',
      preserveAspectRatio: 'xMidYMid meet' });
    svg.innerHTML = `
      <defs>
        <filter id="nshadow" x="-10%" y="-10%" width="120%" height="130%">
          <feDropShadow dx="0" dy="1.5" stdDeviation="2.2" flood-color="#0f172a" flood-opacity="0.08"/>
        </filter>
      </defs>
      <style>
        .arch-svg{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#fcfdff;border-radius:12px}
        .n-l{font-weight:600;font-size:12.5px;fill:#1f2937}
        .n-l.big{font-size:15px}
        .n-s{font-size:10px;fill:#6b7280}
        .n-p{font-size:9px;fill:#9aa3af;font-family:ui-monospace,monospace}
        .g-l{font-weight:700;font-size:10.5px;fill:#94a3b8;letter-spacing:.05em}
        .a-title{font-weight:700;font-size:16px;fill:#1f2937}
        .a-sub{font-size:11px;fill:#94a3b8}
        .leg{font-size:11px;fill:#475569}
        .pan-l{font-weight:700;font-size:10px;fill:#94a3b8;letter-spacing:.04em}
        .foot{font-size:10px;fill:#aab4c2}
      </style>`;

    PANELS.forEach(p => {
      svg.appendChild(el('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 12,
        fill: '#faf8ff', stroke: '#ece7f8', 'stroke-width': 1, 'stroke-dasharray': '5 4' }));
      if (p.t) svg.appendChild(el('text', { x: p.x + 14, y: p.y + 16, class: 'pan-l' }, p.t.toUpperCase()));
    });

    // title + status legend
    svg.appendChild(el('text', { x: 24, y: 30, class: 'a-title' }, 'job2cool — service map'));
    svg.appendChild(el('text', { x: 24, y: 46, class: 'a-sub' }, 'request-path dependencies & live health'));
    ['ok', 'degraded', 'down', 'unknown'].forEach((k, i) => {
      const x = 560 + i * 112;
      svg.appendChild(el('circle', { cx: x, cy: 34, r: 6, fill: STATUS[k].fill }));
      svg.appendChild(el('text', { x: x + 12, y: 38, class: 'leg' }, STATUS[k].label));
    });

    // network legend (upper-left, clear of the edge band)
    [['app', 'this app'], ['noted', 'noted-network'], ['logus2k', 'logus2k-net'], ['mcp', 'mcp_internal'], ['edge', 'edge/identity']]
      .forEach((nv, i) => {
        const y = 92 + i * 18;
        svg.appendChild(el('rect', { x: 24, y: y - 9, width: 12, height: 12, rx: 3, fill: NET[nv[0]] }));
        svg.appendChild(el('text', { x: 42, y: y + 1, class: 'leg' }, nv[1]));
      });

    // edges (under nodes)
    EDGES.forEach(e => svg.appendChild(el('path', {
      d: edgePath(e), fill: 'none', stroke: '#c3ccd9', 'stroke-width': 1.6,
      'stroke-dasharray': e.dashed ? '5 4' : null, opacity: 0.85,
    })));

    GROUPS.forEach(gp => svg.appendChild(el('text', { x: gp.x, y: gp.y, class: 'g-l' }, gp.t.toUpperCase())));

    for (const id in NODES) drawNode(svg, id, NODES[id]);

    svg.appendChild(el('text', { x: W / 2, y: 770, class: 'foot', 'text-anchor': 'middle' },
      'noted platform infra (Airflow · Postgres · Redis · MLflow · MinIO) backs KB ingestion only — not on job2cool’s request path.'));

    return svg;
  }

  // --- public API ------------------------------------------------------------
  let _statusEl = null;

  function render(root, opts) {
    opts = opts || {};
    root.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'arch-wrap';
    wrap.innerHTML = `
      <style>
        .arch-wrap{padding:1rem 1.3rem;display:flex;flex-direction:column;gap:.7rem;min-height:0}
        .arch-bar{display:flex;align-items:center;gap:.7rem}
        .arch-bar h3{margin:0;font-size:15px;color:var(--ink,#1f2937)}
        .arch-bar .sp{flex:1}
        .arch-status{font-size:12px;color:var(--muted,#94a3b8)}
        .arch-refresh{border:1px solid var(--line,#e5e9f0);background:#fff;border-radius:8px;padding:.4rem .8rem;font:inherit;font-size:12.5px;cursor:pointer}
        .arch-refresh:hover{border-color:#cfe6f7;background:#f6fbff}
        .arch-stage{max-width:1000px;width:100%;margin:0 auto}
      </style>
      <div class="arch-bar">
        <h3>Architecture &amp; health</h3>
        <span class="sp"></span>
        <span class="arch-status" id="arch-status"></span>
        <button class="arch-refresh" id="arch-refresh">↻ Refresh</button>
      </div>
      <div class="arch-stage" id="arch-stage"></div>`;
    root.appendChild(wrap);
    wrap.querySelector('#arch-stage').appendChild(buildSVG());
    _statusEl = wrap.querySelector('#arch-status');
    const btn = wrap.querySelector('#arch-refresh');
    if (opts.onRefresh) btn.onclick = () => opts.onRefresh();
    else btn.style.display = 'none';
  }

  function setHealth(map) {
    map = map || {};
    for (const id in NODES) paint(id, map[id]);
  }
  function paint(id, status) {
    const dot = document.getElementById('adot-' + id);
    if (!dot) return;
    const probed = dot.getAttribute('data-probe') === '1';
    const key = status && STATUS[status] ? status : 'unknown';
    dot.setAttribute('fill', STATUS[key].fill);
    dot.setAttribute('opacity', (!probed && key === 'unknown') ? '0.55' : '1');
  }
  function setStatusText(s) { if (_statusEl) _statusEl.textContent = s || ''; }

  window.JOB2COOL_ARCHITECTURE = { render, setHealth, setStatusText, NODES, STATUS };
})();
