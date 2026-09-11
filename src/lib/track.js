/* ============================================================================
 * track.js: counting, for user testing, in this browser only.
 *
 * No third party, no network, no identifiers, no personal data. Each event
 * is a name, an optional label drawn from a fixed list, and a count, kept in
 * localStorage so a tester can hand the numbers back deliberately through
 * the feedback note. Nothing leaves the machine on its own.
 *
 * The questions it exists to answer: which stops students actually use,
 * whether they open an explanation, whether they investigate, and whether
 * they come back a second day.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var KEY = 'usage';
  var MAX_KEYS = 60;          /* a small, bounded record */
  var DAY_MS = 86400000;

  /* Only these are recorded. Anything else is ignored, so a stray call can
   * never quietly start collecting something new. */
  var EVENTS = [
    'session_started',
    'dial_mode_changed',
    'drawer_opened',
    'concept_opened',
    'range_changed',
    'watch_added',
    'feedback_opened',
    'data_missing'
  ];

  var started = Date.now();

  function blank() {
    return { firstSeen: null, lastSeen: null, days: 0, sessions: 0, seconds: 0, events: {} };
  }

  function read() {
    var v = MP.store ? MP.store.get(KEY, null) : null;
    if (!v || typeof v !== 'object' || !v.events) return blank();
    return v;
  }

  function write(v) {
    if (MP.store) MP.store.set(KEY, v);
    return v;
  }

  /* A label keeps an event readable ('dial_mode_changed:vol') without ever
   * holding free text. */
  function slug(label) {
    return String(label || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16);
  }

  function event(name, label) {
    if (EVENTS.indexOf(name) < 0) return null;
    var v = read();
    var k = label ? name + ':' + slug(label) : name;
    if (!v.events[k] && Object.keys(v.events).length >= MAX_KEYS) return v;
    v.events[k] = (v.events[k] || 0) + 1;
    v.lastSeen = Date.now();
    return write(v);
  }

  /* Called once a session: counts the visit, and counts a new day only when
   * the calendar day differs from the last visit. */
  function startSession() {
    var v = read(), now = Date.now();
    var newDay = !v.lastSeen || Math.floor(now / DAY_MS) !== Math.floor(v.lastSeen / DAY_MS);
    v.firstSeen = v.firstSeen || now;
    v.sessions = (v.sessions || 0) + 1;
    if (newDay) v.days = (v.days || 0) + 1;
    v.lastSeen = now;
    write(v);
    event('session_started');
    return v;
  }

  /* Time on the page, added when the tab is hidden or closed. */
  function addTime() {
    var v = read();
    v.seconds = Math.round((v.seconds || 0) + (Date.now() - started) / 1000);
    started = Date.now();
    write(v);
  }

  function summary() {
    var v = read();
    return {
      sessions: v.sessions || 0,
      days: v.days || 0,
      minutes: Math.round((v.seconds || 0) / 60),
      firstSeen: v.firstSeen ? new Date(v.firstSeen).toISOString().slice(0, 10) : null,
      events: v.events || {}
    };
  }

  /* What a tester pastes into the feedback note, by choice. */
  function report() {
    var s = summary();
    var lines = Object.keys(s.events).sort().map(function (k) { return k + ' ' + s.events[k]; });
    return 'visits ' + s.sessions + ' over ' + s.days + ' day(s), about ' + s.minutes + ' minute(s)\n' + lines.join('\n');
  }

  function reset() { if (MP.store) MP.store.remove(KEY); }

  function start() {
    startSession();
    if (root.document && root.document.addEventListener) {
      root.document.addEventListener('visibilitychange', function () {
        if (root.document.hidden) addTime();
      });
    }
    if (root.addEventListener) root.addEventListener('pagehide', addTime);
  }

  MP.track = { KEY: KEY, EVENTS: EVENTS, event: event, start: start, summary: summary, report: report, reset: reset };
})(typeof globalThis !== 'undefined' ? globalThis : this);
