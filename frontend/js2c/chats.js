/* Chats — per-user conversation history (Option A: job2cool-owned, on-disk).
 * Auto-saves each turn (via window.JOB2COOL_TURN_SAVED, fired by the widget),
 * lists threads in the Chats view, reloads a whole thread on click, and starts
 * a fresh thread on New Request / New chat. */
(function () {
  const api = p => new URL('api/' + p, document.baseURI).href;
  const esc = s => (s || '').toString().replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const toast = m => (window.toast ? window.toast(m) : void 0);
  // Empty-state illustration (chat bubble + the shared blue star badge).
  const EMPTY_ART = '<svg viewBox="0 0 210 150" fill="none"><rect x="52" y="40" width="106" height="74" rx="18" fill="#f1f7fc"/><rect x="66" y="56" width="76" height="42" rx="12" fill="#fff" stroke="#a6d0ec" stroke-width="3.4"/><path d="M88 97l-3 13 16-13" fill="#fff" stroke="#a6d0ec" stroke-width="3.4" stroke-linejoin="round"/><circle cx="92" cy="77" r="3" fill="#a6d0ec"/><circle cx="104" cy="77" r="3" fill="#a6d0ec"/><circle cx="116" cy="77" r="3" fill="#a6d0ec"/><circle cx="150" cy="40" r="20" fill="#2f9be6"/><path d="M150 29l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="#fff"/></svg>';
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
    }
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
          </tr>`).join('')}</tbody></table>` : `<div class="kb-empty full"><div class="empty-art">${EMPTY_ART}</div><h3>No saved chats yet</h3><p>Your conversations with Diana will appear here.</p></div>`}
      </div>`;
    root.querySelector('#chats-new').onclick = () => { window.JOB2COOL_CHAT_NEW(); openChat(); };
    root.querySelectorAll('[data-open]').forEach(b => b.onclick = () => loadThread(b.dataset.open));
    root.querySelectorAll('[data-rename]').forEach(b => b.onclick = () => { const c = chats.find(x => x.thread_id === b.dataset.rename); renameThread(b.dataset.rename, c && c.title); });
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
