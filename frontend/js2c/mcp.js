/* Skills + Tools views — admin UI for the shared MCP tool/skill host
 * (mcp-service), reached via job2cool-backend's /api/mcp/* proxy (which injects
 * the admin token + app scope). Tools are callable; skills are instruction
 * templates served over MCP as prompts. Reuses the kb-* / kbdlg-* CSS. */
(function () {
  const api = p => new URL('api/mcp/' + p, document.baseURI).href;
  const enc = encodeURIComponent;
  const esc = s => (s || '').toString().replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const toast = m => (window.toast ? window.toast(m) : void 0);
  let IMPLS = ['web_search'];
  // Empty-state illustrations (themed line-art + the shared blue star badge).
  const STAR = '<circle cx="150" cy="40" r="20" fill="#2f9be6"/><path d="M150 29l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="#fff"/>';
  const ART_SKILLS = '<svg viewBox="0 0 210 150" fill="none"><rect x="52" y="40" width="106" height="74" rx="18" fill="#f1f7fc"/><path d="M113 50l-24 32h17l-6 22 26-34h-19z" fill="#fff" stroke="#a6d0ec" stroke-width="3.4" stroke-linejoin="round"/>' + STAR + '</svg>';
  const ART_TOOLS = '<svg viewBox="0 0 210 150" fill="none"><rect x="52" y="40" width="106" height="74" rx="18" fill="#f1f7fc"/><path transform="translate(80 47) scale(2.4)" d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8 7.2 20l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.7 2.7-2.3-2.3z" fill="#fff" stroke="#a6d0ec" stroke-width="1.5" stroke-linejoin="round"/>' + STAR + '</svg>';

  async function jget(p) { const r = await fetch(api(p), { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return r.json(); }
  async function jsend(p, method, body) {
    const r = await fetch(api(p), {
      method, headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) { let d = ''; try { d = (await r.json()).detail || ''; } catch (e) {} throw new Error(r.status + (d ? ': ' + d : '')); }
    return r.json().catch(() => ({}));
  }

  // In-panel side page (the table flexes to make room; reuses .j2c-side). Each
  // view owns its own panel (prefix = 'mcp-tool' | 'mcp-skill') so the two views
  // can both stay mounted without colliding ids.
  function sideMarkup(prefix, title) {
    return `<div id="${prefix}-side" class="j2c-side" hidden>
        <div class="pdf-head"><span class="src" id="${prefix}-side-title">${esc(title)}</span><button id="${prefix}-side-close" title="Close">✕</button></div>
        <div id="${prefix}-side-body" style="flex:1;overflow:auto;padding:1rem 1.1rem"></div>
      </div>`;
  }
  function openSide(prefix, title) {
    const side = document.getElementById(prefix + '-side');
    if (!side) return null;
    if (window.JOB2COOL_CHAT_CLOSE) try { window.JOB2COOL_CHAT_CLOSE(); } catch (e) {}
    if (window.JOB2COOL_CLOSE_SIDE_PANELS) window.JOB2COOL_CLOSE_SIDE_PANELS(prefix + '-side');
    document.getElementById(prefix + '-side-title').textContent = title;
    side.hidden = false;
    return document.getElementById(prefix + '-side-body');
  }
  function closeSide(prefix) { const s = document.getElementById(prefix + '-side'); if (s) s.hidden = true; }
  const tierBadge = t => `<span class="kb-phase ${t === 'write' ? 'warn' : 'ok'}">${esc(t || 'read')}</span>`;

  // ================= TOOLS =================
  async function renderTools() {
    const root = document.getElementById('view-tools'); if (!root) return;
    let tools;
    try { tools = (await jget('tools')).tools || []; } catch (e) { root.innerHTML = `<div class="kb-head"><b>Tools</b></div><div class="kb-empty">Failed to load: ${esc(e.message)}</div>`; return; }
    try { IMPLS = (await jget('health')).impls || IMPLS; } catch (e) {}
    root.innerHTML = `
      <div style="display:flex;flex:1;min-height:0">
        <div style="flex:1;min-width:0;display:flex;flex-direction:column">
          <div class="kb-head"><button class="hbtn btnnew" id="mcp-new-tool">＋ New Tool</button><span class="kb-sub">Tools available to the Assistant</span></div>
          <div id="mcp-tools-main" style="flex:1;min-width:0;overflow:auto;padding:1rem 1.3rem">
          ${tools.length ? `<table class="kb-doctable"><thead><tr><th>Name</th><th>Description</th><th>Tier</th><th>Impl</th><th>Enabled</th><th></th></tr></thead><tbody>${tools.map(t => `
            <tr>
              <td><b>${esc(t.display_name || t.name)}</b><div class="muted" style="font-size:11px">${esc(t.name)}</div></td>
              <td>${esc(t.description || '')}</td>
              <td>${tierBadge(t.tier)}</td>
              <td><code style="font-size:11px">${esc(t.impl || '')}</code></td>
              <td><input type="checkbox" data-toggle="${esc(t.name)}"${t.enabled !== false ? ' checked' : ''}></td>
              <td style="white-space:nowrap;text-align:right">
                <button class="hbtn" data-test="${esc(t.name)}">Test</button>
                <button class="hbtn" data-edit="${esc(t.name)}">Edit</button>
                <button class="hbtn" data-del="${esc(t.name)}">Delete</button>
              </td>
            </tr>`).join('')}</tbody></table>` : `<div class="kb-empty full"><div class="empty-art">${ART_TOOLS}</div><h3>No tools yet</h3><p>Add callable tools available to this app over MCP.</p></div>`}
          </div>
        </div>
        ${sideMarkup('mcp-tool', 'Test')}
      </div>`;
    const by = n => tools.find(t => t.name === n);
    root.querySelector('#mcp-new-tool').onclick = () => editTool(null);
    root.querySelector('#mcp-tool-side-close').onclick = () => closeSide('mcp-tool');
    if (window.JOB2COOL_RESIZER) window.JOB2COOL_RESIZER(document.getElementById('mcp-tool-side'));
    root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editTool(by(b.dataset.edit)));
    root.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (!confirm('Delete tool ' + b.dataset.del + '?')) return; try { await jsend('tools/' + enc(b.dataset.del), 'DELETE'); toast('Tool deleted'); renderTools(); } catch (e) { toast('Delete failed: ' + e.message); } });
    root.querySelectorAll('[data-toggle]').forEach(c => c.onchange = async () => { const t = by(c.dataset.toggle); try { await jsend('tools/' + enc(t.name), 'PUT', toolBody({ ...t, enabled: c.checked })); toast(c.checked ? 'Enabled' : 'Disabled'); } catch (e) { toast('Update failed: ' + e.message); c.checked = !c.checked; } });
    root.querySelectorAll('[data-test]').forEach(b => b.onclick = () => testTool(by(b.dataset.test)));
  }
  const toolBody = t => ({ display_name: t.display_name || '', description: t.description || '', impl: t.impl || 'web_search', tier: t.tier || 'read', enabled: t.enabled !== false, input_schema: t.input_schema || {}, config: t.config || {} });

  // Create/edit a tool in the right-side resizable panel (same panel Test uses),
  // built from a small field spec so it matches the schema-driven Test form.
  function editTool(t) {
    const isNew = !t;
    const body = openSide('mcp-tool', isNew ? 'New Tool' : 'Edit · ' + (t.display_name || t.name));
    if (!body) return;
    const lbl = (k, txt) => `<label style="display:block;font-size:12px;font-weight:600;margin:.7rem 0 .2rem">${esc(txt)}</label>`;
    const input = (k, v, ph) => `<input data-k="${k}" value="${esc(v || '')}" placeholder="${esc(ph || '')}" style="width:100%;box-sizing:border-box">`;
    const area = (k, v, rows) => `<textarea data-k="${k}" rows="${rows || 4}" style="width:100%;box-sizing:border-box;font-family:inherit">${esc(v || '')}</textarea>`;
    const sel = (k, opts, v) => `<select data-k="${k}" style="width:100%;box-sizing:border-box">${opts.map(o => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    body.innerHTML =
      (isNew ? lbl('name', 'Name (slug)') + input('name', '', 'e.g. web_search') : '')
      + lbl('display_name', 'Display name') + input('display_name', t && t.display_name)
      + lbl('description', 'Description') + area('description', t && t.description, 3)
      + lbl('impl', 'Implementation') + sel('impl', IMPLS, (t && t.impl) || IMPLS[0])
      + lbl('tier', 'Tier') + sel('tier', ['read', 'write'], (t && t.tier) || 'read')
      + lbl('config', 'Config (JSON)') + area('config', JSON.stringify(t && t.config || {}, null, 2), 3)
      + lbl('input_schema', 'Input schema (JSON)') + area('input_schema', JSON.stringify(t && t.input_schema || { type: 'object', properties: {}, required: [] }, null, 2), 6)
      + `<label class="setrow" style="display:flex;align-items:center;gap:.4rem;margin:.8rem 0 .2rem"><input type="checkbox" data-k="enabled"${(t ? t.enabled !== false : true) ? ' checked' : ''}> <span>Enabled</span></label>`
      + `<div style="margin-top:1rem;display:flex;gap:.5rem"><button class="hbtn primary" id="mcp-tool-save">${isNew ? 'Create' : 'Save'}</button><button class="hbtn" id="mcp-tool-cancel">Cancel</button></div>`;
    body.querySelector('#mcp-tool-cancel').onclick = () => closeSide('mcp-tool');
    body.querySelector('#mcp-tool-save').onclick = async () => {
      const f = {}; body.querySelectorAll('[data-k]').forEach(el => { f[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; });
      const name = (isNew ? f.name : t.name || '').trim();
      if (!name) { toast('Name required'); return; }
      let cfg, sch; try { cfg = JSON.parse(f.config || '{}'); sch = JSON.parse(f.input_schema || '{}'); } catch (e) { toast('Invalid JSON: ' + e.message); return; }
      try { await jsend('tools/' + enc(name), 'PUT', { display_name: f.display_name, description: f.description, impl: f.impl, tier: f.tier, enabled: !!f.enabled, config: cfg, input_schema: sch }); toast('Saved'); closeSide('mcp-tool'); renderTools(); } catch (e) { toast('Save failed: ' + e.message); }
    };
    const first = body.querySelector('[data-k]'); if (first) first.focus();
  }

  // Test runs in the side page; the form is built from the tool's input_schema
  // so it generalises beyond web_search.
  function testTool(t) {
    const body = openSide('mcp-tool', 'Test · ' + (t.display_name || t.name));
    if (!body) return;
    const props = (t.input_schema && t.input_schema.properties) || {};
    const required = (t.input_schema && t.input_schema.required) || [];
    const keys = Object.keys(props);
    const fields = (keys.length ? keys : ['query']).map(k => {
      const p = props[k] || { type: 'string' };
      const def = p.default != null ? p.default : '';
      const hint = p.description ? ` <span class="muted" style="font-weight:400">— ${esc(p.description)}</span>` : '';
      return `<label style="display:block;font-size:12px;font-weight:600;margin:.6rem 0 .2rem">${esc(k)}${required.includes(k) ? ' *' : ''}${hint}</label>
        <input data-arg="${esc(k)}" data-type="${esc(p.type || 'string')}" value="${esc(def)}" style="width:100%;box-sizing:border-box">`;
    }).join('');
    body.innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:.3rem">${esc(t.description || '')}</div>
      ${fields}
      <div style="margin-top:.9rem"><button class="hbtn primary" id="mcp-run">Run</button></div>
      <div id="mcp-run-out" style="margin-top:1rem"></div>`;
    const run = async () => {
      const args = {};
      body.querySelectorAll('[data-arg]').forEach(el => {
        const v = el.value.trim(); if (!v) return;
        args[el.dataset.arg] = (el.dataset.type === 'integer' || el.dataset.type === 'number') ? Number(v) : v;
      });
      const out = body.querySelector('#mcp-run-out');
      out.innerHTML = '<div class="kb-empty">Working…</div>';
      let res;
      try { res = await jsend('tools/' + enc(t.name) + '/invoke', 'POST', { args }); }
      catch (e) { out.innerHTML = `<div class="kb-empty">Error: ${esc(e.message)}</div>`; return; }
      const r = res.result && res.result.results;
      out.innerHTML = Array.isArray(r)
        ? (r.length ? `<ol style="padding-left:1.1rem">${r.map(x => `<li style="margin-bottom:.6rem"><b>${esc(x.title || '')}</b>${x.url ? `<br><a href="${esc(x.url)}" target="_blank" style="font-size:11px">${esc(x.url)}</a>` : ''}${x.snippet ? `<div class="muted" style="font-size:12px">${esc(x.snippet)}</div>` : ''}</li>`).join('')}</ol>` : '<div class="kb-empty">No results.</div>')
        : `<pre style="white-space:pre-wrap;font-size:12px">${esc(JSON.stringify(res.result != null ? res.result : res, null, 2))}</pre>`;
    };
    body.querySelector('#mcp-run').onclick = run;
    const first = body.querySelector('[data-arg]');
    if (first) { first.focus(); first.addEventListener('keydown', e => { if (e.key === 'Enter') run(); }); }
  }

  // ================= SKILLS =================
  async function renderSkills() {
    const root = document.getElementById('view-skills'); if (!root) return;
    let skills;
    try { skills = ((await jget('skills')).skills || []).sort((a, b) => (a.priority || 100) - (b.priority || 100)); }
    catch (e) { root.innerHTML = `<div class="kb-head"><b>Skills</b></div><div class="kb-empty">Failed to load: ${esc(e.message)}</div>`; return; }
    root.innerHTML = `
      <div style="display:flex;flex:1;min-height:0">
        <div style="flex:1;min-width:0;display:flex;flex-direction:column">
          <div class="kb-head"><button class="hbtn btnnew" id="mcp-new-skill">＋ New Skill</button><span class="kb-sub">Reusable instruction templates</span></div>
          <div id="mcp-skills-main" style="flex:1;min-width:0;overflow:auto;padding:1rem 1.3rem">
          ${skills.length ? `<table class="kb-doctable"><thead><tr><th>Name</th><th>Description</th><th>Triggers</th><th>Priority</th><th>Enabled</th><th></th></tr></thead><tbody>${skills.map(s => `
            <tr>
              <td><b>${esc(s.display_name || s.name)}</b><div class="muted" style="font-size:11px">${esc(s.name)}</div></td>
              <td>${esc(s.description || '')}</td>
              <td>${(s.triggers || []).map(x => `<span class="kb-phase idle">${esc(x)}</span>`).join(' ')}</td>
              <td>${esc(s.priority == null ? 100 : s.priority)}</td>
              <td><input type="checkbox" data-toggle="${esc(s.name)}"${s.enabled !== false ? ' checked' : ''}></td>
              <td style="white-space:nowrap;text-align:right"><button class="hbtn" data-edit="${esc(s.name)}">Edit</button><button class="hbtn" data-del="${esc(s.name)}">Delete</button></td>
            </tr>`).join('')}</tbody></table>` : `<div class="kb-empty full"><div class="empty-art">${ART_SKILLS}</div><h3>No skills created yet</h3><p>Add reusable instruction templates</p></div>`}
          </div>
        </div>
        ${sideMarkup('mcp-skill', 'Skill')}
      </div>`;
    const by = n => skills.find(s => s.name === n);
    root.querySelector('#mcp-new-skill').onclick = () => editSkill(null);
    root.querySelector('#mcp-skill-side-close').onclick = () => closeSide('mcp-skill');
    if (window.JOB2COOL_RESIZER) window.JOB2COOL_RESIZER(document.getElementById('mcp-skill-side'));
    root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editSkill(by(b.dataset.edit)));
    root.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (!confirm('Delete skill ' + b.dataset.del + '?')) return; try { await jsend('skills/' + enc(b.dataset.del), 'DELETE'); toast('Skill deleted'); renderSkills(); } catch (e) { toast('Delete failed: ' + e.message); } });
    root.querySelectorAll('[data-toggle]').forEach(c => c.onchange = async () => { const s = by(c.dataset.toggle); try { await jsend('skills/' + enc(s.name), 'PUT', skillBody({ ...s, enabled: c.checked })); toast(c.checked ? 'Enabled' : 'Disabled'); } catch (e) { toast('Update failed: ' + e.message); c.checked = !c.checked; } });
  }
  const skillBody = s => ({ display_name: s.display_name || '', description: s.description || '', content: s.content || '', triggers: s.triggers || [], priority: Number(s.priority) || 100, enabled: s.enabled !== false });

  // Create/edit a skill in the right-side resizable panel (same as Tools).
  function editSkill(s) {
    const isNew = !s;
    const body = openSide('mcp-skill', isNew ? 'New Skill' : 'Edit · ' + (s.display_name || s.name));
    if (!body) return;
    const lbl = txt => `<label style="display:block;font-size:12px;font-weight:600;margin:.7rem 0 .2rem">${esc(txt)}</label>`;
    const input = (k, v, ph) => `<input data-k="${k}" value="${esc(v || '')}" placeholder="${esc(ph || '')}" style="width:100%;box-sizing:border-box">`;
    const area = (k, v, rows) => `<textarea data-k="${k}" rows="${rows || 4}" style="width:100%;box-sizing:border-box;font-family:inherit">${esc(v || '')}</textarea>`;
    body.innerHTML =
      (isNew ? lbl('Name (slug)') + input('name', '', 'e.g. cite_sources') : '')
      + lbl('Display name') + input('display_name', s && s.display_name)
      + lbl('Description') + area('description', s && s.description, 2)
      + lbl('Content (instructions injected)') + area('content', s && s.content, 8)
      + lbl('Triggers (comma/space separated)') + input('triggers', (s && s.triggers || []).join(', '))
      + lbl('Priority') + input('priority', String(s && s.priority != null ? s.priority : 100))
      + `<label class="setrow" style="display:flex;align-items:center;gap:.4rem;margin:.8rem 0 .2rem"><input type="checkbox" data-k="enabled"${(s ? s.enabled !== false : true) ? ' checked' : ''}> <span>Enabled</span></label>`
      + `<div style="margin-top:1rem;display:flex;gap:.5rem"><button class="hbtn primary" id="mcp-skill-save">${isNew ? 'Create' : 'Save'}</button><button class="hbtn" id="mcp-skill-cancel">Cancel</button></div>`;
    body.querySelector('#mcp-skill-cancel').onclick = () => closeSide('mcp-skill');
    body.querySelector('#mcp-skill-save').onclick = async () => {
      const f = {}; body.querySelectorAll('[data-k]').forEach(el => { f[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; });
      const name = (isNew ? f.name : s.name || '').trim();
      if (!name) { toast('Name required'); return; }
      const triggers = (f.triggers || '').split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
      try { await jsend('skills/' + enc(name), 'PUT', { display_name: f.display_name, description: f.description, content: f.content, triggers, priority: Number(f.priority) || 100, enabled: !!f.enabled }); toast('Saved'); closeSide('mcp-skill'); renderSkills(); }
      catch (e) { toast('Save failed: ' + e.message); }
    };
    const first = body.querySelector('[data-k]'); if (first) first.focus();
  }

  window.JOB2COOL_MCP_OPEN = function (view) {
    if (view === 'tools') renderTools();
    else if (view === 'skills') renderSkills();
  };
})();
