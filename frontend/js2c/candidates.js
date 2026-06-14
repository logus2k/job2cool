/* Candidates — browse the ingested candidate-CV corpus (jobs_candidates__corpus)
 * and inspect one CV in a right-docked detail panel. Read-only. Backed by
 * job2cool-backend /api/job2cool/candidates (browse + semantic search) and
 * /api/job2cool/candidates/{id} (full detail), which compose noted-rag
 * /list_records + /search. Same list+side-panel shell as the Agents view. */
(function () {
  const api = p => new URL('api/job2cool/candidates' + (p || ''), document.baseURI).href;
  const esc = s => (s == null ? '' : s.toString()).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const toast = m => (window.toast ? window.toast(m) : void 0);
  const PAGE = 30;
  // ID-card + the shared blue star badge (matches the other empty states).
  const EMPTY_ART = '<svg viewBox="0 0 210 150" fill="none"><rect x="40" y="42" width="118" height="72" rx="12" fill="#f1f7fc" stroke="#a6d0ec" stroke-width="3.4"/><circle cx="70" cy="74" r="12" fill="#fff" stroke="#a6d0ec" stroke-width="3.4"/><path d="M52 100c2-8 9-12 18-12s16 4 18 12" fill="#fff" stroke="#a6d0ec" stroke-width="3.4"/><path d="M104 66h36M104 80h36M104 94h22" stroke="#a6d0ec" stroke-width="3.4" stroke-linecap="round"/><circle cx="150" cy="40" r="20" fill="#2f9be6"/><path d="M150 29l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="#fff"/></svg>';

  const state = { mode: 'browse', q: '', offset: 0, total: 0, selected: null };
  let styled = false;

  function injectStyle() {
    if (styled) return; styled = true;
    const s = document.createElement('style');
    s.textContent = `
      .cand-q{flex:1;max-width:440px;border:1px solid var(--line);border-radius:9px;padding:.5rem .7rem;font:inherit;font-size:13px;background:#fff}
      .cand-list{display:flex;flex-direction:column;gap:.5rem}
      .cand-row{border:1px solid #e8eaf0;border-radius:11px;padding:.7rem .85rem;cursor:pointer;background:#fff;transition:border-color .12s,box-shadow .12s}
      .cand-row:hover{border-color:#cfe6f7;box-shadow:0 2px 10px rgba(15,23,42,.06)}
      .cand-row.sel{border-color:#2f9be6;background:#f6fbff}
      .cand-row .r1{display:flex;align-items:flex-start;gap:.6rem}
      .cand-row .pos{font-weight:600;color:var(--ink);font-size:13.5px;flex:1;min-width:0;line-height:1.35}
      .cand-row .snip{color:var(--muted);font-size:12px;margin-top:.35rem;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .cand-chip{display:inline-flex;align-items:center;font-size:11px;font-weight:600;padding:.12rem .5rem;border-radius:999px;white-space:nowrap}
      .cand-chip.kw{background:#eaf4fd;color:#1c6fb0}
      .cand-chip.en{background:#eef7ee;color:#3a7a3a}
      .cand-chip.xp{background:#fff3e0;color:#b9710f}
      .cand-chip.sc{background:#f0eaff;color:#6b3fb0}
      .cand-meta{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.45rem}
      .cand-detail h2{font-size:15px;margin:.1rem 0 .3rem;color:var(--ink)}
      .cand-detail .dmeta{display:flex;gap:.4rem;flex-wrap:wrap;margin:.4rem 0 .8rem}
      .cand-detail .dlabel{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:.9rem 0 .3rem}
      .cand-detail .cvbox{white-space:pre-wrap;font-size:12.5px;line-height:1.6;color:#2b2f36;background:#fbfbf7;border:1px solid #ececec;border-radius:9px;padding:.8rem .9rem}
      .cand-detail .cid{font-size:11px;color:var(--muted);font-family:ui-monospace,monospace;word-break:break-all}`;
    document.head.appendChild(s);
  }

  function fmtExp(n) {
    if (n == null || n === '') return null;
    const v = Number(n);
    return isNaN(v) ? null : (v === 1 ? '1 yr' : v + ' yrs');
  }
  // Djinni English levels are abbreviated/lowercase (upper, pre, …). Expand to
  // readable labels so a chip is self-explanatory without an "EN:" prefix.
  const EN_LABEL = { no_english: 'No English', basic: 'Basic', pre: 'Pre-Intermediate', intermediate: 'Intermediate', upper: 'Upper-Intermediate', fluent: 'Fluent' };
  function fmtEnglish(v) {
    if (!v) return null;
    const k = v.toString().trim().toLowerCase().replace(/[\s-]+/g, '_');
    return EN_LABEL[k] || (v.charAt(0).toUpperCase() + v.slice(1));
  }

  function openSide(title) {
    const side = document.getElementById('cand-side'); if (!side) return null;
    if (window.JOB2COOL_CHAT_CLOSE) try { window.JOB2COOL_CHAT_CLOSE(); } catch (e) {}
    if (window.JOB2COOL_CLOSE_SIDE_PANELS) window.JOB2COOL_CLOSE_SIDE_PANELS('cand-side');
    document.getElementById('cand-side-title').textContent = title;
    side.hidden = false;
    if (window.JOB2COOL_RESIZER) window.JOB2COOL_RESIZER(side);
    return document.getElementById('cand-side-body');
  }

  function rowHTML(c) {
    const exp = fmtExp(c.experience_years);
    const chips = [];
    if (c.primary_keyword) chips.push(`<span class="cand-chip kw">${esc(c.primary_keyword)}</span>`);
    if (c.english_level) chips.push(`<span class="cand-chip en" title="English level">${esc(fmtEnglish(c.english_level))}</span>`);
    if (exp) chips.push(`<span class="cand-chip xp">${esc(exp)}</span>`);
    if (c.score != null) chips.push(`<span class="cand-chip sc">match ${(c.score * 100).toFixed(0)}%</span>`);
    return `<div class="cand-row${state.selected === c.id ? ' sel' : ''}" data-id="${esc(c.id)}">
      <div class="r1"><div class="pos">${esc(c.position || '(no title)')}</div></div>
      <div class="cand-meta">${chips.join('')}</div>
      ${c.snippet ? `<div class="snip">${esc(c.snippet)}</div>` : ''}
    </div>`;
  }

  async function loadPage() {
    const main = document.getElementById('cand-main'); if (!main) return;
    const countEl = document.getElementById('cand-count');
    main.innerHTML = `<div class="kb-empty">Loading candidates…</div>`;
    const params = new URLSearchParams({ offset: state.offset, limit: PAGE });
    if (state.q) params.set('q', state.q);
    let data;
    try { data = await (await fetch(api('?' + params.toString()), { cache: 'no-store' })).json(); }
    catch (e) { main.innerHTML = `<div class="kb-empty">Failed to load: ${esc(e.message)}</div>`; return; }
    state.mode = data.mode || 'browse';
    state.total = data.total || 0;
    const items = data.items || [];
    if (!items.length) {
      main.innerHTML = `<div class="kb-empty full"><div class="empty-art">${EMPTY_ART}</div>
        <h3>${state.q ? 'No matching candidates' : 'No candidates yet'}</h3>
        <p>${state.q ? 'Try a different skill, role, or stack.' : 'The candidate corpus is still importing — check back shortly.'}</p></div>`;
    } else {
      main.innerHTML = `<div class="cand-list">${items.map(rowHTML).join('')}</div>`;
      main.querySelectorAll('.cand-row').forEach(r => r.onclick = () => openDetail(r.dataset.id));
    }
    // Header count + pager state.
    if (countEl) {
      if (state.q) countEl.textContent = `${items.length} best match${items.length === 1 ? '' : 'es'} for “${state.q}”`;
      else if (state.total) countEl.textContent = `${state.offset + 1}–${Math.min(state.offset + items.length, state.total)} of ${state.total.toLocaleString()}`;
      else countEl.textContent = '';
    }
    const prev = document.getElementById('cand-prev'), next = document.getElementById('cand-next');
    const paging = !state.q;
    if (prev) { prev.style.display = paging ? '' : 'none'; prev.disabled = state.offset <= 0; }
    if (next) { next.style.display = paging ? '' : 'none'; next.disabled = state.offset + PAGE >= state.total; }
  }

  async function openDetail(id) {
    state.selected = id;
    document.querySelectorAll('.cand-row').forEach(r => r.classList.toggle('sel', r.dataset.id === id));
    const body = openSide('Candidate'); if (!body) return;
    body.innerHTML = `<div class="kb-empty">Loading…</div>`;
    let d;
    try { d = await (await fetch(api('/' + encodeURIComponent(id)), { cache: 'no-store' })).json(); }
    catch (e) { body.innerHTML = `<div class="kb-empty">Failed to load: ${esc(e.message)}</div>`; return; }
    if (d.detail) { body.innerHTML = `<div class="kb-empty">${esc(d.detail)}</div>`; return; }
    document.getElementById('cand-side-title').textContent = d.primary_keyword || 'Candidate';
    const exp = fmtExp(d.experience_years);
    const chips = [];
    if (d.primary_keyword) chips.push(`<span class="cand-chip kw">${esc(d.primary_keyword)}</span>`);
    if (d.english_level) chips.push(`<span class="cand-chip en" title="English level">${esc(fmtEnglish(d.english_level))}</span>`);
    if (exp) chips.push(`<span class="cand-chip xp">${esc(exp)}</span>`);
    body.innerHTML = `<div class="cand-detail">
      <h2>${esc(d.position || '(no title)')}</h2>
      <div class="dmeta">${chips.join('')}</div>
      <div class="dlabel">CV</div>
      <div class="cvbox">${esc(d.cv || '(no CV text)')}</div>
      <div class="dlabel">Candidate ID</div>
      <div class="cid">${esc(d.candidate_id || d.id)}</div>
    </div>`;
  }

  function closeSide() { const s = document.getElementById('cand-side'); if (s) s.hidden = true; state.selected = null; document.querySelectorAll('.cand-row').forEach(r => r.classList.remove('sel')); }

  function render() {
    const root = document.getElementById('view-candidates'); if (!root) return;
    injectStyle();
    root.innerHTML = `
      <div style="display:flex;flex:1;min-height:0">
        <div style="flex:1;min-width:0;display:flex;flex-direction:column">
          <div class="kb-head">
            <input class="cand-q" id="cand-q" placeholder="Search by skill, role, or stack — press Enter">
            <span class="kb-sub" id="cand-count" style="margin-left:.7rem"></span>
            <span style="flex:1"></span>
            <button class="hbtn" id="cand-prev">‹ Prev</button>
            <button class="hbtn" id="cand-next">Next ›</button>
          </div>
          <div id="cand-main" style="flex:1;min-width:0;overflow:auto;padding:1rem 1.3rem"></div>
        </div>
        <div id="cand-side" class="j2c-side" hidden>
          <div class="pdf-head"><span class="src" id="cand-side-title">Candidate</span><button id="cand-side-close" title="Close">✕</button></div>
          <div id="cand-side-body" style="flex:1;min-height:0;overflow:auto;padding:1rem 1.1rem"></div>
        </div>
      </div>`;
    const q = root.querySelector('#cand-q');
    q.value = state.q;
    // Event-driven (no debounce timers): search on Enter; emptying the box
    // returns to the browse list immediately.
    q.onkeydown = e => { if (e.key === 'Enter') { state.q = q.value.trim(); state.offset = 0; loadPage(); } };
    q.oninput = () => { if (!q.value.trim() && state.q) { state.q = ''; state.offset = 0; loadPage(); } };
    root.querySelector('#cand-prev').onclick = () => { if (state.offset <= 0) return; state.offset = Math.max(0, state.offset - PAGE); loadPage(); };
    root.querySelector('#cand-next').onclick = () => { if (state.offset + PAGE >= state.total) return; state.offset += PAGE; loadPage(); };
    root.querySelector('#cand-side-close').onclick = closeSide;
    loadPage();
  }

  window.JOB2COOL_CANDIDATES_OPEN = render;
})();
