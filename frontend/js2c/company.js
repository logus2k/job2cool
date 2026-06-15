/* Company Profile — one shared record (logo + header + footer text) reused by
 * every generated document at EXPORT time. The export path (index.html
 * companyChrome/printDoc) injects these as a repeating page header/footer; they
 * are never written into the document content. Backed by job2cool-backend
 * /api/job2cool/company-profile (GET any authenticated user; PUT admin-gated via
 * JOB2COOL_ADMIN_EMAILS). Read-only when the server says can_edit=false. */
(function () {
  const api = () => new URL('api/job2cool/company-profile', document.baseURI).href;
  const esc = s => (s == null ? '' : s.toString()).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const toast = m => (window.toast ? window.toast(m) : void 0);
  const LOGO_MAX = 2_000_000;   // ~2MB decoded; warn before the server rejects it

  const state = { logo: '', header: '', footer: '', can_edit: true };
  let styled = false;

  function injectStyle() {
    if (styled) return; styled = true;
    const s = document.createElement('style');
    s.textContent = `
      .cp-wrap{max-width:680px;padding:1.4rem 1.3rem;display:flex;flex-direction:column;gap:1.3rem}
      .cp-intro{color:var(--muted);font-size:12.5px;line-height:1.5}
      .cp-card{border:1px solid #e8eaf0;border-radius:12px;padding:1rem 1.1rem;background:#fff;display:flex;flex-direction:column;gap:.55rem}
      .cp-card h4{margin:0;font-size:13.5px;color:var(--ink)}
      .cp-card .hint{color:var(--muted);font-size:11.5px;line-height:1.45;margin:0}
      .cp-logo-row{display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
      .cp-logo-prev{height:54px;max-width:200px;object-fit:contain;border:1px solid #ececec;border-radius:8px;padding:.3rem .5rem;background:#fbfbf7}
      .cp-logo-empty{height:54px;width:140px;display:flex;align-items:center;justify-content:center;border:1px dashed #cfd3dd;border-radius:8px;color:var(--muted);font-size:11px}
      .cp-field{width:100%;border:1px solid var(--line);border-radius:9px;padding:.55rem .7rem;font:inherit;font-size:13px;background:#fff;resize:vertical}
      .cp-foot{display:flex;align-items:center;gap:.7rem}
      .cp-foot .saved{color:var(--muted);font-size:11.5px}
      .cp-readonly{background:#fff7df;border:1px solid #f0e2b0;color:#7a5d0b;border-radius:9px;padding:.55rem .75rem;font-size:12px}`;
    document.head.appendChild(s);
  }

  async function load() {
    try {
      const r = await (await fetch(api(), { credentials: 'include' })).json();
      state.logo = r.logo || ''; state.header = r.header || '';
      state.footer = r.footer || ''; state.can_edit = !!r.can_edit;
    } catch (e) { /* keep defaults */ }
  }

  function logoCell() {
    return state.logo
      ? `<img class="cp-logo-prev" src="${state.logo}" alt="logo preview">`
      : `<span class="cp-logo-empty">No logo</span>`;
  }

  function render() {
    const root = document.getElementById('view-company'); if (!root) return;
    injectStyle();
    const ro = !state.can_edit;
    const dis = ro ? 'disabled' : '';
    root.innerHTML = `
      <div class="kb-head"><span class="kb-sub">Logo, header and footer applied to every exported document</span></div>
      <div style="flex:1;min-height:0;overflow:auto">
       <div class="cp-wrap">
        ${ro ? `<div class="cp-readonly">You can view the company profile, but only an administrator can edit it.</div>` : ''}
        <p class="cp-intro">These appear as a page header and footer on every PDF you export (Download All and per-document export). They are not added to the document text.</p>

        <div class="cp-card">
          <h4>Logo</h4>
          <p class="hint">Shown at the top-left of every exported page. PNG or SVG with a transparent background works best. Keep it under ~2&nbsp;MB.</p>
          <div class="cp-logo-row">
            <span id="cp-logo-cell">${logoCell()}</span>
            <button class="hbtn" id="cp-logo-btn" ${dis}>Choose image…</button>
            <button class="hbtn" id="cp-logo-clear" ${dis} ${state.logo ? '' : 'hidden'}>Remove</button>
            <input type="file" id="cp-logo-file" accept="image/*" hidden>
          </div>
        </div>

        <div class="cp-card">
          <h4>Header text</h4>
          <p class="hint">Optional. Appears beside the logo (e.g. company name or department).</p>
          <textarea class="cp-field" id="cp-header" rows="2" maxlength="500" placeholder="e.g. Acme Corporation — Talent Acquisition" ${dis}>${esc(state.header)}</textarea>
        </div>

        <div class="cp-card">
          <h4>Footer text</h4>
          <p class="hint">Optional. Appears centered at the bottom of every page (e.g. confidentiality note or contact).</p>
          <textarea class="cp-field" id="cp-footer" rows="2" maxlength="500" placeholder="e.g. Confidential — Acme Corporation · careers@acme.com" ${dis}>${esc(state.footer)}</textarea>
        </div>

        <div class="cp-foot">
          <button class="hbtn primary" id="cp-save" ${dis}>Save</button>
          <span class="saved" id="cp-saved"></span>
        </div>
       </div>
      </div>`;

    if (ro) return;
    const fileInput = root.querySelector('#cp-logo-file');
    root.querySelector('#cp-logo-btn').onclick = () => fileInput.click();
    fileInput.onchange = () => {
      const f = fileInput.files && fileInput.files[0]; if (!f) return;
      if (f.size > LOGO_MAX) { toast('Image is too large (max ~2MB)'); fileInput.value = ''; return; }
      const reader = new FileReader();
      reader.onload = () => {
        state.logo = reader.result;
        root.querySelector('#cp-logo-cell').innerHTML = logoCell();
        root.querySelector('#cp-logo-clear').hidden = false;
      };
      reader.readAsDataURL(f);
      fileInput.value = '';
    };
    root.querySelector('#cp-logo-clear').onclick = e => {
      state.logo = '';
      root.querySelector('#cp-logo-cell').innerHTML = logoCell();
      e.target.hidden = true;
    };
    root.querySelector('#cp-save').onclick = save;
  }

  async function save() {
    const root = document.getElementById('view-company'); if (!root) return;
    state.header = root.querySelector('#cp-header').value;
    state.footer = root.querySelector('#cp-footer').value;
    const btn = root.querySelector('#cp-save'); btn.disabled = true;
    try {
      const r = await fetch(api(), {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logo: state.logo, header: state.header, footer: state.footer })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast(d.error || 'Save failed'); btn.disabled = false; return; }
      if (window.JOB2COOL_COMPANY_CHROME_RESET) window.JOB2COOL_COMPANY_CHROME_RESET();
      const saved = root.querySelector('#cp-saved'); if (saved) saved.textContent = 'Saved.';
      toast('Company profile saved');
    } catch (e) { toast('Save failed'); }
    btn.disabled = false;
  }

  window.JOB2COOL_COMPANY_OPEN = async function () { await load(); render(); };
})();
