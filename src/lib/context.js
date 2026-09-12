/* ============================================================================
 * context.js: MarketContext, one structured account of what the meter is
 * showing right now.
 *
 * Everything in it is either a figure the page already holds or a statistic
 * computed here from stored closes. A field the page cannot know is null,
 * never a guess and never a placeholder. Each block carries where it came
 * from and when, so the drawer can show provenance and a reader can tell a
 * quoted price from a computed one.
 *
 * This is also the packet a future PROBE hands to Claude. Claude will write
 * prose over these figures and add none of its own, so the shape is fixed
 * and versioned: SCHEMA_VERSION changes whenever a field's meaning changes.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});
  var S = MP.stats;

  var SCHEMA_VERSION = 1;
  var VOL_WINDOW = 30;
  var MOVE_WINDOW = 252;     /* how many recent returns a move is judged against */
  var ANNUALIZE = 252;

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function app() { return MP.app && MP.app.state ? MP.app.state : null; }

  /* ---- statistics over a series ------------------------------------------- */

  /* How unusual the latest move is against its own recent history: its z
   * score, and the share of recent moves it is larger than. Both null when
   * there is too little history to say. */
  function moveStats(series) {
    if (!series || series.length < 32) return null;
    var prices = S.sortSeries(series).map(function (p) { return p.price; });
    var rets = S.logReturns(prices).filter(isNum);
    if (rets.length < 30) return null;
    var recent = S.tail(rets, MOVE_WINDOW);
    var latest = recent[recent.length - 1];
    var body = recent.slice(0, -1);
    var sd = S.stdev(body), mean = S.mean(body);
    var smaller = body.filter(function (r) { return Math.abs(r) <= Math.abs(latest); }).length;
    return {
      return: latest,
      z: isNum(sd) && sd > 0 ? (latest - mean) / sd : null,
      percentile: body.length ? smaller / body.length : null,
      comparedWith: body.length,
      basis: 'daily log returns'
    };
  }

  function volatility(series) {
    if (!series || series.length < VOL_WINDOW + 2) return null;
    var prices = S.sortSeries(series).map(function (p) { return p.price; });
    var v = S.annualizedVol(S.tail(S.logReturns(prices), VOL_WINDOW), ANNUALIZE);
    if (!isNum(v)) return null;
    return {
      value: v,
      window: VOL_WINDOW,
      annualized: true,
      basis: 'standard deviation of daily log returns, annualized by the square root of ' + ANNUALIZE
    };
  }

  function drawdown(series) {
    if (!series || series.length < 3) return null;
    var prices = S.sortSeries(series).map(function (p) { return p.price; });
    var run = S.drawdownSeries(prices);
    if (!run || !run.length) return null;
    return { now: run[run.length - 1], worst: S.maxDrawdown(prices), basis: 'distance below the running peak' };
  }

  function window(series) {
    if (!series || !series.length) return null;
    var sorted = S.sortSeries(series);
    return { points: sorted.length, from: sorted[0].date, to: sorted[sorted.length - 1].date, interval: 'daily' };
  }

  /* ---- the pieces the page already holds ----------------------------------- */

  function priceBlock(value, opts) {
    if (!isNum(value)) return null;
    return {
      value: value,
      currency: 'USD',
      basis: opts.basis,            /* 'spot' | 'last trade' | 'close' | 'index level' */
      source: opts.source,
      asOf: isNum(opts.asOf) ? opts.asOf : null,
      live: !!opts.live
    };
  }

  function changeBlock(pct, abs, period, source) {
    if (!isNum(pct) && !isNum(abs)) return null;
    return {
      percent: isNum(pct) ? pct : null,
      absolute: isNum(abs) ? abs : null,
      period: period,
      source: source
    };
  }

  /* Whatever the statistics panels currently measure, as relationships. */
  function relatedFromAnalytics() {
    var st = app();
    var a = st && st.analytics;
    if (!a || !a.coupling || !a.coupling.length) return [];
    var l = a.labels || {};
    return a.coupling.map(function (c) {
      return {
        symbol: l.index || null,
        name: l.indexName || null,
        correlation: isNum(c.correlation) ? c.correlation : null,
        beta: isNum(c.beta) ? c.beta : null,
        r2: isNum(c.r2) ? c.r2 : null,
        window: c.window,
        pairedSessions: c.n,
        basis: 'daily log returns on sessions both traded'
      };
    });
  }

  function marketBlock() {
    var st = app();
    var d = st && st.session ? st.session.data : null;
    var now = Date.now();
    var ses = MP.session ? MP.session.status(now) : null;
    return {
      equities: d ? d.equityStatus : (ses ? (ses.open ? 'open' : 'closed') : null),
      phase: ses ? ses.phase : null,
      lastCompletedSession: MP.session ? MP.session.lastCompletedSession(now, 60) : null,
      crypto: 'continuous'
    };
  }

  /* ---- one stop, one context ----------------------------------------------- */

  var COIN_STOPS = { btc: 'Bitcoin', eth: 'Ether' };

  function build(stop) {
    var st = app();
    var reading = MP.app && MP.app.reading ? MP.app.reading(stop) : null;
    var ctx = {
      version: SCHEMA_VERSION,
      builtAt: Date.now(),
      stop: stop,
      instrument: { kind: null, symbol: null, name: null },
      price: null,
      change: null,
      history: null,
      statistics: { volatility: null, move: null, drawdown: null },
      related: [],
      market: marketBlock(),
      sources: [],
      empty: true
    };
    if (!st || !reading) return ctx;

    var series = null;

    if (stop === 'btc' || stop === 'eth') {
      var key = stop;
      var q = st.quotes[key].data;
      ctx.instrument = { kind: 'crypto', symbol: stop.toUpperCase(), name: COIN_STOPS[stop] };
      ctx.price = priceBlock(reading.value, {
        basis: reading.live ? 'last trade' : 'spot',
        source: reading.live ? 'Coinbase Exchange' : 'CoinGecko',
        asOf: st.quotes[key].stamp,
        live: !!reading.live
      });
      ctx.change = changeBlock(reading.change.pct, reading.change.abs, reading.change.label,
        reading.live ? 'Coinbase Exchange' : 'CoinGecko');
      series = st.history[key] || null;
      if (q && isNum(q.marketCap) && q.marketCap > 0) ctx.instrument.marketCap = q.marketCap;
      if (q && isNum(q.volume) && q.volume > 0) ctx.instrument.volume = q.volume;
      ctx.sources = reading.live ? ['Coinbase Exchange', 'CoinGecko'] : ['CoinGecko'];
    } else if (stop === 'nasdaq' || stop === 'spx') {
      var ik = stop === 'nasdaq' ? 'ixic' : 'spx';
      ctx.instrument = {
        kind: 'index',
        symbol: stop === 'nasdaq' ? '^IXIC' : '^GSPC',
        name: stop === 'nasdaq' ? 'Nasdaq Composite' : 'S&P 500'
      };
      var iq = st.quotes[ik].data;
      if (iq && isNum(iq.volume) && iq.volume > 0) ctx.instrument.volume = iq.volume;
      ctx.price = priceBlock(reading.value, { basis: 'index level', source: 'Financial Modeling Prep', asOf: st.quotes[ik].stamp, live: false });
      ctx.change = changeBlock(reading.change.pct, reading.change.abs, reading.change.label, 'Financial Modeling Prep');
      series = st.history[ik] || null;
      ctx.sources = ['Financial Modeling Prep'];
    } else if (stop === 'watch' && reading.symbol) {
      ctx.instrument = { kind: 'stock', symbol: reading.symbol, name: (MP.app.stockRow(reading.symbol) || {}).name || null };
      ctx.price = priceBlock(reading.value, { basis: 'close', source: 'Financial Modeling Prep', asOf: null, live: false });
      ctx.change = changeBlock(reading.change.pct, reading.change.abs, reading.change.label, 'Financial Modeling Prep');
      series = MP.app.stockSeries(reading.symbol);
      ctx.sources = ['Financial Modeling Prep'];
    } else if ((stop === 'mover' || stop === 'loser') && reading.symbol) {
      var crypto = MP.spotlight && MP.spotlight.kind() === 'crypto';
      ctx.instrument = { kind: crypto ? 'crypto' : 'stock', symbol: reading.symbol, name: null };
      ctx.price = priceBlock(reading.value, {
        basis: crypto ? 'spot' : 'close',
        source: crypto ? 'CoinGecko' : 'Financial Modeling Prep',
        asOf: null,
        live: !!reading.live
      });
      ctx.change = changeBlock(reading.change.pct, reading.change.abs, reading.change.label,
        crypto ? 'CoinGecko' : 'Financial Modeling Prep');
      if (!crypto) series = MP.app.stockSeries(reading.symbol);
      ctx.sources = crypto ? ['CoinGecko'] : ['Financial Modeling Prep'];
    } else if (stop === 'probe' && st.probe) {
      ctx.instrument = { kind: 'crypto', symbol: st.probe.symbol, name: st.probe.name };
      ctx.price = priceBlock(reading.value, { basis: 'spot', source: 'CoinGecko', asOf: st.quotes.probe.stamp, live: !!reading.live });
      ctx.change = changeBlock(reading.change.pct, reading.change.abs, reading.change.label, 'CoinGecko');
      ctx.sources = ['CoinGecko'];
    } else if (stop === 'corr' || stop === 'vol' || stop === 'dd') {
      var a = st.analytics, l = a ? a.labels : null;
      ctx.instrument = { kind: 'statistic', symbol: l ? l.coin : null, name: reading.mode || null };
      ctx.sources = ['CoinGecko', 'Financial Modeling Prep'];
      /* the statistics stops describe a coin, so the packet carries that
       * coin's closes and the same move statistics the other stops show */
      series = MP.app && MP.app.coinHistory ? MP.app.coinHistory(st.stats ? st.stats.coin : null) : null;
      if (a) {
        ctx.statistics.volatility = isNum(a.currentCoinVol)
          ? { value: a.currentCoinVol, window: 30, annualized: true, basis: 'standard deviation of daily log returns, annualized by the square root of 252' }
          : null;
        ctx.statistics.drawdown = a.coinDd ? { now: a.coinDd.now, worst: a.coinDd.max, basis: 'distance below the running peak' } : null;
        ctx.history = { points: a.commonSessions, from: a.windowFrom, to: a.windowTo, interval: 'daily' };
      }
    }

    if (series && series.length) {
      ctx.history = window(series);
      ctx.statistics.volatility = ctx.statistics.volatility || volatility(series);
      ctx.statistics.move = moveStats(series);
      ctx.statistics.drawdown = ctx.statistics.drawdown || drawdown(series);
    }
    ctx.related = relatedFromAnalytics();
    ctx.empty = !ctx.price && !ctx.statistics.volatility && !ctx.history;
    return ctx;
  }

  /* A one-line provenance for the drawer: where the figure came from, when
   * it was read, and over what period. */
  function provenance(ctx) {
    if (!ctx) return '';
    var bits = [];
    if (ctx.price && ctx.price.source) bits.push(ctx.price.source);
    else if (ctx.sources.length) bits.push(ctx.sources.join(' and '));
    if (ctx.price && isNum(ctx.price.asOf) && MP.fmt) bits.push('read ' + MP.fmt.ago(ctx.price.asOf));
    if (ctx.history && ctx.history.points) bits.push(ctx.history.points + ' daily closes to ' + (MP.fmt ? MP.fmt.shortDate(ctx.history.to) : ctx.history.to));
    return bits.join(' · ');
  }

  MP.context = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    build: build,
    provenance: provenance,
    moveStats: moveStats,
    volatility: volatility,
    drawdown: drawdown
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
