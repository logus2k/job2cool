/* Skills + Tools views — now a doorway to the MCP Console, the one place the shared tool/skill host
 * (mcp-service) is administered. The former in-page editors duplicated the console and drifted from it
 * (mcp-service/documents/console_specification.md section 4.8). The backend's /api/mcp/* proxy stays
 * for programmatic use; the views below only show what this app is offered and link to the console. */
(function () {
  const api = p => new URL('api/mcp/' + p, document.baseURI).href;
  const esc = s => (s || '').toString().split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;');
  // The console: on the domain behind oauth2-proxy (owner only); on the machine itself, the service's own port.
  const CONSOLE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:4950/admin' : location.origin + '/mcp-console/admin';
  const APP = 'job2cool';

  async function jget(p) { const r = await fetch(api(p), { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return r.json(); }

  function panel(kind, rows, note) {
    const list = rows.length
      ? '<ul class="kb-list">' + rows.map(r => `<li class="kb-item"><div><b>${esc(r.name)}</b>${r.enabled === false ? ' <span class="kb-badge">disabled</span>' : ''}<div class="kb-muted">${esc(r.description)}</div></div></li>`).join('') + '</ul>'
      : `<p class="kb-muted">No ${kind}s are offered to ${APP} yet.</p>`;
    return `<div class="kb-head"><h2>${kind === 'tool' ? 'Tools' : 'Skills'}</h2>
        <a class="kb-btn" href="${CONSOLE}#${kind === 'tool' ? 'app=' + APP : 'skills'}" target="_blank" rel="noopener">Open the MCP Console</a></div>
      <p class="kb-muted">${note}</p>${list}`;
  }

  async function renderTools() {
    const root = document.getElementById('view-tools'); if (!root) return;
    root.innerHTML = '<p class="kb-muted">Loading…</p>';
    try {
      const d = await jget('tools');
      root.innerHTML = panel('tool', d.tools || [], `The tools ${APP}'s assistant may call, as the shared MCP service offers them. Create, edit, try and audit them in the MCP Console.`);
    } catch (e) { root.innerHTML = panel('tool', [], 'The MCP service did not answer (' + esc(e.message) + ').'); }
  }

  async function renderSkills() {
    const root = document.getElementById('view-skills'); if (!root) return;
    root.innerHTML = '<p class="kb-muted">Loading…</p>';
    try {
      const d = await jget('skills');
      root.innerHTML = panel('skill', d.skills || [], `Instructions ${APP} shares with other apps, served by the MCP service as prompts. Author and version them in the MCP Console.`);
    } catch (e) { root.innerHTML = panel('skill', [], 'The MCP service did not answer (' + esc(e.message) + ').'); }
  }

  window.JOB2COOL_MCP_OPEN = function (view) {
    if (view === 'tools') renderTools();
    else if (view === 'skills') renderSkills();
  };
})();
