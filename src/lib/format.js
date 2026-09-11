/* ============================================================================
 * format.js — display formatting. Pure functions, no DOM.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var DASH = '—';

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  function usd(n, dp) {
    if (!isNum(n)) return DASH;
    dp = dp === undefined ? 2 : dp;
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD',
      minimumFractionDigits: dp, maximumFractionDigits: dp
    }).format(n);
  }

  function num(n, dp) {
    if (!isNum(n)) return DASH;
    dp = dp === undefined ? 2 : dp;
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: dp, maximumFractionDigits: dp
    }).format(n);
  }

  function compact(n) {
    if (!isNum(n)) return DASH;
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
  }

  /* 0.0234 -> "2.34%" */
  function pct(fraction, dp) {
    if (!isNum(fraction)) return DASH;
    dp = dp === undefined ? 2 : dp;
    return (fraction * 100).toFixed(dp) + '%';
  }

  /* 0.0234 -> "+2.34%", -0.0234 -> "-2.34%" */
  function signedPct(fraction, dp) {
    if (!isNum(fraction)) return DASH;
    dp = dp === undefined ? 2 : dp;
    var v = fraction * 100;
    return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(dp) + '%';
  }

  /* Already-a-percentage inputs (APIs that hand back 1.06 for 1.06%). */
  function signedPctPoints(points, dp) {
    if (!isNum(points)) return DASH;
    dp = dp === undefined ? 2 : dp;
    return (points >= 0 ? '+' : '−') + Math.abs(points).toFixed(dp) + '%';
  }

  function ratio(n, dp) {
    if (!isNum(n)) return DASH;
    dp = dp === undefined ? 2 : dp;
    return n.toFixed(dp);
  }

  /* '2026-09-10' -> '10 Sep 26' */
  function shortDate(iso) {
    if (!iso) return DASH;
    var parts = String(iso).slice(0, 10).split('-');
    if (parts.length !== 3) return String(iso);
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var mi = parseInt(parts[1], 10) - 1;
    if (mi < 0 || mi > 11) return String(iso);
    return parts[2] + ' ' + months[mi] + ' ' + parts[0].slice(2);
  }

  function clockTime(ts) {
    if (!isNum(ts)) return DASH;
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function ago(ts) {
    if (!isNum(ts)) return 'awaiting data';
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    var m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    return Math.round(m / 60) + 'h ago';
  }

  function days(n) {
    if (n === null || n === undefined || !isNum(n)) return DASH;
    return n + 'd';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  MP.fmt = {
    DASH: DASH,
    usd: usd,
    num: num,
    compact: compact,
    pct: pct,
    signedPct: signedPct,
    signedPctPoints: signedPctPoints,
    ratio: ratio,
    shortDate: shortDate,
    clockTime: clockTime,
    ago: ago,
    days: days,
    escapeHtml: escapeHtml
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
