/* ============================================================================
 * alerts.js: the continuity beep: a level on any stop that sounds when it is
 * crossed.
 *
 * An alert is { id, stop, level, dir, unit, created, fired }. The direction
 * is inferred when it is set: a level above the current reading fires when
 * the value reaches it from below, and the other way round. Alerts live in
 * this browser (MP.store) and are evaluated on every repaint, so they fire
 * only while the page is open. evaluate() is pure and returns copies.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var KEY = 'alerts';

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  /* An alert on a stop the dial no longer has (STOCK and CRYPTO became
   * MOVER and LOSER) is dropped when the list loads. */
  function live(stop) {
    var views = MP.router && MP.router.VIEWS;
    return !views || views.indexOf(stop) >= 0;
  }

  function valid(a) {
    return a && typeof a === 'object' && typeof a.id === 'string' && typeof a.stop === 'string' &&
      isNum(a.level) && (a.dir === 'above' || a.dir === 'below') && live(a.stop);
  }

  var list = null;   /* loaded lazily, then kept in memory */

  function all() {
    if (list === null) {
      var raw = MP.store ? MP.store.get(KEY, []) : [];
      list = Array.isArray(raw) ? raw.filter(valid) : [];
    }
    return list;
  }

  function save(next) {
    list = (next || []).filter(valid);
    if (MP.store) MP.store.set(KEY, list);
    return list;
  }

  function infer(level, current) {
    return isNum(current) && level <= current ? 'below' : 'above';
  }

  /* Pure: which of `alerts` for `stop` are crossed by `value`. Fired alerts
   * and other stops pass through untouched; the result is a new array. */
  function evaluate(alerts, stop, value, now) {
    var fired = [];
    var next = (alerts || []).map(function (a) {
      if (!valid(a) || a.stop !== stop || a.fired || !isNum(value)) return a;
      var hit = a.dir === 'above' ? value >= a.level : value <= a.level;
      if (!hit) return a;
      var f = Object.assign({}, a, { fired: now || Date.now(), firedAt: value });
      fired.push(f);
      return f;
    });
    return { alerts: next, fired: fired };
  }

  function newId() {
    return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function add(stop, level, current, unit) {
    if (!isNum(level)) return null;
    var a = { id: newId(), stop: stop, level: level, dir: infer(level, current), unit: unit || '', created: Date.now(), fired: null };
    save(all().concat([a]));
    return a;
  }

  function remove(id) {
    save(all().filter(function (a) { return a.id !== id; }));
  }

  function forStop(stop) {
    return all().filter(function (a) { return a.stop === stop; });
  }

  function armed() {
    return all().filter(function (a) { return !a.fired; });
  }

  function armedStops() {
    var out = [];
    armed().forEach(function (a) { if (out.indexOf(a.stop) < 0) out.push(a.stop); });
    return out;
  }

  function count() { return armed().length; }

  /* "Bitcoin above $80,000.00". fmt(stop, level) formats the level. */
  function describe(a, fmt) {
    var title = MP.router && MP.router.TITLES && MP.router.TITLES[a.stop] ? MP.router.TITLES[a.stop] : a.stop;
    var level = typeof fmt === 'function' ? fmt(a.stop, a.level) : String(a.level);
    return title + ' ' + a.dir + ' ' + level;
  }

  MP.alerts = {
    KEY: KEY,
    all: all,
    save: save,
    infer: infer,
    evaluate: evaluate,
    add: add,
    remove: remove,
    forStop: forStop,
    armed: armed,
    armedStops: armedStops,
    count: count,
    describe: describe,
    /* tests only: forget the in-memory list so the next all() reloads */
    _reset: function () { list = null; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
