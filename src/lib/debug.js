/* ============================================================================
 * debug.js: build-verification scaffolding. NOT part of the release bundle.
 *
 * There is no local JS runtime on this machine, so layout and chart geometry
 * are checked by serving the debug bundle over loopback and calling
 * MP.debug.renderSynthetic() from the browser console. The series it makes are
 * a seeded random walk, deliberately synthetic and never shown to a viewer of
 * the published page, which only ever renders connector data.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  /* mulberry32: a small deterministic PRNG so runs are reproducible. */
  function prng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gauss(rand) {
    var u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function isoDay(d) { return d.toISOString().slice(0, 10); }

  /* Builds two correlated walks: index gets the common factor at 1x, BTC at
   * ~2x plus its own idiosyncratic noise, so beta lands near 2. */
  function synthesize(seed, days) {
    var rand = prng(seed || 7);
    var start = new Date(Date.now() - days * 86400000);
    var btc = [], ixic = [], qqq = [];
    var btcPx = 68000, ixicPx = 24000, qqqPx = 640;

    for (var i = 0; i < days; i++) {
      var day = new Date(start.getTime() + i * 86400000);
      var dow = day.getUTCDay();
      var common = gauss(rand) * 0.009;
      var idio = gauss(rand) * 0.021;

      btcPx *= Math.exp(2.0 * common + idio + 0.0004);
      btc.push({ date: isoDay(day), price: Math.round(btcPx * 100) / 100 });

      if (dow !== 0 && dow !== 6) {
        ixicPx *= Math.exp(common + gauss(rand) * 0.003 + 0.0003);
        qqqPx *= Math.exp(common * 1.1 + gauss(rand) * 0.0032 + 0.0003);
        ixic.push({ date: isoDay(day), price: Math.round(ixicPx * 100) / 100 });
        qqq.push({ date: isoDay(day), price: Math.round(qqqPx * 100) / 100 });
      }
    }
    return { btc: btc, ixic: ixic, qqq: qqq.slice(-100) };
  }

  /* Fills app state with synthetic data and runs the real render path. */
  function renderSynthetic(seed, days) {
    var app = MP.app;
    if (!app) return { ok: false, error: 'MP.app is not loaded' };
    var data = synthesize(seed || 7, days || 365);
    var st = app.state;

    st.history.btc = data.btc;
    st.history.ixic = data.ixic;
    st.history.qqq = data.qqq;
    st.history.pending = false;
    st.history.notice = null;

    var lastBtc = data.btc[data.btc.length - 1].price;
    var prevBtc = data.btc[data.btc.length - 2].price;
    var lastIxic = data.ixic[data.ixic.length - 1].price;
    var prevIxic = data.ixic[data.ixic.length - 2].price;
    var lastQqq = data.qqq[data.qqq.length - 1].price;
    var prevQqq = data.qqq[data.qqq.length - 2].price;

    st.quotes.btc.data = {
      price: lastBtc,
      changePct: (lastBtc / prevBtc - 1) * 100,
      marketCap: lastBtc * 19800000,
      volume: 31e9,
      supply: 19800000,
      rank: 1,
      sparkline: data.btc.slice(-48).map(function (p) { return p.price; })
    };
    st.quotes.btc.stamp = Date.now();

    st.quotes.eth.data = {
      id: 'ethereum', symbol: 'ETH', name: 'Ethereum',
      price: Math.round(lastBtc * 0.052 * 100) / 100,
      changePct: (lastBtc / prevBtc - 1) * 100 * 1.4,
      marketCap: lastBtc * 0.052 * 120e6,
      sparkline: data.btc.slice(-96).map(function (p) { return Math.round(p.price * 0.052 * 100) / 100; })
    };
    st.quotes.eth.stamp = Date.now();

    st.quotes.spx.data = {
      symbol: '^GSPC', name: 'S&P 500',
      price: Math.round(lastIxic * 0.2497 * 100) / 100,
      changePct: (lastIxic / prevIxic - 1) * 100 * 0.8,
      prevClose: prevIxic * 0.2497
    };
    st.quotes.spx.stamp = Date.now();
    st.history.spx = data.ixic.map(function (p) { return { date: p.date, price: Math.round(p.price * 0.2497 * 100) / 100 }; });

    st.quotes.ixic.data = {
      price: lastIxic,
      changePct: (lastIxic / prevIxic - 1) * 100,
      dayLow: lastIxic * 0.994, dayHigh: lastIxic * 1.006,
      prevClose: prevIxic, volume: 6.1e9,
      avg50: lastIxic * 0.99, avg200: lastIxic * 0.94
    };
    st.quotes.ixic.stamp = Date.now();

    st.quotes.qqq.data = {
      price: lastQqq,
      changePct: (lastQqq / prevQqq - 1) * 100,
      dayLow: lastQqq * 0.995, dayHigh: lastQqq * 1.005,
      prevClose: prevQqq, volume: 3.1e7,
      open: prevQqq, tradingDay: data.qqq[data.qqq.length - 1].date
    };
    st.quotes.qqq.stamp = Date.now();

    st.session.data = {
      equityStatus: 'open', equityOpen: '09:30', equityClose: '16:15',
      exchanges: 'NASDAQ, NYSE, AMEX, BATS', cryptoStatus: 'open'
    };

    /* hero chart: 24h range, straight from the synthetic walk */
    st.hero.days = 1;
    var heroPrices = data.btc.slice(-48).map(function (p) { return p.price; });
    var heroStamps = data.btc.slice(-48).map(function (p) { return Date.parse(p.date + 'T00:00:00Z'); });
    st.hero.cache['bitcoin:1'] = { prices: heroPrices, stamps: heroStamps, startTs: heroStamps[0], endTs: heroStamps[heroStamps.length - 1] };

    st.analytics = app.computeAnalytics();
    app.renderHero();
    app.renderMarkets();
    app.renderSession();
    app.renderAnalytics();

    /* the daily reading: the template the job falls back to, from these numbers */
    if (MP.note && app.renderNote) {
      var session = data.ixic[data.ixic.length - 1].date;
      var noteInputs = {
        session: session,
        ixic: { price: lastIxic, changePct: (lastIxic / prevIxic - 1) * 100 },
        btc: { price: lastBtc, changePct: (lastBtc / prevBtc - 1) * 100 }
      };
      var synthFindings = MP.findings ? MP.findings.compute({ btc: data.btc, ixic: data.ixic, spx: st.history.spx }, Date.now()) : null;
      st.note.data = {
        forSession: session, text: MP.note.fallback(synthFindings, noteInputs), source: 'fallback',
        model: null, generatedAt: Date.now(), inputs: noteInputs, invalidReason: null
      };
      app.renderNote();
    }

    /* MOVER, LOSER and WATCH: a synthetic slice of the Nasdaq-100 through the
     * same render paths. The late sessions carry each name's weekly move. */
    if (MP.spotlight && st.stocks) {
      var rnd = prng((seed || 7) + 101);
      var names = {
        NVDA: 'NVIDIA Corporation', AMD: 'Advanced Micro Devices, Inc.', PLTR: 'Palantir Technologies Inc.',
        TSLA: 'Tesla, Inc.', APP: 'AppLovin Corporation', AAPL: 'Apple Inc.', MSFT: 'Microsoft Corporation',
        COST: 'Costco Wholesale Corporation', PEP: 'PepsiCo, Inc.', INTC: 'Intel Corporation',
        NFLX: 'Netflix, Inc.', ADBE: 'Adobe Inc.', PYPL: 'PayPal Holdings, Inc.', WBD: 'Warner Bros. Discovery, Inc.'
      };
      var drifts = {
        NVDA: 0.024, AMD: 0.018, PLTR: 0.014, TSLA: 0.011, APP: 0.009, AAPL: 0.003, MSFT: 0.001,
        COST: 0, PEP: -0.002, INTC: -0.006, NFLX: -0.009, ADBE: -0.013, PYPL: -0.016, WBD: -0.021
      };
      var dates = data.ixic.map(function (p) { return p.date; });
      var session = dates[dates.length - 1];
      var rowsSyn = [];
      st.stocks.files = {};
      st.stocks.rowsBy = {};
      Object.keys(names).forEach(function (sym, i) {
        var px = 40 + i * 23, closes = [];
        dates.forEach(function (d, j) {
          px *= Math.exp((j >= dates.length - 5 ? drifts[sym] : 0.0004) + 0.012 * gauss(rnd));
          closes.push({ date: d, price: Math.round(px * 100) / 100 });
        });
        st.stocks.files[sym] = { series: closes, name: names[sym], session: session };
        var n = closes.length, last = closes[n - 1].price;
        var row = {
          symbol: sym, name: names[sym], close: last, date: session,
          change1d: (last / closes[n - 2].price - 1) * 100,
          change5d: (last / closes[n - 6].price - 1) * 100,
          change1m: (last / closes[n - 22].price - 1) * 100
        };
        rowsSyn.push(row);
        st.stocks.rowsBy[sym] = row;
      });
      st.stocks.list = { session: session, listAsOf: '2026-09-11', count: { listed: 102, priced: 101, denied: 1 }, complete: true, rows: rowsSyn };
      st.stocks.notice = null;

      var weekSyn = MP.spotlight.weekOf(new Date());
      var stockSel = MP.spotlight.selectMovers(rowsSyn, 'change5d');
      var cryptoSel = MP.spotlight.selectMovers(MP.spotlight.CRYPTO_UNIVERSE.map(function (c, i) {
        return { id: c.id, symbol: c.symbol, name: c.name, changePct7d: 22 - i * 3.1 };
      }), 'changePct7d');
      var sv = MP.spotlight.view;
      sv.movers = {
        stocks: Object.assign({ weekOf: weekSyn, measuredTo: session, listed: 102, rule: MP.spotlight.STOCK_RULE }, stockSel),
        crypto: Object.assign({ weekOf: weekSyn, rule: MP.spotlight.CRYPTO_RULE }, cryptoSel),
        history: [
          { weekOf: '2026-09-07', kind: 'stocks', rule: 'gain-drop', mover: { symbol: 'AMD', change: 9.0 }, loser: { symbol: 'ADBE', change: -9.34 } },
          { weekOf: '2026-09-07', kind: 'crypto', rule: 'gain-drop', mover: { symbol: 'SOL', id: 'solana', change: 18.4 }, loser: { symbol: 'DOGE', id: 'dogecoin', change: -15.2 } },
          { weekOf: '2026-08-31', kind: 'stocks', rule: 'absolute', mover: { symbol: 'INTC', change: 8.5 }, loser: null }
        ]
      };
      var quoteFor = function (e) {
        var r = st.stocks.rowsBy[e.symbol];
        return { symbol: e.symbol, name: e.name, price: r.close, changePct: r.change1d, marketCap: 2.1e11 + r.close * 1e8 };
      };
      sv.picks = { mover: quoteFor(stockSel.mover), loser: quoteFor(stockSel.loser) };
      sv.coins = {};
      [cryptoSel.mover, cryptoSel.loser].forEach(function (e, j) {
        var base = j ? 0.21 : 187.4, hourlySyn = [];
        for (var hS = 0; hS < 169; hS++) {
          hourlySyn.push(Math.round(base * Math.exp((j ? -1 : 1) * 0.0011 * hS + 0.01 * gauss(rnd)) * 10000) / 10000);
        }
        sv.coins[e.id] = {
          id: e.id, symbol: e.symbol, name: e.name, price: hourlySyn[hourlySyn.length - 1],
          changePct: j ? -2.4 : 3.2, marketCap: j ? 3.1e10 : 9.1e10, sparkline: hourlySyn, image: null
        };
      });
      sv.notice = null;
      st.watch.list = ['AAPL', 'NVDA', 'WBD'];
      st.watch.index = 0;
      MP.spotlight.render();
      app.renderWatch();
    }

    var a = st.analytics;
    return {
      ok: !!a,
      commonSessions: a ? a.commonSessions : 0,
      beta90: a ? a.coupling[1].beta : null,
      corr90: a ? a.coupling[1].correlation : null,
      coinVol: a ? a.currentCoinVol : null,
      indexVol: a ? a.currentIndexVol : null,
      coinEpisodes: a ? a.coinEpisodes.length : 0,
      indexEpisodes: a ? a.indexEpisodes.length : 0
    };
  }

  /* Turns the dial through every stop, one every `ms`, for a visual pass.
   * Returns a function that stops the tour. */
  function cycle(ms) {
    var stops = MP.meter ? MP.meter.STOPS : [];
    var i = 0;
    var id = setInterval(function () {
      if (!stops.length || !MP.router) return;
      MP.router.go(stops[i % stops.length].id);
      i += 1;
    }, ms || 1200);
    return function () { clearInterval(id); };
  }

  MP.debug = { renderSynthetic: renderSynthetic, synthesize: synthesize, cycle: cycle };
})(typeof globalThis !== 'undefined' ? globalThis : this);
