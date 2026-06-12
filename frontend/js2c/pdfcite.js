/* job2cool — citation -> PDF + bbox highlight.
 * Defines window.JOB2COOL_OPEN_PDF(data), called by the (patched) cv-chat
 * citation handler when a chunk citation carries PDF `regions`. Opens the
 * source PDF (served via /api/documents/files, proxied to noted), renders the
 * cited page(s) with pdf.js, and draws the bbox highlight — the noted behaviour.
 */
(function () {
  'use strict';
  var PDF_BASE = 'static/vendor/pdf.min.mjs';
  var WORKER = 'static/vendor/pdf.worker.min.mjs';
  var WASM = 'static/vendor/wasm/';
  var _pdfjs = null;

  // ---- styles (self-contained) ---------------------------------------------
  var css = '\
  .j2c-pdf-bg{position:fixed;inset:0;background:rgba(20,24,40,.55);z-index:10000;display:flex;align-items:center;justify-content:center}\
  .j2c-pdf{background:#fff;border-radius:12px;box-shadow:0 16px 48px rgba(20,24,40,.4);width:min(920px,94vw);height:90vh;display:flex;flex-direction:column;overflow:hidden}\
  .j2c-pdf-head{display:flex;align-items:center;gap:.6rem;padding:.7rem 1rem;border-bottom:1px solid #e6e8ef;font:600 13.5px system-ui}\
  .j2c-pdf-head .meta{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#1e2330}\
  .j2c-pdf-head .sub{font-weight:400;color:#6b7280}\
  .j2c-pdf-head a{color:#4f46e5;font-weight:600;text-decoration:none;font-size:12.5px}\
  .j2c-pdf-head button{border:0;background:#eef0f5;border-radius:8px;width:28px;height:28px;cursor:pointer;font-size:16px}\
  .j2c-pdf-body{flex:1;overflow:auto;background:#f1f2f6;padding:1rem;display:flex;flex-direction:column;align-items:center;gap:1rem}\
  .j2c-page{position:relative;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.15)}\
  .j2c-page canvas{display:block;width:100%;height:auto}\
  .j2c-bbox{position:absolute;background:rgba(0,255,139,.16);border:1px dashed #559766;border-radius:2px;\
            box-shadow:0 0 0 3px rgba(255,220,0,.10);pointer-events:none}\
  .j2c-pageno{position:absolute;top:4px;right:6px;font:600 11px system-ui;color:#9aa0ab;background:#fff;padding:0 4px;border-radius:4px}\
  .j2c-pdf-msg{color:#6b7280;font:13px system-ui;padding:2rem}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function pdfUrl(domain, src) {
    var parts = String(src || '').split('/').map(encodeURIComponent).join('/');
    return 'api/documents/files/' + encodeURIComponent(domain || '') + '/' + parts;
  }

  function close(bg) { if (bg && bg.parentNode) bg.parentNode.removeChild(bg); }

  window.JOB2COOL_OPEN_PDF = async function (data) {
    var src = data.source_path || '';
    var regions = (data.regions || []).filter(function (r) { return r && r.page_no; });
    var url = pdfUrl(data.domain_id, src);

    var bg = document.createElement('div'); bg.className = 'j2c-pdf-bg';
    bg.innerHTML = '<div class="j2c-pdf">\
      <div class="j2c-pdf-head">\
        <div class="meta">' + esc(src) + (data.section_path ? ' <span class="sub">· ' + esc(data.section_path) + '</span>' : '') + '</div>\
        <a href="' + url + '" target="_blank">Open full PDF ↗</a>\
        <button title="Close">×</button>\
      </div>\
      <div class="j2c-pdf-body"><div class="j2c-pdf-msg">Loading PDF…</div></div></div>';
    bg.addEventListener('click', function (e) { if (e.target === bg) close(bg); });
    bg.querySelector('button').onclick = function () { close(bg); };
    document.addEventListener('keydown', function esc2(e) { if (e.key === 'Escape') { close(bg); document.removeEventListener('keydown', esc2); } });
    document.body.appendChild(bg);
    var body = bg.querySelector('.j2c-pdf-body');

    try {
      var pdfjs = await ipdf();
      pdfjs.GlobalWorkerOptions.workerSrc = asset(WORKER);
      var doc = await pdfjs.getDocument({ url: url, wasmUrl: asset(WASM) }).promise;

      // group regions by page (unique pages, sorted)
      var byPage = {};
      regions.forEach(function (r) { (byPage[r.page_no] = byPage[r.page_no] || []).push(r.bbox); });
      var pages = Object.keys(byPage).map(Number).sort(function (a, b) { return a - b; });
      if (!pages.length) pages = [data.page_no || 1];

      body.innerHTML = '';
      var first = null;
      for (var i = 0; i < pages.length; i++) {
        var pageNo = pages[i];
        if (pageNo < 1 || pageNo > doc.numPages) continue;
        var page = await doc.getPage(pageNo);
        var nat = page.getViewport({ scale: 1 });
        var targetW = Math.min(880, body.clientWidth - 32);
        var scale = targetW / nat.width;
        var vp = page.getViewport({ scale: scale });
        var dpr = window.devicePixelRatio || 1;

        var wrap = document.createElement('div'); wrap.className = 'j2c-page';
        wrap.style.width = vp.width + 'px'; wrap.style.height = vp.height + 'px';
        var canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
        wrap.appendChild(canvas);
        var tag = document.createElement('div'); tag.className = 'j2c-pageno'; tag.textContent = 'p.' + pageNo; wrap.appendChild(tag);
        body.appendChild(wrap);
        if (!first) first = wrap;

        var ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;

        byPage[pageNo].forEach(function (bbox) {
          if (!bbox || bbox.length !== 4) return;
          var rect = vp.convertToViewportRectangle(bbox);
          var left = Math.min(rect[0], rect[2]), top = Math.min(rect[1], rect[3]);
          var w = Math.abs(rect[2] - rect[0]), h = Math.abs(rect[3] - rect[1]);
          var hl = document.createElement('div'); hl.className = 'j2c-bbox';
          hl.style.left = left + 'px'; hl.style.top = top + 'px';
          hl.style.width = w + 'px'; hl.style.height = h + 'px';
          wrap.appendChild(hl);
        });
      }
      if (first) first.scrollIntoView({ block: 'center' });
      if (!body.children.length) body.innerHTML = '<div class="j2c-pdf-msg">Could not locate the cited page.</div>';
    } catch (e) {
      body.innerHTML = '<div class="j2c-pdf-msg">Could not render the PDF (' + esc(String(e && e.message || e)) + ').<br>Use “Open full PDF”.</div>';
    }
  };

  // Resolve an asset against the page base so it works under a sub-path
  // (e.g. logus2k.com/job2cool/) as well as at the server root.
  function asset(p) { return new URL(p, document.baseURI).href; }
  async function ipdf() {
    if (_pdfjs) return _pdfjs;
    _pdfjs = await import(asset(PDF_BASE));
    return _pdfjs;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
})();
