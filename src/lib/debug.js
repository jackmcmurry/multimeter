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

    /* pinned panel: same render path, synthetic pick */
    if (MP.spotlight) {
      var sv = MP.spotlight.view;
      var spotSeries = data.qqq.map(function (p, i) {
        return { date: p.date, price: Math.round((p.price * 0.42 + i * 0.1) * 100) / 100 };
      });
      sv.pick = {
        weekOf: MP.spotlight.weekOf(new Date()),
        symbol: 'ADBE',
        name: 'Adobe Inc.',
        changePct5d: -9.34,
        direction: 'down',
        scanned: 14,
        skipped: 1,
        runnerUp: { symbol: 'AMD', changePct5d: 9.0 },
        rule: MP.spotlight.STOCK_RULE
      };
      var lastSpot = spotSeries[spotSeries.length - 1].price;
      sv.quote = {
        symbol: 'ADBE', name: 'Adobe Inc.', price: lastSpot, changePct: -2.37,
        dayLow: lastSpot * 0.99, dayHigh: lastSpot * 1.02,
        prevClose: lastSpot * 1.024, marketCap: 98.9e9
      };
      sv.change = { d1: -2.37, d5: -9.34, m1: -8.84, m3: 6.62, ytd: -28.9 };
      sv.series = spotSeries;
      sv.history = [
        { weekOf: '2026-08-31', symbol: 'INTC', changePct5d: 8.5 },
        { weekOf: '2026-08-24', symbol: 'NFLX', changePct5d: -7.5 }
      ];

      /* crypto of the week: a synthetic SOL pick with a week of hourly prices */
      var solSeries = data.btc.slice(-7).map(function (p) { return p.price * 0.00142; });
      var hourly = [];
      for (var hI = 0; hI < solSeries.length - 1; hI++) {
        for (var k = 0; k < 24; k++) hourly.push(solSeries[hI] + (solSeries[hI + 1] - solSeries[hI]) * (k / 24));
      }
      hourly.push(solSeries[solSeries.length - 1]);
      sv.crypto = {
        weekOf: MP.spotlight.weekOf(new Date()), id: 'solana', symbol: 'SOL', name: 'Solana',
        changePct7d: 18.4, direction: 'up', scanned: 14, skipped: 1,
        runnerUp: { id: 'dogecoin', symbol: 'DOGE', changePct7d: -15.2 }, rule: MP.spotlight.CRYPTO_RULE
      };
      sv.cryptoQuote = {
        id: 'solana', symbol: 'SOL', name: 'Solana',
        price: Math.round(hourly[hourly.length - 1] * 100) / 100, changePct: 3.21, change7d: 18.4,
        marketCap: 61e9, sparkline: hourly.map(function (v) { return Math.round(v * 100) / 100; })
      };
      sv.cryptoHistory = [{ weekOf: '2026-08-31', id: 'ripple', symbol: 'XRP', changePct7d: -11.0 }];
      sv.cryptoNotice = null;
      MP.spotlight.render();
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
