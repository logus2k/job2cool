/* Shared resizable side-panel helper. The Tools test panel and the Agents
 * editor dock on the right and share the SAME width as the Assistant chat —
 * both read the `--cvchat-panel-w` root variable, and the drag handle (left
 * edge, like the chat's) writes back to that variable, so all three panels stay
 * the same width and respond to screen size (clamped to the viewport in CSS). */
(function () {
  window.JOB2COOL_RESIZER = function (panel, opts) {
    opts = opts || {};
    const min = opts.min || 360, max = opts.max || 2400;
    if (!panel) return;
    let handle = panel.querySelector(':scope > .j2c-resize');
    if (!handle) { handle = document.createElement('div'); handle.className = 'j2c-resize'; panel.insertBefore(handle, panel.firstChild); }
    if (handle._wired) return; handle._wired = true;
    handle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      const startX = e.clientX, startW = panel.getBoundingClientRect().width;
      document.body.style.userSelect = 'none'; document.body.style.cursor = 'ew-resize';
      function move(ev) {
        let w = startW + (startX - ev.clientX);   // drag left → wider
        w = Math.max(min, Math.min(max, w));
        document.documentElement.style.setProperty('--cvchat-panel-w', w + 'px');
      }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.style.userSelect = ''; document.body.style.cursor = '';
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  };
})();
