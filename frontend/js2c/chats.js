/* Chats — per-user conversation history (Option A: job2cool-owned, on-disk).
 * Auto-saves each turn (via window.JOB2COOL_TURN_SAVED, fired by the widget),
 * lists threads in the Chats view, reloads a whole thread on click, and starts
 * a fresh thread on New Request / New chat. */
(function () {
  const api = p => new URL('api/' + p, document.baseURI).href;
  const esc = s => (s || '').toString().replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const toast = m => (window.toast ? window.toast(m) : void 0);
  let threadId = null;   // current thread; null = a fresh one is created on first save

  const genId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  function openChat() {
    if (window.openAssistant) window.openAssistant();
    else { const l = document.querySelector('.cvchat-launcher'); if (l) l.click(); }
  }
  function titleFrom(messages) {
    const u = (messages || []).find(m => m.role === 'user');
    return ((u && u.content) || 'New chat').replace(/\s+/g, ' ').trim().slice(0, 80) || 'New chat';
  }
  function fmtWhen(epoch) {
    if (!epoch) return '';
    try { return new Date(epoch * 1000).toLocaleString(); } catch (e) { return ''; }
  }

  // Auto-save the current thread on each completed turn.
  window.JOB2COOL_TURN_SAVED = async function (history) {
    if (!history || !history.length) return;
    if (!threadId) threadId = genId();
    try {
      await fetch(api('job2cool/chats/' + threadId), {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: titleFrom(history), messages: history }),
      });
    } catch (e) { /* non-fatal: history stays in the live panel */ }
    const v = document.getElementById('view-chats');
    if (v && !v.hidden) renderList();
  };

  // New Request / New chat → start a fresh thread (the prior one is already saved).
  window.JOB2COOL_CHAT_NEW = function () {
    threadId = null;
    if (window.JOB2COOL_CHAT_RESET) window.JOB2COOL_CHAT_RESET();
  };

  async function loadThread(id) {
    let t;
    try { t = await (await fetch(api('job2cool/chats/' + id), { cache: 'no-store' })).json(); }
    catch (e) { toast('Could not load chat'); return; }
    threadId = id;
    if (window.JOB2COOL_CHAT_LOAD) window.JOB2COOL_CHAT_LOAD(t.messages || []);
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
      <div class="kb-head"><b>Chats</b><span class="kb-sub">Your saved conversations</span>
        <button class="hbtn primary" id="chats-new" style="margin-left:auto">＋ New chat</button></div>
      <div style="padding:1rem 1.3rem">
        ${chats.length ? `<table class="kb-doctable"><thead><tr><th>Title</th><th>Turns</th><th>Updated</th><th></th></tr></thead><tbody>${chats.map(c => `
          <tr>
            <td class="nm"><a data-open="${esc(c.thread_id)}" title="Reopen"><b>${esc(c.title)}</b></a></td>
            <td>${Math.max(1, Math.floor((c.message_count || 0) / 2))}</td>
            <td>${esc(fmtWhen(c.updated_at))}</td>
            <td style="white-space:nowrap"><button class="hbtn" data-open="${esc(c.thread_id)}">Open</button><button class="hbtn" data-rename="${esc(c.thread_id)}">Rename</button><button class="hbtn" data-del="${esc(c.thread_id)}">Delete</button></td>
          </tr>`).join('')}</tbody></table>` : `<div class="kb-empty">No saved chats yet. Start one with ＋ New chat or the Diana launcher.</div>`}
      </div>`;
    root.querySelector('#chats-new').onclick = () => { window.JOB2COOL_CHAT_NEW(); openChat(); };
    root.querySelectorAll('[data-open]').forEach(b => b.onclick = () => loadThread(b.dataset.open));
    root.querySelectorAll('[data-rename]').forEach(b => b.onclick = () => { const c = chats.find(x => x.thread_id === b.dataset.rename); renameThread(b.dataset.rename, c && c.title); });
    root.querySelectorAll('[data-del]').forEach(b => b.onclick = () => delThread(b.dataset.del));
  }

  window.JOB2COOL_CHATS_OPEN = renderList;
})();
