/* Agents — manage the job2cool_* agent_server presets that drive Diana
 * (orchestrator / composer / judge). Editing a template happens in a resizable
 * right-docked side panel (same width as the Assistant chat). Proxied via
 * job2cool-backend /api/agents/* -> agent_server /admin/api/agents. job2cool
 * fetches these at runtime (cached ~60s) with the inline constant as fallback,
 * so a missing preset is harmless. Filtered to the job2cool_ namespace. */
(function () {
  const api = p => new URL('api/agents/' + (p || ''), document.baseURI).href;
  const esc = s => (s || '').toString().replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const toast = m => (window.toast ? window.toast(m) : void 0);
  const PREFIX = 'job2cool_';
  const ROLE = {
    job2cool_orchestrator: 'Orchestrator — plans the package & reasoning',
    job2cool_composer: 'Composer — writes each document section',
    job2cool_judge: 'Judge — scores faithfulness & answer relevance',
  };

  async function jget(p) { const r = await fetch(api(p), { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return r.json(); }
  async function jsend(p, method, body) {
    const r = await fetch(api(p), { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) { let d = ''; try { d = (await r.json()).detail || ''; } catch (e) {} throw new Error(r.status + (d ? ': ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); }
    return r.json().catch(() => ({}));
  }

  function openSide(title) {
    const side = document.getElementById('ag-side'); if (!side) return null;
    if (window.JOB2COOL_CHAT_CLOSE) try { window.JOB2COOL_CHAT_CLOSE(); } catch (e) {}
    if (window.JOB2COOL_CLOSE_SIDE_PANELS) window.JOB2COOL_CLOSE_SIDE_PANELS('ag-side');
    document.getElementById('ag-side-title').textContent = title;
    side.hidden = false;
    if (window.JOB2COOL_RESIZER) window.JOB2COOL_RESIZER(side);
    return document.getElementById('ag-side-body');
  }
  function closeSide() { const s = document.getElementById('ag-side'); if (s) s.hidden = true; }

  async function renderList() {
    const root = document.getElementById('view-agents'); if (!root) return;
    let agents;
    try { agents = ((await jget('')).agents || []).filter(a => (a.name || '').startsWith(PREFIX)); }
    catch (e) { root.innerHTML = `<div class="kb-head"><b>Agents</b></div><div class="kb-empty">Failed to load: ${esc(e.message)}</div>`; return; }
    agents.sort((a, b) => a.name.localeCompare(b.name));
    root.innerHTML = `
      <div style="display:flex;flex:1;min-height:0">
        <div style="flex:1;min-width:0;display:flex;flex-direction:column">
          <div class="kb-head"><button class="hbtn btnnew" id="ag-new">＋ New Agent</button><span class="kb-sub">agent_server presets that drive Diana — edit a template to change her behaviour</span></div>
          <div id="ag-main" style="flex:1;min-width:0;overflow:auto;padding:1rem 1.3rem">
          ${agents.length ? `<table class="kb-doctable"><thead><tr><th>Agent</th><th>Role</th><th>Memory</th><th></th></tr></thead><tbody>${agents.map(a => `
            <tr>
              <td><b>${esc(a.name.slice(PREFIX.length))}</b><div class="muted" style="font-size:11px">${esc(a.name)}</div></td>
              <td>${esc(ROLE[a.name] || '')}</td>
              <td><code style="font-size:11px">${esc(a.memory_policy || 'none')}</code></td>
              <td style="white-space:nowrap;text-align:right"><button class="hbtn" data-edit="${esc(a.name)}">Edit template</button><button class="hbtn" data-del="${esc(a.name)}">Delete</button></td>
            </tr>`).join('')}</tbody></table>` : `<div class="kb-empty full">No job2cool agents yet. Click ＋ New Agent to add one.</div>`}
          </div>
        </div>
        <div id="ag-side" class="j2c-side" hidden>
          <div class="pdf-head"><span class="src" id="ag-side-title">Edit</span><button id="ag-side-close" title="Close">✕</button></div>
          <div id="ag-side-body" style="flex:1;min-height:0;display:flex;flex-direction:column;padding:1rem 1.1rem;gap:.4rem"></div>
        </div>
      </div>`;
    root.querySelector('#ag-new').onclick = () => editAgent(null);
    root.querySelector('#ag-side-close').onclick = closeSide;
    root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editAgent(b.dataset.edit));
    root.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (!confirm('Delete agent ' + b.dataset.del + '? Diana will fall back to the built-in default.')) return; try { await jsend(b.dataset.del, 'DELETE'); toast('Deleted'); renderList(); } catch (e) { toast('Delete failed: ' + e.message); } });
  }

  async function editAgent(name) {
    const isNew = !name;
    let preset = { system_prompt: '', params_override: {}, memory_policy: 'none' };
    if (!isNew) { try { preset = await jget(name); } catch (e) { toast('Load failed: ' + e.message); return; } }
    const body = openSide(isNew ? 'New Agent' : 'Edit · ' + name);
    if (!body) return;
    body.innerHTML = `
      ${isNew ? `<label>Name <span class="muted">(the job2cool_ prefix is added automatically)</span></label>
        <input id="ag-name" placeholder="e.g. job2cool_interviewer">` : `<div class="muted" style="font-size:12px">${esc(name)} — ${esc(ROLE[name] || '')}</div>`}
      <label>Template (system prompt)</label>
      <textarea id="ag-prompt" class="grow"></textarea>
      <label>Params override <span class="muted">(JSON, stored on the preset)</span></label>
      <textarea id="ag-params" rows="2" style="font-family:ui-monospace,monospace;font-size:12px"></textarea>
      <label>Memory policy</label>
      <select id="ag-mem"><option value="none">none</option><option value="thread_window">thread_window</option></select>
      <div style="margin-top:.5rem;display:flex;gap:.5rem"><button class="hbtn primary" id="ag-save">${isNew ? 'Create' : 'Save'}</button><button class="hbtn" id="ag-cancel">Cancel</button></div>`;
    body.querySelector('#ag-prompt').value = preset.system_prompt || '';
    body.querySelector('#ag-params').value = JSON.stringify(preset.params_override || {}, null, 2);
    body.querySelector('#ag-mem').value = preset.memory_policy || 'none';
    body.querySelector('#ag-cancel').onclick = closeSide;
    body.querySelector('#ag-save').onclick = async () => {
      let nm = isNew ? (body.querySelector('#ag-name').value || '') : name;
      nm = nm.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
      if (isNew && !nm.startsWith(PREFIX)) nm = PREFIX + nm.replace(/^_+/, '');
      if (!nm || nm === PREFIX) { toast('Name required'); return; }
      const sp = body.querySelector('#ag-prompt').value;
      if (!sp.trim()) { toast('Template must not be empty'); return; }
      let params; try { params = JSON.parse(body.querySelector('#ag-params').value || '{}'); } catch (e) { toast('Invalid params JSON: ' + e.message); return; }
      const payload = { name: nm, system_prompt: sp, params_override: params, memory_policy: body.querySelector('#ag-mem').value };
      try {
        if (isNew) await jsend('', 'POST', payload); else await jsend(nm, 'PUT', payload);
        toast('Saved — takes effect within ~60s'); renderList();
      } catch (e) { toast('Save failed: ' + e.message); }
    };
    const focusEl = body.querySelector(isNew ? '#ag-name' : '#ag-prompt'); if (focusEl) focusEl.focus();
  }

  window.JOB2COOL_AGENTS_OPEN = renderList;
})();
