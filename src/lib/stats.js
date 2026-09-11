/* ============================================================================
 * stats.js: return-series statistics. Pure functions: no DOM, no network.
 *
 * Conventions used throughout the app:
 *   - A "series" is [{ date: 'YYYY-MM-DD', price: Number }], any order.
 *   - Paired statistics (correlation, beta) are computed on returns taken
 *     AFTER intersecting the two series on common dates, so both legs span
 *     identical calendar intervals (e.g. a Friday->Monday gap is a
 *     Friday->Monday gap for both). This matters when pairing a 7-day market
 *     (BTC) with a 5-day one (equity indices).
 *   - Returns are log returns; volatility is annualized with sqrt(252)
 *     because the paired calendar is the US equity session calendar.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var TRADING_DAYS = 252;
  var MS_PER_DAY = 86400000;

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  function mean(xs) {
    var n = xs.length;
    if (!n) return NaN;
    var s = 0;
    for (var i = 0; i < n; i++) s += xs[i];
    return s / n;
  }

  /* Sample statistics by default (ddof = 1). */
  function variance(xs, ddof) {
    ddof = ddof === undefined ? 1 : ddof;
    var n = xs.length;
    if (n - ddof <= 0) return NaN;
    var m = mean(xs), s = 0;
    for (var i = 0; i < n; i++) { var d = xs[i] - m; s += d * d; }
    return s / (n - ddof);
  }

  function stdev(xs, ddof) { return Math.sqrt(variance(xs, ddof)); }

  function covariance(xs, ys, ddof) {
    ddof = ddof === undefined ? 1 : ddof;
    var n = Math.min(xs.length, ys.length);
    if (n - ddof <= 0) return NaN;
    var mx = mean(xs.slice(0, n)), my = mean(ys.slice(0, n)), s = 0;
    for (var i = 0; i < n; i++) s += (xs[i] - mx) * (ys[i] - my);
    return s / (n - ddof);
  }

  function pearson(xs, ys) {
    var n = Math.min(xs.length, ys.length);
    if (n < 2) return NaN;
    var a = xs.slice(0, n), b = ys.slice(0, n);
    var sx = stdev(a), sy = stdev(b);
    if (!sx || !sy || !isNum(sx) || !isNum(sy)) return NaN;
    return covariance(a, b) / (sx * sy);
  }

  /* Beta of `asset` against `bench`: cov(a,b) / var(b). */
  function beta(asset, bench) {
    var vb = variance(bench);
    if (!vb || !isNum(vb)) return NaN;
    return covariance(asset, bench) / vb;
  }

  /* Ordinary least squares fit of ys on xs. slope === beta when xs is the
   * benchmark's return series. */
  function regression(xs, ys) {
    var n = Math.min(xs.length, ys.length);
    if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN, n: n };
    var a = xs.slice(0, n), b = ys.slice(0, n);
    var slope = beta(b, a);
    var intercept = mean(b) - slope * mean(a);
    var r = pearson(a, b);
    return { slope: slope, intercept: intercept, r2: isNum(r) ? r * r : NaN, n: n };
  }

  /* Log returns: r[i] = ln(p[i] / p[i-1]). Length is prices.length - 1. */
  function logReturns(prices) {
    var out = [];
    for (var i = 1; i < prices.length; i++) {
      var prev = prices[i - 1], cur = prices[i];
      out.push(isNum(prev) && isNum(cur) && prev > 0 && cur > 0 ? Math.log(cur / prev) : NaN);
    }
    return out;
  }

  /* Drop index pairs where either leg is not finite, keeping alignment. */
  function pairwiseClean(xs, ys) {
    var n = Math.min(xs.length, ys.length), a = [], b = [];
    for (var i = 0; i < n; i++) {
      if (isNum(xs[i]) && isNum(ys[i])) { a.push(xs[i]); b.push(ys[i]); }
    }
    return { a: a, b: b };
  }

  function annualizedVol(returns, periodsPerYear) {
    var ppy = periodsPerYear || TRADING_DAYS;
    var clean = returns.filter(isNum);
    if (clean.length < 2) return NaN;
    return stdev(clean) * Math.sqrt(ppy);
  }

  /* Rolling window over xs. Returns [{ index, value }] where index is the
   * position of the window's LAST element. */
  function rolling(xs, window, fn) {
    var out = [];
    if (window <= 0) return out;
    for (var i = window - 1; i < xs.length; i++) {
      out.push({ index: i, value: fn(xs.slice(i - window + 1, i + 1)) });
    }
    return out;
  }

  /* Rolling window over two aligned arrays. */
  function rollingPair(xs, ys, window, fn) {
    var out = [], n = Math.min(xs.length, ys.length);
    if (window <= 0) return out;
    for (var i = window - 1; i < n; i++) {
      out.push({
        index: i,
        value: fn(xs.slice(i - window + 1, i + 1), ys.slice(i - window + 1, i + 1))
      });
    }
    return out;
  }

  function byDateAsc(p, q) { return p.date < q.date ? -1 : p.date > q.date ? 1 : 0; }

  function sortSeries(series) { return series.slice().sort(byDateAsc); }

  /* Intersect two series on common dates. Returns ascending arrays. */
  function alignByDate(seriesA, seriesB) {
    var lookup = {};
    for (var i = 0; i < seriesB.length; i++) lookup[seriesB[i].date] = seriesB[i].price;
    var dates = [], a = [], b = [];
    var sorted = sortSeries(seriesA);
    for (var j = 0; j < sorted.length; j++) {
      var d = sorted[j].date, pa = sorted[j].price, pb = lookup[d];
      if (pb !== undefined && isNum(pa) && isNum(pb)) { dates.push(d); a.push(pa); b.push(pb); }
    }
    return { dates: dates, a: a, b: b };
  }

  function dayGap(fromDate, toDate) {
    var a = Date.parse(fromDate + 'T00:00:00Z'), b = Date.parse(toDate + 'T00:00:00Z');
    if (isNaN(a) || isNaN(b)) return null;
    return Math.round((b - a) / MS_PER_DAY);
  }

  /* Percentage below the running peak, per observation. */
  function drawdownSeries(prices) {
    var peak = -Infinity, out = [];
    for (var i = 0; i < prices.length; i++) {
      if (isNum(prices[i]) && prices[i] > peak) peak = prices[i];
      out.push(isNum(prices[i]) && peak > 0 ? prices[i] / peak - 1 : NaN);
    }
    return out;
  }

  function maxDrawdown(prices) {
    var dd = drawdownSeries(prices).filter(isNum);
    return dd.length ? Math.min.apply(null, dd) : NaN;
  }

  /* Peak-to-trough episodes, deepest first.
   * An episode opens when price falls below the running peak and closes when
   * price regains that peak; an unrecovered episode is marked `ongoing`. */
  function drawdownEpisodes(dates, prices, opts) {
    opts = opts || {};
    var minDepth = Math.abs(opts.minDepth === undefined ? 0.05 : opts.minDepth);
    var limit = opts.limit === undefined ? Infinity : opts.limit;

    var episodes = [], cur = null;
    var peak = prices[0], peakIdx = 0;

    for (var i = 1; i < prices.length; i++) {
      var p = prices[i];
      if (!isNum(p)) continue;
      if (p >= peak) {
        if (cur) { cur.recoveryIndex = i; episodes.push(cur); cur = null; }
        peak = p; peakIdx = i;
      } else {
        if (!cur) cur = { peakIndex: peakIdx, peak: peak, troughIndex: i, trough: p, recoveryIndex: null };
        if (p < cur.trough) { cur.trough = p; cur.troughIndex = i; }
      }
    }
    if (cur) episodes.push(cur);

    return episodes.map(function (e) {
      return {
        peakDate: dates[e.peakIndex],
        peakPrice: e.peak,
        troughDate: dates[e.troughIndex],
        troughPrice: e.trough,
        depth: e.trough / e.peak - 1,
        recoveryDate: e.recoveryIndex === null ? null : dates[e.recoveryIndex],
        declineDays: dayGap(dates[e.peakIndex], dates[e.troughIndex]),
        recoveryDays: e.recoveryIndex === null ? null : dayGap(dates[e.troughIndex], dates[e.recoveryIndex]),
        ongoing: e.recoveryIndex === null
      };
    }).filter(function (e) {
      return isNum(e.depth) && e.depth <= -minDepth;
    }).sort(function (x, y) {
      return x.depth - y.depth;
    }).slice(0, limit);
  }

  /* Last `count` elements (or all of them). */
  function tail(xs, count) {
    return count >= xs.length ? xs.slice() : xs.slice(xs.length - count);
  }

  /* Correlation / beta / R-squared over a set of trailing window lengths. */
  function couplingWindows(assetReturns, benchReturns, windows) {
    return windows.map(function (w) {
      var pair = pairwiseClean(tail(assetReturns, w), tail(benchReturns, w));
      var n = pair.a.length;
      return {
        window: w,
        n: n,
        correlation: n >= 3 ? pearson(pair.a, pair.b) : NaN,
        beta: n >= 3 ? beta(pair.a, pair.b) : NaN,
        r2: n >= 3 ? Math.pow(pearson(pair.a, pair.b), 2) : NaN
      };
    });
  }

  MP.stats = {
    TRADING_DAYS: TRADING_DAYS,
    isNum: isNum,
    mean: mean,
    variance: variance,
    stdev: stdev,
    covariance: covariance,
    pearson: pearson,
    beta: beta,
    regression: regression,
    logReturns: logReturns,
    pairwiseClean: pairwiseClean,
    annualizedVol: annualizedVol,
    rolling: rolling,
    rollingPair: rollingPair,
    sortSeries: sortSeries,
    alignByDate: alignByDate,
    dayGap: dayGap,
    drawdownSeries: drawdownSeries,
    maxDrawdown: maxDrawdown,
    drawdownEpisodes: drawdownEpisodes,
    tail: tail,
    couplingWindows: couplingWindows
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
