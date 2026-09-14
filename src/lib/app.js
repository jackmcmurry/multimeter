/* ============================================================================
 * app.js: state, data wiring, analytics assembly, rendering.
 *
 * One number per screen. Bitcoin, ether and the crypto movers come straight
 * from CoinGecko's public API on a 45s poll. The index quotes, daily history,
 * the weekly movers and the Nasdaq-100 closes come from snapshot files under
 * data/ that a scheduled GitHub Action rewrites (scripts/update-data.js). Daily history
 * drives the coupling, volatility and drawdown panels; the BTC chart fetches
 * per range, on demand, and caches.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});
  var S = MP.stats, F = MP.fmt, G = MP.geom, SRC = MP.sources, SES = MP.session;

  /* ---- configuration ------------------------------------------------------ */
  /* CoinGecko is keyless and rate limits by address, and a campus shares
   * one, so the poll is deliberately unhurried. */
  var BTC_REFRESH_MS = 60000;
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

  var RANGE_LABELS = { 1: '24hr', 7: '1wk', 30: '1mo', 365: '1yr' };

  var INSTRUMENTS = {
    btc: { code: 'BTC / USD', desc: 'Bitcoin spot', dp: 0, color: 'var(--c-btc)' },
    eth: { code: 'ETH / USD', desc: 'Ether spot', dp: 2, color: 'var(--c-eth)' },
    ixic: { code: '^IXIC', desc: 'Nasdaq Composite', dp: 2, color: 'var(--c-idx)' },
    spx: { code: '^GSPC', desc: 'S&P 500', dp: 2, color: 'var(--c-spx)' },
    qqq: { code: 'QQQ', desc: 'Invesco QQQ Trust', dp: 2, color: 'var(--c-qqq)' }
  };

  /* CoinGecko ids for the live coins; the probe (a coin the viewer chose) and
   * the two crypto movers join them once known. */
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

  /* A ticker the data job can publish closes for. The same test the watch
   * list uses, so the two agree on what a stock is. */
  function validTicker(sym) {
    return typeof sym === 'string' && !!(MP.sources && MP.sources.stockPath(sym));
  }

  /* The subject the analytical tools measure. It is one of the built-in coin
   * slots or a stock ticker, so that choosing NVDA and turning to VOL
   * measures NVDA instead of silently measuring bitcoin. */
  function readStats(v) {
    var out = { coin: 'btc', index: 'ixic' };
    if (v && typeof v.coin === 'string') {
      if (STAT_COINS.indexOf(v.coin) >= 0) out.coin = v.coin;
      else if (STAT_INDEXES.indexOf(v.coin) >= 0) out.coin = v.coin;   /* an index can be the subject too */
      else if (validTicker(v.coin)) out.coin = v.coin.toUpperCase();
    }
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
    /* the Nasdaq-100 from data/stocks.json, and members' closes loaded on demand */
    stocks: { list: null, rowsBy: {}, files: {}, pending: {}, notice: null },
    /* which end of the week MOVER is showing: the rise, or the fall */
    moverEnd: 'mover',
    /* the WATCH stop: the viewer's tickers, the one on screen, the range in sessions */
    watch: { list: MP.watch ? MP.watch.load() : [], index: 0, sessions: 21, query: '', results: [], notice: null },
    coinIdsAsked: '',
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
  var LIVE_STOPS = ['btc', 'eth', 'probe'];   /* plus the crypto movers, from spotlight.js */

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
    /* jitter, so that many tabs on one network do not all ask in the same second */
    function schedule() { if (!stopped) timer = setTimeout(tick, Math.round(delay * (0.85 + Math.random() * 0.3))); }
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

  /* A rate limit or an outage at CoinGecko must not leave the screen blank.
   * A coin with daily history from the data job still reads: its last
   * published close, the move into it, and the line the closes draw, with
   * the mode line saying which it is. */
  function withLastClose(r, key) {
    if (!r.empty) return r;
    var hist = state.history[key];
    if (!hist || hist.length < 2) return r;
    var last = hist[hist.length - 1], prev = hist[hist.length - 2];
    if (!S.isNum(last.price)) return r;
    r.text = money(last.price);
    r.value = last.price;
    r.empty = false;
    r.mode = r.mode + ' · LAST CLOSE';
    if (S.isNum(prev.price) && prev.price > 0) {
      r.change.pct = (last.price / prev.price - 1) * 100;
      r.change.abs = last.price - prev.price;
      r.change.label = '1D';
    }
    if (!r.spark || !r.spark.length) {
      r.spark = S.tail(hist, SPARK_POINTS).map(function (p) { return p.price; });
    }
    return r;
  }

  /* Coins carry the screen's range tabs: the chart and the change follow the
   * chosen range, the price stays live spot. Until the range has loaded, the
   * 24-hour change from the quote stands in. */
  var RANGE_TABS = [[1, '24hr'], [7, '1wk'], [30, '1mo'], [365, '1yr']];

  function rangeTabs() {
    return { kind: 'ranges', label: 'Chart range', options: RANGE_TABS, value: state.hero.days };
  }

  function withRange(r, coinId) {
    if (!coinId) return r;
    r.ranges = true;
    r.tabs = rangeTabs();
    r.coin = coinId;
    r.change.label = RANGE_LABELS[state.hero.days] || '24hr';
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

  /* MOVER and LOSER: spotlight.js builds the reading. The Stocks | Crypto
   * switch rides in the tabs row, and a fresh Coinbase tick updates a crypto
   * mover's price and 24-hour change. */
  var MOVER_TABS = [['stocks', 'STOCKS'], ['crypto', 'CRYPTO']];

  /* MOVER carries both ends of the week. The dial holds one position and a
   * soft key turns it over; the old LOSER view still resolves and forces the
   * falling end. */
  function moverEndFor(stop) {
    return stop === 'loser' ? 'loser' : (state.moverEnd === 'loser' ? 'loser' : 'mover');
  }

  function moverEndLabel() {
    return moverEndFor(currentStop()) === 'loser' ? 'MOVER' : 'LOSER';
  }

  function toggleMoverEnd() {
    state.moverEnd = state.moverEnd === 'loser' ? 'mover' : 'loser';
    var stop = currentStop();
    if (stop === 'mover' || stop === 'loser') {
      var subj = subjectForStop(stop);
      if (subj && subj !== state.stats.coin) setStats({ coin: subj });
    }
    if (MP.meter) MP.meter.renderKeys();
    repaint();
    return state.moverEnd;
  }

  function moverReading(stop) {
    var SP = MP.spotlight;
    var which = moverEndFor(stop);
    var r = SP && SP.reading ? SP.reading(which) : noReading('', which === 'loser' ? 'LOSER' : 'MOVER', '');
    r.tabs = { kind: 'switch', label: 'Mover controls', options: MOVER_TABS, value: SP ? SP.kind() : 'stocks', endLabel: which === 'loser' ? 'MOVER' : 'LOSER' };
    /* One sentence, because the line holds two lines and no more. The dates
     * this was measured to are provenance rather than meaning, and the
     * drawer already prints them under the ranking rule. */
    r.what = (which === 'loser' ? 'Largest fall' : 'Largest rise') + ' among ' + (r.universe || 'tracked assets') +
      ', over ' + (r.rankPeriod || 'the week') + '.';
    if (!r.spark || r.spark.length < 2) r.chartState = r.empty ? 'RANKING UNAVAILABLE' :
      (state.stocks.pending[r.symbol] ? 'LOADING PRICE HISTORY...' : 'PRICE HISTORY UNAVAILABLE');
    var tick = r.empty ? null : freshTick(productForStop(which));
    if (tick && S.isNum(tick.price)) {
      r.lead = money(tick.price);
      if (S.isNum(tick.pct24h)) {
        r.change.pct = tick.pct24h;
        r.change.abs = tick.price - tick.open24h;
        r.change.label = '24hr';
      }
      r.live = true;
      if (r.spark && r.spark.length) r.spark = r.spark.concat([tick.price]);
    }
    return r;
  }

  function probeReading() {
    if (!state.probe) {
      var r = noReading('USD', 'PROBE', '24hr');
      r.hint = 'Press DATA to choose a coin';
      return r;
    }
    return applyLive(withRange(quoteReading('probe', 'USD', state.probe.symbol + ' / USD', '24hr'), state.probe.id), 'probe');
  }

  /* WATCH: one stock at a time from the viewer's list, as its last daily
   * close. The tabs row steps through the list and slices the closes. No
   * value either: a close is not a level worth an alert. */
  var WATCH_RANGES = [[5, '1wk'], [21, '1mo'], [63, '3mo'], [252, '1yr']];

  function sessionsLabel(n) {
    for (var i = 0; i < WATCH_RANGES.length; i++) if (WATCH_RANGES[i][0] === n) return WATCH_RANGES[i][1];
    return '';
  }

  function watchSymbol() {
    var w = state.watch;
    if (!w.list.length) return null;
    if (w.index >= w.list.length) w.index = w.list.length - 1;
    if (w.index < 0) w.index = 0;
    return w.list[w.index];
  }

  function watchReading() {
    var w = state.watch, sym = watchSymbol();
    var r = noReading('CLOSE', 'WATCH', sessionsLabel(w.sessions));
    r.change.usd = true;
    if (!sym) {
      r.hint = 'Press DATA to add stocks';
      return r;
    }
    r.tabs = { kind: 'watch', label: 'Watch list', options: WATCH_RANGES, value: w.sessions, count: w.list.length };
    r.symbol = sym;
    r.ticker = sym;
    r.mode = 'WATCH ' + (w.index + 1) + '/' + w.list.length;
    var series = stockSeries(sym), row = stockRow(sym);
    var last = series ? series[series.length - 1] : row && S.isNum(row.close) ? { date: row.date, price: row.close } : null;
    if (!last) {
      r.hint = state.stocks.pending[sym] ? 'Loading ' + sym : 'Price history unavailable for ' + sym;
      r.chartState = r.hint;
      r.chartDetail = state.stocks.pending[sym] ? null : stockReason(sym);
      r.identity = row ? row.name : sym;
      return r;
    }
    r.dp = Math.abs(last.price) < 10 ? 4 : 2;
    r.text = money(last.price);
    r.empty = false;
    if (last.date) r.mode += ' · ' + F.shortDate(last.date);
    if (series && series.length > 1) {
      var slice = S.tail(series, w.sessions + 1);
      var first = slice[0].price;
      r.spark = slice.map(function (p) { return p.price; });
      if (first > 0) {
        r.change.pct = (last.price / first - 1) * 100;
        r.change.abs = last.price - first;
        r.change.dp = r.dp;
      }
    } else if (row && S.isNum(row.change1d)) {
      r.change.pct = row.change1d;
      r.change.label = '1D';
    }
    r.say = sym + ' closed at ' + r.text + (last.date ? ' on ' + F.shortDate(last.date) : '');
    return r;
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

  /* The dial keeps the short technical label, because that is what the
   * instrument is. The screen spells the idea out, because a student reading
   * the display should not have to already know that VOL means volatility. */
  function analyticsMode(stop) {
    var l = statsLabels();
    if (stop === 'corr') return 'CORRELATION · ' + l.coin + ' & ' + l.indexShort + ' · 90 SESSIONS';
    if (stop === 'beta') return 'BETA · ' + l.coin + ' & ' + l.indexShort + ' · 90 SESSIONS';
    if (stop === 'vol') return 'VOLATILITY · ' + l.coin + ' · 30 SESSIONS';
    return 'DRAWDOWN · ' + l.coin;
  }

  function analyticsReading(stop) {
    var a = state.analytics;
    if (!a) {
      var missing = noReading(ANALYTICS_UNIT[stop], analyticsMode(stop), '');
      missing.chartState = 'INSUFFICIENT HISTORY';
      missing.chartDetail = 'This tool needs dated prices for the subject and comparison. Press DATA to choose another asset, or INDEX to change the comparison.';
      return missing;
    }
    var c90 = a.coupling[1] || a.coupling[0];
    var value, series, dp, scale = 1, suffix = '';
    if (stop === 'corr') { value = c90.correlation; series = entryValues(a.rollCorr); dp = 2; }
    else if (stop === 'beta') { value = c90.beta; series = entryValues(a.rollBeta); dp = 2; }
    else if (stop === 'vol') { value = a.currentCoinVol; series = entryValues(a.coinVol); dp = 1; scale = 100; suffix = ' pp'; }
    else { value = a.coinDd.now; series = a.coinDd.series; dp = 1; scale = 100; suffix = ' pp'; }
    var shown = S.isNum(value) ? value * scale : NaN;
    var text = !S.isNum(shown) ? F.DASH
      : stop === 'corr' || stop === 'beta' ? F.ratio(shown, dp)
      : stop === 'dd' ? F.signedPct(value, dp)
      : F.pct(value, dp);
    return {
      text: text, value: shown, dp: dp, unit: ANALYTICS_UNIT[stop], mode: analyticsMode(stop),
      change: { pct: NaN, abs: NaN, delta: deltaBack(series, CORR_WINDOW) * scale, suffix: suffix, label: 'VS 30 SESSIONS AGO', dp: dp },
      spark: S.tail(series, SPARK_POINTS),
      chartTitle: stop === 'vol' ? 'ROLLING 30-SESSION VOLATILITY' : stop === 'corr' ? 'ROLLING 90-SESSION CORRELATION' : stop === 'dd' ? 'DISTANCE BELOW THE RUNNING PEAK' : 'ROLLING BETA',
      chartDetail: stop === 'vol' ? 'Annualized · matching trading sessions · through ' + a.windowTo : stop === 'corr' ? '−1 opposite · 0 little relationship · +1 together. Correlation is not causation.' : stop === 'dd' ? '0% is the peak. Lower points show a deeper decline.' : 'Calculated from matched returns.',
      empty: !S.isNum(value), ranges: false, coin: null
    };
  }

  /* One plain sentence per stop, printed under the figure. It answers the
   * first question a student has, which is not "what is the number" but
   * "what am I looking at". A function where it has to name the instrument. */
  var WHAT_LINES = {
    btc: 'What one bitcoin costs in US dollars, and how much that has moved.',
    eth: 'What one unit of ether costs in US dollars, and how much that has moved.',
    nasdaq: 'One number tracking about 3,000 listed companies, heavily technology.',
    spx: 'One number tracking 500 large US companies, the usual stand-in for "the market".',
    mover: 'The biggest one-week gain among the things this instrument can price.',
    loser: 'The biggest one-week fall among the things this instrument can price.',
    watch: 'Something you are watching, at the price it last closed at.',
    probe: 'A coin you picked, measured like the others.',
    corr: function (L) { return 'Whether ' + L.coin + ' and the ' + L.indexName + ' tend to move on the same days.'; },
    vol: function (L) { return 'How much ' + L.coin + '’s returns have been moving around.'; },
    dd: function (L) { return 'How far ' + L.coin + ' sits below its own highest point.'; }
  };

  /* ---- the SUBJECT position -----------------------------------------------
   * One detent covers every market. It reads whatever the active subject is,
   * by handing off to the reading that instrument already had, so nothing
   * about how a coin, an index or a stock is priced changes here. */
  function subjectReading() {
    var key = state.stats.coin;
    if (key === 'eth') return reading('eth');
    if (key === 'probe') return probeReading();
    if (key === 'crypto') return moverReading('mover');
    if (INDEX_META[key]) {
      return quoteReading(key, 'INDEX', INDEX_META[key].name.toUpperCase(), '1D');
    }
    if (validTicker(key)) {
      /* stocks are read through the watch list, which already holds their
       * closes; point it at the subject before reading */
      var w = state.watch, at = w.list.indexOf(key);
      if (at >= 0) w.index = at;
      else return stockSubjectReading(key);
      return watchReading();
    }
    return reading('btc');
  }

  /* A stock that is the subject but not on the watch list. */
  function stockSubjectReading(sym) {
    var r = noReading('CLOSE', sym, '1mo');
    r.change.usd = true;
    r.ticker = sym;
    r.symbol = sym;
    var series = stockSeries(sym), row = stockRow(sym);
    var last = series ? series[series.length - 1] : row && S.isNum(row.close) ? { date: row.date, price: row.close } : null;
    if (!last) {
      r.hint = state.stocks.pending[sym] ? 'Loading ' + sym : 'Price history unavailable for ' + sym;
      r.chartState = r.hint;
      r.chartDetail = state.stocks.pending[sym] ? null : stockReason(sym);
      r.identity = row ? row.name : sym;
      return r;
    }
    r.dp = Math.abs(last.price) < 10 ? 4 : 2;
    r.text = money(last.price);
    r.value = last.price;
    r.empty = false;
    r.mode = sym + (last.date ? ' · ' + F.shortDate(last.date) : '');
    if (series && series.length > 1) {
      var slice = S.tail(series, 22), first = slice[0].price;
      r.spark = slice.map(function (p) { return p.price; });
      if (first > 0) {
        r.change.pct = (last.price / first - 1) * 100;
        r.change.abs = last.price - first;
        r.change.dp = r.dp;
      }
    }
    return r;
  }

  /* The dial's SUBJECT position wears the subject's ticker, and the drawer
   * opens the panel that suits what it is pointing at. */
  function syncSubjectPosition() {
    var key = state.stats.coin;
    var label = statsCoinSymbol(key) || 'BTC';
    if (MP.meter && MP.meter.setStopLabel) MP.meter.setStopLabel('subject', label);
    var panel = INDEX_META[key] ? 'markets' : validTicker(key) ? 'watch' : 'hero';
    if (MP.router && MP.router.setPanel) MP.router.setPanel('subject', panel);
    return label;
  }

  /* Which underlying view the subject position is standing in for. */
  function subjectView() {
    var key = state.stats.coin;
    if (key === 'eth') return 'eth';
    if (key === 'probe') return 'probe';
    if (key === 'crypto') return 'mover';
    if (INDEX_META[key]) return key === 'ixic' ? 'nasdaq' : 'spx';
    if (validTicker(key)) return 'watch';
    return 'btc';
  }

  function whatLine(stop) {
    /* SUBJECT says whatever the market it is pointing at would say */
    if (stop === 'subject') return whatLine(subjectView());
    if (stop === 'mover') stop = moverEndFor(stop);
    var w = WHAT_LINES[stop];
    if (typeof w === 'function') { try { return w(statsLabels()); } catch (e) { return ''; } }
    return w || '';
  }

  function reading(stop) {
    var r = readingFor(stop);
    if (r && !r.what) r.what = whatLine(stop);
    return r;
  }

  function readingFor(stop) {
    switch (stop) {
      case 'btc': return applyLive(withLastClose(withRange(quoteReading('btc', 'USD', 'BTC / USD', '24hr'), COINS.btc), 'btc'), stop);
      case 'eth': return applyLive(withLastClose(withRange(quoteReading('eth', 'USD', 'ETH / USD', '24hr'), COINS.eth), 'eth'), stop);
      case 'nasdaq': return quoteReading('ixic', 'INDEX', 'NASDAQ COMPOSITE', '1D');
      case 'spx': return quoteReading('spx', 'INDEX', 'S&P 500', '1D');
      case 'qqq': return quoteReading('qqq', 'USD', 'QQQ', '1D');
      case 'mover': case 'loser': return moverReading(stop);
      case 'watch': return watchReading();
      case 'subject': return subjectReading();
      case 'probe': return probeReading();
      case 'learn': return learnReading();
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
    if (stop === 'mover' || stop === 'loser') return MP.spotlight && MP.spotlight.productFor ? MP.spotlight.productFor(stop) : null;
    if (stop === 'probe') return state.probe && state.probe.symbol ? cb.productFor(state.probe.symbol) : null;
    return null;
  }

  function liveProducts() {
    var unsupported = (state.live.status && state.live.status.unsupported) || [];
    var out = [];
    LIVE_STOPS.map(productForStop)
      .concat(MP.spotlight && MP.spotlight.products ? MP.spotlight.products() : [])
      .forEach(function (p) {
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
    /* the movers have no range tabs: their switch takes the row */
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

  /* The coins one call covers: the dial's own, plus the whole crypto
   * universe, so MOVER and LOSER can be ranked here even before the weekly
   * scan has ever run. */
  function coinIds() {
    var ids = coinKeys().map(liveCoinId);
    function push(id) { if (id && ids.indexOf(id) < 0) ids.push(id); }
    (MP.spotlight ? MP.spotlight.CRYPTO_UNIVERSE : []).forEach(function (c) { push(c.id); });
    (MP.spotlight && MP.spotlight.cryptoIds ? MP.spotlight.cryptoIds() : []).forEach(push);
    return ids;
  }

  /* One CoinGecko call covers bitcoin, ether, the probe and both crypto movers. */
  function loadCoins() {
    var ids = coinIds();
    state.coinIdsAsked = ids.join(',');
    var spec = SRC.coinsMarkets(ids);
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
      if (MP.spotlight && MP.spotlight.setCoinQuotes) {
        var picked = {};
        function keep(id) { if (id && coins[id]) picked[id] = coins[id]; }
        MP.spotlight.CRYPTO_UNIVERSE.forEach(function (c) { keep(c.id); });
        MP.spotlight.cryptoIds().forEach(keep);
        MP.spotlight.setCoinQuotes(picked);
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
      if (MP.spotlight && MP.spotlight.setPicks) MP.spotlight.setPicks(snap.picks);
    }).catch(function (err) {
      state.snapshot.notice = snapshotNotice(err, 'Nasdaq data');
      throw err;
    }).then(renderMarkets, function (err) {
      renderMarkets();
      throw err;
    });
  }

  /* ---- session ------------------------------------------------------------ */
  /* One lamp and one word. This reports the US session; it is not a switch,
   * so nothing here is clickable and the caption says "status". */
  function renderSession() {
    var d = state.session.data;
    var open = d && d.equityStatus === 'open';
    var lamp = el('marketLamp'), word = el('marketWord'), host = el('marketStatus');
    if (lamp) {
      lamp.classList.toggle('is-open', !!open);
      lamp.classList.toggle('is-closed', !!(d && !open));
    }
    if (word) word.textContent = !d ? F.DASH : open ? 'OPEN' : 'CLOSED';
    if (host) host.setAttribute('aria-label', 'US stock market: ' + (d ? (open ? 'open' : 'closed') : 'unknown'));
  }

  function tickSession() {
    var st = SES.status(Date.now());
    state.session.data = { equityStatus: st.open ? 'open' : 'closed', phase: st.phase };
    renderSession();
  }

  /* ---- analytics ---------------------------------------------------------- */

  /* Which coin and index the statistics measure, as the labels the panels
   * print: coin symbol, index code (^IXIC) and its short form (NDQ). */
  /* The statistics' 'crypto' coin is the week's crypto mover. */
  function cryptoMover() {
    var m = MP.spotlight && MP.spotlight.view ? MP.spotlight.view.movers : null;
    return m && m.crypto ? m.crypto.mover : null;
  }

  function statsCoinId(coinKey) {
    if (coinKey === 'btc') return COINS.btc;
    if (coinKey === 'eth') return COINS.eth;
    if (coinKey === 'crypto') { var cm = cryptoMover(); return cm && cm.id ? cm.id : null; }
    if (coinKey === 'probe') return state.probe ? state.probe.id : null;
    return null;
  }

  function statsCoinSymbol(coinKey) {
    if (coinKey === 'btc') return 'BTC';
    if (coinKey === 'eth') return 'ETH';
    if (coinKey === 'crypto') { var cm = cryptoMover(); return cm ? cm.symbol : null; }
    if (coinKey === 'probe') return state.probe ? state.probe.symbol : null;
    if (INDEX_META[coinKey]) return INDEX_META[coinKey].short;
    if (validTicker(coinKey)) return coinKey;
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
    /* an index subject measures on its own published daily closes */
    if (INDEX_META[coinKey]) return state.history[coinKey] || null;
    /* a stock subject measures on the closes the data job publishes for it */
    if (validTicker(coinKey)) return stockSeries(coinKey);
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
    if (validTicker(coinKey)) { ensureStock(coinKey); return; }
    var id = statsCoinId(coinKey);
    if (id && !rangeEntry(id, 365)) loadRange(id, 365).catch(function () { /* shown as a notice */ });
  }

  function recomputeAnalytics() {
    state.analytics = computeAnalytics();
    renderAnalytics();
  }

  function computeAnalytics() {
    var labels = statsLabels();
    /* An index measured against itself would correlate 1.00 and teach
     * nothing, so the comparison moves to the other index instead. */
    if (state.stats.coin === labels.indexKey) {
      var other = labels.indexKey === 'ixic' ? 'spx' : 'ixic';
      labels = Object.assign({}, labels, {
        indexKey: other, index: INDEX_META[other].code,
        indexShort: INDEX_META[other].short, indexName: INDEX_META[other].name
      });
    }
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

  /* Which subject a dial position is showing, or null for a position that is
   * a tool rather than an instrument. */
  function subjectForStop(view) {
    if (view === 'subject') return null;                 /* it already is the subject */
    if (view === 'btc' || view === 'eth' || view === 'probe') return view;
    if (view === 'nasdaq') return 'ixic';
    if (view === 'spx') return 'spx';
    if (view === 'watch') return watchSymbol();
    /* The week's mover is an instrument in its own right: landing on it makes
     * it the subject, so VOL, DD and PROBE investigate the name on screen. */
    if (view === 'mover' || view === 'loser') {
      if (MP.spotlight && MP.spotlight.kind() === 'crypto') return 'crypto';
      var mr = MP.spotlight && MP.spotlight.reading ? MP.spotlight.reading(moverEndFor(view)) : null;
      return mr && mr.symbol && validTicker(mr.symbol) ? mr.symbol : null;
    }
    return null;
  }

  /* The pair selector printed at the top of the three statistics panels. */
  function renderStatsPicker() {
    var hosts = document.querySelectorAll('.stats-picker');
    if (!hosts.length) return;
    var coinPills = STAT_COINS.map(function (key) {
      var sym = statsCoinSymbol(key);
      var label = key === 'crypto' ? (sym ? sym + ' · mover' : 'MOVER') : key === 'probe' ? (sym ? sym + ' · probe' : 'PROBE') : sym;
      return '<button type="button" class="pill' + (state.stats.coin === key ? ' is-on' : '') + '" data-stat-coin="' + key + '"' +
        (sym ? '' : ' disabled') + '>' + F.escapeHtml(label) + '</button>';
    }).join('');
    /* a stock subject is not one of the fixed slots, so it gets its own pill
     * and the picker shows what is actually being measured */
    if (validTicker(state.stats.coin)) {
      coinPills += '<button type="button" class="pill is-on" data-stat-coin="' + F.escapeHtml(state.stats.coin) + '">' +
        F.escapeHtml(state.stats.coin) + '</button>';
    }
    var indexPills = STAT_INDEXES.map(function (key) {
      return '<button type="button" class="pill' + (state.stats.index === key ? ' is-on' : '') + '" data-stat-index="' + key + '">' +
        F.escapeHtml(INDEX_META[key].name) + '</button>';
    }).join('');
    var status = '';
    if (!state.analytics) {
      var L = statsLabels(), id = statsCoinId(L.coinKey);
      var coinLeg = coinHistory(L.coinKey), indexLeg = state.history[L.indexKey];
      if (!indexLeg && !state.history.pending) status = L.index + ' daily history appears after the first scheduled update.';
      else if (validTicker(L.coinKey) && !coinLeg) status = L.coin + ' daily closes appear once the data job publishes them.';
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
    syncSubjectPosition();
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

  /* [label, value, class, concept]: the fourth entry puts a question mark
   * beside the label that opens the explanation of what the figure means. */
  /* [label, value, valueClass, conceptId, rawValue]. Where a concept has
   * bands and the raw figure is known, the word for it prints under the
   * figure, so a number arrives with a reading of its size. */
  function strip(items) {
    return items.map(function (it) {
      var c = it[3] && MP.concepts ? MP.concepts.get(it[3]) : null;
      var ask = c
        ? '<button type="button" class="ask" data-concept="' + F.escapeHtml(it[3]) + '" aria-label="What ' + F.escapeHtml(c.name) + ' means">?</button>'
        : '';
      var b = c && it.length > 4 ? MP.concepts.band(it[3], it[4]) : null;
      return '<div><div class="stat-label">' + F.escapeHtml(it[0]) + ask + '</div>' +
        '<div class="stat-value' + (it[2] ? ' ' + it[2] : '') + '">' + F.escapeHtml(it[1]) + '</div>' +
        (b ? '<div class="stat-band is-' + b.tone + '">' + F.escapeHtml(b.label) + '</div>' : '') + '</div>';
    }).join('');
  }

  /* The peak a fall began from and the low it reached, as indices into the
   * drawdown series, so the chart can show the drawdown happening. */
  function ddMarks(dd, episodes) {
    var deepest = (episodes || []).slice().sort(function (p, q) { return p.depth - q.depth; })[0];
    if (!deepest || !dd || !dd.dates) return [];
    var marks = [];
    var pi = dd.dates.indexOf(deepest.peakDate), ti = dd.dates.indexOf(deepest.troughDate);
    if (pi >= 0) marks.push({ index: pi, value: 0, label: 'peak ' + F.shortDate(deepest.peakDate) });
    if (ti >= 0) marks.push({ index: ti, value: dd.series[ti], label: F.signedPct(deepest.depth, 0) });
    return marks;
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
      ['Corr 90d', F.ratio(c90.correlation, 2), '', 'correlation', c90.correlation],
      ['Beta 90d', F.ratio(c90.beta, 2), '', 'beta', c90.beta],
      ['R² 90d', F.ratio(c90.r2, 2), '', 'r2', c90.r2]
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
      [L.coin + ' 30d', F.pct(a.currentCoinVol, 0), '', 'volatility', a.currentCoinVol],
      [L.index + ' 30d', F.pct(a.currentIndexVol, 0), '', 'volatility', a.currentIndexVol],
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
      [L.coin + ' now', F.signedPct(a.coinDd.now, 1), 'neg', 'drawdown', a.coinDd.now],
      [L.coin + ' worst', F.signedPct(a.coinDd.max, 1), 'neg', 'drawdown', a.coinDd.max],
      [L.index + ' worst', F.signedPct(a.indexDd.max, 1), 'neg']
    ]));
    setHtml('chartDdBtc', G.underwaterChart({
      values: a.coinDd.series, w: 900, h: 150, color: 'var(--c-btc)',
      marks: ddMarks(a.coinDd, a.coinEpisodes),
      xLabels: a.coinDd.dates.map(F.shortDate)
    }));
    setHtml('chartDdIxic', G.underwaterChart({
      values: a.indexDd.series, w: 900, h: 150, color: 'var(--c-idx)',
      marks: ddMarks(a.indexDd, a.indexEpisodes),
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
      syncLive();   /* the crypto movers may have changed */
      ensureMoverFiles();
      /* new crypto movers are priced now rather than at the next poll */
      if (coinIds().join(',') !== state.coinIdsAsked) loadCoins().catch(function () { /* shown as a notice */ });
    }).catch(function (err) {
      MP.spotlight.setNotice(snapshotNotice(err, 'The movers list'));
      throw err;
    });
  }

  /* ---- the Nasdaq-100: the list and members' closes ------------------------ */

  /* data/stocks.json: every member's last close and its 1-day, 5-day and
   * 1-month change. It names the WATCH search's choices; a member's closes
   * load from its own file when a screen needs them. */
  var catalogue = { rows: [], by: {} };
  function loadCatalogue() {
    return fetchJson(snapshotUrl('data/catalogue.json')).then(function (data) {
      if (!data || !Array.isArray(data.rows)) throw emptyError();
      catalogue.rows = data.rows.filter(function (r) { return r && SRC.stockPath(r.symbol) && typeof r.name === 'string'; });
      catalogue.by = {};
      catalogue.rows.forEach(function (r) { catalogue.by[r.symbol] = r; });
      if (MP.meter && MP.meter.screen() === 'search') runSearch(find.query);
      repaint();
    });
  }
  function loadStocks() {
    return fetchJson(snapshotUrl(SRC.SNAPSHOT.stocks)).then(function (payload) {
      var list = SRC.normalizeStocksSnapshot(payload);
      if (!list) throw emptyError();
      state.stocks.list = list;
      state.stocks.rowsBy = {};
      list.rows.forEach(function (r) { state.stocks.rowsBy[r.symbol] = r; });
      state.stocks.notice = null;
      ensureMoverFiles();
      ensureStock(watchSymbol());
    }).catch(function (err) {
      if (!state.stocks.list) {
        state.stocks.notice = err && err.status === 404
          ? { level: 'quiet', text: 'The Nasdaq-100 list appears after the first scheduled update.' }
          : snapshotNotice(err, 'Nasdaq-100 list');
      }
      throw err;
    }).then(function () {
      renderWatch();
      if (MP.meter && MP.meter.screen() === 'search') runSearch(find.query);
      if (MP.spotlight) MP.spotlight.render();
      repaint();
    }, function (err) {
      renderWatch();
      if (MP.meter && MP.meter.screen() === 'search') renderSearchResults();
      throw err;
    });
  }

  /* One member's closes, fetched once per published session. A failure is
   * remembered for that session, so a missing file is not asked for again
   * on every screen change. */
  function ensureStock(sym) {
    var path = sym ? SRC.stockPath(sym) : null;
    if (!path) return;
    var st = state.stocks, have = st.files[sym];
    var session = st.list ? st.list.session : null;
    if ((have && (have.session === session || !session)) || st.pending[sym]) return;
    st.pending[sym] = true;
    function read(payload) {
      var f = SRC.normalizeStockFile(payload);
      /* The endpoint answers 200 with an empty series and a sentence saying
       * which source declined and why. Carry that sentence through: a blank
       * chart that cannot say what went wrong is the thing being fixed. */
      if (!f || f.symbol !== sym) {
        var err = emptyError();
        if (payload && typeof payload.message === 'string') err.reason = payload.message;
        throw err;
      }
      return f;
    }
    fetchJson(snapshotUrl(path)).then(read).catch(function () {
      /* The scheduled job publishes a file for the Nasdaq-100 and the majors
       * only. Every other listed symbol is fetched on demand through the
       * site's own endpoint, so searching a company and charting it are the
       * same act. */
      var api = SRC.stockApiUrl(sym);
      if (!api) throw emptyError();
      return fetchJson(api).then(read);
    }).then(function (f) {
      var listed = catalogue.by[sym];
      st.files[sym] = { series: f.series, name: (listed && listed.name) || f.name, session: session, reason: null };
    }).catch(function (err) {
      var reason = (err && err.reason) || null;
      if (have) { have.session = session; have.reason = reason; }
      else st.files[sym] = { series: null, name: null, session: session, reason: reason };
    }).then(function () {
      delete st.pending[sym];
      if (state.stats.coin === sym) recomputeAnalytics();
      renderWatch();
      if (MP.meter && MP.meter.screen() === 'search') runSearch(find.query);
      if (MP.spotlight) MP.spotlight.render();
      repaint();
    });
  }

  /* Why this symbol has no series, when the source said so in words. */
  function stockReason(sym) {
    var f = sym ? state.stocks.files[sym] : null;
    return (f && f.reason) || null;
  }

  function stockSeries(sym) {
    var f = sym ? state.stocks.files[sym] : null;
    return f && f.series ? f.series : null;
  }

  function stockRow(sym) {
    return (sym && (state.stocks.rowsBy[sym] || catalogue.by[sym])) || null;
  }

  function ensureMoverFiles() {
    (MP.spotlight && MP.spotlight.stockSymbols ? MP.spotlight.stockSymbols() : []).forEach(ensureStock);
  }

  /* ---- MOVER and LOSER ----------------------------------------------------- */

  function setMoversKind(k) {
    if (!MP.spotlight) return;
    MP.spotlight.setKind(k);
    syncLive();
    ensureMoverFiles();
    repaint();
  }

  /* An old #stock or #crypto link sets the switch; landing on a stop loads
   * the closes its screen needs. */
  function onStopChange(view) {
    var st = MP.router && MP.router.aliasState ? MP.router.aliasState(root.location && root.location.hash) : null;
    if (st && st.movers && MP.spotlight && MP.spotlight.kind() !== st.movers) setMoversKind(st.movers);
    if (view === 'mover' || view === 'loser') {
      ensureMoverFiles();
      if (MP.spotlight) MP.spotlight.render();
    }
    if (view === 'watch') ensureStock(watchSymbol());
    /* The subject follows the dial. Landing on an instrument makes it the
     * thing VOL, CORR and DD measure, so an investigation survives a turn of
     * the knob instead of resetting to bitcoin. */
    var subj = subjectForStop(view);
    if (subj && subj !== state.stats.coin) setStats({ coin: subj });
    setStopNote(view);
    hideConcept();
    refreshContext(true);
    if (MP.track) MP.track.event('dial_mode_changed', view);
  }

  /* ---- WATCH --------------------------------------------------------------- */

  /* ---- what this stop is, and what the figures mean ------------------------ */

  /* One sentence per stop, in the drawer under the title: what question the
   * stop answers, in words a first-year student already has. */
  var STOP_NOTES = {
    off: 'How the meter works, where every figure comes from, and what it is not.',
    btc: 'What bitcoin costs now, and how far it has moved over the period on the screen.',
    eth: 'What ether costs now, next to bitcoin and the two indexes.',
    nasdaq: 'Where the Nasdaq Composite stands today: about 3,000 listed companies, tech heavy.',
    spx: 'Where the S&P 500 stands today: 500 large US companies, the usual stand-in for the market.',
    mover: 'The largest five-session gain of the week, among the names the job could price. It says what moved, not what to buy.',
    loser: 'The largest five-session drop of the week, shown beside the gain so both ends are visible.',
    watch: 'The stocks you chose, at their last daily close. Closes, not live prices.',
    probe: 'Any coin you pick, on the same instruments as bitcoin.',
    corr: 'Whether two things move together, and how strongly. Correlation near 1 is in step, near 0 is unrelated.',
    vol: 'How violently the price has been moving lately, next to the index, so you can tell calm from turbulent.',
    dd: 'How far below its own peak the asset sits, which is what a buyer at the top would still be down.',
    subject: 'The market you are looking at. Press DATA to point it at something else.',
    investigate: 'Investigate what you were just looking at: what the figures show, what they could mean, and what they cannot tell you.',
    learn: 'The idea behind the figure you were just looking at, explained with that figure, and the session in three plain sentences.'
  };

  function setStopNote(stop) {
    setText('viewNote', STOP_NOTES[stop] || '');
  }

  /* The structured account of the current stop (MP.context), rebuilt on a
   * stop change and every half minute, not on every tick. */
  var ctxCache = { stop: null, at: 0, value: null };

  function currentContext(force) {
    var stop = currentStop();
    if (!MP.context || !stop) return null;
    if (!force && ctxCache.stop === stop && Date.now() - ctxCache.at < 20000) return ctxCache.value;
    ctxCache = { stop: stop, at: Date.now(), value: MP.context.build(stop) };
    return ctxCache.value;
  }

  /* "Larger than 94% of the last 251 daily moves." The one line that turns a
   * percentage into something a student can judge. */
  function unusualLine(ctx) {
    var m = ctx && ctx.statistics ? ctx.statistics.move : null;
    if (!m || !S.isNum(m.return) || !S.isNum(m.percentile)) return '';
    var pct = Math.round(m.percentile * 100);
    var size = F.signedPctPoints(m.return * 100, 2);
    var z = S.isNum(m.z) ? ', about ' + Math.abs(m.z).toFixed(1) + ' standard deviations from its average day' : '';
    return 'Last session moved ' + size + '. That is larger than ' + pct + '% of the last ' + m.comparedWith + ' daily moves' + z + '.';
  }

  function refreshContext(force) {
    var ctx = currentContext(force);
    if (!ctx) return;
    setText('drawerProv', MP.context.provenance(ctx));
    var line = unusualLine(ctx);
    setText('heroUnusual', currentStop() === 'btc' ? line : '');
    setText('volUnusual', currentStop() === 'vol' ? line : '');
    /* a figure on the learn screen follows the data that produced it */
    if (MP.meter && MP.meter.screen && MP.meter.screen() === 'learn') renderLearn();
  }

  /* The explainer bar: a question mark beside a figure opens it, and it
   * shows the same words wherever it is opened from. */
  function showConcept(id) {
    var c = MP.concepts ? MP.concepts.get(id) : null;
    var bar = el('conceptBar');
    if (!bar || !c) return;
    bar.hidden = false;
    bar.innerHTML = '<button type="button" class="pill close" data-concept-close="1">Close</button>' +
      '<h3>' + F.escapeHtml(c.name) + '</h3>' +
      '<p>' + F.escapeHtml(c.beginner) + '</p>' +
      '<p>' + F.escapeHtml(c.read) + '</p>' +
      '<p class="here">' + F.escapeHtml(c.advanced) + '</p>' +
      '<div class="learn-acts"><button type="button" class="lcd-act" data-learn-open="' + F.escapeHtml(c.id) +
      '">See this on the screen →</button></div>';
    if (MP.track) MP.track.event('concept_opened', id);
  }

  function hideConcept() {
    var bar = el('conceptBar');
    if (bar) { bar.hidden = true; bar.innerHTML = ''; }
  }

  /* ---- LEARN --------------------------------------------------------------- */
  /* Education attached to the measurement, not to a chapter. LEARN explains
   * the idea behind the figure already on the screen, using that figure, and
   * ends in a way back into the instrument. */
  var learnTopic = null;

  /* The learn stop has no reading of its own, so it explains the stop before
   * it. Everywhere else, the stop under the dial. */
  function learnStop() {
    var s = currentStop();
    if (s !== 'learn') return s;
    var back = MP.meter && MP.meter.lastStop ? MP.meter.lastStop() : null;
    return back && back !== 'learn' ? back : 'btc';
  }

  /* The figure a concept is about, printed as the screen prints it, with the
   * raw value so the bands can judge it. Null where the page cannot measure
   * it, which is never filled in with a guess. */
  function learnMeasure(id, stop) {
    var a = state.analytics, L = statsLabels();
    var c90 = a && a.coupling ? (a.coupling[1] || a.coupling[0]) : null;
    if (id === 'volatility') {
      return a && S.isNum(a.currentCoinVol)
        ? { text: F.pct(a.currentCoinVol, 1), raw: a.currentCoinVol, of: L.coin + ', 30 sessions' } : null;
    }
    if (id === 'correlation') {
      return c90 && S.isNum(c90.correlation)
        ? { text: F.ratio(c90.correlation, 2), raw: c90.correlation, of: L.coin + ' and the ' + L.indexName + ', 90 days' } : null;
    }
    if (id === 'beta') {
      return c90 && S.isNum(c90.beta) ? { text: F.ratio(c90.beta, 2), raw: c90.beta, of: L.coin + ' on ' + L.index } : null;
    }
    if (id === 'r2') {
      return c90 && S.isNum(c90.r2) ? { text: F.ratio(c90.r2, 2), raw: c90.r2, of: L.coin + ' and ' + L.index } : null;
    }
    if (id === 'drawdown') {
      return a && a.coinDd && S.isNum(a.coinDd.now)
        ? { text: F.signedPct(a.coinDd.now, 1), raw: a.coinDd.now, of: L.coin + ' below its peak' } : null;
    }
    var ctx = currentContext();
    if (id === 'unusual') {
      var m = ctx && ctx.statistics ? ctx.statistics.move : null;
      return m && S.isNum(m.percentile)
        ? { text: Math.round(m.percentile * 100) + '%', raw: m.percentile, of: 'of the last ' + m.comparedWith + ' daily moves' } : null;
    }
    if (id === 'marketcap') {
      var cap = ctx && ctx.instrument ? ctx.instrument.marketCap : NaN;
      return S.isNum(cap) && cap > 0 ? { text: F.compact(cap), raw: cap, of: ctx.instrument.symbol || '' } : null;
    }
    if (id === 'volume') {
      var vol = ctx && ctx.instrument ? ctx.instrument.volume : NaN;
      return S.isNum(vol) && vol > 0 ? { text: F.compact(vol), raw: vol, of: 'over 24 hours' } : null;
    }
    /* returns: the move the screen is showing, which carries no band of its
     * own on purpose */
    var r = reading(stop);
    if (r && r.change && S.isNum(r.change.pct)) {
      return { text: F.signedPctPoints(r.change.pct, 2), raw: NaN, of: (r.symbol || r.ticker || '') + ' ' + (r.change.label || '') };
    }
    return null;
  }

  var BAND_NOTE = 'LOW, MODERATE and the rest are rules of thumb this instrument uses so a figure has somewhere to stand. They are conventions, not facts about markets.';

  var learnDeep = false;     /* level three, on request */
  var learnCmpOn = false;    /* the comparison, on request */

  /* The questions a student would actually ask next. Each carries where the
   * answer lives, so an explanation never ends in a full stop. */
  function learnQuestionHtml(qs) {
    return (qs || []).map(function (q) {
      var attr = q.concept ? ' data-learn-concept="' + F.escapeHtml(q.concept) + '"'
        : q.stop ? ' data-learn-stop="' + F.escapeHtml(q.stop) + '"'
        : ' data-learn-action="' + F.escapeHtml(q.action || '') + '"';
      return '<button type="button" class="lcd-act"' + attr + '>' + F.escapeHtml(q.q) + ' →</button>';
    }).join('');
  }

  /* A figure alone means nothing to a beginner. Only two comparisons here are
   * financially sound: an asset's volatility against the index's, and its
   * fall from peak against the index's. Anything else would be a number
   * trick rather than a lesson. */
  function learnCompare(id) {
    var a = state.analytics;
    if (!a) return null;
    var L = statsLabels();
    /* the index goes by its name here, not its ticker: a beginner reading
     * "^GSPC" has learned nothing */
    if (id === 'volatility' && S.isNum(a.currentCoinVol) && S.isNum(a.currentIndexVol)) {
      return {
        mine: a.currentCoinVol, theirs: a.currentIndexVol, me: L.coin, them: L.indexName,
        mineText: F.pct(a.currentCoinVol, 1), theirsText: F.pct(a.currentIndexVol, 1)
      };
    }
    if (id === 'drawdown' && a.coinDd && a.indexDd && S.isNum(a.coinDd.now) && S.isNum(a.indexDd.now)) {
      return {
        mine: a.coinDd.now, theirs: a.indexDd.now, me: L.coin, them: L.indexName,
        mineText: F.signedPct(a.coinDd.now, 1), theirsText: F.signedPct(a.indexDd.now, 1)
      };
    }
    return null;
  }

  /* Level two: the measurement said back as a statement about this asset,
   * built only from figures the page holds. */
  function learnSentence(id, m, b, cmp) {
    if (id === 'volatility' && cmp) {
      var more = cmp.mine > cmp.theirs;
      var times = cmp.theirs > 0 ? cmp.mine / cmp.theirs : NaN;
      return cmp.me + '’s returns have moved around ' + (more ? 'more' : 'less') + ' than ' + cmp.them +
        '’s over this period' + (S.isNum(times) && times >= 1.2 ? ', about ' + times.toFixed(1) + ' times as much' : '') + '.';
    }
    if (id === 'drawdown' && cmp) {
      return cmp.me + ' sits ' + cmp.mineText + ' below its own peak, against ' + cmp.theirsText + ' for ' + cmp.them + '.';
    }
    if (id === 'correlation' && m && S.isNum(m.raw)) {
      return m.raw > 0.2 ? 'These two have tended to rise and fall on the same days.'
        : m.raw < -0.2 ? 'These two have tended to move in opposite directions.'
        : 'Their daily moves have had little to do with each other.';
    }
    if (id === 'unusual' && m && S.isNum(m.raw)) {
      return 'That move was bigger than ' + Math.round(m.raw * 100) + '% of its recent days.';
    }
    if (b && m) return 'On this instrument’s scale that counts as ' + b.label.toLowerCase() + '.';
    return '';
  }

  /* A scale a student can point at, so the range is understood before the
   * number is read. */
  function correlationScale(v) {
    if (!S.isNum(v)) return '';
    var x = ((Math.max(-1, Math.min(1, v)) + 1) / 2) * 100;
    return '<div class="cscale"><div class="cscale-bar"><i style="left:' + x.toFixed(1) + '%"></i></div>' +
      '<div class="cscale-ends"><span>−1 opposite</span><span>0 unrelated</span><span>+1 together</span></div></div>';
  }

  /* Two bars, same scale: the whole point of a comparison is seeing one
   * against the other rather than reading two numbers. */
  function compareBars(cmp) {
    if (!cmp) return '';
    var max = Math.max(Math.abs(cmp.mine), Math.abs(cmp.theirs)) || 1;
    function row(label, val, text) {
      var w = Math.max(3, Math.round(Math.abs(val) / max * 100));
      return '<div class="cbar"><span class="cbar-l">' + F.escapeHtml(label) + '</span>' +
        '<span class="cbar-t"><i style="width:' + w + '%"></i></span>' +
        '<span class="cbar-v">' + F.escapeHtml(text) + '</span></div>';
    }
    return '<div class="cbars">' + row(cmp.me, cmp.mine, cmp.mineText) +
      row(cmp.them, cmp.theirs, cmp.theirsText) + '</div>';
  }

  /* Where a return came from: the two prices and the percent between them. */
  function returnVisual(stop) {
    var r = reading(stop);
    if (!r || !r.change || !S.isNum(r.change.pct) || !S.isNum(r.value)) return '';
    var end = r.value, pct = r.change.pct;
    var start = pct === -100 ? NaN : end / (1 + pct / 100);
    if (!S.isNum(start)) return '';
    return '<div class="rvis"><span><b>' + F.escapeHtml(money(start)) + '</b>start</span>' +
      '<span class="rvis-arrow">→</span><span><b>' + F.escapeHtml(money(end)) + '</b>now</span>' +
      '<span class="rvis-pct"><b>' + F.escapeHtml(F.signedPctPoints(pct, 2)) + '</b>' +
      F.escapeHtml(r.change.label || '') + '</span></div>';
  }

  /* A personal map of what the student has met, not a score. */
  var EXPLORED_KEY = 'explored';

  function markExplored(id) {
    if (!MP.store || !id) return [];
    var list = MP.store.get(EXPLORED_KEY, []);
    if (!Array.isArray(list)) list = [];
    if (list.indexOf(id) < 0) list.push(id);
    list = list.slice(0, 40);
    MP.store.set(EXPLORED_KEY, list);
    return list;
  }

  function explored() {
    var list = MP.store ? MP.store.get(EXPLORED_KEY, []) : [];
    return Array.isArray(list) ? list.filter(function (id) { return !!(MP.concepts && MP.concepts.get(id)); }) : [];
  }

  /* The screen holds one layer at a time. Level one is the term, the live
   * figure, the word for its size and one plain sentence. Level two says
   * what that means for this asset. DEEPER swaps in level three. The
   * comparison and the long form wait until they are asked for, so a
   * beginner is never dropped into a textbook. */
  function renderLearn() {
    var c = MP.concepts ? MP.concepts.get(learnTopic) : null;
    if (!c) return;
    var stop = learnStop();
    var m = learnMeasure(c.id, stop);
    var b = m && S.isNum(m.raw) ? MP.concepts.band(c.id, m.raw) : null;
    var cmp = learnCompare(c.id);

    setText('lcdLearnTerm', c.name.toUpperCase());
    setText('lcdLearnMeta', m && m.of ? m.of : '');
    setText('lcdLearnValue', m ? m.text : F.DASH);
    var bandEl = el('lcdLearnBand');
    if (bandEl) {
      bandEl.textContent = b ? b.label : '';
      bandEl.className = 'lcd-learn-band' + (b ? ' is-' + b.tone : '');
    }

    setText('lcdLearnShort', c.beginner);
    var said = learnSentence(c.id, m, b, cmp);
    setText('lcdLearnRead', learnDeep ? c.advanced : (said || c.read));

    /* show before explain, where showing teaches something */
    var visual = '';
    if (learnCmpOn && cmp) visual = compareBars(cmp);
    else if (c.visual === 'scale') visual = correlationScale(m ? m.raw : NaN);
    else if (c.visual === 'return') visual = returnVisual(stop);
    setHtml('lcdLearnVisual', visual);

    /* the questions, plus the one the keypad owns */
    var qs = c.explorations.filter(function (q) {
      return q.action !== 'compare' || !!cmp;
    });
    setHtml('lcdLearnActs', learnQuestionHtml(qs));

    var deeper = keyOf('deeper');
    if (deeper) {
      deeper.textContent = learnDeep ? 'SIMPLER' : 'DEEPER';
      deeper.classList.toggle('is-on', learnDeep);
    }
    renderLearnCard(c, m, b, cmp, said);
  }

  function keyOf(act) { return document.querySelector('.keys .key[data-act="' + act + '"]'); }

  /* Level three, and back again. */
  function learnDeeper() {
    learnDeep = !learnDeep;
    renderLearn();
    return learnDeep;
  }

  /* The comparison is the answer to "is that a lot?", so it arrives when
   * that question is pressed rather than sitting there by default. */
  function learnAction(name) {
    if (name === 'compare') {
      learnCmpOn = true;
      learnDeep = false;
      renderLearn();
    }
    return name;
  }

  /* The drawer: the same concept in full, for a reader who wants all of it
   * at once, plus the ideas met so far. */
  function renderLearnCard(c, m, b, cmp, said) {
    if (!c) { setHtml('learnCard', ''); return; }
    var rows = [
      ['What it is', c.beginner],
      ['How to read it', c.read],
      ['Why it matters', c.why],
      ['The usual mistake', c.misconception],
      ['How this page measures it', c.advanced]
    ];
    var met = explored();
    var related = c.related.filter(function (id) { return !!MP.concepts.get(id); });
    setHtml('learnCard',
      '<div class="concept concept-learn">' +
      '<h3>' + F.escapeHtml(c.name) + '</h3>' +
      (m ? '<p class="learn-figure">' + F.escapeHtml(m.text) +
        (b ? ' <span class="band is-' + b.tone + '">' + F.escapeHtml(b.label) + '</span>' : '') +
        (m.of ? ' <span class="learn-of">' + F.escapeHtml(m.of) + '</span>' : '') + '</p>' : '') +
      (said ? '<p class="learn-said">' + F.escapeHtml(said) + '</p>' : '') +
      (cmp ? compareBars(cmp) : '') +
      rows.map(function (r) {
        return '<p class="learn-row"><b>' + F.escapeHtml(r[0]) + '</b> ' + F.escapeHtml(r[1]) + '</p>';
      }).join('') +
      '<div class="learn-acts">' + learnQuestionHtml(c.explorations) + '</div>' +
      (related.length ? '<p class="learn-rel">Connects to ' + related.map(function (id) {
        return '<button type="button" class="linkish" data-learn-concept="' + F.escapeHtml(id) + '">' +
          F.escapeHtml(MP.concepts.get(id).name.toLowerCase()) + '</button>';
      }).join(', ') + '.</p>' : '') +
      (b ? '<p class="foot">' + F.escapeHtml(BAND_NOTE) + '</p>' : '') +
      (met.length > 1 ? '<p class="learn-met"><b>Ideas you have met</b> ' + met.map(function (id) {
        return '<button type="button" class="linkish" data-learn-concept="' + F.escapeHtml(id) + '">' +
          F.escapeHtml(MP.concepts.get(id).name.toLowerCase()) + '</button>';
      }).join(', ') + '</p>' : '') +
      '</div>');
  }

  /* topic: a concept id, or nothing to explain whatever the dial is on.
   * Every opening starts at level one with the comparison put away. */
  function openLearn(topic) {
    var wanted = MP.concepts && MP.concepts.get(topic) ? topic : null;
    learnTopic = wanted || (MP.concepts ? MP.concepts.bindingFor(learnStop()) : null) || 'returns';
    learnDeep = false;
    learnCmpOn = false;
    markExplored(learnTopic);
    renderLearn();
    if (MP.track) MP.track.event('concept_opened', learnTopic);
    return learnTopic;
  }

  /* ---- the soft keys that need the page's state ---------------------------- */

  /* WATCH on a mover: put that stock on the list, or take it off. Coins
   * cannot go on a list of Nasdaq-100 stocks, so the key does nothing there. */
  function toggleWatchCurrent() {
    var stop = currentStop();
    var r = reading(stop);
    var sym = r ? r.symbol : null;
    var crypto = MP.spotlight && MP.spotlight.kind() === 'crypto';
    if (!sym || ((stop === 'mover' || stop === 'loser') && crypto)) return null;
    if (isWatched(sym)) removeWatch(sym);
    else addWatch(sym);
    repaint();
    return sym;
  }

  /* COMPARE on a statistics stop: measure against the other index. */
  function cycleIndex() {
    var next = state.stats.index === 'ixic' ? 'spx' : 'ixic';
    setStats({ index: next });
    return next;
  }

  /* ---- customize the dial --------------------------------------------------
   * Which functions occupy the plate. OFF and SUBJECT are fixed; the rest can
   * be switched off, as long as one way of explaining a reading survives. */
  var dialDraft = null;

  function openDialConfig() {
    dialDraft = MP.dial ? MP.dial.load() : null;
    renderDialConfig();
  }

  function renderDialConfig() {
    var D = MP.dial;
    if (!D || !dialDraft) return;
    var rows = D.FIXED.concat(D.OPTIONAL).map(function (id) {
      var fixed = D.FIXED.indexOf(id) >= 0;
      var on = dialDraft.indexOf(id) >= 0;
      var locked = fixed || (on && !D.canRemove(dialDraft, id));
      /* here the slot is named by what it is, not by what it currently points
       * at: this screen configures positions, not assets */
      var name = id === 'subject' ? 'SUBJECT' : D.labelFor(id);
      var note = id === 'subject'
        ? 'Now showing ' + (statsCoinSymbol(state.stats.coin) || 'BTC') + '. ' + (D.NOTES[id] || '')
        : (D.NOTES[id] || '');
      return '<li><button type="button" class="cfg-row' + (on ? '' : ' is-off') + (locked ? ' is-fixed' : '') +
        '" data-cfg="' + F.escapeHtml(id) + '"' + (locked ? ' aria-disabled="true"' : '') +
        ' aria-pressed="' + (on ? 'true' : 'false') + '">' +
        '<span class="cfg-mark">' + (on ? '■' : '□') + '</span>' +
        '<span class="cfg-name">' + F.escapeHtml(name) + '</span>' +
        '<span class="cfg-note">' + F.escapeHtml(note) + '</span></button></li>';
    }).join('');
    setHtml('lcdConfigRows', rows);
    setText('lcdConfigCount', dialDraft.length + ' OF ' + D.MAX);
  }

  function toggleDialRow(id) {
    var D = MP.dial;
    if (!D || !dialDraft || D.FIXED.indexOf(id) >= 0) return dialDraft;
    if (dialDraft.indexOf(id) >= 0) {
      if (!D.canRemove(dialDraft, id)) return dialDraft;
      dialDraft = D.read(dialDraft.filter(function (x) { return x !== id; }));
    } else {
      /* keep the canonical order rather than appending in click order */
      dialDraft = D.read(D.OPTIONAL.filter(function (x) {
        return x === id || dialDraft.indexOf(x) >= 0;
      }));
    }
    renderDialConfig();
    return dialDraft;
  }

  function saveDialConfig() {
    if (!MP.dial || !dialDraft) return null;
    var saved = MP.dial.save(dialDraft);
    if (MP.meter) MP.meter.applyDial(saved);
    syncSubjectPosition();
    if (MP.meter) MP.meter.setScreen('reading');
    repaint();
    return saved;
  }

  function resetDialConfig() {
    if (!MP.dial) return null;
    var def = MP.dial.reset();
    dialDraft = def.slice();
    if (MP.meter) MP.meter.applyDial(def);
    syncSubjectPosition();
    renderDialConfig();
    repaint();
    return def;
  }

  function wireDialConfig() {
    var host = el('lcdConfigRows');
    if (!host) return;
    host.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('[data-cfg]') : null;
      if (b && b.getAttribute('aria-disabled') !== 'true') toggleDialRow(b.getAttribute('data-cfg'));
    });
  }

  /* ---- the first-visit orientation ------------------------------------------
   * One overlay, about fifteen seconds of reading, with the instrument still
   * visible behind it. Shown once; reachable afterwards from HOW IT WORKS. */
  var INTRO_KEY = 'intro';
  var introReturn = null;

  function introSeen() {
    return !!(MP.store && MP.store.get(INTRO_KEY, false));
  }

  function showIntro(force) {
    var box = el('intro');
    if (!box || (!force && introSeen())) return false;
    introReturn = document.activeElement;
    box.hidden = false;
    var stage = document.querySelector('.stage');
    if (stage) stage.setAttribute('inert', '');
    var go = el('introGo');
    if (go) setTimeout(function () { try { go.focus({ preventScroll: true }); } catch (e) { go.focus(); } }, 0);
    return true;
  }

  function hideIntro() {
    var box = el('intro');
    if (!box || box.hidden) return false;
    box.hidden = true;
    var stage = document.querySelector('.stage');
    if (stage) stage.removeAttribute('inert');
    if (!introReturn || introReturn === document.body) introReturn = el('knob');
    if (MP.store) MP.store.set(INTRO_KEY, true);
    if (introReturn && introReturn.focus) { try { introReturn.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
    introReturn = null;
    return true;
  }

  function wireIntro() {
    var dialSettings = el('dialSettings');
    if (dialSettings) dialSettings.addEventListener('click', function () { MP.meter.setScreen('config'); });
    var box = el('intro'), go = el('introGo'), how = el('howBtn');
    if (go) go.addEventListener('click', function () { hideIntro(); if (MP.meter) MP.meter.setScreen('search'); });
    var about = el('aboutDialog'), aboutBtn = el('aboutBtn');
    if (about && aboutBtn) aboutBtn.addEventListener('click', function () { about.showModal(); });
    if (about) about.addEventListener('keydown', function (ev) { ev.stopPropagation(); });
    if (how) how.addEventListener('click', function () { showIntro(true); });
    if (box) {
      box.addEventListener('click', function (ev) { if (ev.target === box) hideIntro(); });
    }
    document.addEventListener('keydown', function (ev) {
      if (!box || box.hidden) return;
      if (ev.key === 'Escape') { hideIntro(); ev.preventDefault(); ev.stopImmediatePropagation(); }
      else if (ev.key === 'Tab') { ev.preventDefault(); if (go) go.focus(); }
    });
    showIntro(false);
  }

  /* ---- PROBE ---------------------------------------------------------------
   * The investigative mode. It reads the instrument's own context, answers
   * what arithmetic can answer, and says plainly where nothing can. Naming
   * note: renderProbe and wireProbe already belong to the custom-coin picker
   * in the drawer, so the screen's functions carry their own names.
   * ------------------------------------------------------------------------ */
  var probeView = { ctx: null, finding: null, source: false };

  function probeContext(question) {
    if (!MP.probe) return null;
    return MP.probe.build({
      stop: currentStop(),
      analytics: state.analytics,
      labels: statsLabels(),
      question: question || null
    });
  }

  function probeSubjectLine(ctx) {
    if (!ctx) return '';
    var mode = { vol: 'VOLATILITY', corr: 'CORRELATION', dd: 'DRAWDOWN' }[ctx.mode] || '';
    var sym = ctx.subject.symbol || '';
    return mode && sym ? sym + ' / ' + mode : sym || mode;
  }

  function openProbe() {
    probeView.ctx = probeContext(null);
    probeView.finding = null;
    probeView.source = false;
    paintProbe();
    if (MP.track) MP.track.event('probe_opened', currentStop());
    return probeView.ctx;
  }

  function probeQuestionsHtml(list) {
    return (list || []).map(function (q) {
      return '<button type="button" class="probe-q" data-probe-q="' + F.escapeHtml(q) + '">' + F.escapeHtml(q) + '</button>';
    }).join('');
  }

  function probeActionsHtml(actions) {
    return (actions || []).map(function (a, i) {
      return '<button type="button" class="lcd-act" data-probe-act="' + i + '">' + F.escapeHtml(a.label) + ' →</button>';
    }).join('');
  }

  function probeSection(title, items, evidence) {
    if (!items || !items.length) return '';
    return '<p class="probe-sec">' + F.escapeHtml(title) + '</p><ul class="probe-list' + (evidence ? ' is-evidence' : '') + '">' +
      items.map(function (it) {
        return '<li>' + F.escapeHtml(typeof it === 'string' ? it : it.text) + '</li>';
      }).join('') + '</ul>';
  }

  function paintProbe() {
    var ctx = probeView.ctx, f = probeView.finding;
    setText('lcdProbeSubject', probeSubjectLine(ctx));

    if (probeView.source) {
      setText('lcdProbeState', 'SOURCES');
      setHtml('lcdProbeBody', probeSection('WHERE THIS COMES FROM', MP.probe ? MP.probe.provenance(ctx) : [], false));
      return;
    }

    if (!f) {
      var qs = MP.probe ? MP.probe.questionsFor(ctx) : [];
      setText('lcdProbeState', qs.length ? 'PROBE READY' : 'INSUFFICIENT DATA');
      setHtml('lcdProbeBody', qs.length
        ? '<p class="probe-sum">What are you curious about?</p>' + probeQuestionsHtml(qs)
        : '<p class="probe-sum">There is nothing measured on this stop yet for PROBE to investigate. Turn to a measurement, or ask a question below.</p>');
      return;
    }

    var STATE = { answered: 'EVIDENCE FOUND', insufficient: 'LIMITED EVIDENCE', refused: 'OUT OF SCOPE', unavailable: 'PROBE UNAVAILABLE' };
    setText('lcdProbeState', STATE[f.status] || 'EVIDENCE FOUND');
    setHtml('lcdProbeBody',
      '<div class="probe-head is-' + F.escapeHtml(f.status) + '">' + F.escapeHtml(f.answer.headline) + '</div>' +
      (f.answer.summary ? '<p class="probe-sum">' + F.escapeHtml(f.answer.summary) + '</p>' : '') +
      probeSection('WHAT WE SEE', f.observations, true) +
      probeSection('WHAT IT COULD MEAN', f.interpretation, false) +
      probeSection('WHAT WE CANNOT TELL', f.uncertainty, false) +
      '<div class="probe-acts">' + probeActionsHtml(f.actions) + '</div>' +
      (f.followUps && f.followUps.length ? '<p class="probe-sec">ASK NEXT</p>' + probeQuestionsHtml(f.followUps) : ''));
  }

  /* A question, answered from the instrument's own figures. */
  function askProbe(question, suggested) {
    if (!MP.probe) return null;
    var q = String(question || '').trim();
    if (!q) return null;
    probeView.ctx = probeContext(q);
    probeView.source = false;
    if (MP.track) {
      /* the topic is a fixed vocabulary; the student's words are never kept */
      MP.track.event(suggested ? 'probe_suggested_question_selected' : 'probe_custom_question_submitted',
        MP.probe.topicOf(q, probeView.ctx) || 'other');
    }
    probeView.finding = MP.probe.answer(probeView.ctx, q);
    if (!probeView.finding) {
      probeView.finding = {
        status: 'unavailable', origin: 'local',
        answer: { headline: 'PROBE CANNOT ANSWER THAT YET', summary: 'This question needs evidence Multimeter does not hold. The instrument keeps prices and the measurements taken from them, and nothing else.' },
        observations: [], interpretation: [], uncertainty: ['No verified event or company information is loaded.'],
        concepts: [], actions: [], followUps: []
      };
    }
    paintProbe();
    if (MP.track) {
      MP.track.event(probeView.finding.status === 'answered' ? 'probe_completed' : 'probe_insufficient_evidence',
        probeView.finding.status);
    }
    return probeView.finding;
  }

  /* Claude may one day suggest an action; the instrument decides what runs.
   * Only the allowlist executes, and only against things that exist. */
  function runProbeAction(a) {
    if (!a || !MP.probe || !MP.probe.validAction(a)) return null;
    if (a.type === 'OPEN_LEARN') {
      if (MP.track) MP.track.event('probe_learn_selected', a.concept);
      if (MP.meter) MP.meter.setScreen('learn', a.concept);
      return a.type;
    }
    if (MP.track) MP.track.event('probe_instrument_action_selected', a.type.toLowerCase().slice(0, 16));
    if (a.type === 'OPEN_MODE' && MP.router) MP.router.go(a.mode);
    else if (a.type === 'SET_COMPARISON') setStats({ index: a.index });
    else if (a.type === 'OPEN_DATA' && MP.meter) MP.meter.setScreen('search');
    else if (a.type === 'RETURN' && MP.meter) MP.meter.setScreen('reading');
    return a.type;
  }

  function focusProbeAsk() {
    var input = el('lcdProbeInput');
    if (input) { try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); } }
  }

  function toggleProbeSource() {
    probeView.source = !probeView.source;
    paintProbe();
    return probeView.source;
  }

  function wireProbeScreen() {
    var body = el('lcdProbeBody');
    if (body) {
      body.addEventListener('click', function (ev) {
        var t = ev.target && ev.target.closest ? ev.target : null;
        if (!t) return;
        var q = t.closest('[data-probe-q]');
        if (q) { askProbe(q.getAttribute('data-probe-q'), true); return; }
        var act = t.closest('[data-probe-act]');
        if (act && probeView.finding) {
          runProbeAction(probeView.finding.actions[parseInt(act.getAttribute('data-probe-act'), 10)]);
        }
      });
    }
    var form = el('lcdProbeAsk');
    if (form) {
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var input = el('lcdProbeInput');
        if (!input) return;
        askProbe(input.value, false);
        input.value = '';
      });
    }
  }

  /* Feedback: three questions, opened as a GitHub issue the tester can read
   * before sending. Counts go only if they paste them. */
  function openFeedback() {
    var base = 'https://github.com/jackmcmurry/multimeter/issues/new';
    var body = ['What confused you?', '', 'What was useful?', '', 'What would bring you back?', '',
      'Stop you were on: ' + (currentStop() || 'unknown'), '',
      'Usage counts (optional, from this browser only):', '', MP.track ? MP.track.report() : ''].join('\n');
    var url = base + '?title=' + encodeURIComponent('Feedback') + '&body=' + encodeURIComponent(body);
    if (MP.track) MP.track.event('feedback_opened');
    root.open(url, '_blank', 'noopener');
  }

  function wireLearn() {
    var drawer = el('drawer');
    if (drawer) {
      drawer.addEventListener('click', function (ev) {
        var t = ev.target && ev.target.closest ? ev.target : null;
        if (!t) return;
        var ask = t.closest('[data-concept]');
        if (ask) { showConcept(ask.getAttribute('data-concept')); return; }
        var full = t.closest('[data-learn-open]');
        if (full) {
          if (MP.meter) MP.meter.setScreen('learn', full.getAttribute('data-learn-open'));
          return;
        }
        if (t.closest('[data-concept-close]')) hideConcept();
      });
    }
    var fb = el('feedbackBtn');
    if (fb) fb.addEventListener('click', openFeedback);

    /* An explanation always ends somewhere in the instrument: another
     * concept, or the stop that measures it. */
    function actions(host) {
      if (!host) return;
      host.addEventListener('click', function (ev) {
        var b = ev.target.closest ? ev.target.closest('[data-learn-stop],[data-learn-concept],[data-learn-action]') : null;
        if (!b) return;
        var concept = b.getAttribute('data-learn-concept');
        if (concept) {
          openLearn(concept);
          if (MP.meter && MP.meter.screen() !== 'learn') MP.meter.setScreen('learn', concept);
          return;
        }
        var act = b.getAttribute('data-learn-action');
        if (act) { learnAction(act); return; }
        var stop = b.getAttribute('data-learn-stop');
        if (stop && MP.router) MP.router.go(stop);
      });
    }
    actions(el('lcdLearnActs'));
    actions(el('learnCard'));
  }

  /* ---- the screen's search ------------------------------------------------- */
  /* One search for every "which instrument?" the meter asks: the DATA key
   * and the watch list's ADD open the same panel, on the screen itself. The
   * local index answers immediately; coins the page has never heard of are
   * merged in from CoinGecko a moment later. */
  var find = { query: '', results: [], active: 0, remote: [], timer: null };

  function searchIndex() {
    return MP.search.build({
      stocks: (state.stocks.list ? state.stocks.list.rows : []).concat(catalogue.rows),
      coins: MP.spotlight ? MP.spotlight.CRYPTO_UNIVERSE : [],
      remote: find.remote
    });
  }

  function openSearch() {
    find = { query: '', results: [], active: 0, remote: [], timer: null };
    var input = el('lcdSearchInput');
    if (input) {
      input.value = '';
      setTimeout(function () { try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); } }, 0);
    }
    runSearch('');
    if (MP.track) MP.track.event('search_opened');
  }

  function runSearch(q) {
    find.query = String(q || '');
    find.results = MP.search.query(searchIndex(), find.query,
      find.query ? MP.search.LIMIT : MP.search.SHORTLIST);
    find.active = 0;
    renderSearchResults();
    clearTimeout(find.timer);
    if (find.query.trim().length >= 2) {
      find.timer = setTimeout(function () { remoteCoins(find.query.trim()); }, 350);
    }
  }

  function remoteCoins(q) {
    var spec = SRC.coinSearch(q);
    fetchJson(spec.url).then(function (payload) {
      if (find.query.trim() !== q) return;
      find.remote = spec.normalize(payload) || [];
      find.results = MP.search.query(searchIndex(), find.query,
        find.query ? MP.search.LIMIT : MP.search.SHORTLIST);
      renderSearchResults();
    }).catch(function () { /* the local index has already answered */ });
  }

  /* A beginner cannot be expected to know what a ticker stands for, so every
   * row says what kind of thing it is. Stocks keep their last close beside
   * the type, since a price is the one number a newcomer already reads. */
  var KIND_LABEL = { stock: 'STOCK', coin: 'CRYPTO', index: 'INDEX' };

  function pickRow(i, e, active) {
    var meta = '', cls = '';
    if (e.kind === 'stock' && S.isNum(e.close)) {
      meta = money(e.close);
      if (S.isNum(e.change1d)) { meta += '  ' + F.signedPctPoints(e.change1d, 2); cls = e.change1d >= 0 ? 'is-up' : 'is-down'; }
    }
    return '<li><button type="button" class="lcd-pick' + (active ? ' is-active' : '') + '" role="option"' +
      ' id="search-option-' + i + '" aria-selected="' + (active ? 'true' : 'false') + '" data-pick="' + i + '">' +
      '<span class="sym">' + F.escapeHtml(e.symbol) + '</span>' +
      '<span class="desc">' + F.escapeHtml(e.name || '') +
      '<span class="kind">' + F.escapeHtml(KIND_LABEL[e.kind] || '') + '</span></span>' +
      '<span class="meta ' + cls + '">' + F.escapeHtml(meta) + '</span></button></li>';
  }

  function renderSearchResults() {
    var host = el('lcdResults');
    if (!host) return;
    var input = el('lcdSearchInput');
    if (input) input.removeAttribute('aria-activedescendant');
    if (!find.results.length) {
      var message = find.query ? 'Nothing matches "' + F.escapeHtml(find.query) + '"' : 'Type a ticker, a company or a coin';
      if (!state.stocks.list) message = state.stocks.notice
        ? 'Stock search is unavailable. The stock catalogue could not be loaded. You can still search indexes and crypto.'
        : 'Loading the stock catalogue. Indexes and crypto are available now.';
      host.innerHTML = '<li class="lcd-empty">' + message + '</li>';
      return;
    }
    host.innerHTML = find.results.map(function (e, i) { return pickRow(i, e, i === find.active); }).join('');
    if (input) input.setAttribute('aria-activedescendant', 'search-option-' + find.active);
  }

  function moveSearch(by) {
    if (!find.results.length) return;
    find.active = (find.active + by + find.results.length) % find.results.length;
    renderSearchResults();
    var option = el('search-option-' + find.active);
    if (option) option.scrollIntoView({ block: 'nearest' });
  }

  /* Selecting sets the instrument, closes search and leaves the meter on the
   * stop that shows it. */
  function selectSearch(i) {
    var e = find.results[i];
    var r = e ? MP.search.route(e) : null;
    if (!r) return;
    if (MP.track) MP.track.event('instrument_selected', e.kind);
    if (r.action === 'setCoin') setProbe(r.coin);
    if (r.action === 'watch') { addWatch(r.symbol); setStats({ coin: r.symbol }); ensureStock(r.symbol); r.stop = 'subject'; }
    if (MP.meter) MP.meter.setScreen(r.stop === 'watch' ? 'list' : 'reading');
    if (MP.router) MP.router.go(r.stop);
    repaint();
  }

  /* ---- the screen's watch list --------------------------------------------- */
  function renderScreenList() {
    var host = el('lcdListRows'), w = state.watch;
    setText('lcdListCount', w.list.length ? (w.index + 1) + '/' + w.list.length : '');
    if (!host) return;
    if (!w.list.length) {
      host.innerHTML = '<li class="lcd-empty"><b>THINGS YOU WANT TO FOLLOW</b><p>Keep companies you are curious about here. You do not need to own them.</p><p>Press ADD, search a ticker, then select it. Your list stays in this browser.</p></li>';
      return;
    }
    host.innerHTML = w.list.map(function (sym, i) {
      var row = stockRow(sym);
      var meta = row && S.isNum(row.close) ? money(row.close) : F.DASH;
      var cls = '';
      if (row && S.isNum(row.change1d)) {
        meta += '  ' + F.signedPctPoints(row.change1d, 2);
        cls = row.change1d >= 0 ? 'is-up' : 'is-down';
      }
      return '<li><button type="button" class="lcd-pick' + (i === w.index ? ' is-active' : '') + '" role="option"' +
        ' aria-selected="' + (i === w.index ? 'true' : 'false') + '" data-row="' + i + '">' +
        '<span class="sym">' + F.escapeHtml(sym) + '</span>' +
        '<span class="desc">' + F.escapeHtml(row ? row.name : '') + '</span>' +
        '<span class="meta ' + cls + '">' + F.escapeHtml(meta) + '</span></button></li>';
    }).join('');
  }

  /* i below zero means the row already highlighted, which is what OPEN does. */
  function openWatchRow(i) {
    if (S.isNum(i) && i >= 0) state.watch.index = i;
    ensureStock(watchSymbol());
    syncSubjectToWatch();
    if (MP.meter) MP.meter.setScreen('reading');
    renderScreenList();
    renderWatch();
    repaint();
  }

  function removeCurrentWatch() {
    var sym = watchSymbol();
    if (sym) removeWatch(sym);
    renderScreenList();
  }

  function wireScreen() {
    var input = el('lcdSearchInput');
    if (input) {
      input.addEventListener('input', function () { runSearch(input.value); });
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'ArrowDown') { moveSearch(1); ev.preventDefault(); }
        else if (ev.key === 'ArrowUp') { moveSearch(-1); ev.preventDefault(); }
        else if (ev.key === 'Enter') { selectSearch(find.active); ev.preventDefault(); }
        else if (ev.key === 'Escape') {
          if (MP.meter) MP.meter.setScreen(currentStop() === 'watch' ? 'list' : 'reading');
          ev.preventDefault();
        }
      });
    }
    var results = el('lcdResults');
    if (results) {
      results.addEventListener('click', function (ev) {
        var b = ev.target.closest ? ev.target.closest('[data-pick]') : null;
        if (b) selectSearch(parseInt(b.getAttribute('data-pick'), 10));
      });
    }
    var rows = el('lcdListRows');
    if (rows) {
      rows.addEventListener('click', function (ev) {
        var b = ev.target.closest ? ev.target.closest('[data-row]') : null;
        if (b) openWatchRow(parseInt(b.getAttribute('data-row'), 10));
      });
    }
    /* the first visit's three starting points */
    var welcome = el('lcdWelcome');
    if (welcome) {
      welcome.addEventListener('click', function (ev) {
        var b = ev.target.closest ? ev.target.closest('[data-welcome]') : null;
        if (!b) return;
        var stop = b.getAttribute('data-welcome');
        if (MP.meter) MP.meter.dismissWelcome();
        if (MP.router) MP.router.go(stop);
        repaint();
      });
    }
  }

  /* ---- WATCH --------------------------------------------------------------- */

  function isWatched(sym) { return state.watch.list.indexOf(String(sym || '').toUpperCase()) >= 0; }

  function afterWatchChange() {
    ensureStock(watchSymbol());
    syncSubjectToWatch();
    renderWatch();
    renderScreenList();
    if (MP.spotlight) MP.spotlight.render();
    repaint();
  }

  /* The row under the cursor on the WATCH stop is the subject, so stepping
   * through the list and then turning to VOL measures the stock on screen. */
  function syncSubjectToWatch() {
    var sym = watchSymbol();
    if (sym && currentStop() === 'watch' && sym !== state.stats.coin) setStats({ coin: sym });
  }

  function addWatch(sym) {
    var w = state.watch, s = String(sym || '').trim().toUpperCase();
    if (!MP.watch || !s) return;
    if (w.list.indexOf(s) < 0) {
      if (w.list.length >= MP.watch.MAX) {
        w.notice = { level: 'warn', text: 'The watch list holds ' + MP.watch.MAX + ' stocks. Remove one to add another.' };
        renderWatch();
        return;
      }
      w.list = MP.watch.save(MP.watch.add(w.list, s));
    }
    w.index = Math.max(0, w.list.indexOf(s));
    w.notice = null;
    w.query = '';
    w.results = [];
    var input = el('watchSearch');
    if (input) input.value = '';
    afterWatchChange();
  }

  function removeWatch(sym) {
    var w = state.watch;
    if (!MP.watch) return;
    w.list = MP.watch.save(MP.watch.remove(w.list, sym));
    if (w.index >= w.list.length) w.index = Math.max(0, w.list.length - 1);
    w.notice = null;
    afterWatchChange();
  }

  function stepWatch(by) {
    var w = state.watch;
    if (w.list.length < 2) return;
    w.index = (w.index + (by < 0 ? -1 : 1) + w.list.length) % w.list.length;
    afterWatchChange();
  }

  function setWatchRange(n) {
    if (!sessionsLabel(n)) return;
    state.watch.sessions = n;
    repaint();
  }

  function searchWatch(q) {
    var w = state.watch;
    w.query = String(q || '').trim();
    var rows = state.stocks.list ? state.stocks.list.rows : [];
    w.results = MP.watch ? MP.watch.search(rows, w.query, 16).filter(function (r) {
      return w.list.indexOf(r.symbol) < 0;
    }).slice(0, 8) : [];
    renderWatch();
  }

  function renderWatch() {
    var w = state.watch;
    var res = el('watchResults');
    if (res) {
      res.innerHTML = w.results.map(function (r) {
        return '<li><button type="button" class="pick" data-watch-add="' + F.escapeHtml(r.symbol) + '">' +
          '<span class="row-code">' + F.escapeHtml(r.symbol) + '</span>' +
          '<span class="row-desc">' + F.escapeHtml(r.name + (S.isNum(r.close) ? ' · ' + money(r.close) : '')) + '</span></button></li>';
      }).join('') + (w.query && !w.results.length && state.stocks.list
        ? '<li class="row-desc">No stock matches "' + F.escapeHtml(w.query) + '".</li>' : '');
    }

    var host = el('watchTable');
    if (host) {
      host.innerHTML = w.list.length
        ? '<table class="data watch-table"><thead><tr><th scope="col">Stock</th><th scope="col">Close</th><th scope="col">Date</th>' +
          '<th scope="col">1D</th><th scope="col">5D</th><th scope="col" aria-label="Remove"></th></tr></thead><tbody>' +
          w.list.map(function (sym, i) {
            var row = stockRow(sym);
            function pctCell(v) {
              return '<td><span class="' + changeClass(v) + '">' + (S.isNum(v) ? F.signedPctPoints(v, 2) : F.DASH) + '</span></td>';
            }
            return '<tr' + (i === w.index ? ' class="is-on"' : '') + '>' +
              '<th scope="row"><button type="button" class="linkish" data-watch-pick="' + i + '">' + F.escapeHtml(sym) + '</button>' +
              '<div class="row-desc">' + F.escapeHtml(row ? row.name : (state.stocks.list ? 'not in the current list' : '')) + '</div></th>' +
              '<td>' + (row && S.isNum(row.close) ? money(row.close) : F.DASH) + '</td>' +
              '<td class="dim">' + (row && row.date ? F.shortDate(row.date) : F.DASH) + '</td>' +
              pctCell(row ? row.change1d : NaN) + pctCell(row ? row.change5d : NaN) +
              '<td><button type="button" class="pill" data-watch-del="' + F.escapeHtml(sym) + '" aria-label="Remove ' + F.escapeHtml(sym) + '">✕</button></td></tr>';
          }).join('') + '</tbody></table>'
        : '<p class="row-desc">Nothing on the watch list yet. Search above to add up to ' + (MP.watch ? MP.watch.MAX : 8) + ' stocks.</p>';
    }
    setHtml('watchNotice', noticeHtml(w.notice || state.stocks.notice));
  }

  function wireWatch() {
    var input = el('watchSearch');
    if (input) {
      input.addEventListener('input', function () { searchWatch(input.value); });
      input.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        var first = document.querySelector('#watchResults [data-watch-add]');
        if (first) first.click();
      });
    }
    var drawer = el('drawer');
    if (!drawer) return;
    drawer.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest ? ev.target : null;
      if (!t) return;
      var add = t.closest('[data-watch-add]');
      if (add) { if (!add.disabled) addWatch(add.getAttribute('data-watch-add')); return; }
      var del = t.closest('[data-watch-del]');
      if (del) { removeWatch(del.getAttribute('data-watch-del')); return; }
      var pick = t.closest('[data-watch-pick]');
      if (pick) {
        state.watch.index = parseInt(pick.getAttribute('data-watch-pick'), 10) || 0;
        if (MP.router && MP.router.currentView() !== 'watch') MP.router.go('watch');
        afterWatchChange();
        return;
      }
      var kindBtn = t.closest('[data-movers-kind]');
      if (kindBtn) setMoversKind(kindBtn.getAttribute('data-movers-kind'));
    });
  }

  /* ---- the daily reading -------------------------------------------------- */

  /* The NOTE stop: the words take the chart's place, the session date the
   * price's, and the change line says who wrote it. No value, so REL,
   * MIN/MAX and ALERT pass it by. */
  function learnReading() {
    var d = state.note.data;
    return {
      text: d ? F.shortDate(d.forSession) : F.DASH, value: NaN, dp: 0,
      unit: d ? 'SESSION' : '', mode: 'DAILY READING',
      change: { pct: NaN, abs: NaN, delta: NaN, suffix: '', label: '', dp: 0 },
      /* Short enough for one line on a phone, where the change line holds a
       * single row on every stop so the display keeps one height. */
      caption: d ? (d.source === 'claude' ? 'By Claude · not advice' : 'From the numbers · not advice') : '',
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
      [['Nasdaq-100, five sessions', inp.stocks], ['Crypto, seven days', inp.crypto]].forEach(function (pair) {
        var set = pair[1];
        if (!set || !set.mover || !S.isNum(set.mover.change)) return;
        row(pair[0], 'highest ' + set.mover.symbol + ' ' + F.signedPctPoints(set.mover.change, 1) +
          (set.loser && S.isNum(set.loser.change) ? ' · lowest ' + set.loser.symbol + ' ' + F.signedPctPoints(set.loser.change, 1) : ''));
      });
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
      MP.router.onChange(onStopChange);
      MP.router.start();
    }
    tickSession();
    wireAlerts();
    renderAlerts();
    wireProbe();
    wireWatch();
    renderWatch();
    wireScreen();
    wireProbeScreen();
    wireDialConfig();
    wireIntro();
    wireLearn();
    syncSubjectPosition();
    if (MP.track) MP.track.start();
    if (MP.spotlight && MP.spotlight.wire) MP.spotlight.wire();
    if (MP.meter && MP.meter.setStopLabel && state.probe) MP.meter.setStopLabel('probe', state.probe.symbol);
    renderProbe();
    renderNote();
    renderHero();
    renderMarkets();
    renderAnalytics();
    if (MP.spotlight) MP.spotlight.render();
    every(function () { renderStamp(); watchLive(); }, 1000);
    every(function () { refreshContext(true); }, 30000);
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
    poll(loadStocks, DAILY_REFRESH_MS);
    poll(loadCatalogue, DAILY_REFRESH_MS);
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
    setStopNote: setStopNote,
    refreshContext: refreshContext,
    coinHistory: coinHistory,
    showConcept: showConcept,
    openLearn: openLearn,
    renderLearn: renderLearn,
    learnMeasure: learnMeasure,
    learnDeeper: learnDeeper,
    learnAction: learnAction,
    learnCompare: learnCompare,
    learnSentence: learnSentence,
    explored: explored,
    whatLine: whatLine,
    toggleWatchCurrent: toggleWatchCurrent,
    toggleMoverEnd: toggleMoverEnd,
    moverEndLabel: moverEndLabel,
    moverEndFor: moverEndFor,
    cycleIndex: cycleIndex,
    subjectView: subjectView,
    syncSubjectPosition: syncSubjectPosition,
    openDialConfig: openDialConfig,
    toggleDialRow: toggleDialRow,
    saveDialConfig: saveDialConfig,
    resetDialConfig: resetDialConfig,
    showIntro: showIntro,
    hideIntro: hideIntro,
    introSeen: introSeen,
    openProbe: openProbe,
    askProbe: askProbe,
    probeContext: probeContext,
    runProbeAction: runProbeAction,
    focusProbeAsk: focusProbeAsk,
    toggleProbeSource: toggleProbeSource,
    STOP_NOTES: STOP_NOTES,
    applyTick: applyTick,
    liveProducts: liveProducts,
    productForStop: productForStop,
    setRange: setRange,
    ensureRange: ensureRange,
    setMoversKind: setMoversKind,
    stepWatch: stepWatch,
    setWatchRange: setWatchRange,
    addWatch: addWatch,
    removeWatch: removeWatch,
    isWatched: isWatched,
    renderWatch: renderWatch,
    openSearch: openSearch,
    runSearch: runSearch,
    selectSearch: selectSearch,
    renderScreenList: renderScreenList,
    openWatchRow: openWatchRow,
    removeCurrentWatch: removeCurrentWatch,
    stockSeries: stockSeries,
    stockRow: stockRow,
    ensureStock: ensureStock,
    loadStocks: loadStocks,
    loadCatalogue: loadCatalogue,
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
