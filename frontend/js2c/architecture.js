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
  const W = 1000, H = 940;

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
    'browser':          { x: 395, y: 4,   w: 162, h: 46, net: 'edge',    label: 'Browser', sub: 'end user · cv-chat widget', client: true },

    'job2cool-backend': { x: 385, y: 218, w: 230, h: 64, net: 'app',     label: 'job2cool-backend', sub: 'App orchestrator · FastAPI', port: ':4920', probe: true, big: true },

    'proxy_server':     { x: 292, y: 100,  w: 180, h: 64, net: 'edge',    label: 'proxy_server',  sub: 'nginx · public origin · auth', port: ':80/443', probe: true },
    'oauth2-proxy':     { x: 528, y: 100,  w: 180, h: 64, net: 'edge',    label: 'oauth2-proxy',  sub: 'Google auth → X-Forwarded-*', port: ':4180', probe: true },

    'agent_server':     { x: 210, y: 344, w: 160, h: 64, net: 'noted',   label: 'agent_server',  sub: 'LLM API · gemma-4 · ma2-dpo', port: ':7701', probe: true },
    'kb-service':       { x: 420, y: 344, w: 160, h: 64, net: 'noted',   label: 'kb-service',    sub: 'KB gateway · /rag /graph', port: ':4940', probe: true },
    'mcp-service':      { x: 630, y: 344, w: 160, h: 64, net: 'mcp',     label: 'mcp-service',   sub: 'Tools / Skills host', port: ':4950', probe: true },

    'websearch_server': { x: 730, y: 458, w: 168, h: 64, net: 'mcp',     label: 'websearch_server', sub: 'web_search · Camoufox', port: ':4960', probe: true },

    'noted-rag':        { x: 218, y: 574, w: 168, h: 64, net: 'noted',   label: 'noted-rag',     sub: 'Vector retrieval · ChromaDB', port: ':8201', probe: true },
    'noted-graph':      { x: 416, y: 574, w: 168, h: 64, net: 'noted',   label: 'noted-graph',   sub: 'Knowledge-graph retrieval ⚡', port: ':5523', probe: true },
    'noted':            { x: 614, y: 574, w: 168, h: 64, net: 'noted',   label: 'noted',         sub: 'KB / document files', port: ':8123', probe: true },

    'llama-vision':     { x: 270, y: 700, w: 240, h: 64, net: 'noted',   label: 'llama-vision',  sub: 'GPU host · gemma-4 + bge-m3 + reranker', port: ':8500', probe: true },
    'noted-arcadedb':   { x: 560, y: 700, w: 170, h: 64, net: 'noted',   label: 'noted-arcadedb', sub: 'Graph persistence', port: ':2480', probe: true },

    'stt_server':       { x: 220, y: 826, w: 160, h: 64, net: 'logus2k', label: 'stt_server',    sub: 'Speech-to-text', port: ':2700', probe: true },
    'tts_server':       { x: 420, y: 826, w: 160, h: 64, net: 'logus2k', label: 'tts_server',    sub: 'Text-to-speech', port: ':7700', probe: true },
    'avatar_server':    { x: 620, y: 826, w: 160, h: 64, net: 'logus2k', label: 'avatar_server', sub: 'Talking avatar', port: ':7800', probe: true },
  };

  // Group/tier labels (small caps above each cluster).
  const GROUPS = [
    // all tier labels left-aligned in one vertical column (same x).
    { x: 68, y: 92,  t: 'Edge & Identity' },
    { x: 68, y: 210, t: 'Application' },
    { x: 68, y: 336, t: 'Direct dependencies' },
    { x: 68, y: 450, t: 'mcp tool backend' },
    { x: 68, y: 566, t: 'KB engine stack · via kb-service' },
    { x: 68, y: 692, t: 'Model & graph store' },
    { x: 68, y: 812, t: 'Voice · via proxy origin' },
  ];

  // Faint enclosing panel for the voice cluster.
  const PANELS = [
    { x: 206, y: 818, w: 580, h: 80, t: '' },
  ];

  // --- edges (call paths). via:'left' routes through a left side channel.
  // gapY forces the horizontal-run y for an elbow (to clear other nodes). -----
  const EDGES = [
    { a: 'browser', b: 'proxy_server' },                           // user enters via nginx
    { a: 'oauth2-proxy', b: 'proxy_server', side: true },          // auth_request
    { a: 'proxy_server', b: 'job2cool-backend' },
    // voice is reached Browser→proxy→stt/tts/avatar (not via the backend); the
    // proxy routes /stt /tts /avatar to them. Routed down a left bus to the
    // bottom voice cluster so the lines don't cross the whole diagram.
    { a: 'proxy_server', b: 'stt_server', via: 'voicebus', dashed: true },
    { a: 'proxy_server', b: 'tts_server', via: 'voicebus', dashed: true },
    { a: 'proxy_server', b: 'avatar_server', via: 'voicebus', dashed: true },
    { a: 'job2cool-backend', b: 'agent_server' },
    { a: 'job2cool-backend', b: 'kb-service' },
    { a: 'job2cool-backend', b: 'mcp-service' },
    { a: 'mcp-service', b: 'websearch_server', dashed: true, gapY: 430 },
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
    if (e.via === 'voicebus') {   // proxy → down a far-left bus → up into each voice node
      const ax = cx(a), bx = cx(b);
      return `M ${ax} ${a.y + a.h} L ${ax} 200 L 16 200 L 16 790 L ${bx} 790 L ${bx} ${b.y}`;
    }
    const ax = cx(a), ay = a.y + a.h, bx = cx(b), by = b.y;
    const my = e.gapY != null ? e.gapY : (ay + by) / 2;
    return `M ${ax} ${ay} L ${ax} ${my} L ${bx} ${my} L ${bx} ${by}`;
  }

  function drawNode(svg, id, n) {
    const g = el('g', {});
    if (n.client) {   // the user's browser — not a container: no health dot/port
      g.appendChild(el('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 11,
        fill: '#f8fafc', stroke: '#cbd5e1', 'stroke-width': 1.3, 'stroke-dasharray': '5 4' }));
      g.appendChild(el('text', { x: n.x + 15, y: n.y + 20, class: 'n-l' }, n.label));
      g.appendChild(el('text', { x: n.x + 15, y: n.y + 35, class: 'n-s' }, n.sub));
      svg.appendChild(g);
      return;
    }
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
    g.appendChild(el('circle', { id: 'adot-' + id, class: 'hdot', cx: dx, cy: dy, r: dr, fill: STATUS.unknown.fill,
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
        .arch-svg{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#ffffff;border-radius:12px}
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
        .arch-svg.stale .hdot{opacity:.28}
      </style>`;

    PANELS.forEach(p => {
      svg.appendChild(el('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 12,
        fill: '#faf8ff', stroke: '#ece7f8', 'stroke-width': 1, 'stroke-dasharray': '5 4' }));
      if (p.t) svg.appendChild(el('text', { x: p.x + 14, y: p.y + 16, class: 'pan-l' }, p.t.toUpperCase()));
    });

    // legends — both vertical at top-right, label to the right of each marker.
    const LMARK = 840, LLABEL = 858;
    ['ok', 'degraded', 'down', 'unknown'].forEach((k, i) => {   // status: dots
      const y = 30 + i * 22;
      svg.appendChild(el('circle', { cx: LMARK, cy: y, r: 6, fill: STATUS[k].fill }));
      svg.appendChild(el('text', { x: LLABEL, y: y + 4, class: 'leg' }, STATUS[k].label));
    });
    [['app', 'this app'], ['noted', 'noted-network'], ['logus2k', 'logus2k-net'], ['mcp', 'mcp_internal'], ['edge', 'edge/identity']]
      .forEach((nv, i) => {                                     // networks: swatches
        const y = 132 + i * 22;
        svg.appendChild(el('rect', { x: LMARK - 6, y: y - 6, width: 12, height: 12, rx: 3, fill: NET[nv[0]] }));
        svg.appendChild(el('text', { x: LLABEL, y: y + 4, class: 'leg' }, nv[1]));
      });

    // edges (under nodes)
    EDGES.forEach(e => svg.appendChild(el('path', {
      d: edgePath(e), fill: 'none', stroke: '#c3ccd9', 'stroke-width': 1.6,
      'stroke-dasharray': e.dashed ? '5 4' : null, opacity: 0.85,
    })));

    GROUPS.forEach(gp => svg.appendChild(el('text', { x: gp.x, y: gp.y, class: 'g-l' }, gp.t.toUpperCase())));

    for (const id in NODES) drawNode(svg, id, NODES[id]);

    return svg;
  }

  // --- public API ------------------------------------------------------------
  let _statusEl = null, _freshEl = null;

  function render(root, opts) {
    opts = opts || {};
    root.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'arch-wrap';
    wrap.innerHTML = `
      <style>
        /* fill the Help view; the toolbar stays pinned at top and only the
           graph (.arch-stage) centers vertically in the space below it. */
        .arch-wrap{padding:1rem 1.3rem;display:flex;flex-direction:column;gap:.7rem;flex:1;min-height:0}
        .arch-bar{display:flex;align-items:center;gap:.7rem}
        .arch-bar h3{margin:0;font-size:15px;color:var(--ink,#1f2937)}
        .arch-bar .sp{flex:1}
        .arch-status{font-size:12px;color:var(--muted,#94a3b8)}
        .arch-refresh{border:1px solid var(--line,#e5e9f0);background:#fff;border-radius:8px;padding:.4rem .8rem;font:inherit;font-size:12.5px;cursor:pointer}
        .arch-refresh:hover{border-color:#cfe6f7;background:#f6fbff}
        .arch-stage{flex:1;min-height:0;max-width:1000px;width:100%;margin:0 auto;
          display:flex;flex-direction:column;justify-content:safe center;overflow:auto}
        /* "live feed" watchdog: each push restarts archDecay; if pushes stop,
           the browser's own animation clock carries it green→yellow→orange→red,
           and the animationend EVENT fires goStale(). No JS timer involved. */
        .arch-fresh{display:inline-flex;align-items:center;gap:.4rem;font-size:12px;font-weight:600;
          padding:.28rem .6rem;border:1px solid #e5e9f0;border-radius:999px;color:#94a3b8;background:#fff}
        .arch-fresh i{width:8px;height:8px;border-radius:50%;background:currentColor;
          box-shadow:0 0 0 3px color-mix(in srgb, currentColor 22%, transparent)}
        .arch-fresh.live{animation:archDecay var(--arch-stale,40s) linear forwards}
        .arch-fresh.stale{color:#dc2626 !important;animation:none !important;border-color:#f3c9c9;background:#fff6f6}
        @keyframes archDecay{
          0%{color:#16a34a} 30%{color:#16a34a} 46%{color:#eab308}
          70%{color:#f97316} 100%{color:#dc2626}
        }
      </style>
      <div class="arch-bar">
        <h3>Infrastructure Live Monitoring</h3>
        <span class="sp"></span>
        <span class="arch-fresh" id="arch-fresh"><i></i><b>connecting…</b></span>
        <span class="arch-status" id="arch-status"></span>
        <button class="arch-refresh" id="arch-refresh">↻ Refresh</button>
      </div>
      <div class="arch-stage" id="arch-stage"></div>`;
    root.appendChild(wrap);
    wrap.querySelector('#arch-stage').appendChild(buildSVG());
    _statusEl = wrap.querySelector('#arch-status');
    _freshEl = wrap.querySelector('#arch-fresh');
    // animationend only fires if NO push restarted the animation in time.
    _freshEl.addEventListener('animationend', goStale);
    const btn = wrap.querySelector('#arch-refresh');
    if (opts.onRefresh) btn.onclick = () => opts.onRefresh();
    else btn.style.display = 'none';
  }

  function _label(s) { const b = _freshEl && _freshEl.querySelector('b'); if (b) b.textContent = s; }
  function goStale() {
    if (_freshEl) _freshEl.classList.add('stale');
    _label('no signal');
    const svg = document.querySelector('.arch-svg'); if (svg) svg.classList.add('stale');
  }
  // Call on every push: pets the watchdog by restarting the decay animation.
  function markLive() {
    if (!_freshEl) return;
    _freshEl.classList.remove('stale');
    const svg = document.querySelector('.arch-svg'); if (svg) svg.classList.remove('stale');
    _label('live feed');
    _freshEl.classList.remove('live');
    void _freshEl.offsetWidth;        // reflow so re-adding restarts the animation
    _freshEl.classList.add('live');
  }
  // Call on an explicit socket drop: jump straight to the stale/red end-state.
  function markDisconnected() { _freshEl && _freshEl.classList.remove('live'); goStale(); }

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

  window.JOB2COOL_ARCHITECTURE = { render, setHealth, setStatusText, markLive, markDisconnected, NODES, STATUS };
})();
