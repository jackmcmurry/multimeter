/* ============================================================================
 * live.js: real-time prices over Coinbase Exchange's public WebSocket.
 *
 * The page keeps polling CoinGecko as before; this feed only makes the coins
 * on the screen tick between polls. It subscribes one product at a time so a
 * symbol Coinbase does not list (the week's crypto pick often is not) can
 * fail on its own without taking BTC and ETH down with it, coalesces ticks
 * so the screen repaints at most four times a second, closes while the tab
 * is hidden, and reconnects with capped exponential backoff. A watchdog
 * treats twenty seconds of silence as a dead socket: heartbeats arrive
 * every second, so silence never means "quiet market".
 *
 * Pure helpers (backoffDelay, diffProducts) are exported for the tests.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var TICK_MIN_MS = 250;          /* coalesce ticks: at most one flush per product per interval */
  var STALE_MS = 20000;           /* no message at all for this long = reconnect */
  var WATCHDOG_MS = 5000;
  var BACKOFF_BASE_MS = 1000;
  var BACKOFF_CAP_MS = 30000;

  /* 1s, 2s, 4s ... capped at 30s, with ±20% jitter so many tabs do not
   * reconnect in lockstep. `rand` is injectable for the tests. */
  function backoffDelay(attempt, rand) {
    var r = typeof rand === 'function' ? rand() : Math.random();
    var base = Math.min(BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt | 0)), BACKOFF_CAP_MS);
    return Math.round(base * (0.8 + 0.4 * r));
  }

  function diffProducts(prev, next) {
    prev = prev || []; next = next || [];
    return {
      add: next.filter(function (p) { return prev.indexOf(p) < 0; }),
      remove: prev.filter(function (p) { return next.indexOf(p) < 0; })
    };
  }

  function unique(list) {
    var out = [];
    (list || []).forEach(function (p) { if (p && out.indexOf(p) < 0) out.push(p); });
    return out;
  }

  /* ---- connection state --------------------------------------------------- */
  var st = {
    running: false,
    handlers: {},
    socket: null,
    connected: false,
    wanted: [],          /* what the page asked for */
    subscribed: [],      /* what is actually subscribed on the open socket */
    unsupported: [],     /* products Coinbase rejected this session */
    attempt: 0,
    reconnectTimer: null,
    watchdog: null,
    lastMessageAt: 0,
    pending: {},
    flushTimer: null
  };

  function SRC() { return MP.sources; }
  function hidden() { return !!(root.document && root.document.hidden); }
  function offline() { return !!(root.navigator && root.navigator.onLine === false); }

  function active() {
    return st.wanted.filter(function (p) { return st.unsupported.indexOf(p) < 0; });
  }

  function status() {
    return {
      connected: st.connected,
      products: st.subscribed.slice(),
      wanted: st.wanted.slice(),
      unsupported: st.unsupported.slice(),
      attempt: st.attempt
    };
  }

  function emitStatus() {
    if (typeof st.handlers.onStatus === 'function') {
      try { st.handlers.onStatus(status()); } catch (e) { /* a listener must not break the feed */ }
    }
  }

  function send(message) {
    if (!st.socket || st.socket.readyState !== 1) return false;
    try { st.socket.send(JSON.stringify(message)); return true; } catch (e) { return false; }
  }

  /* One subscribe per product: a rejected product fails alone. */
  function subscribe(products) {
    products.forEach(function (p) { send(SRC().coinbaseWs.subscribeMessage([p])); });
  }

  function unsubscribe(products) {
    products.forEach(function (p) { send(SRC().coinbaseWs.unsubscribeMessage([p])); });
  }

  /* ---- messages ----------------------------------------------------------- */
  function flush() {
    st.flushTimer = null;
    var batch = st.pending;
    st.pending = {};
    if (typeof st.handlers.onTick !== 'function') return;
    Object.keys(batch).forEach(function (product) {
      try { st.handlers.onTick(product, batch[product]); } catch (e) { /* keep ticking */ }
    });
  }

  function handle(raw) {
    var cb = SRC().coinbaseWs;
    var msg;
    try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'error') {
      var bad = cb.productIn(cb.errorReason(msg));
      if (bad && st.unsupported.indexOf(bad) < 0) {
        st.unsupported.push(bad);
        st.subscribed = active();
        emitStatus();
      }
      return;
    }

    var tick = cb.normalizeTicker(msg);
    if (!tick) return;
    st.pending[tick.product] = tick;
    if (!st.flushTimer) st.flushTimer = setTimeout(flush, TICK_MIN_MS);
  }

  /* ---- lifecycle ---------------------------------------------------------- */
  function clearWatchdog() {
    if (st.watchdog) clearInterval(st.watchdog);
    st.watchdog = null;
  }

  function armWatchdog() {
    clearWatchdog();
    st.watchdog = setInterval(function () {
      if (st.socket && Date.now() - st.lastMessageAt > STALE_MS) {
        try { st.socket.close(); } catch (e) { /* already gone */ }
      }
    }, WATCHDOG_MS);
  }

  function scheduleReconnect() {
    if (st.reconnectTimer || !st.running) return;
    var delay = backoffDelay(st.attempt);
    st.attempt += 1;
    st.reconnectTimer = setTimeout(function () {
      st.reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (!st.running || st.socket || hidden() || offline()) return;
    if (!active().length || typeof root.WebSocket !== 'function') return;

    var ws;
    try { ws = new root.WebSocket(SRC().COINBASE_WS); } catch (e) { scheduleReconnect(); return; }
    st.socket = ws;

    ws.onopen = function () {
      if (st.socket !== ws) return;
      st.connected = true;
      st.attempt = 0;
      st.lastMessageAt = Date.now();
      /* Coinbase drops a socket that has not subscribed within five seconds. */
      subscribe(active());
      st.subscribed = active();
      armWatchdog();
      emitStatus();
    };
    ws.onmessage = function (ev) {
      if (st.socket !== ws) return;
      st.lastMessageAt = Date.now();
      handle(ev.data);
    };
    ws.onerror = function () { /* the close that follows does the work */ };
    ws.onclose = function () {
      if (st.socket !== ws) return;
      st.socket = null;
      st.connected = false;
      st.subscribed = [];
      clearWatchdog();
      emitStatus();
      if (st.running && !hidden() && !offline()) scheduleReconnect();
    };
  }

  function disconnect() {
    if (st.reconnectTimer) clearTimeout(st.reconnectTimer);
    st.reconnectTimer = null;
    clearWatchdog();
    if (st.socket) {
      var s = st.socket;
      st.socket = null;
      s.onopen = s.onmessage = s.onerror = s.onclose = null;
      try { s.close(); } catch (e) { /* already gone */ }
    }
    st.connected = false;
    st.subscribed = [];
  }

  function onVisibility() {
    if (hidden()) { disconnect(); emitStatus(); }
    else if (st.running) { st.attempt = 0; connect(); }
  }
  function onOnline() { if (st.running) { st.attempt = 0; connect(); } }
  function onOffline() { disconnect(); emitStatus(); }

  /* The page's current wish list. Idempotent; diffs against the open socket. */
  function setProducts(list) {
    var next = unique(list);
    var diff = diffProducts(st.wanted, next);
    st.wanted = next;
    if (st.socket && st.connected) {
      unsubscribe(diff.remove);
      subscribe(diff.add.filter(function (p) { return st.unsupported.indexOf(p) < 0; }));
      st.subscribed = active();
    } else if (st.running && !st.socket) {
      connect();
    }
    if (st.socket && !active().length) disconnect();
    emitStatus();
  }

  function start(handlers) {
    st.handlers = handlers || {};
    if (st.running) return;
    st.running = true;
    if (root.document && root.document.addEventListener) {
      root.document.addEventListener('visibilitychange', onVisibility);
    }
    if (root.addEventListener) {
      root.addEventListener('online', onOnline);
      root.addEventListener('offline', onOffline);
    }
    connect();
  }

  function stop() {
    st.running = false;
    if (root.document && root.document.removeEventListener) {
      root.document.removeEventListener('visibilitychange', onVisibility);
    }
    if (root.removeEventListener) {
      root.removeEventListener('online', onOnline);
      root.removeEventListener('offline', onOffline);
    }
    if (st.flushTimer) clearTimeout(st.flushTimer);
    st.flushTimer = null;
    st.pending = {};
    disconnect();
    emitStatus();
  }

  MP.live = {
    TICK_MIN_MS: TICK_MIN_MS,
    STALE_MS: STALE_MS,
    backoffDelay: backoffDelay,
    diffProducts: diffProducts,
    start: start,
    stop: stop,
    setProducts: setProducts,
    status: status,
    handle: handle          /* exposed for the tests: feed a canned frame */
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
