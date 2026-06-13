/* Knowledge Base view — consolidated Domain Manager + Monitor (job2cool native).
 * Full parity with noted's Domain Manager: create/delete domains, document CRUD
 * (upload/rename/set-folder/delete), rebuild graph, run diagnostics, plus the
 * Monitor's rich live progress. Calls noted's backend through job2cool's /api/*
 * reverse proxy. Lists the jobs_* domains. */
(function () {
  const api = p => new URL('api/' + p, document.baseURI).href;   // -> proxied to noted:8123
  const enc = encodeURIComponent;
  const esc = s => (s || '').toString().replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const JOBS = 'jobs_';

  let DOMAINS = [];          // jobs_* domain records
  let sel = null;            // selected domain_id
  let tab = 'knowledge';     // documents | knowledge | settings
  let pollTimer = null;
  const STATUS = {};         // domain_id -> /status payload
  const FMT = {};            // domain_id -> format_breakdown
  let DOCS = [];             // current domain's documents
  let docFilter = '';
  const docSel = new Set();  // selected document paths (bulk)
  let profilesCache = null;

  async function jget(p) { const r = await fetch(api(p), { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return r.json(); }
  async function jmethod(p, m) { return fetch(api(p), { method: m }); }

  function toast(m) { window.toast ? window.toast(m) : void 0; }
  function phaseChip(ph) {
    ph = ph || 'idle';
    const cls = ph === 'done' ? 'ok' : (ph === 'error' || ph === 'failed') ? 'err'
      : ph === 'suspended' ? 'warn' : ph === 'idle' ? 'idle' : 'gen';
    return `<span class="kb-phase ${cls}">${esc(ph)}</span>`;
  }
  function fmtBuild(lb) {
    if (!lb) return '—';
    if (typeof lb === 'object') { const d = lb.duration_seconds; return '✓' + (d ? ` (${d < 60 ? d.toFixed(1) + 's' : (d / 60).toFixed(1) + 'm'})` : ''); }
    return esc(lb);
  }
  function fmtDate(s) { return s ? (s + '').replace('T', ' ').slice(0, 16) : '—'; }

  // ---------- small inline dialog ----------
  function dialog(title, fields, submitLabel) {
    return new Promise(resolve => {
      const bg = document.createElement('div'); bg.className = 'kbdlg-bg';
      const body = fields.map(f => {
        if (f.type === 'select') return `<label>${esc(f.label)}</label><select data-k="${f.key}">${(f.options || []).map(o => `<option value="${esc(o.value)}"${o.value === f.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
        if (f.type === 'textarea') return `<label>${esc(f.label)}</label><textarea data-k="${f.key}">${esc(f.value || '')}</textarea>`;
        if (f.type === 'file') return `<label>${esc(f.label)}</label><input type="file" data-k="${f.key}"${f.multiple ? ' multiple' : ''}>`;
        return `<label>${esc(f.label)}</label><input type="text" data-k="${f.key}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}">`;
      }).join('');
      bg.innerHTML = `<div class="kbdlg"><h3>${esc(title)}</h3>${body}<div class="foot"><button class="hbtn" data-x>Cancel</button><button class="hbtn primary" data-ok>${esc(submitLabel || 'Save')}</button></div></div>`;
      document.body.appendChild(bg);
      const close = v => { bg.remove(); resolve(v); };
      bg.querySelector('[data-x]').onclick = () => close(null);
      bg.onclick = e => { if (e.target === bg) close(null); };
      bg.querySelector('[data-ok]').onclick = () => {
        const out = {};
        bg.querySelectorAll('[data-k]').forEach(el => { out[el.dataset.k] = el.type === 'file' ? el.files : el.value; });
        close(out);
      };
      const first = bg.querySelector('input,textarea,select'); if (first) first.focus();
    });
  }

  // ---------- data ----------
  async function loadDomains() {
    const d = await jget('domains');
    DOMAINS = (d.domains || []).filter(x => (x.domain_id || '').startsWith(JOBS))
      .sort((a, b) => a.domain_id.localeCompare(b.domain_id));
  }
  async function loadStatus(id) { try { STATUS[id] = await jget('domains/' + enc(id) + '/status'); } catch (e) { } }
  async function loadFmt(id) { try { FMT[id] = await jget('rag/index/format_breakdown?collection=' + enc(id) + '__corpus'); } catch (e) { } }
  async function loadDocs() { try { const d = await jget('graph/research/' + enc(sel) + '/corpus'); DOCS = d.documents || []; } catch (e) { DOCS = []; } }
  async function loadProfiles() {
    if (profilesCache) return profilesCache;
    try { profilesCache = await jget('rag/chunking-profiles'); } catch (e) { profilesCache = { default_profile: '', profiles: [] }; }
    return profilesCache;
  }

  // ---------- render shell ----------
  function render() {
    const root = document.getElementById('view-kb'); if (!root) return;
    root.innerHTML = `
      <div class="kb-head"><b>Knowledge Base</b>
        <span class="kb-sub">Company hiring knowledge · ${DOMAINS.length} domains</span>
      </div>
      <div class="kb-body">
        <div class="kb-list" id="kb-list"></div>
        <div class="kb-detail" id="kb-detail"></div>
      </div>`;
    renderList(); renderDetail();
  }

  function listChip(id) {
    const s = STATUS[id]; if (!s) return '<span class="kb-mini">—</span>';
    const g = s.graph || {}, pr = g.progress || {};
    if (g.rebuild_in_progress) return phaseChip(pr.phase || 'building');
    const ent = (g.global_counts || {}).entities;
    return `<span class="kb-mini">${ent != null ? ent + ' ent' : '—'}</span>`;
  }
  function renderList() {
    const el = document.getElementById('kb-list'); if (!el) return;
    el.innerHTML = `<button class="kb-newdom" id="kb-new">＋ New Domain</button>` + DOMAINS.map(d => `
      <div class="kb-dom${d.domain_id === sel ? ' on' : ''}" data-id="${esc(d.domain_id)}">
        <div class="kb-dom-main"><b>${esc(d.name || d.domain_id)}</b><span class="kb-dom-id">${esc(d.domain_id)}</span></div>
        ${listChip(d.domain_id)}</div>`).join('');
    document.getElementById('kb-new').onclick = () => newDomain();
    el.querySelectorAll('.kb-dom').forEach(n => n.onclick = () => selectDomain(n.dataset.id));
  }
  function selectDomain(id) {
    sel = id; docSel.clear();
    render();
    if (!FMT[sel]) loadFmt(sel).then(() => { if (tab === 'knowledge') renderKnowledge(); });
    loadStatus(sel).then(() => { renderList(); if (tab === 'knowledge') renderKnowledge(); });
    if (tab === 'documents') loadDocs().then(renderDocuments);
  }

  function renderDetail() {
    const el = document.getElementById('kb-detail'); if (!el) return;
    if (!sel) { el.innerHTML = '<div class="kb-empty">Select a domain, or create a new one.</div>'; return; }
    const d = DOMAINS.find(x => x.domain_id === sel) || {};
    el.innerHTML = `
      <div class="kb-dhead"><b>${esc(d.name || sel)}</b><span class="kb-dom-id">${esc(sel)}</span></div>
      <div class="kb-tabs">
        <button data-t="documents" class="${tab === 'documents' ? 'on' : ''}">Documents</button>
        <button data-t="knowledge" class="${tab === 'knowledge' ? 'on' : ''}">Knowledge</button>
        <button data-t="settings" class="${tab === 'settings' ? 'on' : ''}">Settings</button>
      </div>
      <div class="kb-tabbody" id="kb-tabbody"></div>`;
    el.querySelectorAll('.kb-tabs button').forEach(b => b.onclick = () => { tab = b.dataset.t; renderDetail(); });
    if (tab === 'knowledge') renderKnowledge();
    else if (tab === 'documents') { loadDocs().then(renderDocuments); }
    else renderSettings();
  }

  // ---------- Knowledge tab = Monitor ----------
  function renderKnowledge() {
    const body = document.getElementById('kb-tabbody'); if (!body) return;
    const s = STATUS[sel];
    if (!s) { body.innerHTML = '<div class="kb-empty">Loading status…</div>'; return; }
    const g = s.graph || {}, v = s.vector || {}, pr = g.progress || {}, gc = g.global_counts || {};
    const inProg = !!g.rebuild_in_progress;
    const fb = (FMT[sel] || {}).by_format || {};
    const fmtChips = Object.keys(fb).length ? Object.entries(fb).map(([k, n]) => `<span class="kb-chip">${esc(k)} ${n}</span>`).join('') : '—';
    const sources = (v.sources || []).length;
    const recl = s.pending_recluster || g.pending_recluster;

    let banner = '';
    if (pr.phase === 'suspended') banner = `<div class="kb-banner warn">⏸ Build suspended — operator action required.<span class="kb-spacer"></span><button class="hbtn" id="kb-resume">Resume</button><button class="hbtn danger" id="kb-abort">Abort</button></div>`;
    else if (pr.phase === 'failed' || pr.phase === 'error') banner = `<div class="kb-banner err">⚠ Last build ended in ${esc(pr.phase)}.<span class="kb-spacer"></span><button class="hbtn" id="kb-rebuild2">Retry</button></div>`;
    else if (recl && Object.keys(recl).length && !inProg) banner = `<div class="kb-banner">↻ Knowledge graph is behind the corpus.<span class="kb-spacer"></span><button class="hbtn" id="kb-recluster">Recluster</button></div>`;

    let prog = '';
    if (inProg) {
      const done = pr.extraction_chunks_done || 0, tot = pr.extraction_chunks_total || 0;
      const pct = tot ? Math.round(done / tot * 100) : 0;
      prog = `<div class="kb-prog">
        <div class="kb-prog-top"><span>${esc(pr.phase || '')}${pr.operation ? ' · ' + esc(pr.operation) : ''}</span><span>${done}/${tot}${tot ? ` · ${pct}%` : ''}</span></div>
        <div class="kb-bar"><div class="kb-bar-in" style="width:${pct}%"></div></div>
        ${pr.current_doc ? `<div class="kb-cur" title="${esc(pr.current_doc)}">▸ ${esc(pr.current_doc)}${pr.current_chunk_in_doc ? ' · chunk ' + pr.current_chunk_in_doc : ''}</div>` : ''}
        <div class="kb-prow"><span>Entities accepted</span><b>${pr.entities_accepted || 0}</b></div>
        <div class="kb-prow"><span>Docs scanned</span><b>${pr.md_docs || 0}</b></div>
        <div class="kb-prow"><span>Communities</span><b>${pr.communities_summarized || 0} / ${pr.communities_total || 0}</b></div>
        ${pr.pictures_total ? `<div class="kb-prow"><span>Pictures captioned</span><b>${pr.pictures_captioned || 0} / ${pr.pictures_total}${pr.pictures_failed ? ' · ' + pr.pictures_failed + ' failed' : ''}</b></div>` : ''}
        ${pr.tables_total ? `<div class="kb-prow"><span>Tables captioned</span><b>${pr.tables_captioned || 0} / ${pr.tables_total}${pr.tables_failed ? ' · ' + pr.tables_failed + ' failed' : ''}</b></div>` : ''}
        ${pr.started_at ? `<div class="kb-prow"><span>Started</span><b>${fmtDate(pr.started_at).slice(0, 19)}</b></div>` : ''}
      </div>`;
    }

    body.innerHTML = `${banner}
      <div class="kb-card">
        <div class="kb-card-h">Vector RAG <span class="kb-card-sub">ChromaDB</span></div>
        <div class="kb-prow"><span>Total chunks</span><b>${v.total_chunks != null ? v.total_chunks : '—'}</b></div>
        <div class="kb-prow"><span>Sources indexed</span><b>${sources || '—'}</b></div>
        <div class="kb-prow"><span>Format</span><span class="kb-chips">${fmtChips}</span></div>
      </div>
      <div class="kb-card">
        <div class="kb-card-h">Knowledge Graph <span class="kb-card-sub">ArcadeDB</span><span class="kb-spacer"></span>${phaseChip(pr.phase)}</div>
        <div class="kb-prow"><span>Entities</span><b>${gc.entities != null ? gc.entities : '—'}</b></div>
        <div class="kb-prow"><span>Relationships</span><b>${gc.relationships != null ? gc.relationships : '—'}</b></div>
        <div class="kb-prow"><span>Communities</span><b>${gc.communities != null ? gc.communities : (pr.communities_total || 0)}</b></div>
        <div class="kb-prow"><span>Last build</span><b>${fmtBuild(g.last_build)}</b></div>
        ${prog}
        <div class="kb-actions">
          <button class="hbtn primary" id="kb-rebuild" ${inProg ? 'disabled' : ''}>↻ Rebuild Graph</button>
          <button class="hbtn" id="kb-diag">🩺 Run Diagnostics</button>
          <span class="kb-note">Full re-extraction.</span>
        </div>
      </div>`;
    const on = (id, fn) => { const e = document.getElementById(id); if (e) e.onclick = fn; };
    on('kb-rebuild', doRebuild); on('kb-rebuild2', doRebuild); on('kb-diag', doDiagnostics);
    on('kb-resume', () => act('resume')); on('kb-abort', () => act('abort')); on('kb-recluster', () => act('recluster'));
  }
  async function act(op) {
    const r = await jmethod('domains/' + enc(sel) + '/' + op, 'POST');
    toast(r.ok ? (op + ' started') : (op + ' failed (' + r.status + ')'));
    await loadStatus(sel); renderList(); if (tab === 'knowledge') renderKnowledge();
  }
  async function doRebuild() {
    if (!confirm('Rebuild the knowledge graph for ' + sel + '?\nThis re-extracts all entities and replaces the current graph.')) return;
    await act('rebuild');
  }
  async function doDiagnostics() {
    // Render in an OVERLAY, not inline: the 5s status poll rebuilds the Knowledge
    // tab and would wipe an inline result while preflight (~5s) is still running.
    const domain = sel;
    const bg = document.createElement('div'); bg.className = 'kbdlg-bg';
    bg.innerHTML = `<div class="kbdlg" style="width:660px;max-width:94vw">
      <h3>Diagnostics — ${esc(domain)}</h3>
      <div id="kb-diag-body"><div class="kb-empty">Running diagnostics…</div></div>
      <div class="foot"><button class="hbtn" data-x>Close</button></div></div>`;
    document.body.appendChild(bg);
    const close = () => bg.remove();
    bg.querySelector('[data-x]').onclick = close;
    bg.onclick = e => { if (e.target === bg) close(); };
    const out = bg.querySelector('#kb-diag-body');
    try {
      const j = await (await fetch(api('domains/' + enc(domain) + '/preflight'), { method: 'POST' })).json();
      const rows = (j.checks || []).map(c => {
        const ic = c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✕';
        return `<div class="kb-chk ${esc(c.status)}"><span class="kb-chk-ic">${ic}</span><span class="kb-chk-n">${esc(c.name)}</span><span class="kb-chk-ms">${c.elapsed_ms != null ? c.elapsed_ms + 'ms' : ''}</span><span class="kb-chk-d">${esc(c.detail || '')}</span></div>`;
      }).join('');
      const cnt = st => (j.checks || []).filter(c => c.status === st).length;
      out.innerHTML = `<div class="kb-card-h" style="margin:.2rem 0 .7rem">${j.ok ? '<span class="kb-phase ok">pass</span>' : '<span class="kb-phase err">blocking error</span>'}<span class="kb-spacer"></span><span class="kb-mini">${cnt('ok')} ok · ${cnt('warn')} warn · ${cnt('error')} error</span></div>${rows}`;
    } catch (e) { out.innerHTML = '<div class="kb-empty">Diagnostics failed to run.</div>'; }
  }

  // ---------- Documents tab (full CRUD) ----------
  function renderDocuments() {
    const body = document.getElementById('kb-tabbody'); if (!body || tab !== 'documents') return;
    const q = docFilter.toLowerCase();
    const shown = DOCS.filter(d => !q || ((d.display_name || d.basename || d.path || '') + ' ' + (d.category || '')).toLowerCase().includes(q));
    const bulk = docSel.size ? `<div class="kb-bulk"><b>${docSel.size} selected</b><button class="hbtn danger" id="kb-bulkdel">Delete selected</button></div>` : '';
    const rows = shown.map(d => `
      <tr>
        <td><input type="checkbox" data-p="${esc(d.path)}" ${docSel.has(d.path) ? 'checked' : ''}></td>
        <td class="nm"><b>${esc(d.display_name || d.basename || (d.path || '').split('/').pop())}</b><span>${esc(d.path)}</span></td>
        <td>${esc(d.category || '')}</td>
        <td><span class="kb-chip">${esc((d.mode || '').replace('_', ' & '))}</span></td>
        <td>${fmtDate(d.added_at)}${d.exists === false ? ' <span class="kb-phase err">missing</span>' : ''}</td>
        <td class="act">
          <button class="kb-iconbtn" data-act="rename" data-p="${esc(d.path)}" title="Rename">✎</button>
          <button class="kb-iconbtn" data-act="folder" data-p="${esc(d.path)}" title="Set folder">🏷</button>
          <button class="kb-iconbtn" data-act="del" data-p="${esc(d.path)}" title="Delete">🗑</button>
        </td>
      </tr>`).join('');
    body.innerHTML = `
      <div class="kb-toolbar">
        <button class="hbtn primary" id="kb-upload">⬆ Upload Document</button>
        <input class="filter" id="kb-docfilter" placeholder="Filter by name or folder…" value="${esc(docFilter)}">
        <button class="hbtn" id="kb-docrefresh" title="Refresh">↻</button>
      </div>
      ${bulk}
      ${shown.length ? `<table class="kb-doctable"><thead><tr><th></th><th>Name</th><th>Folder</th><th>Mode</th><th>Added</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`
        : `<div class="kb-empty">${DOCS.length ? 'No documents match the filter.' : 'No documents in this domain. Click Upload to add the first one.'}</div>`}`;
    document.getElementById('kb-upload').onclick = () => uploadDocs();
    document.getElementById('kb-docrefresh').onclick = () => loadDocs().then(renderDocuments);
    const fl = document.getElementById('kb-docfilter');
    fl.oninput = () => { docFilter = fl.value; renderDocuments(); fl.focus(); fl.setSelectionRange(fl.value.length, fl.value.length); };
    body.querySelectorAll('input[type=checkbox][data-p]').forEach(c => c.onchange = () => { c.checked ? docSel.add(c.dataset.p) : docSel.delete(c.dataset.p); renderDocuments(); });
    body.querySelectorAll('[data-act]').forEach(b => b.onclick = () => docAction(b.dataset.act, b.dataset.p));
    const bd = document.getElementById('kb-bulkdel'); if (bd) bd.onclick = () => bulkDelete();
  }
  async function uploadDocs() {
    const prof = await loadProfiles();
    const r = await dialog('Upload document', [
      { key: 'file', label: 'File(s)', type: 'file', multiple: true },
      { key: 'mode', label: 'Mode', type: 'select', value: 'read_store', options: [{ value: 'read_store', label: 'read & store' }, { value: 'read_only', label: 'read only' }] },
      { key: 'category', label: 'Folder (optional)', placeholder: 'e.g. Job Market' },
      { key: 'chunking_profile', label: 'Chunking profile', type: 'select', value: prof.default_profile, options: (prof.profiles || []).map(p => ({ value: p.id, label: p.name || p.id })) },
    ], 'Upload');
    if (!r || !r.file || !r.file.length) return;
    toast('Uploading ' + r.file.length + ' file(s)…');
    for (const f of r.file) {
      const fd = new FormData(); fd.append('file', f);
      let url = 'domains/' + enc(sel) + '/documents?mode=' + enc(r.mode || 'read_store');
      if (r.category) url += '&category=' + enc(r.category);
      if (r.chunking_profile) url += '&chunking_profile=' + enc(r.chunking_profile);
      try { const rr = await fetch(api(url), { method: 'POST', body: fd }); if (!rr.ok) toast('Upload failed: ' + f.name); } catch (e) { toast('Upload error: ' + f.name); }
    }
    await loadDocs(); renderDocuments(); toast('Upload complete');
  }
  async function docAction(action, path) {
    const doc = DOCS.find(d => d.path === path) || { path };
    if (action === 'rename') {
      const r = await dialog('Rename document', [{ key: 'display_name', label: 'Display name (empty = use filename)', value: doc.display_name || '' }], 'Save');
      if (!r) return;
      await fetch(api('domains/' + enc(sel) + '/documents/display_name?' + new URLSearchParams({ path, display_name: r.display_name || '' })), { method: 'PATCH' });
    } else if (action === 'folder') {
      const r = await dialog('Set folder', [{ key: 'category', label: 'Folder', value: doc.category || '' }], 'Save');
      if (!r) return;
      await fetch(api('domains/' + enc(sel) + '/documents/category?' + new URLSearchParams({ path, category: r.category || '' })), { method: 'PATCH' });
    } else if (action === 'del') {
      if (!confirm('Delete document?\n' + path)) return;
      await fetch(api('domains/' + enc(sel) + '/documents?path=' + enc(path)), { method: 'DELETE' });
    }
    await loadDocs(); renderDocuments();
  }
  async function bulkDelete() {
    if (!confirm('Delete ' + docSel.size + ' selected document(s)?')) return;
    for (const p of Array.from(docSel)) { try { await fetch(api('domains/' + enc(sel) + '/documents?path=' + enc(p)), { method: 'DELETE' }); } catch (e) { } }
    docSel.clear(); await loadDocs(); renderDocuments();
  }

  // ---------- Settings tab (general + resources + danger zone) ----------
  function renderSettings() {
    const d = DOMAINS.find(x => x.domain_id === sel) || {};
    const body = document.getElementById('kb-tabbody'); if (!body) return;
    body.innerHTML = `
      <div class="kb-card"><div class="kb-card-h">General</div>
        <label class="kb-flabel">Display name</label>
        <input class="kb-finput" id="kb-set-name" value="${esc(d.name || '')}">
        <label class="kb-flabel">Description</label>
        <textarea class="kb-finput" id="kb-set-desc">${esc(d.description || '')}</textarea>
        <div class="kb-actions"><button class="hbtn primary" id="kb-set-save">Save changes</button></div>
      </div>
      <div class="kb-card"><div class="kb-card-h">Resources</div>
        <div class="kb-prow"><span>Domain ID</span><b>${esc(d.domain_id)}</b></div>
        <div class="kb-prow"><span>Pinned</span><b>${d.pinned ? 'Yes' : 'No'}</b></div>
        <div class="kb-prow"><span>Has knowledge</span><b>${d.has_knowledge ? 'Yes (vector + graph)' : 'No'}</b></div>
        <div class="kb-prow"><span>Corpus collection</span><b>${esc(d.corpus_collection || '—')}</b></div>
        <div class="kb-prow"><span>ArcadeDB project</span><b>${esc(d.arcadedb_project_id || '—')}</b></div>
        <div class="kb-prow"><span>Embeddings</span><b>${esc(d.embeddings_model || '—')}</b></div>
      </div>
      ${d.deletable === false ? '' : `<div class="kb-card danger"><div class="kb-card-h" style="color:#b42318">Danger zone</div>
        <div class="kb-note" style="margin-bottom:.6rem">Permanently remove this domain, its ChromaDB collections and its ArcadeDB project. Source files remain on disk.</div>
        <button class="hbtn danger" id="kb-deldom">🗑 Delete Domain</button></div>`}`;
    document.getElementById('kb-set-save').onclick = async () => {
      const name = document.getElementById('kb-set-name').value.trim();
      const desc = document.getElementById('kb-set-desc').value.trim();
      const r = await fetch(api('domains/' + enc(sel) + '?' + new URLSearchParams({ name, description: desc })), { method: 'PATCH' });
      toast(r.ok ? 'Saved' : 'Save failed'); await refreshAll();
    };
    const del = document.getElementById('kb-deldom');
    if (del) del.onclick = async () => {
      if (!confirm('Delete domain "' + (d.name || sel) + '" (' + sel + ')?\nThis removes its vector collections and graph. Source files stay on disk.')) return;
      const r = await jmethod('domains/' + enc(sel) + '', 'DELETE');
      toast(r.ok ? 'Domain deleted' : 'Delete failed (' + r.status + ')');
      sel = null; await refreshAll();
    };
  }

  // ---------- New Domain ----------
  async function newDomain() {
    const r = await dialog('New domain', [
      { key: 'domain_id', label: 'Domain ID (slug)', placeholder: 'jobs_onboard_xyz' },
      { key: 'name', label: 'Display name', placeholder: 'Job Offers Onboard …' },
      { key: 'description', label: 'Description', type: 'textarea' },
    ], 'Create');
    if (!r) return;
    const id = (r.domain_id || '').trim();
    if (!id) { toast('Domain ID required'); return; }
    const params = new URLSearchParams({ domain_id: id });
    if (r.name) params.set('name', r.name.trim());
    if (r.description) params.set('description', r.description.trim());
    const resp = await fetch(api('domains?' + params.toString()), { method: 'POST' });
    if (!resp.ok) { toast('Create failed (' + resp.status + ')'); return; }
    toast('Domain created'); await refreshAll();
    if (DOMAINS.find(x => x.domain_id === id)) selectDomain(id);
  }

  // ---------- polling ----------
  async function refreshAll() {
    await loadDomains();
    await Promise.all(DOMAINS.map(d => loadStatus(d.domain_id)));
    if (sel && !DOMAINS.find(x => x.domain_id === sel)) sel = null;
    if (sel && !FMT[sel]) await loadFmt(sel);
    render();
  }
  function startPoll() {
    stopPoll();
    pollTimer = setInterval(async () => {
      await Promise.all(DOMAINS.map(d => loadStatus(d.domain_id)));
      renderList(); if (tab === 'knowledge') renderKnowledge();
    }, 5000);
  }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  // ---------- public hooks ----------
  window.JOB2COOL_KB_OPEN = async function () {
    const root = document.getElementById('view-kb'); if (!root) return;
    if (!DOMAINS.length) root.innerHTML = '<div class="kb-empty" style="margin:3rem auto">Loading knowledge base…</div>';
    await refreshAll();
    if (!sel && DOMAINS.length) sel = DOMAINS[0].domain_id;
    if (sel && !FMT[sel]) await loadFmt(sel);
    render();
    startPoll();
  };
  window.JOB2COOL_KB_CLOSE = function () { stopPoll(); };
})();
