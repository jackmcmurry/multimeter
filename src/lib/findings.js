/* ============================================================================
 * findings.js: the running answer to "is bitcoin a tech stock?"
 *
 * Pure: daily closes in, one findings object out, computed by the data job
 * from the same history the meter's statistics use and published as
 * data/findings.json for the write-up page. Everything here is descriptive:
 * regimes are conventional thresholds on a rolling correlation, "breaks" are
 * the largest falls in it, and narrative() turns the numbers into sentences
 * with nothing added: no causes, no forecasts. Numbers are rounded here so
 * the file is small and the browser and Node agree to the digit.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});
  var S = MP.stats;

  var WINDOWS = [30, 90, 252];
  var ROLL = 90;                   /* the rolling-correlation window */
  var BREAK_SPAN = 20;             /* sessions over which a "break" is measured */
  var MIN_SESSIONS = ROLL + 2;
  var VOL_WINDOW = 30;
  var ANNUALIZE = 252;
  var VOL_POINTS = 120;
  var SCATTER_SESSIONS = 90;
  var MAX_POINTS = 400;
  var COUPLED = 0.5;               /* correlation above this: coupled */
  var DECOUPLED = 0.2;             /* below this: decoupled */

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function r4(v) { return isNum(v) ? Math.round(v * 1e4) / 1e4 : null; }
  function r3(v) { return isNum(v) ? Math.round(v * 1e3) / 1e3 : null; }
  function values(entries) { return entries.map(function (e) { return e.value; }); }
  function last(list) { return list.length ? list[list.length - 1] : null; }

  /* Keeps at most `max` points, always including the last one. */
  function thin(list, max) {
    if (list.length <= max) return list;
    var step = Math.ceil(list.length / max), out = [];
    for (var i = 0; i < list.length; i += step) out.push(list[i]);
    if (out[out.length - 1] !== list[list.length - 1]) out.push(list[list.length - 1]);
    return out;
  }

  /* The longest run of consecutive points satisfying `test`. */
  function longestRun(roll, test) {
    var best = null, start = -1;
    for (var i = 0; i <= roll.length; i++) {
      var on = i < roll.length && isNum(roll[i].value) && test(roll[i].value);
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        var len = i - start;
        if (!best || len > best.sessions) best = { from: roll[start].date, to: roll[i - 1].date, sessions: len };
        start = -1;
      }
    }
    return best;
  }

  function regimes(roll) {
    var n = 0, coupled = 0, decoupled = 0;
    for (var i = 0; i < roll.length; i++) {
      var v = roll[i].value;
      if (!isNum(v)) continue;
      n += 1;
      if (v > COUPLED) coupled += 1;
      else if (v < DECOUPLED) decoupled += 1;
    }
    var lastValue = roll.length ? roll[roll.length - 1].value : null;
    return {
      coupledShare: n ? r4(coupled / n) : null,
      decoupledShare: n ? r4(decoupled / n) : null,
      middleShare: n ? r4((n - coupled - decoupled) / n) : null,
      current: !isNum(lastValue) ? null : lastValue > COUPLED ? 'coupled' : lastValue < DECOUPLED ? 'decoupled' : 'middle',
      longestCoupled: longestRun(roll, function (v) { return v > COUPLED; }),
      longestDecoupled: longestRun(roll, function (v) { return v < DECOUPLED; })
    };
  }

  /* The three largest falls in the rolling correlation over BREAK_SPAN
   * sessions, greedy and non-overlapping. */
  function breaks(roll) {
    var cands = [];
    for (var i = BREAK_SPAN; i < roll.length; i++) {
      var a = roll[i - BREAK_SPAN].value, b = roll[i].value;
      if (!isNum(a) || !isNum(b)) continue;
      var drop = a - b;
      if (drop > 0) cands.push({ i: i, from: roll[i - BREAK_SPAN].date, to: roll[i].date, before: r4(a), after: r4(b), drop: r4(drop) });
    }
    cands.sort(function (p, q) { return q.drop - p.drop; });
    var out = [], taken = [];
    for (var k = 0; k < cands.length && out.length < 3; k++) {
      var c = cands[k], clash = false;
      for (var t = 0; t < taken.length; t++) if (Math.abs(taken[t] - c.i) < BREAK_SPAN) { clash = true; break; }
      if (clash) continue;
      taken.push(c.i);
      out.push({ from: c.from, to: c.to, before: c.before, after: c.after, drop: c.drop });
    }
    return out;
  }

  /* Share of sessions on which both legs moved the same way. */
  function agreement(rb, ri, count) {
    var a = S.tail(rb, count), b = S.tail(ri, count);
    var n = Math.min(a.length, b.length), same = 0, used = 0;
    for (var i = 0; i < n; i++) {
      if (!isNum(a[i]) || !isNum(b[i]) || a[i] === 0 || b[i] === 0) continue;
      used += 1;
      if ((a[i] > 0) === (b[i] > 0)) same += 1;
    }
    return used ? r4(same / used) : null;
  }

  function pairBlock(coin, index) {
    if (!coin || !index) return null;
    var pair = S.alignByDate(coin, index);
    if (pair.dates.length < MIN_SESSIONS) return null;

    var rb = S.logReturns(pair.a), ri = S.logReturns(pair.b);
    var retDates = pair.dates.slice(1);
    var rollFull = S.rollingPair(rb, ri, ROLL, S.pearson).map(function (e) {
      return { date: retDates[e.index], value: r4(e.value) };
    });

    var volFn = function (w) { return S.annualizedVol(w, ANNUALIZE); };
    var bv = S.rolling(rb, VOL_WINDOW, volFn), iv = S.rolling(ri, VOL_WINDOW, volFn);
    var bvLast = last(bv), ivLast = last(iv);
    var bvYear = S.mean(values(S.tail(bv, 252))), ivYear = S.mean(values(S.tail(iv, 252)));
    var bvTail = S.tail(bv, VOL_POINTS), ivTail = S.tail(iv, VOL_POINTS);

    var sc = S.pairwiseClean(S.tail(ri, SCATTER_SESSIONS), S.tail(rb, SCATTER_SESSIONS));
    var fit = S.regression(sc.a, sc.b);

    return {
      sessions: pair.dates.length,
      from: pair.dates[0],
      to: pair.dates[pair.dates.length - 1],
      coupling: S.couplingWindows(rb, ri, WINDOWS).map(function (c) {
        return { window: c.window, n: c.n, correlation: r4(c.correlation), beta: r4(c.beta), r2: r4(c.r2) };
      }),
      rolling90: thin(rollFull, MAX_POINTS),
      regimes: regimes(rollFull),
      breaks: breaks(rollFull),
      agreement: { all: agreement(rb, ri, rb.length), last252: agreement(rb, ri, 252) },
      vol: {
        coin: bvLast ? r4(bvLast.value) : null,
        index: ivLast ? r4(ivLast.value) : null,
        ratio: bvLast && ivLast && ivLast.value ? r3(bvLast.value / ivLast.value) : null,
        coinYear: r4(bvYear),
        indexYear: r4(ivYear),
        series: {
          dates: bvTail.map(function (e) { return retDates[e.index]; }),
          coin: values(bvTail).map(r3),
          index: values(ivTail).map(r3)
        }
      },
      scatter: {
        xs: sc.a.map(r4),
        ys: sc.b.map(r4),
        fit: { slope: r4(fit.slope), intercept: r4(fit.intercept), r2: r4(fit.r2), n: fit.n }
      }
    };
  }

  function drawdownBlock(series, minDepth) {
    if (!series || series.length < 2) return null;
    var sorted = S.sortSeries(series);
    var prices = sorted.map(function (p) { return p.price; });
    var dates = sorted.map(function (p) { return p.date; });
    var dd = S.drawdownSeries(prices);
    var eps = S.drawdownEpisodes(dates, prices, { minDepth: minDepth, limit: 6 });
    var recovered = eps.filter(function (e) { return !e.ongoing; });
    var longest = 0;
    recovered.forEach(function (e) { if (isNum(e.recoveryDays) && e.recoveryDays > longest) longest = e.recoveryDays; });
    var deepest = eps[0] || null;
    return {
      now: r4(dd[dd.length - 1]),
      max: r4(S.maxDrawdown(prices)),
      episodes: eps.length,
      recovered: recovered.length,
      longestRecoveryDays: recovered.length ? longest : null,
      deepest: deepest ? {
        peakDate: deepest.peakDate, troughDate: deepest.troughDate, recoveryDate: deepest.recoveryDate || null,
        depth: r4(deepest.depth), declineDays: deepest.declineDays, recoveryDays: deepest.ongoing ? null : deepest.recoveryDays,
        ongoing: !!deepest.ongoing
      } : null
    };
  }

  /* history: { btc, ixic, spx } daily closes. Null until bitcoin and the
   * Nasdaq share at least MIN_SESSIONS dates. */
  function compute(history, now) {
    if (!history || !history.btc || !history.ixic) return null;
    var ixic = pairBlock(history.btc, history.ixic);
    if (!ixic) return null;
    var spx = history.spx ? pairBlock(history.btc, history.spx) : null;
    return {
      version: 1,
      computedAt: new Date(now === undefined ? Date.now() : now).toISOString(),
      asOf: ixic.to,
      from: ixic.from,
      to: ixic.to,
      sessions: ixic.sessions,
      primary: 'ixic',
      pairs: { ixic: ixic, spx: spx },
      drawdowns: {
        btc: drawdownBlock(history.btc, 0.05),
        ixic: drawdownBlock(history.ixic, 0.03),
        spx: history.spx ? drawdownBlock(history.spx, 0.03) : null
      }
    };
  }

  /* ---- words from the numbers ------------------------------------------- */
  function pct(v, dp) { return (v * 100).toFixed(dp === undefined ? 1 : dp) + '%'; }
  function day(iso) { return MP.fmt && MP.fmt.shortDate ? MP.fmt.shortDate(iso) : String(iso); }
  function windowAt(pair, w) {
    if (!pair) return null;
    for (var i = 0; i < pair.coupling.length; i++) if (pair.coupling[i].window === w) return pair.coupling[i];
    return null;
  }

  function label(f) {
    var cur = f && f.pairs && f.pairs.ixic ? f.pairs.ixic.regimes.current : null;
    return cur === 'coupled' ? 'coupled' : cur === 'decoupled' ? 'decoupled' : cur === 'middle' ? 'loosely coupled' : 'unknown';
  }

  /* Sentences built only from the findings; each is omitted when a number it
   * needs is missing. No causes, no forecasts. */
  function narrative(f) {
    var out = [];
    if (!f || !f.pairs || !f.pairs.ixic) return out;
    var p = f.pairs.ixic, q = f.pairs.spx;
    var c90 = windowAt(p, 90), c252 = windowAt(p, 252), s90 = windowAt(q, 90);

    if (c90 && isNum(c90.correlation)) {
      out.push('Over the ' + f.sessions + ' sessions to ' + day(f.to) + ', the correlation between bitcoin\'s daily returns and the Nasdaq Composite\'s was ' +
        c90.correlation.toFixed(2) + ' across the last 90 sessions' +
        (s90 && isNum(s90.correlation) ? ', and ' + s90.correlation.toFixed(2) + ' against the S&P 500' : '') + '.');
    }
    if (c252 && isNum(c252.beta) && isNum(c252.r2)) {
      out.push('Against the Nasdaq over ' + c252.n + ' sessions the beta is ' + c252.beta.toFixed(2) + ' with an R² of ' + c252.r2.toFixed(2) +
        ', so the index accounts for about ' + pct(c252.r2, 0) + ' of the variance in bitcoin\'s daily returns.');
    }
    var rg = p.regimes;
    if (rg && isNum(rg.coupledShare) && isNum(rg.decoupledShare)) {
      var s = 'The rolling 90-session correlation was above 0.5 on ' + pct(rg.coupledShare, 0) + ' of sessions and below 0.2 on ' + pct(rg.decoupledShare, 0);
      if (rg.longestCoupled) s += '; the longest coupled stretch ran ' + rg.longestCoupled.sessions + ' sessions, ' + day(rg.longestCoupled.from) + ' to ' + day(rg.longestCoupled.to);
      out.push(s + '.');
    }
    if (p.breaks && p.breaks.length) {
      var b = p.breaks[0];
      out.push('The sharpest fall in that correlation came in the 20 sessions to ' + day(b.to) + ', from ' + b.before.toFixed(2) + ' to ' + b.after.toFixed(2) + '.');
    }
    if (p.vol && isNum(p.vol.coin) && isNum(p.vol.index) && isNum(p.vol.ratio)) {
      out.push('Bitcoin\'s 30-session realized volatility is ' + pct(p.vol.coin, 0) + ' annualized against the Nasdaq\'s ' + pct(p.vol.index, 0) + ', a ratio of ' + p.vol.ratio.toFixed(1) + '×.');
    }
    var db = f.drawdowns && f.drawdowns.btc, di = f.drawdowns && f.drawdowns.ixic;
    if (db && isNum(db.now) && isNum(db.max) && di && isNum(di.max)) {
      out.push('Bitcoin sits ' + pct(-db.now, 1) + ' below its peak in this window; its deepest drawdown was ' + pct(-db.max, 1) +
        (db.deepest ? ' from ' + day(db.deepest.peakDate) : '') + ', the Nasdaq\'s ' + pct(-di.max, 1) + '.');
    }
    if (p.agreement && isNum(p.agreement.last252)) {
      out.push('The two closed in the same direction on ' + pct(p.agreement.last252, 0) + ' of the last 252 sessions.');
    }
    return out;
  }

  MP.findings = {
    compute: compute,
    narrative: narrative,
    label: label,
    config: { WINDOWS: WINDOWS, ROLL: ROLL, BREAK_SPAN: BREAK_SPAN, MIN_SESSIONS: MIN_SESSIONS, COUPLED: COUPLED, DECOUPLED: DECOUPLED }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
