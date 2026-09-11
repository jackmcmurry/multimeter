/* ============================================================================
 * session.js: the US equity session clock, computed locally.
 *
 * Replaces the Alpha Vantage MARKET_STATUS call: regular NYSE / Nasdaq hours
 * are 09:30–16:00 America/New_York on weekdays that are not exchange
 * holidays, with 13:00 early closes on a few half days. Pure functions over a
 * timestamp, so the page and the data job agree on what "open" means.
 *
 * The holiday table is explicit and runs through 2027. Past its end every
 * weekday counts as a session, which errs toward "open" on an unlisted
 * holiday rather than hiding a real session. Extend HOLIDAYS each year.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var TZ = 'America/New_York';
  var OPEN_MIN = 9 * 60 + 30;
  var CLOSE_MIN = 16 * 60;
  var EARLY_CLOSE_MIN = 13 * 60;

  /* NYSE full-day closures (observed dates). */
  var HOLIDAYS = {
    '2026-01-01': 1, '2026-01-19': 1, '2026-02-16': 1, '2026-04-03': 1,
    '2026-05-25': 1, '2026-06-19': 1, '2026-07-03': 1, '2026-09-07': 1,
    '2026-11-26': 1, '2026-12-25': 1,
    '2027-01-01': 1, '2027-01-18': 1, '2027-02-15': 1, '2027-03-26': 1,
    '2027-05-31': 1, '2027-06-18': 1, '2027-07-05': 1, '2027-09-06': 1,
    '2027-11-25': 1, '2027-12-24': 1
  };

  /* 13:00 ET closes. */
  var EARLY_CLOSES = { '2026-11-27': 1, '2026-12-24': 1, '2027-11-26': 1 };

  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  var formatter = null;
  function nyFormatter() {
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23'
      });
    }
    return formatter;
  }

  /* New York wall-clock parts for a timestamp. */
  function nyParts(ts) {
    var out = {};
    nyFormatter().formatToParts(new Date(ts)).forEach(function (p) { out[p.type] = p.value; });
    var hour = parseInt(out.hour, 10) % 24;   /* some engines render midnight as 24 */
    return {
      date: out.year + '-' + out.month + '-' + out.day,
      weekday: out.weekday,
      minutes: hour * 60 + parseInt(out.minute, 10)
    };
  }

  function weekdayOf(date) {
    return WEEKDAYS[new Date(date + 'T12:00:00Z').getUTCDay()];
  }

  function prevDate(date) {
    var d = new Date(date + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  function isWeekend(weekday) { return weekday === 'Sat' || weekday === 'Sun'; }

  function isSessionDay(date) { return !isWeekend(weekdayOf(date)) && !HOLIDAYS[date]; }

  function closeMinutes(date) { return EARLY_CLOSES[date] ? EARLY_CLOSE_MIN : CLOSE_MIN; }

  /* { open, phase: 'open' | 'pre' | 'post' | 'weekend' | 'holiday', date } */
  function status(ts) {
    var p = nyParts(ts);
    if (isWeekend(p.weekday)) return { open: false, phase: 'weekend', date: p.date };
    if (HOLIDAYS[p.date]) return { open: false, phase: 'holiday', date: p.date };
    var close = closeMinutes(p.date);
    if (p.minutes < OPEN_MIN) return { open: false, phase: 'pre', date: p.date };
    if (p.minutes >= close) return { open: false, phase: 'post', date: p.date };
    return { open: true, phase: 'open', date: p.date };
  }

  /* Most recent session whose close is at least `graceMin` minutes past, as
   * YYYY-MM-DD. The data job uses it to know which daily close should exist
   * by now, and whether a stored quote is already that session's final one. */
  function lastCompletedSession(ts, graceMin) {
    var p = nyParts(ts);
    var date = p.date;
    if (!(isSessionDay(date) && p.minutes >= closeMinutes(date) + (graceMin || 0))) {
      date = prevDate(date);
    }
    for (var i = 0; i < 14; i++) {
      if (isSessionDay(date)) return date;
      date = prevDate(date);
    }
    return date;
  }

  /* The session before `day` (YYYY-MM-DD), skipping weekends and holidays.
   * `day` itself need not be a session. */
  function sessionBefore(day) {
    var date = prevDate(day);
    for (var i = 0; i < 14; i++) {
      if (isSessionDay(date)) return date;
      date = prevDate(date);
    }
    return date;
  }

  MP.session = {
    TZ: TZ,
    HOLIDAYS: HOLIDAYS,
    EARLY_CLOSES: EARLY_CLOSES,
    nyParts: nyParts,
    weekdayOf: weekdayOf,
    isSessionDay: isSessionDay,
    status: status,
    lastCompletedSession: lastCompletedSession,
    sessionBefore: sessionBefore
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
