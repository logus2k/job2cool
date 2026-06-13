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

  async function jget(p) { const r = await fetch(api(p), { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return r.json(); }
  async function jsend(p, method, body) {
    const r = await fetch(api(p), {
      method, headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) { let d = ''; try { d = (await r.json()).detail || ''; } catch (e) {} throw new Error(r.status + (d ? ': ' + d : '')); }
    return r.json().catch(() => ({}));
  }

  // ---- dialog + overlay (reuse kbdlg CSS) ----
  function dialog(title, fields, submitLabel) {
    return new Promise(resolve => {
      const bg = document.createElement('div'); bg.className = 'kbdlg-bg';
      const body = fields.map(f => {
        if (f.type === 'textarea') return `<label>${esc(f.label)}</label><textarea data-k="${f.key}" rows="${f.rows || 5}">${esc(f.value || '')}</textarea>`;
        if (f.type === 'select') return `<label>${esc(f.label)}</label><select data-k="${f.key}">${(f.options || []).map(o => `<option value="${esc(o)}"${o === f.value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
        if (f.type === 'checkbox') return `<label class="setrow"><input type="checkbox" data-k="${f.key}"${f.value ? ' checked' : ''}> <span>${esc(f.label)}</span></label>`;
        return `<label>${esc(f.label)}</label><input type="text" data-k="${f.key}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}">`;
      }).join('');
      bg.innerHTML = `<div class="kbdlg"><h3>${esc(title)}</h3>${body}<div class="foot"><button class="hbtn" data-x>Cancel</button><button class="hbtn primary" data-ok>${esc(submitLabel || 'Save')}</button></div></div>`;
      document.body.appendChild(bg);
      const close = v => { bg.remove(); resolve(v); };
      bg.querySelector('[data-x]').onclick = () => close(null);
      bg.onclick = e => { if (e.target === bg) close(null); };
      bg.querySelector('[data-ok]').onclick = () => {
        const out = {}; bg.querySelectorAll('[data-k]').forEach(el => { out[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; }); close(out);
      };
      const first = bg.querySelector('input,textarea,select'); if (first) first.focus();
    });
  }
  // In-panel side page (the tools table flexes to make room; reuses .pdf-col).
  function openSide(title) {
    const side = document.getElementById('mcp-tool-side');
    if (!side) return null;
    document.getElementById('mcp-side-title').textContent = title;
    side.hidden = false;
    return document.getElementById('mcp-side-body');
  }
  function closeSide() { const s = document.getElementById('mcp-tool-side'); if (s) s.hidden = true; }
  const tierBadge = t => `<span class="kb-phase ${t === 'write' ? 'warn' : 'ok'}">${esc(t || 'read')}</span>`;

  // ================= TOOLS =================
  async function renderTools() {
    const root = document.getElementById('view-tools'); if (!root) return;
    let tools;
    try { tools = (await jget('tools')).tools || []; } catch (e) { root.innerHTML = `<div class="kb-head"><b>Tools</b></div><div class="kb-empty">Failed to load: ${esc(e.message)}</div>`; return; }
    try { IMPLS = (await jget('health')).impls || IMPLS; } catch (e) {}
    root.innerHTML = `
      <div class="kb-head"><b>Tools</b><span class="kb-sub">Callable tools available to this app over MCP</span>
        <button class="hbtn primary" id="mcp-new-tool" style="margin-left:auto">＋ New Tool</button></div>
      <div style="display:flex;flex:1;min-height:0">
        <div id="mcp-tools-main" style="flex:1;min-width:0;overflow:auto;padding:1rem 1.3rem">
          ${tools.length ? `<table class="kb-doctable"><thead><tr><th>Name</th><th>Description</th><th>Tier</th><th>Impl</th><th>Enabled</th><th></th></tr></thead><tbody>${tools.map(t => `
            <tr>
              <td><b>${esc(t.display_name || t.name)}</b><div class="muted" style="font-size:11px">${esc(t.name)}</div></td>
              <td>${esc(t.description || '')}</td>
              <td>${tierBadge(t.tier)}</td>
              <td><code style="font-size:11px">${esc(t.impl || '')}</code></td>
              <td><input type="checkbox" data-toggle="${esc(t.name)}"${t.enabled !== false ? ' checked' : ''}></td>
              <td style="white-space:nowrap">
                <button class="hbtn" data-test="${esc(t.name)}">Test</button>
                <button class="hbtn" data-edit="${esc(t.name)}">Edit</button>
                <button class="hbtn" data-del="${esc(t.name)}">Delete</button>
              </td>
            </tr>`).join('')}</tbody></table>` : `<div class="kb-empty">No tools yet. Click ＋ New Tool to add one.</div>`}
        </div>
        <div id="mcp-tool-side" class="pdf-col" hidden style="flex:0 0 460px;min-width:0">
          <div class="pdf-head"><span class="src" id="mcp-side-title">Test</span><button id="mcp-side-close" title="Close">✕</button></div>
          <div id="mcp-side-body" style="flex:1;overflow:auto;padding:1rem 1.1rem"></div>
        </div>
      </div>`;
    const by = n => tools.find(t => t.name === n);
    root.querySelector('#mcp-new-tool').onclick = () => editTool(null);
    root.querySelector('#mcp-side-close').onclick = closeSide;
    root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editTool(by(b.dataset.edit)));
    root.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (!confirm('Delete tool ' + b.dataset.del + '?')) return; try { await jsend('tools/' + enc(b.dataset.del), 'DELETE'); toast('Tool deleted'); renderTools(); } catch (e) { toast('Delete failed: ' + e.message); } });
    root.querySelectorAll('[data-toggle]').forEach(c => c.onchange = async () => { const t = by(c.dataset.toggle); try { await jsend('tools/' + enc(t.name), 'PUT', toolBody({ ...t, enabled: c.checked })); toast(c.checked ? 'Enabled' : 'Disabled'); } catch (e) { toast('Update failed: ' + e.message); c.checked = !c.checked; } });
    root.querySelectorAll('[data-test]').forEach(b => b.onclick = () => testTool(by(b.dataset.test)));
  }
  const toolBody = t => ({ display_name: t.display_name || '', description: t.description || '', impl: t.impl || 'web_search', tier: t.tier || 'read', enabled: t.enabled !== false, input_schema: t.input_schema || {}, config: t.config || {} });

  async function editTool(t) {
    const isNew = !t;
    const f = await dialog(isNew ? 'New Tool' : 'Edit ' + (t.display_name || t.name), [
      ...(isNew ? [{ key: 'name', label: 'Name (slug)', placeholder: 'e.g. web_search' }] : []),
      { key: 'display_name', label: 'Display name', value: t && t.display_name || '' },
      { key: 'description', label: 'Description', type: 'textarea', rows: 3, value: t && t.description || '' },
      { key: 'impl', label: 'Implementation', type: 'select', options: IMPLS, value: (t && t.impl) || IMPLS[0] },
      { key: 'tier', label: 'Tier', type: 'select', options: ['read', 'write'], value: (t && t.tier) || 'read' },
      { key: 'config', label: 'Config (JSON)', type: 'textarea', rows: 3, value: JSON.stringify(t && t.config || {}, null, 2) },
      { key: 'input_schema', label: 'Input schema (JSON)', type: 'textarea', rows: 6, value: JSON.stringify(t && t.input_schema || { type: 'object', properties: {}, required: [] }, null, 2) },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', value: t ? t.enabled !== false : true },
    ], isNew ? 'Create' : 'Save');
    if (!f) return;
    const name = (isNew ? f.name : t.name || '').trim();
    if (!name) { toast('Name required'); return; }
    let cfg, sch; try { cfg = JSON.parse(f.config || '{}'); sch = JSON.parse(f.input_schema || '{}'); } catch (e) { toast('Invalid JSON: ' + e.message); return; }
    try { await jsend('tools/' + enc(name), 'PUT', { display_name: f.display_name, description: f.description, impl: f.impl, tier: f.tier, enabled: !!f.enabled, config: cfg, input_schema: sch }); toast('Saved'); renderTools(); } catch (e) { toast('Save failed: ' + e.message); }
  }

  // Test runs in the side page; the form is built from the tool's input_schema
  // so it generalises beyond web_search.
  function testTool(t) {
    const body = openSide('Test · ' + (t.display_name || t.name));
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
      <div class="kb-head"><b>Skills</b><span class="kb-sub">Reusable instruction templates (served over MCP as prompts)</span>
        <button class="hbtn primary" id="mcp-new-skill" style="margin-left:auto">＋ New Skill</button></div>
      <div style="padding:1rem 1.3rem">
        ${skills.length ? `<table class="kb-doctable"><thead><tr><th>Name</th><th>Description</th><th>Triggers</th><th>Priority</th><th>Enabled</th><th></th></tr></thead><tbody>${skills.map(s => `
          <tr>
            <td><b>${esc(s.display_name || s.name)}</b><div class="muted" style="font-size:11px">${esc(s.name)}</div></td>
            <td>${esc(s.description || '')}</td>
            <td>${(s.triggers || []).map(x => `<span class="kb-phase idle">${esc(x)}</span>`).join(' ')}</td>
            <td>${esc(s.priority == null ? 100 : s.priority)}</td>
            <td><input type="checkbox" data-toggle="${esc(s.name)}"${s.enabled !== false ? ' checked' : ''}></td>
            <td style="white-space:nowrap"><button class="hbtn" data-edit="${esc(s.name)}">Edit</button><button class="hbtn" data-del="${esc(s.name)}">Delete</button></td>
          </tr>`).join('')}</tbody></table>` : `<div class="kb-empty">No skills yet. Click ＋ New Skill to add one.</div>`}
      </div>`;
    const by = n => skills.find(s => s.name === n);
    root.querySelector('#mcp-new-skill').onclick = () => editSkill(null);
    root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editSkill(by(b.dataset.edit)));
    root.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (!confirm('Delete skill ' + b.dataset.del + '?')) return; try { await jsend('skills/' + enc(b.dataset.del), 'DELETE'); toast('Skill deleted'); renderSkills(); } catch (e) { toast('Delete failed: ' + e.message); } });
    root.querySelectorAll('[data-toggle]').forEach(c => c.onchange = async () => { const s = by(c.dataset.toggle); try { await jsend('skills/' + enc(s.name), 'PUT', skillBody({ ...s, enabled: c.checked })); toast(c.checked ? 'Enabled' : 'Disabled'); } catch (e) { toast('Update failed: ' + e.message); c.checked = !c.checked; } });
  }
  const skillBody = s => ({ display_name: s.display_name || '', description: s.description || '', content: s.content || '', triggers: s.triggers || [], priority: Number(s.priority) || 100, enabled: s.enabled !== false });

  async function editSkill(s) {
    const isNew = !s;
    const f = await dialog(isNew ? 'New Skill' : 'Edit ' + (s.display_name || s.name), [
      ...(isNew ? [{ key: 'name', label: 'Name (slug)', placeholder: 'e.g. cite_sources' }] : []),
      { key: 'display_name', label: 'Display name', value: s && s.display_name || '' },
      { key: 'description', label: 'Description', type: 'textarea', rows: 2, value: s && s.description || '' },
      { key: 'content', label: 'Content (instructions injected)', type: 'textarea', rows: 8, value: s && s.content || '' },
      { key: 'triggers', label: 'Triggers (comma/space separated)', value: (s && s.triggers || []).join(', ') },
      { key: 'priority', label: 'Priority', value: String(s && s.priority != null ? s.priority : 100) },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', value: s ? s.enabled !== false : true },
    ], isNew ? 'Create' : 'Save');
    if (!f) return;
    const name = (isNew ? f.name : s.name || '').trim();
    if (!name) { toast('Name required'); return; }
    const triggers = (f.triggers || '').split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
    try { await jsend('skills/' + enc(name), 'PUT', { display_name: f.display_name, description: f.description, content: f.content, triggers, priority: Number(f.priority) || 100, enabled: !!f.enabled }); toast('Saved'); renderSkills(); }
    catch (e) { toast('Save failed: ' + e.message); }
  }

  window.JOB2COOL_MCP_OPEN = function (view) {
    if (view === 'tools') renderTools();
    else if (view === 'skills') renderSkills();
  };
})();
