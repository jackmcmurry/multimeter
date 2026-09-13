/* ============================================================================
 * search.js: one instrument search, used wherever the meter asks "which
 * instrument?": the DATA key, the watch list's ADD, and anything later.
 *
 * Pure. It builds an index from what the page already holds (the two
 * indexes, the live coins, the crypto universe, the Nasdaq-100 rows from the
 * data job) and ranks a query against it. Coins the page has never heard of
 * arrive separately from CoinGecko's own search and are merged in by the
 * caller, so this module never fetches anything itself.
 *
 * route() says what selecting an entry should do, in terms of dial stops the
 * meter already has. Nothing here renders.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var LIMIT = 7;   /* rows the screen can show without scrolling */

  /* The fixed part of the index: the stops that are instruments in their own
   * right. Coins and stocks are added from live data by build(). */
  var BUILT_IN = [
    { kind: 'index', symbol: '^IXIC', name: 'Nasdaq Composite', stop: 'nasdaq' },
    { kind: 'index', symbol: '^GSPC', name: 'S&P 500', stop: 'spx' },
    { kind: 'coin', symbol: 'BTC', name: 'Bitcoin', id: 'bitcoin', stop: 'btc' },
    { kind: 'coin', symbol: 'ETH', name: 'Ether', id: 'ethereum', stop: 'eth' }
  ];

  function clean(s) { return String(s || '').trim().toLowerCase(); }

  /* opts: { stocks: [rows from stocks.json], coins: [{id,symbol,name}],
   * remote: [coin search results] }. Later entries never displace earlier
   * ones with the same symbol, so the built-in stops always win. */
  function build(opts) {
    opts = opts || {};
    var out = [], seen = {};
    function push(e) {
      if (!e || !e.symbol) return;
      var key = e.kind + ':' + e.symbol.toUpperCase();
      if (seen[key]) return;
      seen[key] = 1;
      out.push(e);
    }
    BUILT_IN.forEach(push);
    (opts.coins || []).forEach(function (c) {
      push({ kind: 'coin', symbol: String(c.symbol || '').toUpperCase(), name: c.name || c.symbol, id: c.id });
    });
    (opts.stocks || []).forEach(function (r) {
      push({ kind: 'stock', symbol: r.symbol, name: r.name || r.symbol, close: r.close, change1d: r.change1d });
    });
    (opts.remote || []).forEach(function (c) {
      push({ kind: 'coin', symbol: String(c.symbol || '').toUpperCase(), name: c.name || c.symbol, id: c.id, remote: true });
    });
    return out;
  }

  /* 0 is the best match. An exact ticker beats a ticker that starts with the
   * query, which beats a name that starts with it, which beats a name that
   * merely contains it. Anything else is not a match. */
  function rank(entry, q) {
    if (entry.kind === 'stock' && clean(entry.name).split(' / ')[0] === q) return 0;
    var sym = clean(entry.symbol), name = clean(entry.name);
    if (sym === q) return 0;
    if (sym.indexOf(q) === 0) return 1;
    if (name.indexOf(q) === 0) return 2;
    if (name.indexOf(q) >= 0) return 3;
    if (sym.indexOf(q) > 0) return 4;
    return -1;
  }

  /* An empty query gives the shortlist a student starts from: the indexes and
   * the live coins, then whatever the caller passed as recent. */
  function query(index, q, limit) {
    var text = clean(q);
    limit = limit || LIMIT;
    if (!text) return (index || []).slice(0, limit);
    var hits = [];
    (index || []).forEach(function (e) {
      var r = rank(e, text);
      if (r >= 0) hits.push({ e: e, r: r });
    });
    hits.sort(function (a, b) {
      if (a.r !== b.r) return a.r - b.r;
      if (a.e.kind === 'stock' && b.e.remote) return -1;
      if (b.e.kind === 'stock' && a.e.remote) return 1;
      return a.e.symbol < b.e.symbol ? -1 : a.e.symbol > b.e.symbol ? 1 : 0;
    });
    return hits.slice(0, limit).map(function (h) { return h.e; });
  }

  /* What selecting an entry means, in stops the meter already has:
   *   index            -> its own stop
   *   bitcoin, ether   -> their own stops
   *   any other coin   -> the coin stop, with the pick set
   *   stock            -> the watch list, added if it is not on it
   * Returns null for an entry the meter cannot show. */
  function route(entry) {
    if (!entry || !entry.symbol) return null;
    if (entry.kind === 'index' || entry.stop) return { stop: entry.stop, action: 'go' };
    if (entry.kind === 'coin') return { stop: 'probe', action: 'setCoin', coin: { id: entry.id, symbol: entry.symbol, name: entry.name } };
    if (entry.kind === 'stock') return { stop: 'watch', action: 'watch', symbol: entry.symbol };
    return null;
  }

  MP.search = { LIMIT: LIMIT, BUILT_IN: BUILT_IN, build: build, query: query, rank: rank, route: route };
})(typeof globalThis !== 'undefined' ? globalThis : this);
