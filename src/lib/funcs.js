/* ============================================================================
 * funcs.js — the instrument functions a real meter has: REL and MIN/MAX.
 *
 * REL (relative) zeroes the reading where it stands: from then on the change
 * line shows the move since that reference instead of the day's or range's.
 * MIN/MAX captures the lowest and highest value seen while it is switched
 * on. Both are per stop, live in memory only, and never touch app state:
 * decorate() returns a copy of a reading with the function applied.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  var refs = {};      /* stop -> reference value */
  var captures = {};  /* stop -> { min, max, n } */
  var shown = {};     /* stop -> MIN/MAX switched on */

  var rel = {
    set: function (stop, value) { if (isNum(value)) refs[stop] = value; },
    clear: function (stop) { delete refs[stop]; },
    get: function (stop) { return Object.prototype.hasOwnProperty.call(refs, stop) ? refs[stop] : null; },
    /* Press: on when off (if there is a value to hold), off when on. */
    toggle: function (stop, value) {
      if (Object.prototype.hasOwnProperty.call(refs, stop)) { delete refs[stop]; return false; }
      if (!isNum(value)) return false;
      refs[stop] = value;
      return true;
    }
  };

  var minmax = {
    track: function (stop, value) {
      if (!isNum(value) || !shown[stop]) return;
      var c = captures[stop];
      if (!c) { captures[stop] = { min: value, max: value, n: 1 }; return; }
      if (value < c.min) c.min = value;
      if (value > c.max) c.max = value;
      c.n += 1;
    },
    get: function (stop) {
      var c = captures[stop];
      return c ? { min: c.min, max: c.max, n: c.n } : null;
    },
    reset: function (stop) { delete captures[stop]; },
    show: function (stop, on) { shown[stop] = !!on; },
    isShown: function (stop) { return !!shown[stop]; }
  };

  /* A reading with REL and MIN/MAX applied. Prices (USD, INDEX) get a percent
   * and an absolute move since the reference; statistics get a plain delta
   * in their own units. */
  function decorate(r, stop) {
    var out = {};
    Object.keys(r).forEach(function (k) { out[k] = r[k]; });
    out.change = r.change ? Object.assign({}, r.change) : null;

    var ref = rel.get(stop);
    if (ref !== null && isNum(r.value)) {
      var priceLike = r.unit === 'USD' || r.unit === 'INDEX';
      out.change = {
        pct: priceLike && ref !== 0 ? (r.value / ref - 1) * 100 : NaN,
        abs: priceLike ? r.value - ref : NaN,
        delta: priceLike ? NaN : r.value - ref,
        suffix: r.unit === '%' ? '%' : '',
        label: 'REL',
        dp: isNum(r.dp) ? r.dp : 2
      };
      out.rel = true;
    }
    out.minmax = minmax.isShown(stop) ? minmax.get(stop) : null;
    return out;
  }

  function reset() { refs = {}; captures = {}; shown = {}; }

  MP.funcs = { rel: rel, minmax: minmax, decorate: decorate, reset: reset };
})(typeof globalThis !== 'undefined' ? globalThis : this);
