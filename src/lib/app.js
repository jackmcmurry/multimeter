/* ============================================================================
 * app.js — state, data wiring, analytics assembly, rendering.
 *
 * One number per screen. Bitcoin, ether and the crypto of the week come
 * straight from CoinGecko's public API on a 45s poll. The index quotes, daily
 * history and the two weekly picks come from snapshot files under data/ that
 * a scheduled GitHub Action rewrites (scripts/update-data.js). Daily history
 * drives the coupling, volatility and drawdown panels; the BTC chart fetches
 * per range, on demand, and caches.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});
  var S = MP.stats, F = MP.fmt, G = MP.geom, SRC = MP.sources, SES = MP.session, SEG = MP.sevenseg;

  /* ---- configuration ------------------------------------------------------ */
  var BTC_REFRESH_MS = 45000;
  var SNAPSHOT_REFRESH_MS = 60000;
  var DAILY_REFRESH_MS = 30 * 60000;
  var HERO_REFRESH_MS = 5 * 60000;
  var SESSION_TICK_MS = 30000;
  var FETCH_TIMEOUT_MS = 12000;
  var MAX_BACKOFF_MS = 10 * 60000;
  var STALE_SNAPSHOT_MS = 4 * 86400000;   /* longer than any market weekend */
  var VOL_WINDOW = 30;
  var CORR_WINDOW = 30;
  var SCATTER_SESSIONS = 90;
  var COUPLING_WINDOWS = [30, 90, 252];
  var VOL_CHART_POINTS = 120;
  var CORR_CHART_POINTS = 180;
  var ANNUALIZE = S.TRADING_DAYS;

  var RANGE_LABELS = { 1: '24H', 7: '1W', 30: '1M', 365: '1Y' };

  var INSTRUMENTS = {
    btc: { code: 'BTC / USD', desc: 'Bitcoin spot', dp: 0, color: 'var(--c-btc)' },
    eth: { code: 'ETH / USD', desc: 'Ether spot', dp: 2, color: 'var(--c-eth)' },
    ixic: { code: '^IXIC', desc: 'Nasdaq Composite', dp: 2, color: 'var(--c-idx)' },
    spx: { code: '^GSPC', desc: 'S&P 500', dp: 2, color: 'var(--c-spx)' },
    qqq: { code: 'QQQ', desc: 'Invesco QQQ Trust', dp: 2, color: 'var(--c-qqq)' }
  };

  /* CoinGecko ids for the live coins; the crypto of the week joins them once
   * its pick is known. */
  var COINS = { btc: 'bitcoin', eth: 'ethereum' };

  var state = {
    quotes: {
      btc: { data: null, stamp: null, notice: null },
      eth: { data: null, stamp: null, notice: null },
      ixic: { data: null, stamp: null, notice: null },
      spx: { data: null, stamp: null, notice: null },
      qqq: { data: null, stamp: null, notice: null }
    },
    snapshot: { generatedAt: null, notice: null },
    session: { data: null },
    history: { btc: null, ixic: null, spx: null, qqq: null, notice: null, pending: true },
    analytics: null,
    hero: { days: 1, series: null, notice: null, loading: false, cache: {} },
    teardown: []
  };

  function el(id) { return document.getElementById(id); }
  function setText(id, text) { var n = el(id); if (n) n.textContent = text; }
  function setHtml(id, html) { var n = el(id); if (n) n.innerHTML = html; }

  /* ---- fetching ----------------------------------------------------------- */
  function fetchJson(url) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS) : null;
    function done() { if (timer) clearTimeout(timer); }
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (res) {
        if (!res.ok) {
          var err = new Error('HTTP ' + res.status);
          err.status = res.status;
          throw err;
        }
        return res.json();
      })
      .then(function (body) { done(); return body; }, function (err) { done(); throw err; });
  }

  /* GitHub Pages caches files for ten minutes; a per-minute query string keeps
   * snapshot reads current without defeating the cache entirely. */
  function snapshotUrl(path) {
    return path + '?t=' + Math.floor(Date.now() / 60000);
  }

  function emptyError() {
    var err = new Error('no usable data');
    err.empty = true;
    return err;
  }

  /* Runs `task` now and then every `baseMs`, doubling the wait after a 429 up
   * to MAX_BACKOFF_MS. A background tab makes no requests at all; a tick that
   * was skipped while hidden runs the moment the tab is shown again. */
  function poll(task, baseMs) {
    var delay = baseMs, timer = null, stopped = false, skipped = false;
    function schedule() { if (!stopped) timer = setTimeout(tick, delay); }
    function tick() {
      if (stopped) return;
      if (root.document && root.document.hidden) { skipped = true; schedule(); return; }
      skipped = false;
      Promise.resolve().then(task).then(function () {
        delay = baseMs;
      }, function (err) {
        delay = err && err.status === 429 ? Math.min(delay * 2, MAX_BACKOFF_MS) : baseMs;
      }).then(schedule);
    }
    function onShow() {
      if (skipped && !(root.document && root.document.hidden)) { clearTimeout(timer); tick(); }
    }
    if (root.document && root.document.addEventListener) {
      root.document.addEventListener('visibilitychange', onShow);
    }
    tick();
    state.teardown.push(function () {
      stopped = true;
      clearTimeout(timer);
      if (root.document && root.document.removeEventListener) {
        root.document.removeEventListener('visibilitychange', onShow);
      }
    });
  }

  function every(fn, ms) {
    var id = setInterval(fn, ms);
    state.teardown.push(function () { clearInterval(id); });
  }

  /* ---- notice copy -------------------------------------------------------- */
  function liveNotice(source, err) {
    if (err && err.status === 429) {
      return { level: 'warn', text: source + ' is rate limiting this browser. Retrying with a longer wait.' };
    }
    if (err && err.name === 'AbortError') {
      return { level: 'warn', text: source + ' took too long to answer. Retrying shortly.' };
    }
    if (err && err.empty) {
      return { level: 'warn', text: source + ' returned no usable data. Retrying shortly.' };
    }
    return { level: 'warn', text: 'Could not reach ' + source + '. Retrying shortly.' };
  }

  function snapshotNotice(err, what) {
    if (err && err.status === 404) {
      return { level: 'quiet', text: what + ' appears after the first scheduled update.' };
    }
    return { level: 'warn', text: 'Could not load the latest ' + what.toLowerCase() + '. Retrying shortly.' };
  }

  function staleNotice(generatedAt) {
    if (!S.isNum(generatedAt) || Date.now() - generatedAt < STALE_SNAPSHOT_MS) return null;
    return {
      level: 'quiet',
      text: 'Nasdaq figures were last refreshed ' + F.shortDate(new Date(generatedAt).toISOString()) + '.'
    };
  }

  function noticeHtml(notice) {
    if (!notice) return '';
    return '<p class="notice notice-' + notice.level + '">' + F.escapeHtml(notice.text) + '</p>';
  }

  function changeClass(v) {
    return !S.isNum(v) ? 'chg is-flat' : (v >= 0 ? 'chg is-up' : 'chg is-down');
  }

  /* The meter's screen paints from app state; every renderer below ends by
   * asking it to repaint, so the LCD is never staler than the drawer. */
  function repaint() {
    if (MP.meter && MP.meter.refresh) MP.meter.refresh();
  }

  /* ---- the meter's reading ------------------------------------------------ */

  /* One dial stop -> one reading:
   *   { digits, neg, unit, mode, change: { value, label, suffix, dp }, spark, empty }
   * digits is already fitted to the seven-segment cells; change is either a
   * percent (suffix '%') or a plain delta in the reading's own units. Never
   * throws: a stop whose data has not arrived reads '----'. */
  function noReading(unit, mode, label) {
    return {
      digits: '----', neg: false, unit: unit, mode: mode,
      change: { value: NaN, label: label, suffix: '', dp: 2 },
      spark: null, empty: true
    };
  }

  var SPARK_POINTS = 120;   /* how much history the LCD chart shows */

  function quoteReading(key, unit, mode, changeLabel) {
    var meta = INSTRUMENTS[key], d = state.quotes[key].data;
    var price = d && S.isNum(d.price) ? d.price : NaN;
    var f = SEG.fit(price, { dp: meta.dp });
    var series = seriesFor(key);
    return {
      digits: f.text, neg: f.neg, unit: unit, mode: mode,
      change: { value: d && S.isNum(d.changePct) ? d.changePct : NaN, label: changeLabel, suffix: '%', dp: 2 },
      spark: series ? S.tail(series, SPARK_POINTS) : null,
      empty: !S.isNum(price)
    };
  }

  /* BTC follows the drawer's range pills: the chart and the change are for
   * the selected range, the price is live spot — the same rule renderHero
   * applies. */
  function btcReading() {
    var r = quoteReading('btc', 'USD', 'BTC/USD', RANGE_LABELS[state.hero.days] || '24H');
    var series = state.hero.series;
    if (series && series.length > 1 && series[0] > 0) {
      r.spark = series;
      r.change.value = (series[series.length - 1] / series[0] - 1) * 100;
    } else if (state.hero.days !== 1) {
      r.change.value = NaN;
    }
    return r;
  }

  /* The two weekly picks share a shape: { price, changePct, changeLabel,
   * mode, series } from spotlight.js, or null before the scan has run. */
  function pickReading(r, fallbackMode) {
    if (!r) return noReading('USD', fallbackMode, '1D');
    var f = SEG.fit(r.price, { dp: S.isNum(r.price) && r.price < 10 ? 4 : 2 });
    return {
      digits: f.text, neg: f.neg, unit: 'USD', mode: r.mode,
      change: { value: r.changePct, label: r.changeLabel, suffix: '%', dp: 2 },
      spark: r.series ? S.tail(r.series, SPARK_POINTS) : null,
      empty: !S.isNum(r.price)
    };
  }

  function stockReading() {
    return pickReading(MP.spotlight && MP.spotlight.reading ? MP.spotlight.reading() : null, 'STOCK');
  }

  function cryptoReading() {
    return pickReading(MP.spotlight && MP.spotlight.cryptoReading ? MP.spotlight.cryptoReading() : null, 'CRYPTO');
  }

  function entryValues(entries) {
    return (entries || []).map(function (e) { return e.value; });
  }

  /* Last value minus the value `back` steps earlier; NaN when either is missing. */
  function deltaBack(series, back) {
    var n = series ? series.length : 0;
    if (n < back + 1) return NaN;
    var a = series[n - 1], b = series[n - 1 - back];
    return S.isNum(a) && S.isNum(b) ? a - b : NaN;
  }

  var ANALYTICS_MODE = { corr: 'CORR BTC·NDQ 90D', beta: 'BETA 90D', vol: 'VOL BTC 30D', dd: 'DRAWDOWN BTC' };
  var ANALYTICS_UNIT = { corr: '', beta: '×', vol: '%', dd: '%' };

  function analyticsReading(stop) {
    var a = state.analytics;
    if (!a) return noReading(ANALYTICS_UNIT[stop], ANALYTICS_MODE[stop], '30S');
    var c90 = a.coupling[1] || a.coupling[0];
    var value, series, dp, scale = 1, suffix = '';
    if (stop === 'corr') { value = c90.correlation; series = entryValues(a.rollCorr); dp = 2; }
    else if (stop === 'beta') { value = c90.beta; series = entryValues(a.rollBeta); dp = 2; }
    else if (stop === 'vol') { value = a.currentBtcVol; series = entryValues(a.btcVol); dp = 1; scale = 100; suffix = '%'; }
    else { value = a.btcDd.now; series = a.btcDd.series; dp = 1; scale = 100; suffix = '%'; }
    var f = SEG.fit(S.isNum(value) ? value * scale : NaN, { dp: dp });
    return {
      digits: f.text, neg: f.neg, unit: ANALYTICS_UNIT[stop], mode: ANALYTICS_MODE[stop],
      change: { value: deltaBack(series, CORR_WINDOW) * scale, label: '30S', suffix: suffix, dp: dp },
      spark: S.tail(series, SPARK_POINTS),
      empty: !S.isNum(value)
    };
  }

  function reading(stop) {
    switch (stop) {
      case 'btc': return btcReading();
      case 'eth': return quoteReading('eth', 'USD', 'ETH/USD', '24H');
      case 'nasdaq': return quoteReading('ixic', 'PTS', 'NASDAQ ^IXIC', '1D');
      case 'spx': return quoteReading('spx', 'PTS', 'S&P 500 ^GSPC', '1D');
      case 'qqq': return quoteReading('qqq', 'USD', 'QQQ', '1D');
      case 'stock': return stockReading();
      case 'crypto': return cryptoReading();
      case 'corr': case 'beta': case 'vol': case 'dd': return analyticsReading(stop);
      default:
        return { digits: '', neg: false, unit: '', mode: '', change: { value: NaN, label: '', suffix: '', dp: 2 }, spark: null, empty: true };
    }
  }

  /* ---- hero (home) -------------------------------------------------------- */
  function seriesFor(key) {
    if (key === 'btc' && state.hero.series) return state.hero.series;
    var spot = state.quotes[key] && state.quotes[key].data;
    if (spot && spot.sparkline && spot.sparkline.length > 2) return spot.sparkline;
    var hist = state.history[key];
    return hist && hist.length > 2 ? S.tail(hist, 60).map(function (p) { return p.price; }) : null;
  }

  function renderHero() {
    var spot = state.quotes.btc.data;
    var price = el('heroPrice');
    if (price) {
      price.textContent = spot && S.isNum(spot.price) ? F.usd(spot.price, 0) : F.DASH;
      price.classList.toggle('is-empty', !(spot && S.isNum(spot.price)));
    }

    /* Change is measured over the selected range, from the range's own series;
     * the price above it is the live spot. */
    var series = state.hero.series;
    var pct = NaN;
    if (series && series.length > 1 && series[0] > 0) {
      pct = (series[series.length - 1] / series[0] - 1) * 100;
    } else if (state.hero.days === 1 && spot && S.isNum(spot.changePct)) {
      pct = spot.changePct;
    }
    var chg = el('heroChange');
    if (chg) {
      chg.textContent = S.isNum(pct) ? F.signedPctPoints(pct) : F.DASH;
      chg.className = changeClass(pct);
    }
    setText('heroRangeLabel', RANGE_LABELS[state.hero.days] || '');

    var host = el('heroChart');
    if (host) {
      host.innerHTML = series && series.length > 1
        ? G.sparkStep({ values: series, w: 900, h: 230, color: 'var(--c-btc)', area: true, strokeWidth: 1.8 })
        : '';
    }
    setHtml('heroNotice', noticeHtml(state.hero.notice || state.quotes.btc.notice));
    repaint();
  }

  function loadHeroRange(days, refresh) {
    state.hero.days = days;
    var cached = state.hero.cache[days];
    if (cached && !refresh) {
      state.hero.series = cached;
      state.hero.notice = null;
      renderHero();
      return;
    }
    if (!cached) state.hero.series = null;
    state.hero.loading = true;
    renderHero();

    var spec = SRC.btcChart(days);
    fetchJson(spec.url).then(function (payload) {
      var parsed = spec.normalize(payload);
      if (!parsed) throw emptyError();
      state.hero.cache[days] = parsed.prices;
      if (state.hero.days === days) {
        state.hero.series = parsed.prices;
        state.hero.notice = null;
      }
    }).catch(function (err) {
      if (state.hero.days === days) state.hero.notice = liveNotice('CoinGecko', err);
    }).then(function () {
      state.hero.loading = false;
      renderHero();
    });
  }

  function wirePills() {
    var group = el('heroPills');
    if (!group) return;
    group.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('.pill') : null;
      if (!btn || !group.contains(btn)) return;
      var days = parseInt(btn.getAttribute('data-days'), 10);
      if (!days) return;
      var pills = group.querySelectorAll('.pill');
      for (var i = 0; i < pills.length; i++) pills[i].classList.toggle('is-on', pills[i] === btn);
      loadHeroRange(days);
    });
  }

  /* ---- markets ------------------------------------------------------------ */

  /* QQQ is optional upstream (it needs a second API key), so its row appears
   * only once there is something to show. */
  function marketKeys() {
    var keys = ['btc', 'eth', 'ixic', 'spx'];
    if (state.quotes.qqq.data || state.history.qqq) keys.push('qqq');
    return keys;
  }

  function asOfLabel(key) {
    if (COINS[key]) return state.quotes[key].data ? 'live' : '';
    var ts = state.quotes[key].stamp;
    if (!S.isNum(ts)) return '';
    return new Date(ts).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }

  function renderMarkets() {
    var host = el('marketRows');
    if (!host) return;
    host.innerHTML = marketKeys().map(function (key) {
      var meta = INSTRUMENTS[key], d = state.quotes[key].data;
      var series = seriesFor(key);
      var spark = series
        ? G.sparkStep({ values: S.tail(series, 60), w: 150, h: 34, color: meta.color })
        : '';
      var label = asOfLabel(key);
      return '<li>' +
        '<div class="row-name"><div class="row-code">' + F.escapeHtml(meta.code) + '</div>' +
        '<div class="row-desc">' + F.escapeHtml(meta.desc + (label ? ' · ' + label : '')) + '</div></div>' +
        '<div class="row-spark">' + spark + '</div>' +
        '<div class="row-px">' + (d && S.isNum(d.price) ? F.num(d.price, meta.dp) : F.DASH) + '</div>' +
        '<div class="row-chg"><span class="' + changeClass(d && d.changePct) + '">' +
        (d && S.isNum(d.changePct) ? F.signedPctPoints(d.changePct) : F.DASH) + '</span></div>' +
        '</li>';
    }).join('');

    setHtml('marketNotice', noticeHtml(state.quotes.btc.notice || state.snapshot.notice));
    repaint();
  }

  /* The stamp tracks bitcoin, the one instrument that is actually live; the
   * snapshot instruments carry their own as-of time in the Markets rows. */
  function renderStamp() {
    var ts = state.quotes.btc.stamp;
    setText('quoteStamp', S.isNum(ts) ? F.ago(ts) : '—');
  }

  function coinIds() {
    var ids = [COINS.btc, COINS.eth];
    var pick = MP.spotlight && MP.spotlight.cryptoId ? MP.spotlight.cryptoId() : null;
    if (pick && ids.indexOf(pick) < 0) ids.push(pick);
    return ids;
  }

  /* One CoinGecko call covers bitcoin, ether and the crypto of the week. */
  function loadCoins() {
    var spec = SRC.coinsMarkets(coinIds());
    return fetchJson(spec.url).then(function (payload) {
      var coins = spec.normalize(payload);
      if (!coins || !coins[COINS.btc]) throw emptyError();
      var now = Date.now();
      Object.keys(COINS).forEach(function (key) {
        var c = coins[COINS[key]];
        if (!c) return;
        var slot = state.quotes[key];
        slot.data = c;
        slot.stamp = now;
        slot.notice = null;
      });
      if (MP.spotlight && MP.spotlight.setCryptoQuote) {
        var pick = MP.spotlight.cryptoId();
        MP.spotlight.setCryptoQuote(pick && coins[pick] ? coins[pick] : null);
      }
    }).catch(function (err) {
      state.quotes.btc.notice = liveNotice('CoinGecko', err);
      throw err;
    }).then(function () {
      renderHero(); renderMarkets(); renderStamp();
    }, function (err) {
      renderHero(); renderMarkets();
      throw err;
    });
  }

  function applySnapshotQuote(key, q) {
    var slot = state.quotes[key];
    slot.data = q || null;
    slot.stamp = !q ? null : S.isNum(q.timestamp) ? q.timestamp : S.isNum(q.fetchedAt) ? q.fetchedAt : null;
  }

  function loadQuotes() {
    return fetchJson(snapshotUrl(SRC.SNAPSHOT.quotes)).then(function (payload) {
      var snap = SRC.normalizeQuotesSnapshot(payload);
      if (!snap) throw emptyError();
      applySnapshotQuote('ixic', snap.ixic);
      applySnapshotQuote('spx', snap.spx);
      applySnapshotQuote('qqq', snap.qqq);
      state.snapshot.generatedAt = snap.generatedAt;
      state.snapshot.notice = staleNotice(snap.generatedAt);
      if (MP.spotlight) MP.spotlight.setQuote(snap.spotlight);
    }).catch(function (err) {
      state.snapshot.notice = snapshotNotice(err, 'Nasdaq data');
      throw err;
    }).then(renderMarkets, function (err) {
      renderMarkets();
      throw err;
    });
  }

  /* ---- session ------------------------------------------------------------ */
  function renderSession() {
    var d = state.session.data;
    var dot = el('sessionDot');
    var open = d && d.equityStatus === 'open';
    if (dot) {
      dot.classList.toggle('is-open', !!open);
      dot.classList.toggle('is-closed', !!(d && !open));
    }
    setText('sessionText', d && d.equityStatus ? (open ? 'Market open' : 'Market closed') : 'Market —');
  }

  function tickSession() {
    var st = SES.status(Date.now());
    state.session.data = { equityStatus: st.open ? 'open' : 'closed', phase: st.phase };
    renderSession();
  }

  /* ---- analytics ---------------------------------------------------------- */
  function computeAnalytics() {
    var btc = state.history.btc, ixic = state.history.ixic, qqq = state.history.qqq;
    if (!btc || !ixic) return null;

    var pair = S.alignByDate(btc, ixic);
    if (pair.dates.length < VOL_WINDOW + 2) return null;

    var btcR = S.logReturns(pair.a);
    var ixicR = S.logReturns(pair.b);
    var retDates = pair.dates.slice(1);

    var scatterPair = S.pairwiseClean(S.tail(ixicR, SCATTER_SESSIONS), S.tail(btcR, SCATTER_SESSIONS));
    var volFn = function (w) { return S.annualizedVol(w, ANNUALIZE); };
    var btcVol = S.rolling(btcR, VOL_WINDOW, volFn);
    var ixicVol = S.rolling(ixicR, VOL_WINDOW, volFn);

    var btcSorted = S.sortSeries(btc), ixicSorted = S.sortSeries(ixic);
    var btcPrices = btcSorted.map(function (p) { return p.price; });
    var ixicPrices = ixicSorted.map(function (p) { return p.price; });
    var btcDates = btcSorted.map(function (p) { return p.date; });
    var ixicDates = ixicSorted.map(function (p) { return p.date; });

    var qqqCoupling = null;
    if (qqq && qqq.length > 40) {
      var qPair = S.alignByDate(btc, qqq);
      if (qPair.dates.length > 40) {
        qqqCoupling = S.couplingWindows(S.logReturns(qPair.a), S.logReturns(qPair.b), [30, 90]);
      }
    }

    var btcDd = S.drawdownSeries(btcPrices);
    var ixicDd = S.drawdownSeries(ixicPrices);

    return {
      dates: retDates,
      commonSessions: pair.dates.length,
      windowFrom: pair.dates[0],
      windowTo: pair.dates[pair.dates.length - 1],
      coupling: S.couplingWindows(btcR, ixicR, COUPLING_WINDOWS),
      qqqCoupling: qqqCoupling,
      scatter: { xs: scatterPair.a, ys: scatterPair.b, fit: S.regression(scatterPair.a, scatterPair.b) },
      rollCorr: S.rollingPair(btcR, ixicR, CORR_WINDOW, S.pearson),
      rollBeta: S.rollingPair(btcR, ixicR, CORR_WINDOW, S.beta),
      btcVol: btcVol,
      ixicVol: ixicVol,
      currentBtcVol: btcVol.length ? btcVol[btcVol.length - 1].value : NaN,
      currentIxicVol: ixicVol.length ? ixicVol[ixicVol.length - 1].value : NaN,
      btcDd: { dates: btcDates, series: btcDd, now: btcDd[btcDd.length - 1], max: S.maxDrawdown(btcPrices) },
      ixicDd: { dates: ixicDates, series: ixicDd, now: ixicDd[ixicDd.length - 1], max: S.maxDrawdown(ixicPrices) },
      btcEpisodes: S.drawdownEpisodes(btcDates, btcPrices, { minDepth: 0.05, limit: 4 }),
      ixicEpisodes: S.drawdownEpisodes(ixicDates, ixicPrices, { minDepth: 0.03, limit: 4 })
    };
  }

  function strip(items) {
    return items.map(function (it) {
      return '<div><div class="stat-label">' + F.escapeHtml(it[0]) + '</div>' +
        '<div class="stat-value' + (it[2] ? ' ' + it[2] : '') + '">' + F.escapeHtml(it[1]) + '</div></div>';
    }).join('');
  }

  function datesForRolling(entries, dates, count) {
    return S.tail(entries, count).map(function (e) { return dates[e.index] || ''; });
  }

  function renderAnalytics() {
    var a = state.analytics;
    setHtml('notice-history', noticeHtml(state.history.notice));

    if (!a) {
      var waiting = state.history.pending ? '—' : F.DASH;
      setHtml('couplingStrip', strip([['Corr 90d', waiting], ['Beta 90d', waiting], ['R² 90d', waiting]]));
      setHtml('volStrip', strip([['BTC 30d', waiting], ['^IXIC 30d', waiting], ['Ratio', waiting]]));
      setHtml('ddStrip', strip([['BTC now', waiting], ['BTC worst', waiting], ['^IXIC worst', waiting]]));
      repaint();
      return;
    }

    /* coupling */
    var c90 = a.coupling[1] || a.coupling[0];
    setHtml('couplingStrip', strip([
      ['Corr 90d', F.ratio(c90.correlation, 2)],
      ['Beta 90d', F.ratio(c90.beta, 2)],
      ['R² 90d', F.ratio(c90.r2, 2)]
    ]));

    var rows = a.coupling.map(function (c) {
      return '<tr><th scope="row">' + c.window + 'd</th><td>' + F.ratio(c.correlation, 3) +
        '</td><td>' + F.ratio(c.beta, 3) + '</td><td>' + F.ratio(c.r2, 3) +
        '</td><td class="dim">' + c.n + '</td></tr>';
    }).join('');
    if (a.qqqCoupling) {
      rows += '<tr class="row-rule"><th scope="row" colspan="5">vs QQQ</th></tr>';
      rows += a.qqqCoupling.map(function (c) {
        return '<tr><th scope="row">' + c.window + 'd</th><td>' + F.ratio(c.correlation, 3) +
          '</td><td>' + F.ratio(c.beta, 3) + '</td><td>' + F.ratio(c.r2, 3) +
          '</td><td class="dim">' + c.n + '</td></tr>';
      }).join('');
    }
    setHtml('couplingTable',
      '<table class="data"><thead><tr><th scope="col">Window</th><th scope="col">Corr</th>' +
      '<th scope="col">Beta</th><th scope="col">R²</th><th scope="col">n</th></tr></thead><tbody>' +
      rows + '</tbody></table>');

    setHtml('chartScatter', G.scatterFit({
      xs: a.scatter.xs, ys: a.scatter.ys, fit: a.scatter.fit,
      w: 560, h: 320,
      pointColor: 'var(--c-btc)', fitColor: 'var(--gold)',
      xTitle: '^IXIC', yTitle: 'BTC'
    }));
    setText('scatterCaption', 'Daily log returns, ' + a.scatter.fit.n + ' sessions. Slope β=' +
      F.ratio(a.scatter.fit.slope, 2) + ', axes scaled independently.');

    setHtml('chartRollCorr', G.stepChart({
      series: [{ values: S.tail(a.rollCorr, CORR_CHART_POINTS).map(function (e) { return e.value; }), color: 'var(--c-idx)' }],
      w: 900, h: 170, yDomain: [-1, 1], zeroLine: true, tickCount: 4,
      yFmt: function (v) { return v.toFixed(1); },
      xLabels: datesForRolling(a.rollCorr, a.dates, CORR_CHART_POINTS).map(F.shortDate)
    }));

    /* volatility */
    var volRatio = S.isNum(a.currentBtcVol) && S.isNum(a.currentIxicVol) && a.currentIxicVol
      ? a.currentBtcVol / a.currentIxicVol : NaN;
    setHtml('volStrip', strip([
      ['BTC 30d', F.pct(a.currentBtcVol, 0)],
      ['^IXIC 30d', F.pct(a.currentIxicVol, 0)],
      ['Ratio', S.isNum(volRatio) ? F.ratio(volRatio, 1) + '×' : F.DASH]
    ]));
    setHtml('chartVol', G.columnChart({
      series: [
        { values: S.tail(a.btcVol, VOL_CHART_POINTS).map(function (e) { return e.value; }), color: 'var(--c-btc)' },
        { values: S.tail(a.ixicVol, VOL_CHART_POINTS).map(function (e) { return e.value; }), color: 'var(--c-idx)' }
      ],
      w: 900, h: 190,
      yFmt: function (v) { return (v * 100).toFixed(0) + '%'; },
      xLabels: datesForRolling(a.btcVol, a.dates, VOL_CHART_POINTS).map(F.shortDate)
    }));

    /* drawdown */
    setHtml('ddStrip', strip([
      ['BTC now', F.signedPct(a.btcDd.now, 1), 'neg'],
      ['BTC worst', F.signedPct(a.btcDd.max, 1), 'neg'],
      ['^IXIC worst', F.signedPct(a.ixicDd.max, 1), 'neg']
    ]));
    setHtml('chartDdBtc', G.underwaterChart({
      values: a.btcDd.series, w: 900, h: 150, color: 'var(--c-btc)',
      xLabels: a.btcDd.dates.map(F.shortDate)
    }));
    setHtml('chartDdIxic', G.underwaterChart({
      values: a.ixicDd.series, w: 900, h: 150, color: 'var(--c-idx)',
      xLabels: a.ixicDd.dates.map(F.shortDate)
    }));

    var episodes = a.btcEpisodes.map(function (e) { return { code: 'BTC', e: e }; })
      .concat(a.ixicEpisodes.map(function (e) { return { code: '^IXIC', e: e }; }))
      .sort(function (p, q) { return p.e.depth - q.e.depth; });

    setHtml('ddTable', episodes.length
      ? '<table class="data"><thead><tr><th scope="col">Asset</th><th scope="col">Depth</th>' +
        '<th scope="col">Peak</th><th scope="col">Trough</th><th scope="col">Recovered</th>' +
        '</tr></thead><tbody>' + episodes.map(function (r) {
          return '<tr><th scope="row">' + F.escapeHtml(r.code) + '</th>' +
            '<td class="neg">' + F.signedPct(r.e.depth, 1) + '</td>' +
            '<td class="dim">' + F.shortDate(r.e.peakDate) + '</td>' +
            '<td class="dim">' + F.shortDate(r.e.troughDate) + '</td>' +
            '<td>' + (r.e.ongoing ? '<span class="tag">not yet</span>' : F.shortDate(r.e.recoveryDate)) + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '');
    repaint();
  }

  /* ---- history ------------------------------------------------------------ */
  function loadHistory() {
    function finish() {
      state.history.pending = false;
      state.analytics = computeAnalytics();
      renderAnalytics();
      renderMarkets();
    }

    return fetchJson(snapshotUrl(SRC.SNAPSHOT.history)).then(function (payload) {
      var snap = SRC.normalizeHistorySnapshot(payload);
      if (snap && snap.btc && snap.ixic) {
        state.history.btc = snap.btc;
        state.history.ixic = snap.ixic;
        state.history.spx = snap.spx;
        state.history.qqq = snap.qqq;
        state.history.notice = null;
      } else if (!state.history.btc) {
        state.history.notice = { level: 'quiet', text: 'Daily history appears after the first scheduled update.' };
      }
    }).catch(function (err) {
      if (!state.history.btc) state.history.notice = snapshotNotice(err, 'Daily history');
      throw err;
    }).then(finish, function (err) {
      finish();
      throw err;
    });
  }

  function loadSpotlight() {
    if (!MP.spotlight) return Promise.resolve();
    return fetchJson(snapshotUrl(SRC.SNAPSHOT.spotlight)).then(function (payload) {
      var snap = SRC.normalizeSpotlightSnapshot(payload);
      if (!snap) throw emptyError();
      MP.spotlight.applySnapshot(snap);
    }).catch(function (err) {
      MP.spotlight.setNotice(snapshotNotice(err, 'This week’s pick'));
      throw err;
    });
  }

  /* ---- offline ------------------------------------------------------------ */
  function renderOffline(reason) {
    state.history.pending = false;
    setHtml('pageNotice', '<p class="notice">' + F.escapeHtml(reason) + '</p>');
    renderHero();
    renderMarkets();
    renderAnalytics();
  }

  /* ---- boot --------------------------------------------------------------- */
  function start() {
    /* The meter subscribes to the router, so it must exist before the router
     * announces the first stop. */
    if (MP.meter) MP.meter.init();
    if (MP.router) MP.router.start();
    tickSession();
    renderHero();
    renderMarkets();
    renderAnalytics();
    if (MP.spotlight) MP.spotlight.render();
    wirePills();
    every(renderStamp, 1000);
    every(tickSession, SESSION_TICK_MS);

    if (typeof root.fetch !== 'function') {
      renderOffline('This browser cannot load live data. Try a current version of Chrome, Safari, Firefox or Edge.');
      return;
    }

    poll(loadCoins, BTC_REFRESH_MS);
    poll(loadQuotes, SNAPSHOT_REFRESH_MS);
    poll(loadHistory, DAILY_REFRESH_MS);
    poll(loadSpotlight, DAILY_REFRESH_MS);
    poll(function () { loadHeroRange(state.hero.days, true); }, HERO_REFRESH_MS);
  }

  /* Stops every poll and timer. The debug bundle calls it before rendering
   * synthetic data so live responses do not overwrite it. */
  function stop() {
    state.teardown.splice(0).forEach(function (fn) {
      try { fn(); } catch (e) { /* already stopped */ }
    });
  }

  MP.app = {
    start: start,
    stop: stop,
    state: state,
    computeAnalytics: computeAnalytics,
    renderAnalytics: renderAnalytics,
    renderHero: renderHero,
    renderMarkets: renderMarkets,
    renderSession: renderSession,
    reading: reading,
    loadHeroRange: loadHeroRange,
    INSTRUMENTS: INSTRUMENTS,
    config: {
      BTC_REFRESH_MS: BTC_REFRESH_MS,
      SNAPSHOT_REFRESH_MS: SNAPSHOT_REFRESH_MS,
      VOL_WINDOW: VOL_WINDOW,
      CORR_WINDOW: CORR_WINDOW,
      COUPLING_WINDOWS: COUPLING_WINDOWS,
      ANNUALIZE: ANNUALIZE
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
