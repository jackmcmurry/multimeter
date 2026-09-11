/* ============================================================================
 * app.js: state, data wiring, analytics assembly, rendering.
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
  var S = MP.stats, F = MP.fmt, G = MP.geom, SRC = MP.sources, SES = MP.session;

  /* ---- configuration ------------------------------------------------------ */
  var BTC_REFRESH_MS = 45000;
  var SNAPSHOT_REFRESH_MS = 60000;
  var DAILY_REFRESH_MS = 30 * 60000;
  var HERO_REFRESH_MS = 5 * 60000;
  var NOTE_REFRESH_MS = 30 * 60000;
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

  /* CoinGecko ids for the live coins; the probe (a coin the viewer chose) and
   * the crypto of the week join them once known. */
  var COINS = { btc: 'bitcoin', eth: 'ethereum' };

  var STAT_COINS = ['btc', 'eth', 'crypto', 'probe'];
  var STAT_INDEXES = ['ixic', 'spx'];
  var INDEX_META = {
    ixic: { key: 'ixic', code: '^IXIC', short: 'NDQ', name: 'Nasdaq' },
    spx: { key: 'spx', code: '^GSPC', short: 'SPX', name: 'S&P 500' }
  };

  function readProbe(v) {
    return v && typeof v === 'object' && typeof v.id === 'string' && typeof v.symbol === 'string'
      ? { id: v.id, symbol: String(v.symbol).toUpperCase().slice(0, 12), name: typeof v.name === 'string' ? v.name : v.symbol }
      : null;
  }

  function readStats(v) {
    var out = { coin: 'btc', index: 'ixic' };
    if (v && STAT_COINS.indexOf(v.coin) >= 0) out.coin = v.coin;
    if (v && STAT_INDEXES.indexOf(v.index) >= 0) out.index = v.index;
    return out;
  }

  var state = {
    quotes: {
      btc: { data: null, stamp: null, notice: null },
      eth: { data: null, stamp: null, notice: null },
      probe: { data: null, stamp: null, notice: null },
      ixic: { data: null, stamp: null, notice: null },
      spx: { data: null, stamp: null, notice: null },
      qqq: { data: null, stamp: null, notice: null }
    },
    /* the viewer's own coin, and the pair the statistics measure */
    probe: readProbe(MP.store ? MP.store.get('probe', null) : null),
    stats: readStats(MP.store ? MP.store.get('stats', null) : null),
    search: { query: '', results: null, pending: false, notice: null },
    /* the daily reading, from data/note.json */
    note: { data: null, notice: null },
    snapshot: { generatedAt: null, notice: null },
    session: { data: null },
    history: { btc: null, ixic: null, spx: null, qqq: null, notice: null, pending: true },
    analytics: null,
    /* range charts per coin and range, keyed 'coinId:days' */
    hero: { days: 1, notice: null, cache: {}, pending: {} },
    /* last Coinbase tick per product, with the client-clock time it landed */
    live: { ticks: {}, status: null, fresh: false },
    teardown: []
  };

  var LIVE_FRESH_MS = 60000;   /* a tick older than this yields to the poll */
  var LIVE_STOPS = ['btc', 'eth', 'crypto', 'probe'];

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
    /* A CORS-less 429 reaches the page as a plain network failure, so this
     * is as often a rate limit as an outage. */
    return { level: 'warn', text: 'Could not reach ' + source + ' (or it is rate limiting this browser). Retrying shortly.' };
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
    checkAlerts();
    if (MP.meter && MP.meter.refresh) MP.meter.refresh();
  }

  /* ---- alerts ------------------------------------------------------------- */

  /* Every armed alert is checked against its own stop's current reading on
   * every repaint, whatever the dial shows and whether or not HOLD is on. */
  function checkAlerts() {
    if (!MP.alerts) return;
    var stops = MP.alerts.armedStops();
    if (!stops.length) return;
    var fired = [];
    stops.forEach(function (stop) {
      var res = MP.alerts.evaluate(MP.alerts.all(), stop, reading(stop).value, Date.now());
      if (res.fired.length) {
        MP.alerts.save(res.alerts);
        fired = fired.concat(res.fired);
      }
    });
    if (!fired.length) return;
    if (MP.meter && MP.meter.alarm) {
      MP.meter.alarm(fired.map(function (a) { return MP.alerts.describe(a, formatValue); }));
    }
    renderAlerts();
  }

  function renderAlerts() {
    var host = el('alertRows');
    if (!host || !MP.alerts) return;
    var list = MP.alerts.all().slice().sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
    host.innerHTML = list.length ? list.map(function (a) {
      var when = a.fired ? 'fired ' + F.ago(a.fired) : 'armed · set ' + F.ago(a.created);
      return '<li' + (a.fired ? ' class="is-fired"' : '') + '>' +
        '<div class="row-name"><div class="row-code">' + F.escapeHtml(MP.alerts.describe(a, formatValue)) + '</div>' +
        '<div class="row-desc">' + F.escapeHtml(when) + '</div></div>' +
        '<span class="tag">' + (a.fired ? 'fired' : 'armed') + '</span>' +
        '<button type="button" class="pill" data-del="' + F.escapeHtml(a.id) + '" aria-label="Delete alert">✕</button>' +
        '</li>';
    }).join('') : '<li class="row-desc">No alerts yet. Press ALERT on the meter to set one.</li>';
  }

  function wireAlerts() {
    var host = el('alertRows');
    if (!host) return;
    host.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-del]') : null;
      if (!btn || !MP.alerts) return;
      MP.alerts.remove(btn.getAttribute('data-del'));
      renderAlerts();
      repaint();
    });
  }

  /* ---- the meter's reading ------------------------------------------------ */

  /* One dial stop -> one reading:
   *   { text, unit, mode, change: { pct, abs, delta, suffix, label, dp },
   *     spark, empty, ranges, coin }
   * text is the value already formatted for the screen. change carries a
   * percent and an absolute move for prices, or a plain delta in the
   * reading's own units for the statistics. ranges is true for the coins,
   * whose chart follows the screen's range tabs. Never throws: a stop whose
   * data has not arrived reads a dash. */
  function noReading(unit, mode, label) {
    return {
      text: F.DASH, value: NaN, dp: 2, unit: unit, mode: mode,
      change: { pct: NaN, abs: NaN, delta: NaN, suffix: '', label: label, dp: 2 },
      spark: null, empty: true, ranges: false, coin: null
    };
  }

  /* A raw number in a stop's own display units, formatted the way the screen
   * shows it. Used by the alert editor, the MIN/MAX row and the alerts list. */
  function formatValue(stop, v) {
    if (!S.isNum(v)) return F.DASH;
    var r = reading(stop);
    if (r.unit === 'USD') return money(v);
    if (r.unit === 'INDEX') return F.num(v, 2);
    return F.num(v, r.dp) + (r.unit || '');
  }

  var SPARK_POINTS = 120;   /* how much history the screen shows when it is not a range */

  /* Prices under ten dollars need the extra decimals; everything else reads
   * like a brokerage: two, with thousands separators. */
  function money(v) {
    return S.isNum(v) ? F.usd(v, Math.abs(v) < 10 ? 4 : 2) : F.DASH;
  }

  function quoteReading(key, unit, mode, changeLabel) {
    var d = state.quotes[key].data;
    var price = d && S.isNum(d.price) ? d.price : NaN;
    var pct = d && S.isNum(d.changePct) ? d.changePct : NaN;
    var series = seriesFor(key);
    return {
      text: unit === 'USD' ? money(price) : (S.isNum(price) ? F.num(price, 2) : F.DASH),
      value: price, dp: 2, unit: unit, mode: mode,
      change: {
        pct: pct,
        abs: S.isNum(pct) && S.isNum(price) ? price - price / (1 + pct / 100) : NaN,
        delta: NaN, suffix: '', label: changeLabel, dp: 2
      },
      spark: series ? S.tail(series, SPARK_POINTS) : null,
      empty: !S.isNum(price), ranges: false, coin: null
    };
  }

  /* Coins carry the screen's range tabs: the chart and the change follow the
   * chosen range, the price stays live spot. Until the range has loaded, the
   * 24-hour change from the quote stands in. */
  function withRange(r, coinId) {
    if (!coinId) return r;
    r.ranges = true;
    r.coin = coinId;
    r.change.label = RANGE_LABELS[state.hero.days] || '24H';
    var series = rangeSeries(coinId);
    if (series && series.length > 1 && series[0] > 0) {
      r.spark = series;
      r.change.pct = (series[series.length - 1] / series[0] - 1) * 100;
      r.change.abs = series[series.length - 1] - series[0];
    } else if (state.hero.days !== 1) {
      r.change.pct = NaN;
      r.change.abs = NaN;
    }
    return r;
  }

  /* The two weekly picks share a shape: { price, changePct, changeLabel,
   * mode, series } from spotlight.js, or null before the scan has run. */
  function pickReading(r, fallbackMode) {
    if (!r) return noReading('USD', fallbackMode, '1D');
    var pct = r.changePct;
    var dp = S.isNum(r.price) && Math.abs(r.price) < 10 ? 4 : 2;
    return {
      text: money(r.price), value: r.price, dp: dp,
      unit: 'USD', mode: r.mode,
      change: {
        pct: pct,
        abs: S.isNum(pct) && S.isNum(r.price) ? r.price - r.price / (1 + pct / 100) : NaN,
        delta: NaN, suffix: '', label: r.changeLabel, dp: dp
      },
      spark: r.series ? S.tail(r.series, SPARK_POINTS) : null,
      empty: !S.isNum(r.price), ranges: false, coin: null
    };
  }

  function stockReading() {
    return pickReading(MP.spotlight && MP.spotlight.reading ? MP.spotlight.reading() : null, 'STOCK');
  }

  function probeReading() {
    if (!state.probe) {
      var r = noReading('USD', 'PROBE', '24H');
      r.hint = 'Press DATA to choose a coin';
      return r;
    }
    return applyLive(withRange(quoteReading('probe', 'USD', state.probe.symbol + ' / USD', '24H'), state.probe.id), 'probe');
  }

  function cryptoReading() {
    var r = pickReading(MP.spotlight && MP.spotlight.cryptoReading ? MP.spotlight.cryptoReading() : null, 'CRYPTO');
    return withRange(r, coinForStop('crypto'));
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

  var ANALYTICS_UNIT = { corr: '', beta: '×', vol: '%', dd: '%' };

  /* The screen's mode line names the pair the statistics measure. */
  function analyticsMode(stop) {
    var l = statsLabels();
    if (stop === 'corr') return 'CORR ' + l.coin + '·' + l.indexShort + ' 90D';
    if (stop === 'beta') return 'BETA ' + l.coin + '·' + l.indexShort + ' 90D';
    if (stop === 'vol') return 'VOL ' + l.coin + ' 30D';
    return 'DRAWDOWN ' + l.coin;
  }

  function analyticsReading(stop) {
    var a = state.analytics;
    if (!a) return noReading(ANALYTICS_UNIT[stop], analyticsMode(stop), '30S');
    var c90 = a.coupling[1] || a.coupling[0];
    var value, series, dp, scale = 1, suffix = '';
    if (stop === 'corr') { value = c90.correlation; series = entryValues(a.rollCorr); dp = 2; }
    else if (stop === 'beta') { value = c90.beta; series = entryValues(a.rollBeta); dp = 2; }
    else if (stop === 'vol') { value = a.currentCoinVol; series = entryValues(a.coinVol); dp = 1; scale = 100; suffix = '%'; }
    else { value = a.coinDd.now; series = a.coinDd.series; dp = 1; scale = 100; suffix = '%'; }
    var shown = S.isNum(value) ? value * scale : NaN;
    var text = !S.isNum(shown) ? F.DASH
      : stop === 'corr' || stop === 'beta' ? F.ratio(shown, dp)
      : stop === 'dd' ? F.signedPct(value, dp)
      : F.pct(value, dp);
    return {
      text: text, value: shown, dp: dp, unit: ANALYTICS_UNIT[stop], mode: analyticsMode(stop),
      change: { pct: NaN, abs: NaN, delta: deltaBack(series, CORR_WINDOW) * scale, suffix: suffix, label: '30S', dp: dp },
      spark: S.tail(series, SPARK_POINTS),
      empty: !S.isNum(value), ranges: false, coin: null
    };
  }

  function reading(stop) {
    switch (stop) {
      case 'btc': return applyLive(withRange(quoteReading('btc', 'USD', 'BTC / USD', '24H'), COINS.btc), stop);
      case 'eth': return applyLive(withRange(quoteReading('eth', 'USD', 'ETH / USD', '24H'), COINS.eth), stop);
      case 'nasdaq': return quoteReading('ixic', 'INDEX', 'NASDAQ COMPOSITE', '1D');
      case 'spx': return quoteReading('spx', 'INDEX', 'S&P 500', '1D');
      case 'qqq': return quoteReading('qqq', 'USD', 'QQQ', '1D');
      case 'stock': return stockReading();
      case 'crypto': return applyLive(cryptoReading(), stop);
      case 'probe': return probeReading();
      case 'note': return noteReading();
      case 'corr': case 'beta': case 'vol': case 'dd': return analyticsReading(stop);
      default: return noReading('', '', '');
    }
  }

  /* ---- live ticks (Coinbase) ---------------------------------------------- */

  /* The Coinbase product a stop can stream, or null. */
  function productForStop(stop) {
    var cb = SRC.coinbaseWs;
    if (stop === 'btc') return 'BTC-USD';
    if (stop === 'eth') return 'ETH-USD';
    if (stop === 'crypto') {
      var pick = MP.spotlight && MP.spotlight.view ? MP.spotlight.view.crypto : null;
      return pick && pick.symbol ? cb.productFor(pick.symbol) : null;
    }
    if (stop === 'probe') return state.probe && state.probe.symbol ? cb.productFor(state.probe.symbol) : null;
    return null;
  }

  function liveProducts() {
    var unsupported = (state.live.status && state.live.status.unsupported) || [];
    var out = [];
    LIVE_STOPS.forEach(function (stop) {
      var p = productForStop(stop);
      if (p && out.indexOf(p) < 0 && unsupported.indexOf(p) < 0) out.push(p);
    });
    return out;
  }

  function syncLive() {
    if (MP.live && MP.live.setProducts) MP.live.setProducts(liveProducts());
  }

  function freshTick(product) {
    var t = product ? state.live.ticks[product] : null;
    return t && Date.now() - t.at < LIVE_FRESH_MS ? t : null;
  }

  /* A tick repaints the screen only; the drawer keeps following the poll. */
  function applyTick(product, tick) {
    state.live.ticks[product] = { price: tick.price, open24h: tick.open24h, pct24h: tick.pct24h, at: Date.now() };
    if (product === 'BTC-USD') state.quotes.btc.stamp = Date.now();
    repaint();
  }

  /* While a tick is fresh the screen shows Coinbase's last trade instead of
   * the polled price: the price and value, the change (24-hour from the
   * ticker's own open, otherwise against the start of the chosen range) and
   * the chart's end point. The cached range series is never mutated. */
  function applyLive(r, stop) {
    var tick = freshTick(productForStop(stop));
    if (!tick || !S.isNum(tick.price)) return r;
    r.text = money(tick.price);
    r.value = tick.price;
    r.empty = false;
    r.live = true;
    var series = r.coin ? rangeSeries(r.coin) : null;
    if (state.hero.days !== 1 && series && series.length > 1 && series[0] > 0) {
      r.change.pct = (tick.price / series[0] - 1) * 100;
      r.change.abs = tick.price - series[0];
    } else if (S.isNum(tick.pct24h)) {
      r.change.pct = tick.pct24h;
      r.change.abs = tick.price - tick.open24h;
    }
    if (r.spark && r.spark.length) r.spark = r.spark.concat([tick.price]);
    return r;
  }

  /* Once a second: when the newest tick crosses the freshness line, repaint
   * so the LIVE lamp goes dark and the polled price takes over at once. */
  function watchLive() {
    var stop = currentStop();
    var fresh = !!freshTick(productForStop(stop));
    if (fresh !== state.live.fresh) {
      state.live.fresh = fresh;
      repaint();
    }
  }

  /* ---- ranges: the screen's tabs ------------------------------------------ */

  /* The CoinGecko id behind a quote key, when it is a coin. */
  function liveCoinId(key) {
    if (COINS[key]) return COINS[key];
    if (key === 'probe') return state.probe ? state.probe.id : null;
    return null;
  }

  function coinKeys() {
    return state.probe ? ['btc', 'eth', 'probe'] : ['btc', 'eth'];
  }

  /* The coin a stop measures, when it has range tabs; null otherwise. */
  function coinForStop(stop) {
    if (stop === 'btc') return COINS.btc;
    if (stop === 'eth') return COINS.eth;
    if (stop === 'probe') return state.probe ? state.probe.id : null;
    if (stop === 'crypto') return MP.spotlight && MP.spotlight.cryptoId ? MP.spotlight.cryptoId() : null;
    return null;
  }

  function currentStop() {
    return MP.router && MP.router.currentView ? MP.router.currentView() : null;
  }

  function rangeKey(coinId, days) { return coinId + ':' + days; }

  /* The cache holds the whole normalized chart ({ prices, stamps, startTs,
   * endTs }); the screen wants the prices, the statistics want the stamps. */
  function rangeEntry(coinId, days) {
    return (coinId && state.hero.cache[rangeKey(coinId, days === undefined ? state.hero.days : days)]) || null;
  }

  function rangeSeries(coinId) {
    var entry = rangeEntry(coinId);
    return entry ? entry.prices : null;
  }

  function seriesFor(key) {
    var coinId = liveCoinId(key);
    if (coinId) {
      var ranged = rangeSeries(coinId);
      if (ranged) return ranged;
    }
    var spot = state.quotes[key] && state.quotes[key].data;
    if (spot && spot.sparkline && spot.sparkline.length > 2) return spot.sparkline;
    var hist = state.history[key];
    return hist && hist.length > 2 ? S.tail(hist, 60).map(function (p) { return p.price; }) : null;
  }

  /* The drawer's BTC panel: the range chart in the printed style. */
  function renderHero() {
    var spot = state.quotes.btc.data;
    var series = rangeSeries(COINS.btc);
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
      var shown = series || seriesFor('btc');
      host.innerHTML = shown && shown.length > 1
        ? G.sparkStep({ values: shown, w: 900, h: 230, color: 'var(--c-btc)', area: true, strokeWidth: 1.8 })
        : '';
    }
    setHtml('heroNotice', noticeHtml(state.hero.notice || state.quotes.btc.notice));
    repaint();
  }

  /* Fetches one coin's chart for one range and caches it, so switching tabs
   * or stops back and forth is instant after the first load. */
  function loadRange(coinId, days, refresh) {
    if (!coinId) return Promise.resolve();
    var key = rangeKey(coinId, days);
    if (state.hero.cache[key] && !refresh) { renderHero(); return Promise.resolve(); }
    if (state.hero.pending[key]) return Promise.resolve();
    state.hero.pending[key] = true;

    var spec = SRC.coinChart(coinId, days);
    return fetchJson(spec.url).then(function (payload) {
      var parsed = spec.normalize(payload);
      if (!parsed) throw emptyError();
      state.hero.cache[key] = parsed;
      state.hero.notice = null;
      /* a year of daily closes is also a statistics leg */
      if (days === 365 && statsCoinId(state.stats.coin) === coinId) recomputeAnalytics();
    }).catch(function (err) {
      state.hero.notice = liveNotice('CoinGecko', err);
      throw err;
    }).then(function () {
      delete state.hero.pending[key];
      renderHero();
    }, function (err) {
      delete state.hero.pending[key];
      renderHero();
      throw err;
    });
  }

  /* The screen's range tab: applies to whichever coin is on the dial. */
  function setRange(days) {
    if (!RANGE_LABELS[days]) return;
    state.hero.days = days;
    renderHero();
    loadRange(coinForStop(currentStop()), days).catch(function () { /* shown as a notice */ });
  }

  /* Landing on a coin stop fetches its range if it is not cached yet. */
  function ensureRange(stop) {
    var coin = coinForStop(stop);
    if (coin) loadRange(coin, state.hero.days).catch(function () { /* shown as a notice */ });
  }

  /* ---- markets ------------------------------------------------------------ */

  /* QQQ is optional upstream (it needs a second API key), so its row appears
   * only once there is something to show. */
  function marketKeys() {
    var keys = coinKeys().concat(['ixic', 'spx']);
    if (state.quotes.qqq.data || state.history.qqq) keys.push('qqq');
    return keys;
  }

  /* The probe's row is described by whatever coin the viewer chose. */
  function instrument(key) {
    if (key === 'probe') {
      return state.probe
        ? { code: state.probe.symbol + ' / USD', desc: state.probe.name, dp: 2, color: 'var(--c-probe)' }
        : { code: 'PROBE', desc: 'No coin chosen', dp: 2, color: 'var(--c-probe)' };
    }
    return INSTRUMENTS[key];
  }

  function asOfLabel(key) {
    if (liveCoinId(key)) return state.quotes[key].data ? 'live' : '';
    var ts = state.quotes[key].stamp;
    if (!S.isNum(ts)) return '';
    return new Date(ts).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }

  function renderMarkets() {
    var host = el('marketRows');
    if (!host) return;
    host.innerHTML = marketKeys().map(function (key) {
      var meta = instrument(key), d = state.quotes[key].data;
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
    var ids = coinKeys().map(liveCoinId);
    var pick = MP.spotlight && MP.spotlight.cryptoId ? MP.spotlight.cryptoId() : null;
    if (pick && ids.indexOf(pick) < 0) ids.push(pick);
    return ids;
  }

  /* One CoinGecko call covers bitcoin, ether, the probe and the crypto of the week. */
  function loadCoins() {
    var spec = SRC.coinsMarkets(coinIds());
    return fetchJson(spec.url).then(function (payload) {
      var coins = spec.normalize(payload);
      if (!coins || !coins[COINS.btc]) throw emptyError();
      var now = Date.now();
      coinKeys().forEach(function (key) {
        var c = coins[liveCoinId(key)];
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

  /* Which coin and index the statistics measure, as the labels the panels
   * print: coin symbol, index code (^IXIC) and its short form (NDQ). */
  function statsCoinId(coinKey) {
    if (coinKey === 'btc') return COINS.btc;
    if (coinKey === 'eth') return COINS.eth;
    if (coinKey === 'crypto') return MP.spotlight && MP.spotlight.cryptoId ? MP.spotlight.cryptoId() : null;
    if (coinKey === 'probe') return state.probe ? state.probe.id : null;
    return null;
  }

  function statsCoinSymbol(coinKey) {
    if (coinKey === 'btc') return 'BTC';
    if (coinKey === 'eth') return 'ETH';
    if (coinKey === 'crypto') {
      var pick = MP.spotlight && MP.spotlight.view ? MP.spotlight.view.crypto : null;
      return pick ? pick.symbol : null;
    }
    if (coinKey === 'probe') return state.probe ? state.probe.symbol : null;
    return null;
  }

  function statsLabels() {
    var idx = INDEX_META[state.stats.index] || INDEX_META.ixic;
    return {
      coinKey: state.stats.coin,
      coin: statsCoinSymbol(state.stats.coin) || 'BTC',
      indexKey: idx.key,
      index: idx.code,
      indexShort: idx.short,
      indexName: idx.name
    };
  }

  /* Daily closes for the coin under measurement. Bitcoin's come from the
   * data job (FMP); any other coin's from its cached one-year CoinGecko
   * chart, which the 1Y range tab shares, dated as closes. */
  var dailyMemo = { entry: null, series: null };

  function coinHistory(coinKey) {
    if (coinKey === 'btc') return state.history.btc;
    var id = statsCoinId(coinKey);
    var entry = id ? rangeEntry(id, 365) : null;
    if (!entry) return null;
    if (dailyMemo.entry !== entry) {
      dailyMemo.entry = entry;
      dailyMemo.series = SRC.dailySeries(entry);
    }
    return dailyMemo.series;
  }

  function ensureCoinHistory() {
    var coinKey = state.stats.coin;
    if (coinKey === 'btc') return;
    var id = statsCoinId(coinKey);
    if (id && !rangeEntry(id, 365)) loadRange(id, 365).catch(function () { /* shown as a notice */ });
  }

  function recomputeAnalytics() {
    state.analytics = computeAnalytics();
    renderAnalytics();
  }

  function computeAnalytics() {
    var labels = statsLabels();
    return analyticsFor(coinHistory(state.stats.coin), state.history[labels.indexKey], state.history.qqq, labels);
  }

  /* coin, index, qqq: [{ date, price }] series. Null until both legs have
   * at least VOL_WINDOW + 2 sessions in common. */
  function analyticsFor(coin, index, qqq, labels) {
    if (!coin || !index) return null;

    var pair = S.alignByDate(coin, index);
    if (pair.dates.length < VOL_WINDOW + 2) return null;

    var coinR = S.logReturns(pair.a);
    var indexR = S.logReturns(pair.b);
    var retDates = pair.dates.slice(1);

    var scatterPair = S.pairwiseClean(S.tail(indexR, SCATTER_SESSIONS), S.tail(coinR, SCATTER_SESSIONS));
    var volFn = function (w) { return S.annualizedVol(w, ANNUALIZE); };
    var coinVol = S.rolling(coinR, VOL_WINDOW, volFn);
    var indexVol = S.rolling(indexR, VOL_WINDOW, volFn);

    var coinSorted = S.sortSeries(coin), indexSorted = S.sortSeries(index);
    var coinPrices = coinSorted.map(function (p) { return p.price; });
    var indexPrices = indexSorted.map(function (p) { return p.price; });
    var coinDates = coinSorted.map(function (p) { return p.date; });
    var indexDates = indexSorted.map(function (p) { return p.date; });

    var qqqCoupling = null;
    if (qqq && qqq.length > 40) {
      var qPair = S.alignByDate(coin, qqq);
      if (qPair.dates.length > 40) {
        qqqCoupling = S.couplingWindows(S.logReturns(qPair.a), S.logReturns(qPair.b), [30, 90]);
      }
    }

    var coinDd = S.drawdownSeries(coinPrices);
    var indexDd = S.drawdownSeries(indexPrices);

    return {
      labels: labels || { coin: 'BTC', index: '^IXIC', indexShort: 'NDQ' },
      dates: retDates,
      commonSessions: pair.dates.length,
      windowFrom: pair.dates[0],
      windowTo: pair.dates[pair.dates.length - 1],
      coupling: S.couplingWindows(coinR, indexR, COUPLING_WINDOWS),
      qqqCoupling: qqqCoupling,
      scatter: { xs: scatterPair.a, ys: scatterPair.b, fit: S.regression(scatterPair.a, scatterPair.b) },
      rollCorr: S.rollingPair(coinR, indexR, CORR_WINDOW, S.pearson),
      rollBeta: S.rollingPair(coinR, indexR, CORR_WINDOW, S.beta),
      coinVol: coinVol,
      indexVol: indexVol,
      currentCoinVol: coinVol.length ? coinVol[coinVol.length - 1].value : NaN,
      currentIndexVol: indexVol.length ? indexVol[indexVol.length - 1].value : NaN,
      coinDd: { dates: coinDates, series: coinDd, now: coinDd[coinDd.length - 1], max: S.maxDrawdown(coinPrices) },
      indexDd: { dates: indexDates, series: indexDd, now: indexDd[indexDd.length - 1], max: S.maxDrawdown(indexPrices) },
      coinEpisodes: S.drawdownEpisodes(coinDates, coinPrices, { minDepth: 0.05, limit: 4 }),
      indexEpisodes: S.drawdownEpisodes(indexDates, indexPrices, { minDepth: 0.03, limit: 4 })
    };
  }

  /* The pair selector printed at the top of the three statistics panels. */
  function renderStatsPicker() {
    var hosts = document.querySelectorAll('.stats-picker');
    if (!hosts.length) return;
    var coinPills = STAT_COINS.map(function (key) {
      var sym = statsCoinSymbol(key);
      var label = key === 'crypto' ? (sym ? sym + ' · week' : 'CRYPTO') : key === 'probe' ? (sym ? sym + ' · probe' : 'PROBE') : sym;
      return '<button type="button" class="pill' + (state.stats.coin === key ? ' is-on' : '') + '" data-stat-coin="' + key + '"' +
        (sym ? '' : ' disabled') + '>' + F.escapeHtml(label) + '</button>';
    }).join('');
    var indexPills = STAT_INDEXES.map(function (key) {
      return '<button type="button" class="pill' + (state.stats.index === key ? ' is-on' : '') + '" data-stat-index="' + key + '">' +
        F.escapeHtml(INDEX_META[key].name) + '</button>';
    }).join('');
    var status = '';
    if (!state.analytics) {
      var L = statsLabels(), id = statsCoinId(L.coinKey);
      var coinLeg = coinHistory(L.coinKey), indexLeg = state.history[L.indexKey];
      if (!indexLeg && !state.history.pending) status = L.index + ' daily history appears after the first scheduled update.';
      else if (L.coinKey !== 'btc' && id && !rangeEntry(id, 365)) status = 'Loading ' + L.coin + ' daily history…';
      else if (L.coinKey === 'btc' && !coinLeg && !state.history.pending) status = 'BTC daily history appears after the first scheduled update.';
      else if (coinLeg && indexLeg) status = 'Not enough overlapping sessions yet.';
    }
    var html = '<div class="picker"><span class="picker-label">Coin</span><div class="pills">' + coinPills + '</div>' +
      '<span class="picker-label">vs</span><div class="pills">' + indexPills + '</div></div>' +
      (status ? '<p class="foot">' + F.escapeHtml(status) + '</p>' : '');
    for (var i = 0; i < hosts.length; i++) hosts[i].innerHTML = html;
  }

  function setStats(patch) {
    state.stats = readStats(Object.assign({}, state.stats, patch || {}));
    if (MP.store) MP.store.set('stats', state.stats);
    ensureCoinHistory();
    recomputeAnalytics();
    renderStatsPicker();
    repaint();
  }

  /* ---- the probe jack ----------------------------------------------------- */
  var searchTimer = null;

  function setProbe(coin) {
    state.probe = readProbe(coin);
    if (MP.store) { if (state.probe) MP.store.set('probe', state.probe); else MP.store.remove('probe'); }
    state.quotes.probe.data = null;
    state.quotes.probe.stamp = null;
    state.search.results = null;
    state.search.query = '';
    var input = el('probeSearch');
    if (input) input.value = '';
    if (MP.meter && MP.meter.setStopLabel) MP.meter.setStopLabel('probe', state.probe ? state.probe.symbol : 'PROBE');
    syncLive();
    if (state.probe) {
      loadCoins().catch(function () { /* shown as a notice */ });
      ensureRange('probe');
    }
    if (state.stats.coin === 'probe' && !state.probe) state.stats = readStats({ coin: 'btc', index: state.stats.index });
    ensureCoinHistory();
    recomputeAnalytics();
    renderStatsPicker();
    renderProbe();
    renderMarkets();
    repaint();
  }

  /* Debounced, minimum two characters, and a late answer for an older query
   * is dropped. */
  function searchCoins(q) {
    q = String(q || '').trim();
    state.search.query = q;
    clearTimeout(searchTimer);
    if (q.length < 2) {
      state.search.results = null;
      state.search.notice = null;
      state.search.pending = false;
      renderProbe();
      return;
    }
    searchTimer = setTimeout(function () {
      var spec = SRC.coinSearch(q);
      state.search.pending = true;
      renderProbe();
      fetchJson(spec.url).then(function (payload) {
        if (state.search.query !== q) return;
        state.search.results = spec.normalize(payload) || [];
        state.search.notice = state.search.results.length ? null : { level: 'quiet', text: 'No coins match "' + q + '".' };
      }).catch(function (err) {
        if (state.search.query === q) state.search.notice = liveNotice('CoinGecko', err);
      }).then(function () {
        if (state.search.query === q) state.search.pending = false;
        renderProbe();
      });
    }, 400);
  }

  function renderProbe() {
    var current = el('probeCurrent');
    if (!current) return;
    var p = state.probe;
    current.innerHTML = p
      ? '<div class="hero-top"><span class="hero-asset">' + F.escapeHtml(p.symbol) + '</span>' +
        '<span class="muted">' + F.escapeHtml(p.name) + '</span></div>' +
        '<div class="hero-sub"><span class="muted">On the dial as ' + F.escapeHtml(p.symbol.slice(0, 5)) + '.</span>' +
        '<button type="button" class="pill" id="probeClear">Clear</button></div>'
      : '<p class="row-desc">No coin on the probe yet. Search below; the pick stays in this browser.</p>';

    var results = el('probeResults');
    if (results) {
      var list = state.search.results;
      results.innerHTML = list && list.length ? list.map(function (c) {
        return '<li><button type="button" class="pick" data-pick-id="' + F.escapeHtml(c.id) + '" data-pick-symbol="' + F.escapeHtml(c.symbol) +
          '" data-pick-name="' + F.escapeHtml(c.name) + '"><span class="row-code">' + F.escapeHtml(c.symbol) + '</span>' +
          '<span class="row-desc">' + F.escapeHtml(c.name + (S.isNum(c.rank) ? ' · #' + c.rank : '')) + '</span></button></li>';
      }).join('') : (state.search.pending ? '<li class="row-desc">Searching…</li>' : '');
    }

    var chart = el('probeChart');
    if (chart) {
      var series = p ? seriesFor('probe') : null;
      chart.innerHTML = series && series.length > 1
        ? G.sparkStep({ values: series, w: 900, h: 200, color: 'var(--c-probe)', area: true, strokeWidth: 1.8 })
        : '';
    }
    setHtml('probeNotice', noticeHtml(state.search.notice || (p ? state.quotes.probe.notice : null)));
  }

  function wireProbe() {
    var input = el('probeSearch');
    if (input) {
      input.addEventListener('input', function () { searchCoins(input.value); });
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          var first = document.querySelector('#probeResults .pick');
          if (first) first.click();
        }
      });
    }
    var drawer = el('drawer');
    if (!drawer) return;
    drawer.addEventListener('click', function (ev) {
      var t = ev.target.closest ? ev.target : null;
      if (!t) return;
      var pick = t.closest('.pick[data-pick-id]');
      if (pick) {
        setProbe({ id: pick.getAttribute('data-pick-id'), symbol: pick.getAttribute('data-pick-symbol'), name: pick.getAttribute('data-pick-name') });
        return;
      }
      if (t.closest('#probeClear')) { setProbe(null); return; }
      var coinPill = t.closest('[data-stat-coin]');
      if (coinPill && !coinPill.disabled) { setStats({ coin: coinPill.getAttribute('data-stat-coin') }); return; }
      var indexPill = t.closest('[data-stat-index]');
      if (indexPill) setStats({ index: indexPill.getAttribute('data-stat-index') });
    });
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
    var L = a ? a.labels : statsLabels();
    setHtml('notice-history', noticeHtml(state.history.notice));
    setText('volFoot', '30-session realized volatility, annualized. ' + L.coin + ' left, ' + L.index + ' right.');
    setText('ddFootCoin', L.coin + ' / USD below running peak.');
    setText('ddFootIndex', L.index + ' below running peak.');
    renderStatsPicker();

    if (!a) {
      var waiting = state.history.pending ? '—' : F.DASH;
      setHtml('couplingStrip', strip([['Corr 90d', waiting], ['Beta 90d', waiting], ['R² 90d', waiting]]));
      setHtml('volStrip', strip([[L.coin + ' 30d', waiting], [L.index + ' 30d', waiting], ['Ratio', waiting]]));
      setHtml('ddStrip', strip([[L.coin + ' now', waiting], [L.coin + ' worst', waiting], [L.index + ' worst', waiting]]));
      setHtml('chartScatter', ''); setText('scatterCaption', ''); setHtml('chartRollCorr', ''); setHtml('couplingTable', '');
      setHtml('chartVol', ''); setHtml('chartDdBtc', ''); setHtml('chartDdIxic', ''); setHtml('ddTable', '');
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
      xTitle: L.index, yTitle: L.coin
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
    var volRatio = S.isNum(a.currentCoinVol) && S.isNum(a.currentIndexVol) && a.currentIndexVol
      ? a.currentCoinVol / a.currentIndexVol : NaN;
    setHtml('volStrip', strip([
      [L.coin + ' 30d', F.pct(a.currentCoinVol, 0)],
      [L.index + ' 30d', F.pct(a.currentIndexVol, 0)],
      ['Ratio', S.isNum(volRatio) ? F.ratio(volRatio, 1) + '×' : F.DASH]
    ]));
    setHtml('chartVol', G.columnChart({
      series: [
        { values: S.tail(a.coinVol, VOL_CHART_POINTS).map(function (e) { return e.value; }), color: 'var(--c-btc)' },
        { values: S.tail(a.indexVol, VOL_CHART_POINTS).map(function (e) { return e.value; }), color: 'var(--c-idx)' }
      ],
      w: 900, h: 190,
      yFmt: function (v) { return (v * 100).toFixed(0) + '%'; },
      xLabels: datesForRolling(a.coinVol, a.dates, VOL_CHART_POINTS).map(F.shortDate)
    }));

    /* drawdown */
    setHtml('ddStrip', strip([
      [L.coin + ' now', F.signedPct(a.coinDd.now, 1), 'neg'],
      [L.coin + ' worst', F.signedPct(a.coinDd.max, 1), 'neg'],
      [L.index + ' worst', F.signedPct(a.indexDd.max, 1), 'neg']
    ]));
    setHtml('chartDdBtc', G.underwaterChart({
      values: a.coinDd.series, w: 900, h: 150, color: 'var(--c-btc)',
      xLabels: a.coinDd.dates.map(F.shortDate)
    }));
    setHtml('chartDdIxic', G.underwaterChart({
      values: a.indexDd.series, w: 900, h: 150, color: 'var(--c-idx)',
      xLabels: a.indexDd.dates.map(F.shortDate)
    }));

    var episodes = a.coinEpisodes.map(function (e) { return { code: L.coin, e: e }; })
      .concat(a.indexEpisodes.map(function (e) { return { code: L.index, e: e }; }))
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
      syncLive();   /* the crypto pick may have changed */
    }).catch(function (err) {
      MP.spotlight.setNotice(snapshotNotice(err, 'This week’s pick'));
      throw err;
    });
  }

  /* ---- the daily reading -------------------------------------------------- */

  /* The NOTE stop: the words take the chart's place, the session date the
   * price's, and the change line says who wrote it. No value, so REL,
   * MIN/MAX and ALERT pass it by. */
  function noteReading() {
    var d = state.note.data;
    return {
      text: d ? F.shortDate(d.forSession) : F.DASH, value: NaN, dp: 0,
      unit: d ? 'SESSION' : '', mode: 'DAILY READING',
      change: { pct: NaN, abs: NaN, delta: NaN, suffix: '', label: '', dp: 0 },
      caption: d ? (d.source === 'claude' ? 'Written by Claude · description, not advice' : 'From the numbers · description, not advice') : '',
      note: d ? d.text : null,
      hint: d ? '' : 'Appears after the first close the job sees',
      spark: null, empty: !d, ranges: false, coin: null
    };
  }

  /* 'claude-opus-5' -> 'Claude Opus 5' */
  function modelName(id) {
    if (!id) return 'Claude';
    return String(id).replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-/g, ' ')
      .replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
  }

  function renderNote() {
    var d = state.note.data;
    setText('noteText', d ? d.text : '');
    var meta = '';
    if (d) {
      meta = (d.source === 'claude'
        ? 'Written by ' + modelName(d.model)
        : 'Written from the numbers by a fixed template' + (d.invalidReason ? ' (the model’s reply was not used: ' + d.invalidReason + ')' : '')) +
        ' · session of ' + F.shortDate(d.forSession) + (S.isNum(d.generatedAt) ? ' · generated ' + F.ago(d.generatedAt) : '');
    }
    setText('noteMeta', meta);

    var inp = d && d.inputs, rows = [];
    function row(label, value) {
      rows.push('<tr><th scope="row">' + F.escapeHtml(label) + '</th><td>' + F.escapeHtml(value) + '</td></tr>');
    }
    function quote(label, x, horizon, usd) {
      if (!x || !S.isNum(x.price)) return;
      row(label, (usd ? F.usd(x.price, 2) : F.num(x.price, 2)) + (S.isNum(x.changePct) ? '  ' + F.signedPctPoints(x.changePct) + ' ' + horizon : ''));
    }
    if (inp) {
      quote('Nasdaq Composite', inp.ixic, 'on the day', false);
      quote('S&P 500', inp.spx, 'on the day', false);
      quote('Bitcoin', inp.btc, '24h', true);
      quote('Ether', inp.eth, '24h', true);
      if (inp.coupling && S.isNum(inp.coupling.corr90)) row('BTC vs Nasdaq, 90 sessions', 'corr ' + F.ratio(inp.coupling.corr90, 2) + (S.isNum(inp.coupling.beta90) ? ' · beta ' + F.ratio(inp.coupling.beta90, 2) : ''));
      if (inp.vol && S.isNum(inp.vol.btc)) row('30-session volatility', 'BTC ' + F.pct(inp.vol.btc, 0) + (S.isNum(inp.vol.index) ? ' · Nasdaq ' + F.pct(inp.vol.index, 0) : ''));
      if (inp.drawdown && S.isNum(inp.drawdown.btc)) row('Below running peak', 'BTC ' + F.signedPct(inp.drawdown.btc, 1) + (S.isNum(inp.drawdown.index) ? ' · Nasdaq ' + F.signedPct(inp.drawdown.index, 1) : ''));
      if (inp.stock && S.isNum(inp.stock.changePct5d)) row('Stock of the week', inp.stock.symbol + ' ' + F.signedPctPoints(inp.stock.changePct5d, 1) + ' over 5 sessions');
      if (inp.crypto && S.isNum(inp.crypto.changePct7d)) row('Crypto of the week', inp.crypto.symbol + ' ' + F.signedPctPoints(inp.crypto.changePct7d, 1) + ' over 7 days');
    }
    setHtml('noteInputs', rows.length ? '<table class="data note-inputs"><tbody>' + rows.join('') + '</tbody></table>' : '');
    setHtml('noteNotice', noticeHtml(state.note.notice));
    repaint();
  }

  function loadNote() {
    return fetchJson(snapshotUrl(SRC.SNAPSHOT.note)).then(function (payload) {
      var n = SRC.normalizeNoteSnapshot(payload);
      if (!n) throw emptyError();
      state.note.data = n;
      state.note.notice = null;
    }).catch(function (err) {
      if (!state.note.data) {
        state.note.notice = err && err.status === 404
          ? { level: 'quiet', text: 'The daily reading appears after the first market close the data job sees.' }
          : snapshotNotice(err, 'Daily reading');
      }
      throw err;
    }).then(renderNote, function (err) {
      renderNote();
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
    if (MP.router) {
      MP.router.onChange(ensureRange);
      MP.router.start();
    }
    tickSession();
    wireAlerts();
    renderAlerts();
    wireProbe();
    if (MP.meter && MP.meter.setStopLabel && state.probe) MP.meter.setStopLabel('probe', state.probe.symbol);
    renderProbe();
    renderNote();
    renderHero();
    renderMarkets();
    renderAnalytics();
    if (MP.spotlight) MP.spotlight.render();
    every(function () { renderStamp(); watchLive(); }, 1000);
    every(tickSession, SESSION_TICK_MS);

    if (typeof root.fetch !== 'function') {
      renderOffline('This browser cannot load live data. Try a current version of Chrome, Safari, Firefox or Edge.');
      return;
    }

    poll(loadCoins, BTC_REFRESH_MS);
    poll(loadQuotes, SNAPSHOT_REFRESH_MS);
    poll(loadHistory, DAILY_REFRESH_MS);
    poll(loadNote, NOTE_REFRESH_MS);
    ensureCoinHistory();
    poll(loadSpotlight, DAILY_REFRESH_MS);
    poll(function () {
      ensureCoinHistory();   /* a failed statistics leg gets another try */
      return loadRange(coinForStop(currentStop()), state.hero.days, true);
    }, HERO_REFRESH_MS);

    /* The offline shell. A relative path keeps the scope at the Pages
     * sub-path; a failure to register costs nothing. */
    var nav = root.navigator;
    if (nav && 'serviceWorker' in nav && root.location && root.location.protocol !== 'file:') {
      try {
        nav.serviceWorker.register('sw.js').catch(function () { /* no offline shell */ });
      } catch (e) { /* not available */ }
    }

    /* Real-time ticks ride alongside the polls; without WebSocket support
     * the polls alone carry the page, as before. */
    if (MP.live && typeof root.WebSocket === 'function') {
      MP.live.start({
        onTick: applyTick,
        onStatus: function (status) { state.live.status = status; }
      });
      syncLive();
      state.teardown.push(MP.live.stop);
    }
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
    analyticsFor: analyticsFor,
    renderAnalytics: renderAnalytics,
    setProbe: setProbe,
    renderNote: renderNote,
    setStats: setStats,
    searchCoins: searchCoins,
    renderHero: renderHero,
    renderMarkets: renderMarkets,
    renderSession: renderSession,
    reading: reading,
    formatValue: formatValue,
    renderAlerts: renderAlerts,
    checkAlerts: checkAlerts,
    applyTick: applyTick,
    liveProducts: liveProducts,
    productForStop: productForStop,
    setRange: setRange,
    ensureRange: ensureRange,
    RANGE_LABELS: RANGE_LABELS,
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
