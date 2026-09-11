/* ============================================================================
 * store.js: the one place the page touches localStorage.
 *
 * Everything the viewer sets up for themselves (alerts, the probe coin, the
 * statistics pair) lives in this browser only. Storage can be missing,
 * full, or throw on access (Safari's private mode does), so every call is
 * guarded and a failure simply reads as "nothing saved".
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var PREFIX = 'mm.';

  function storage() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }

  function get(key, fallback) {
    var s = storage();
    if (!s) return fallback;
    try {
      var raw = s.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function set(key, value) {
    var s = storage();
    if (!s) return false;
    try { s.setItem(PREFIX + key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  function remove(key) {
    var s = storage();
    if (!s) return;
    try { s.removeItem(PREFIX + key); } catch (e) { /* nothing to remove */ }
  }

  MP.store = { PREFIX: PREFIX, get: get, set: set, remove: remove };
})(typeof globalThis !== 'undefined' ? globalThis : this);
