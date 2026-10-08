// Live leaderboard connection: one WebSocket to /ws that delivers {type:'state', state}.
// Reconnects with backoff, and pings so a dead connection is noticed within ~30s.
window.live = function live(onState, { onStatus } = {}) {
  let ws, retry = 0, pingTimer, pongTimer;
  const status = s => onStatus && onStatus(s);

  function connect() {
    status('connecting');
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      status('live');
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws.readyState !== 1) return;
        ws.send('ping');
        clearTimeout(pongTimer);
        pongTimer = setTimeout(() => ws.close(), 10000);
      }, 20000);
    };
    ws.onmessage = e => {
      if (e.data === 'pong') { clearTimeout(pongTimer); return; }
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'state') onState(msg.state);
      } catch { /* ignore malformed */ }
    };
    ws.onclose = () => {
      clearInterval(pingTimer); clearTimeout(pongTimer);
      status('offline');
      setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
    };
    ws.onerror = () => ws.close();
  }

  // Phones suspend background tabs; reconnect straight away when the page comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ws && ws.readyState > 1) { retry = 0; connect(); }
  });

  connect();
};
