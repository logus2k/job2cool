/* Help & Support view: renders the architecture/service-map diagram and feeds
 * it LIVE dependency health pushed from job2cool-backend over Socket.IO.
 *
 * Event-driven, no timers: we subscribe once and only listen for `health:status`
 * pushes. Each push pets the diagram's CSS-animation watchdog (markLive); if the
 * stream goes silent the badge decays green→yellow→orange→red on its own and a
 * socket drop jumps it to disconnected. Same Socket.IO server as KB progress. */
(function () {
  const A = window.JOB2COOL_ARCHITECTURE;
  let sock = null;

  const base = () => new URL('.', document.baseURI).pathname;   // '/job2cool/' or '/'

  function ensureSocket() {
    if (sock || typeof io === 'undefined') return sock;
    sock = io(window.location.origin, { path: base() + 'socket.io', transports: ['websocket', 'polling'] });
    sock.on('connect', () => sock.emit('health:subscribe'));
    sock.on('health:status', (d) => {
      A.setHealth((d && d.statuses) || {});
      try { A.setStatusText('updated ' + new Date(d.ts).toLocaleTimeString()); } catch (e) { /* noop */ }
      A.markLive();                       // pet the watchdog
    });
    sock.on('disconnect', () => A.markDisconnected());
    return sock;
  }

  function open() {
    const root = document.getElementById('view-help');
    if (!root || !A) return;
    A.render(root, { onRefresh: () => { const s = ensureSocket(); if (s && s.connected) s.emit('health:subscribe'); } });
    const s = ensureSocket();
    if (s && s.connected) s.emit('health:subscribe');   // already connected → re-snapshot now
  }

  window.JOB2COOL_HELP_OPEN = open;
})();
