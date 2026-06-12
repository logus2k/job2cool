/* job2cool — citation -> PDF + bbox highlight.
 * Renders a cited PDF (cited page(s) + bbox) INTO a given container via
 * window.JOB2COOL_RENDER_PDF(bodyEl, data). The caller (index.html) owns the
 * split-pane layout / header / close; this module is just the renderer.
 * PDF bytes come from /api/documents/files (proxied to noted); the bbox math is
 * pdf.js's convertToViewportRectangle (the noted approach).
 */
(function () {
  'use strict';
  var PDF_BASE = 'static/vendor/pdf.min.mjs';
  var WORKER = 'static/vendor/pdf.worker.min.mjs';
  var WASM = 'static/vendor/wasm/';
  var _pdfjs = null;

  var css = '\
  .j2c-pdf-msg{color:#6b7280;font:13px system-ui;padding:1.4rem}\
  .j2c-page{position:relative;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.15);margin:0 auto 1rem}\
  .j2c-page canvas{display:block;width:100%;height:auto}\
  .j2c-bbox{position:absolute;background:rgba(0,255,139,.16);border:1px dashed #559766;border-radius:2px;\
            box-shadow:0 0 0 3px rgba(255,220,0,.10);pointer-events:none}\
  .j2c-pageno{position:absolute;top:4px;right:6px;font:600 11px system-ui;color:#9aa0ab;background:#fff;padding:0 4px;border-radius:4px}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function asset(p) { return new URL(p, document.baseURI).href; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function pdfUrl(domain, src) {
    var parts = String(src || '').split('/').map(encodeURIComponent).join('/');
    return 'api/documents/files/' + encodeURIComponent(domain || '') + '/' + parts;
  }
  window.JOB2COOL_PDF_URL = pdfUrl;   // for the caller's "Open full PDF" link

  async function ipdf() {
    if (_pdfjs) return _pdfjs;
    _pdfjs = await import(asset(PDF_BASE));
    return _pdfjs;
  }

  // Render the cited PDF page(s) + bbox into `body` (a scroll container).
  window.JOB2COOL_RENDER_PDF = async function (body, data) {
    if (!body) return;
    body.innerHTML = '<div class="j2c-pdf-msg">Loading PDF…</div>';
    var src = data.source_path || '';
    var regions = (data.regions || []).filter(function (r) { return r && r.page_no; });
    var url = pdfUrl(data.domain_id, src);
    try {
      var pdfjs = await ipdf();
      pdfjs.GlobalWorkerOptions.workerSrc = asset(WORKER);
      var doc = await pdfjs.getDocument({ url: url, wasmUrl: asset(WASM) }).promise;

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
        var targetW = Math.min(820, Math.max(280, body.clientWidth - 28));
        var vp = page.getViewport({ scale: targetW / nat.width });
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
          var hl = document.createElement('div'); hl.className = 'j2c-bbox';
          hl.style.left = left + 'px'; hl.style.top = top + 'px';
          hl.style.width = Math.abs(rect[2] - rect[0]) + 'px'; hl.style.height = Math.abs(rect[3] - rect[1]) + 'px';
          wrap.appendChild(hl);
        });
      }
      if (first) first.scrollIntoView({ block: 'start' });
      if (!body.children.length) body.innerHTML = '<div class="j2c-pdf-msg">Could not locate the cited page.</div>';
    } catch (e) {
      body.innerHTML = '<div class="j2c-pdf-msg">Could not render the PDF (' + esc(String(e && e.message || e)) + '). Use “Open full PDF”.</div>';
    }
  };
})();
