/* ============================================================================
 * watch.js: the WATCH stop's list: up to eight Nasdaq-100 stocks the viewer
 * picks from the data job's list.
 *
 * Pure helpers, plus the two calls that touch storage. The list holds
 * tickers only; names, closes and changes come from data/stocks.json and each
 * member's data/stocks/SYM.json.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var MAX = 8;
  var KEY = 'watch';
  var SEARCH_LIMIT = 8;

  function clean(sym) {
    return typeof sym === 'string' ? sym.trim().toUpperCase() : '';
  }

  function valid(sym) {
    return !!sym && !!(MP.sources && MP.sources.stockPath(sym));
  }

  /* Whatever was stored -> a clean list: tickers only, no repeats, at most MAX. */
  function read(v) {
    var out = [];
    (Array.isArray(v) ? v : []).forEach(function (s) {
      var sym = clean(s);
      if (valid(sym) && out.indexOf(sym) < 0 && out.length < MAX) out.push(sym);
    });
    return out;
  }

  /* A new list with `sym` at the end; unchanged when it is there already,
   * not a ticker, or the list is full. */
  function add(list, sym) {
    var s = clean(sym), cur = read(list);
    if (!valid(s) || cur.indexOf(s) >= 0 || cur.length >= MAX) return cur;
    return cur.concat([s]);
  }

  function remove(list, sym) {
    var s = clean(sym);
    return read(list).filter(function (x) { return x !== s; });
  }

  /* rows: stocks.json rows. The exact ticker first, then other tickers that
   * start with the query, then names that contain it, each group by ticker. */
  function search(rows, query, limit) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    var head = [], rest = [];
    (rows || []).forEach(function (r) {
      if (!r || typeof r.symbol !== 'string') return;
      var sym = r.symbol.toLowerCase(), name = String(r.name || '').toLowerCase();
      if (sym.indexOf(q) === 0) head.push(r);
      else if (name.indexOf(q) >= 0) rest.push(r);
    });
    function bySymbol(a, b) { return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; }
    head.sort(function (a, b) {
      var ea = a.symbol.toLowerCase() === q, eb = b.symbol.toLowerCase() === q;
      if (ea !== eb) return ea ? -1 : 1;
      return bySymbol(a, b);
    });
    return head.concat(rest.sort(bySymbol)).slice(0, limit || SEARCH_LIMIT);
  }

  function load() { return read(MP.store ? MP.store.get(KEY, []) : []); }

  function save(list) {
    var c = read(list);
    if (MP.store) MP.store.set(KEY, c);
    return c;
  }

  MP.watch = { MAX: MAX, KEY: KEY, read: read, add: add, remove: remove, search: search, load: load, save: save };
})(typeof globalThis !== 'undefined' ? globalThis : this);
