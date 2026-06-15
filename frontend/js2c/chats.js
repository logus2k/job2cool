/* Projects — per-user named workspaces with conversation history (job2cool-owned,
 * on-disk). A project has a name + optional description + visibility (private =
 * owner only, shared = visible to all authenticated users). Auto-saves each turn
 * (window.JOB2COOL_TURN_SAVED), lists projects, reloads a whole project on click,
 * and starts a fresh one via the New Project dialog (name + description + private/
 * shared, defaulting to shared). */
(function () {
  const api = p => new URL('api/' + p, document.baseURI).href;
  const esc = s => (s || '').toString().replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const toast = m => (window.toast ? window.toast(m) : void 0);
  // Empty-state illustration (folder + the shared blue star badge).
  const EMPTY_ART = '<svg viewBox="0 0 210 150" fill="none"><rect x="52" y="40" width="106" height="74" rx="14" fill="#f1f7fc"/><path d="M64 64h24l8 9h44a6 6 0 0 1 6 6v26a6 6 0 0 1-6 6H64a6 6 0 0 1-6-6V70a6 6 0 0 1 6-6z" fill="#fff" stroke="#a6d0ec" stroke-width="3.4" stroke-linejoin="round"/><circle cx="150" cy="40" r="20" fill="#2f9be6"/><path d="M150 29l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="#fff"/></svg>';
  let threadId = null;   // current project; null = a fresh one is created on first save
  let currentTitle = ''; // project name
  let currentDescription = '';
  let currentVisibility = 'shared';   // 'private' | 'shared' (shared is the default)
  let currentReadonly = false;        // true when viewing a shared project you don't own
  let titleUserSet = false;

  const genId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  function openChat() {
    if (window.openAssistant) window.openAssistant();
    else { const l = document.querySelector('.cvchat-launcher'); if (l) l.click(); }
  }
  function titleFrom(messages) {
    const role = ((window.JOB2COOL_GET_ROLE && window.JOB2COOL_GET_ROLE()) || '').trim();
    if (role) return role.slice(0, 80);
    const u = (messages || []).find(m => m.role === 'user');
    return ((u && u.content) || 'New chat').replace(/\s+/g, ' ').trim().slice(0, 80) || 'New chat';
  }
  function fmtWhen(epoch) {
    if (!epoch) return '';
    try { return new Date(epoch * 1000).toLocaleString(); } catch (e) { return ''; }
  }

  // Auto-save the current thread. Event-driven (no timers): save on each
  // completed turn, and re-save whenever the workspace document buffers actually
  // change (the `job2cool:docschanged` event the buffer SSE handler dispatches),
  // so late-arriving docs land in the saved thread without waiting on a clock.
  let _lastHistory = null;
  window.JOB2COOL_TURN_SAVED = function (history) {
    if (!history || !history.length) return;
    if (!threadId) threadId = genId();
    _lastHistory = history;
    _saveThread(history);
  };
  document.addEventListener('job2cool:docschanged', () => {
    if (threadId && _lastHistory) _saveThread(_lastHistory);   // persist updated docs against the current thread
  });
  async function _saveThread(history) {
    if (currentReadonly) return;   // viewing someone else's shared project — don't persist
    if (!titleUserSet) currentTitle = titleFrom(history);   // default name = detected role
    const documents = window.JOB2COOL_GET_DOCS ? window.JOB2COOL_GET_DOCS() : {};
    const role = (window.JOB2COOL_GET_ROLE && window.JOB2COOL_GET_ROLE()) || '';
    const panels = window.JOB2COOL_GET_PANELS ? window.JOB2COOL_GET_PANELS() : [];
    try {
      await fetch(api('job2cool/chats/' + threadId), {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: currentTitle || 'New project', description: currentDescription,
                               visibility: currentVisibility, role, messages: history, documents, panels }),
      });
    } catch (e) { /* non-fatal: history stays in the live panel */ }
    const v = document.getElementById('view-chats');
    if (v && !v.hidden) renderList();
  }

  // Reset to a blank project (the prior one is already saved).
  window.JOB2COOL_CHAT_NEW = function () {
    threadId = null; currentTitle = ''; currentDescription = '';
    currentVisibility = 'shared'; currentReadonly = false; titleUserSet = false;
    if (window.JOB2COOL_SET_PROJECT_NAME) window.JOB2COOL_SET_PROJECT_NAME('');
    if (window.JOB2COOL_CHAT_RESET) window.JOB2COOL_CHAT_RESET();
    try { fetch(new URL('api/buffers/clear', document.baseURI).href, { method: 'POST' }); } catch (e) {}
  };

  // ---- New Project dialog (name required, description optional, private/shared) ----
  function projectDialog(prefill) {
    prefill = prefill || {};
    const editing = prefill.name != null;
    const vis = prefill.visibility || 'shared';
    return new Promise(resolve => {
      const bg = document.createElement('div'); bg.className = 'kbdlg-bg';
      bg.innerHTML = `<div class="kbdlg" style="width:660px"><h3>${editing ? 'Edit Project' : 'New Project'}</h3>
        <label>Name</label>
        <input id="pj-name" type="text" value="${esc(prefill.name || '')}" placeholder="e.g. Senior DevOps hire">
        <label>Description <span class="muted" style="font-weight:400">(optional)</span></label>
        <textarea id="pj-desc" rows="3" placeholder="What is this project about?">${esc(prefill.description || '')}</textarea>
        <label>Visibility</label>
        <label class="setrow" style="display:flex;align-items:center;gap:.5rem;font-weight:400;margin:.25rem 0"><input type="radio" name="pj-vis" value="shared" style="width:16px;height:16px;min-width:16px;flex:none;margin:0;accent-color:#1d1d1d"${vis !== 'private' ? ' checked' : ''}> <span><b>Shared</b> — visible to everyone</span></label>
        <label class="setrow" style="display:flex;align-items:center;gap:.5rem;font-weight:400;margin:.25rem 0"><input type="radio" name="pj-vis" value="private" style="width:16px;height:16px;min-width:16px;flex:none;margin:0;accent-color:#1d1d1d"${vis === 'private' ? ' checked' : ''}> <span><b>Private</b> — only you</span></label>
        <div class="foot"><button class="hbtn" data-x>Cancel</button><button class="hbtn primary" data-ok>${editing ? 'Save' : 'Create'}</button></div></div>`;
      document.body.appendChild(bg);
      let down = null;
      const close = v => { bg.remove(); resolve(v); };
      bg.querySelector('[data-x]').onclick = () => close(null);
      bg.addEventListener('mousedown', e => { down = e.target; });
      bg.addEventListener('click', e => { if (e.target === bg && down === bg) close(null); });
      const ok = () => {
        const name = bg.querySelector('#pj-name').value.trim();
        if (!name) { bg.querySelector('#pj-name').focus(); toast('Name is required'); return; }
        close({
          name,
          description: bg.querySelector('#pj-desc').value.trim(),
          visibility: (bg.querySelector('input[name=pj-vis]:checked') || {}).value || 'shared',
        });
      };
      bg.querySelector('[data-ok]').onclick = ok;
      const ni = bg.querySelector('#pj-name'); ni.focus();
      ni.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
    });
  }

  // New Project → name/description/visibility dialog, then a fresh named project.
  window.JOB2COOL_NEW_PROJECT = async function () {
    const r = await projectDialog();
    if (!r) return;
    threadId = genId();
    currentTitle = r.name; currentDescription = r.description;
    currentVisibility = r.visibility; currentReadonly = false; titleUserSet = true;
    if (window.JOB2COOL_SET_PROJECT_NAME) window.JOB2COOL_SET_PROJECT_NAME(r.name);
    if (window.JOB2COOL_CHAT_RESET) window.JOB2COOL_CHAT_RESET();
    try { await fetch(new URL('api/buffers/clear', document.baseURI).href, { method: 'POST' }); } catch (e) {}
    if (window.showView) window.showView('workspace');
    if (window.JOB2COOL_NEW_TURN) window.JOB2COOL_NEW_TURN();   // fresh empty workspace
    _saveThread([]);                                           // persist the empty project so it lists immediately
    openChat();
  };

  async function loadThread(id) {
    let t;
    try { t = await (await fetch(api('job2cool/chats/' + id), { cache: 'no-store' })).json(); }
    catch (e) { toast('Could not load project'); return; }
    threadId = id; currentTitle = t.title || ''; titleUserSet = true;
    if (window.JOB2COOL_SET_PROJECT_NAME) window.JOB2COOL_SET_PROJECT_NAME(currentTitle);
    currentDescription = t.description || '';
    currentVisibility = t.visibility || 'private';
    currentReadonly = (currentVisibility === 'shared' && t.is_owner === false);   // shared, not mine → view-only
    if (window.JOB2COOL_CHAT_LOAD) window.JOB2COOL_CHAT_LOAD(t.messages || [], t.panels || []);
    if (window.JOB2COOL_SET_DOCS) window.JOB2COOL_SET_DOCS(t.documents || {});
    if (window.JOB2COOL_SET_ROLE) window.JOB2COOL_SET_ROLE(t.role || (t.documents && t.documents.role) || '');
    if (window.showView) window.showView('workspace');   // reopening a project lands you in its Workspace
  }
  async function editProject(id, cur) {
    const r = await projectDialog({ name: cur.title || '', description: cur.description || '', visibility: cur.visibility || 'private' });
    if (!r) return;
    try {
      const rr = await fetch(api('job2cool/chats/' + id), {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: r.name, description: r.description }),
      });
      if (!rr.ok) { toast(rr.status === 403 ? 'Only the owner can edit' : 'Save failed'); return; }
    } catch (e) { toast('Save failed'); return; }
    if (id === threadId) { currentTitle = r.name; currentDescription = r.description; titleUserSet = true;
      if (window.JOB2COOL_SET_PROJECT_NAME) window.JOB2COOL_SET_PROJECT_NAME(r.name); }
    renderList();
  }
  async function delThread(id) {
    if (!confirm('Delete this project?')) return;
    try { await fetch(api('job2cool/chats/' + id), { method: 'DELETE' }); } catch (e) {}
    const wasActive = (threadId === id);
    if (wasActive) threadId = null;
    // The Workspace documents live in the backend's in-memory buffers (replayed
    // on SSE connect), independent of the thread JSON. Deleting the open chat —
    // or the last remaining chat — should clear them too, otherwise the docs
    // reappear after a refresh. (After a hard refresh threadId is null, so the
    // "no chats remain" check is what catches the last-chat case.)
    let remaining = 1;
    try { remaining = ((await (await fetch(api('job2cool/chats'), { cache: 'no-store' })).json()).chats || []).length; } catch (e) {}
    if (wasActive || remaining === 0) {
      try { await fetch(new URL('api/buffers/clear', document.baseURI).href, { method: 'POST' }); } catch (e) {}
      if (window.JOB2COOL_NEW_TURN) window.JOB2COOL_NEW_TURN();   // reset doc state + re-render the empty Workspace
      currentTitle = ''; titleUserSet = false;
      if (window.JOB2COOL_SET_PROJECT_NAME) window.JOB2COOL_SET_PROJECT_NAME('');
    }
    renderList();
  }

  const visBadge = c => c.visibility === 'shared'
    ? '<span style="display:inline-block;font-size:10.5px;font-weight:600;padding:.05rem .45rem;border-radius:10px;background:#d0efd1;color:#1d5b2a">Shared</span>'
    : '<span style="display:inline-block;font-size:10.5px;font-weight:600;padding:.05rem .45rem;border-radius:10px;background:#eceef3;color:#5a6273">Private</span>';

  async function renderList() {
    const root = document.getElementById('view-chats'); if (!root) return;
    let chats = [];
    try { chats = (await (await fetch(api('job2cool/chats'), { cache: 'no-store' })).json()).chats || []; }
    catch (e) { root.innerHTML = `<div class="kb-head"><b>Projects</b></div><div class="kb-empty">Failed to load projects.</div>`; return; }
    const rows = chats.map(c => {
      const owned = c.is_owner !== false;
      const sub = [];
      if (c.description) sub.push(esc(c.description));
      if (c.visibility === 'shared' && !owned && c.owner) sub.push('by ' + esc(c.owner));
      else if (c.role && c.role !== c.title) sub.push(esc(c.role));
      const subline = sub.length ? `<span style="display:block;font-size:11px;color:var(--muted);font-family:inherit">${sub.join(' · ')}</span>` : '';
      const actions = owned
        ? `<button class="hbtn" data-open="${esc(c.thread_id)}">Open</button><button class="hbtn" data-edit="${esc(c.thread_id)}">Edit</button><button class="hbtn" data-del="${esc(c.thread_id)}">Delete</button>`
        : `<button class="hbtn" data-open="${esc(c.thread_id)}">Open</button>`;
      return `<tr>
        <td class="nm"><a data-open="${esc(c.thread_id)}" title="Open"><b>${esc(c.title)}</b></a>${subline}</td>
        <td>${visBadge(c)}</td>
        <td>${Math.max(0, Math.floor((c.message_count || 0) / 2))}</td>
        <td>${esc(fmtWhen(c.updated_at))}</td>
        <td style="white-space:nowrap;text-align:right">${actions}</td>
      </tr>`;
    }).join('');
    root.innerHTML = `
      <div class="kb-head"><span class="kb-sub">Your projects and shared team projects</span></div>
      <div style="padding:1rem 1.3rem">
        ${chats.length ? `<table class="kb-doctable"><thead><tr><th>Project</th><th>Visibility</th><th>Turns</th><th>Updated</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
          : `<div class="kb-empty full"><div class="empty-art">${EMPTY_ART}</div><h3>No projects yet</h3><p>Create one with ＋ New Project</p></div>`}
      </div>`;
    root.querySelectorAll('[data-open]').forEach(b => b.onclick = () => loadThread(b.dataset.open));
    root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { const c = chats.find(x => x.thread_id === b.dataset.edit); editProject(b.dataset.edit, c || {}); });
    root.querySelectorAll('[data-del]').forEach(b => b.onclick = () => delThread(b.dataset.del));
  }

  window.JOB2COOL_CHATS_OPEN = renderList;

  // Orphaned-workspace guard: the Workspace documents live in the backend's
  // in-memory buffers and are replayed on every SSE connect, independent of the
  // chat threads. If there are no saved chats, any lingering buffers belong to a
  // chat that no longer exists — drop them on load so deleted docs don't reappear
  // after a refresh. (Runs once at startup; a new generation repopulates them.)
  (async function pruneOrphanWorkspace() {
    try {
      const chats = (await (await fetch(api('job2cool/chats'), { cache: 'no-store' })).json()).chats || [];
      if (!chats.length) {
        await fetch(new URL('api/buffers/clear', document.baseURI).href, { method: 'POST' });
        if (window.JOB2COOL_NEW_TURN) window.JOB2COOL_NEW_TURN();   // reset any docs the SSE snapshot already rendered
      }
    } catch (e) { /* non-fatal */ }
  })();
})();
