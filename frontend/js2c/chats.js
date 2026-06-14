/* Chats — per-user conversation history (Option A: job2cool-owned, on-disk).
 * Auto-saves each turn (via window.JOB2COOL_TURN_SAVED, fired by the widget),
 * lists threads in the Chats view, reloads a whole thread on click, and starts
 * a fresh thread on New Request / New chat. */
(function () {
  const api = p => new URL('api/' + p, document.baseURI).href;
  const esc = s => (s || '').toString().replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const toast = m => (window.toast ? window.toast(m) : void 0);
  let threadId = null;   // current thread; null = a fresh one is created on first save
  let currentTitle = ''; // the thread's title; default = detected role, unless renamed
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

  // Auto-save the current thread on each completed turn. Debounced ~1s so the
  // turn's workspace document buffers land in the doc state before we snapshot.
  let _saveTimer = null;
  window.JOB2COOL_TURN_SAVED = function (history) {
    if (!history || !history.length) return;
    if (!threadId) threadId = genId();
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => _saveThread(history), 1000);
  };
  async function _saveThread(history) {
    if (!titleUserSet) currentTitle = titleFrom(history);   // default name = detected role
    const documents = window.JOB2COOL_GET_DOCS ? window.JOB2COOL_GET_DOCS() : {};
    const role = (window.JOB2COOL_GET_ROLE && window.JOB2COOL_GET_ROLE()) || '';
    try {
      await fetch(api('job2cool/chats/' + threadId), {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: currentTitle || 'New chat', role, messages: history, documents }),
      });
    } catch (e) { /* non-fatal: history stays in the live panel */ }
    const v = document.getElementById('view-chats');
    if (v && !v.hidden) renderList();
  }

  // New Request / New chat → start a fresh thread (the prior one is already saved).
  window.JOB2COOL_CHAT_NEW = function () {
    threadId = null; currentTitle = ''; titleUserSet = false;
    if (window.JOB2COOL_CHAT_RESET) window.JOB2COOL_CHAT_RESET();
    try { fetch(new URL('api/buffers/clear', document.baseURI).href, { method: 'POST' }); } catch (e) {}
  };

  async function loadThread(id) {
    let t;
    try { t = await (await fetch(api('job2cool/chats/' + id), { cache: 'no-store' })).json(); }
    catch (e) { toast('Could not load chat'); return; }
    threadId = id; currentTitle = t.title || ''; titleUserSet = true;
    if (window.JOB2COOL_CHAT_LOAD) window.JOB2COOL_CHAT_LOAD(t.messages || []);
    if (window.JOB2COOL_SET_DOCS) window.JOB2COOL_SET_DOCS(t.documents || {});
    if (window.JOB2COOL_SET_ROLE) window.JOB2COOL_SET_ROLE(t.role || (t.documents && t.documents.role) || '');
    if (window.showView) window.showView('workspace');   // reopening a chat lands you in its Workspace
  }
  async function renameThread(id, current) {
    const title = window.prompt('Rename chat', current || '');
    if (title == null) return;
    const t = title.trim(); if (!t) return;
    try {
      await fetch(api('job2cool/chats/' + id), {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: t }),
      });
    } catch (e) { toast('Rename failed'); return; }
    if (id === threadId) { currentTitle = t; titleUserSet = true; }   // don't let auto-naming clobber it
    renderList();
  }
  async function delThread(id) {
    if (!confirm('Delete this chat?')) return;
    try { await fetch(api('job2cool/chats/' + id), { method: 'DELETE' }); } catch (e) {}
    if (threadId === id) threadId = null;
    renderList();
  }

  async function renderList() {
    const root = document.getElementById('view-chats'); if (!root) return;
    let chats = [];
    try { chats = (await (await fetch(api('job2cool/chats'), { cache: 'no-store' })).json()).chats || []; }
    catch (e) { root.innerHTML = `<div class="kb-head"><b>Chats</b></div><div class="kb-empty">Failed to load chats.</div>`; return; }
    root.innerHTML = `
      <div class="kb-head"><button class="hbtn btnnew" id="chats-new">＋ New chat</button><span class="kb-sub">Your saved conversations</span></div>
      <div style="padding:1rem 1.3rem">
        ${chats.length ? `<table class="kb-doctable"><thead><tr><th>Title</th><th>Turns</th><th>Updated</th><th></th></tr></thead><tbody>${chats.map(c => `
          <tr>
            <td class="nm"><a data-open="${esc(c.thread_id)}" title="Reopen"><b>${esc(c.title)}</b></a>${c.role && c.role !== c.title ? `<span style="display:block;font-size:11px;color:var(--muted);font-family:inherit">${esc(c.role)}</span>` : ''}</td>
            <td>${Math.max(1, Math.floor((c.message_count || 0) / 2))}</td>
            <td>${esc(fmtWhen(c.updated_at))}</td>
            <td style="white-space:nowrap;text-align:right"><button class="hbtn" data-open="${esc(c.thread_id)}">Open</button><button class="hbtn" data-rename="${esc(c.thread_id)}">Rename</button><button class="hbtn" data-del="${esc(c.thread_id)}">Delete</button></td>
          </tr>`).join('')}</tbody></table>` : `<div class="kb-empty full">No saved chats yet.</div>`}
      </div>`;
    root.querySelector('#chats-new').onclick = () => { window.JOB2COOL_CHAT_NEW(); openChat(); };
    root.querySelectorAll('[data-open]').forEach(b => b.onclick = () => loadThread(b.dataset.open));
    root.querySelectorAll('[data-rename]').forEach(b => b.onclick = () => { const c = chats.find(x => x.thread_id === b.dataset.rename); renameThread(b.dataset.rename, c && c.title); });
    root.querySelectorAll('[data-del]').forEach(b => b.onclick = () => delThread(b.dataset.del));
  }

  window.JOB2COOL_CHATS_OPEN = renderList;
})();
