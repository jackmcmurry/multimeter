/* ============================================================================
 * data.test.js — the data layer: session clock, payload normalizers, and the
 * scheduled job's decisions, driven against canned payloads.
 *
 *   MP.dataTest.run()          -> { total, passed, failed, failures }
 *   MP.dataTest.runPipeline()  -> Promise of the same shape
 *
 * Fixtures are trimmed copies of real responses observed on 10–11 Sep 2026:
 * FMP through the claude.ai connector, CoinGecko through its public API.
 * Like stats.test.js, this runs in the browser from the debug bundle.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  function harness() {
    var results = [];
    function record(name, pass, detail) {
      results.push({ name: name, pass: !!pass, detail: pass ? null : detail });
    }
    return {
      ok: function (name, condition, detail) { record(name, condition, detail || 'assertion failed'); },
      eq: function (name, actual, expected) {
        record(name, actual === expected, 'expected ' + expected + ', got ' + actual);
      },
      close: function (name, actual, expected, tol) {
        tol = tol === undefined ? 1e-9 : tol;
        record(name, typeof actual === 'number' && Math.abs(actual - expected) <= tol,
          'expected ' + expected + ' (+/-' + tol + '), got ' + actual);
      },
      summary: function () {
        var failures = results.filter(function (r) { return !r.pass; });
        return {
          total: results.length,
          passed: results.length - failures.length,
          failed: failures.length,
          failures: failures.map(function (f) { return f.name + ' -> ' + f.detail; })
        };
      }
    };
  }

  /* ---- fixtures ------------------------------------------------------------ */
  var CG_MARKETS = [{
    id: 'bitcoin', current_price: 76908, price_change_percentage_24h: -1.43882,
    market_cap: 1544202910743, total_volume: 29608816302, circulating_supply: 20082468.0,
    max_supply: 21000000.0, market_cap_rank: 1, last_updated: '2026-09-11T02:05:00.000Z',
    sparkline_in_7d: { price: [78018.3, 77500.1, 76908] }
  }];

  var CG_CHART = {
    prices: [[1789006500000, 78018.32432388069], [1789049700000, 77402.1], [1789092720000, 76894.07420358695]],
    market_caps: [], total_volumes: []
  };

  var FMP_IXIC = [{
    symbol: '^IXIC', name: 'NASDAQ Composite', price: 26081.7245, changePercentage: -0.65369,
    change: -171.6155, volume: 6065122513, dayLow: 25979.535, dayHigh: 26178.254,
    yearHigh: 27190.21, yearLow: 20690.25, marketCap: 0, priceAvg50: 26043.611,
    priceAvg200: 24436.217, exchange: 'INDEX', open: 26021.053, previousClose: 26253.34,
    timestamp: 1789070407
  }];

  var FMP_EOD_ADBE = [
    { symbol: 'ADBE', date: '2026-09-10', price: 248.83, volume: 9237429 },
    { symbol: 'ADBE', date: '2026-09-09', price: 254.86, volume: 4165500 },
    { symbol: 'ADBE', date: '2026-09-08', price: 257.26, volume: 5491058 }
  ];

  var FMP_CHANGE_ADBE = [{
    symbol: 'ADBE', '1D': -2.366, '5D': -9.34164, '1M': -8.84012, '3M': 6.6201,
    '6M': -9.55912, ytd: -28.90368, '1Y': -28.9382
  }];

  var FMP_DENIED = { 'Error Message': 'Premium Query Parameter: this symbol requires a higher plan.' };

  var AV_QUOTE = {
    'Global Quote': {
      '01. symbol': 'QQQ', '02. open': '712.1000', '03. high': '714.0000', '04. low': '706.5000',
      '05. price': '708.6900', '06. volume': '41234567', '07. latest trading day': '2026-09-10',
      '08. previous close': '716.3100', '09. change': '-7.6200', '10. change percent': '-1.0638%'
    }
  };

  var AV_DAILY = {
    'Meta Data': {},
    'Time Series (Daily)': {
      '2026-09-10': { '4. close': '708.6900' },
      '2026-09-09': { '4. close': '716.3100' }
    }
  };

  var AV_LIMITED = { Information: 'Our standard API rate limit is 25 requests per day.' };

  /* ---- synchronous suite ---------------------------------------------------- */
  function run() {
    var t = harness();
    var SES = MP.session, SRC = MP.sources;

    /* session clock */
    function phase(iso) { return SES.status(Date.parse(iso)).phase; }
    eq('Thursday 10:00 EDT is open', phase('2026-09-10T14:00:00Z'), 'open');
    eq('Thursday 09:00 EDT is pre-market', phase('2026-09-10T13:00:00Z'), 'pre');
    eq('Thursday 16:30 EDT is after the close', phase('2026-09-10T20:30:00Z'), 'post');
    eq('Saturday is a weekend', phase('2026-09-12T15:00:00Z'), 'weekend');
    eq('Labor Day is a holiday', phase('2026-09-07T15:00:00Z'), 'holiday');
    eq('day after Thanksgiving closes at 13:00 EST', phase('2026-11-27T18:30:00Z'), 'post');
    eq('day after Thanksgiving is open at 12:30 EST', phase('2026-11-27T17:30:00Z'), 'open');
    eq('winter open follows EST (09:45)', phase('2026-12-01T14:45:00Z'), 'open');
    eq('winter pre-market follows EST (09:15)', phase('2026-12-01T14:15:00Z'), 'pre');
    ok('status reports open as a boolean', SES.status(Date.parse('2026-09-10T14:00:00Z')).open === true);

    eq('completed session after close plus grace', SES.lastCompletedSession(Date.parse('2026-09-10T20:30:00Z'), 20), '2026-09-10');
    eq('inside the grace the prior session stands', SES.lastCompletedSession(Date.parse('2026-09-10T20:10:00Z'), 20), '2026-09-09');
    eq('Tuesday pre-market reaches back over the holiday weekend', SES.lastCompletedSession(Date.parse('2026-09-08T13:00:00Z'), 0), '2026-09-04');
    eq('weekdayOf a known Monday', SES.weekdayOf('2026-09-07'), 'Mon');
    ok('holiday is not a session day', !SES.isSessionDay('2026-12-25'));

    /* CoinGecko */
    var spot = SRC.btcSpot.normalize(CG_MARKETS);
    close('CoinGecko spot price', spot.price, 76908);
    close('CoinGecko 24h change in points', spot.changePct, -1.43882);
    eq('CoinGecko sparkline carried through', spot.sparkline.length, 3);
    close('CoinGecko max supply', spot.maxSupply, 21000000);
    ok('CoinGecko error body normalizes to null', SRC.btcSpot.normalize({ status: { error_code: 429 } }) === null);
    ok('spot URL asks for the sparkline', SRC.btcSpot.url.indexOf('sparkline=true') > 0);

    var chart = SRC.btcChart(365);
    ok('chart URL carries the range', chart.url.indexOf('days=365') > 0);
    var parsedChart = chart.normalize(CG_CHART);
    eq('chart keeps every point', parsedChart.prices.length, 3);
    eq('chart start timestamp', parsedChart.startTs, 1789006500000);
    eq('chart end timestamp', parsedChart.endTs, 1789092720000);
    ok('chart with one point is unusable', chart.normalize({ prices: [[1, 2]] }) === null);

    /* FMP */
    var ixic = SRC.normalizeFmpQuote(FMP_IXIC);
    close('FMP index price', ixic.price, 26081.7245);
    close('FMP change in points', ixic.changePct, -0.65369);
    eq('FMP timestamp becomes milliseconds', ixic.timestamp, 1789070407000);
    eq('FMP symbol kept', ixic.symbol, '^IXIC');
    ok('FMP error body normalizes to null', SRC.normalizeFmpQuote(FMP_DENIED) === null);

    var eod = SRC.normalizeEodLight(FMP_EOD_ADBE);
    eq('EOD rows sorted ascending', eod[0].date, '2026-09-08');
    close('EOD last close', eod[2].price, 248.83);

    var ch = SRC.normalizeQuoteChange(FMP_CHANGE_ADBE);
    close('five-session change', ch.d5, -9.34164);
    close('one-month change', ch.m1, -8.84012);

    /* Alpha Vantage */
    var avq = SRC.normalizeAvQuote(AV_QUOTE);
    close('AV quote price from string', avq.price, 708.69);
    close('AV change percent strips the % sign', avq.changePct, -1.0638);
    eq('AV quote symbol', avq.symbol, 'QQQ');
    ok('AV rate-limit body normalizes to null', SRC.normalizeAvQuote(AV_LIMITED) === null);
    var avd = SRC.normalizeAvDaily(AV_DAILY);
    eq('AV daily sorted ascending', avd[0].date, '2026-09-09');

    /* snapshots */
    var hs = SRC.normalizeHistorySnapshot({ btc: [{ date: '2026-09-10', price: 1 }, { date: '2026-09-09', price: 2 }], ixic: [] });
    eq('history snapshot sorts series', hs.btc[0].date, '2026-09-09');
    ok('empty history series becomes null', hs.ixic === null);
    ok('missing history series becomes null', hs.qqq === null);
    ok('unparseable snapshot is null', SRC.normalizeQuotesSnapshot('not json') === null);
    var qs = SRC.normalizeQuotesSnapshot({ generatedAt: '2026-09-10T20:00:07.000Z', ixic: { price: 1 }, qqq: { price: 'x' } });
    ok('quote without a numeric price is dropped', qs.qqq === null);
    eq('generatedAt parsed to ms', qs.generatedAt, 1789070407000);
    var ss = SRC.normalizeSpotlightSnapshot({ current: { symbol: 'ADBE' }, history: 'junk' });
    eq('spotlight snapshot keeps the pick', ss.current.symbol, 'ADBE');
    ok('spotlight history must be a list', Array.isArray(ss.history) && ss.history.length === 0);

    /* key hygiene */
    var P = MP.pipeline;
    if (P) {
      var url = P.fmpUrl('quote', { symbol: '^IXIC' }, 'SECRET-KEY-123');
      ok('FMP URL encodes the caret', url.indexOf('symbol=%5EIXIC') > 0);
      ok('redact removes the key', P.redact('GET ' + url + ' failed').indexOf('SECRET-KEY-123') < 0);
    }

    return t.summary();

    function eq(n, a, e) { t.eq(n, a, e); }
    function ok(n, c, d) { t.ok(n, c, d); }
    function close(n, a, e, tol) { t.close(n, a, e, tol); }
  }

  /* ---- pipeline suite ------------------------------------------------------- */

  /* Newest-first weekday closes ending on `lastDay`, as FMP returns them. */
  function eodRows(symbol, count, lastDay) {
    var rows = [], d = new Date(lastDay + 'T12:00:00Z'), price = 100;
    while (rows.length < count) {
      var dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) {
        rows.push({ symbol: symbol, date: d.toISOString().slice(0, 10), price: price, volume: 1 });
        price += 0.5;
      }
      d.setUTCDate(d.getUTCDate() - 1);
    }
    return rows;
  }

  function mockApi(opts) {
    opts = opts || {};
    var moves = {
      AAPL: 1.2, MSFT: -0.8, NVDA: 4.1, AMZN: 2.2, GOOGL: -1.9, META: 3.3, AVGO: null,
      TSLA: 7.7, COST: 0.4, NFLX: -2.5, AMD: 9.0, ADBE: -9.34, CSCO: 0.9, PEP: -0.3, INTC: 5.5
    };
    var log = [];
    function reject(status) {
      var e = new Error('HTTP ' + status);
      e.status = status;
      return Promise.reject(e);
    }
    function fetchJson(url) {
      log.push(url);
      var u = new URL(url);
      var sym = u.searchParams.get('symbol');
      if (u.hostname === 'financialmodelingprep.com') {
        if (opts.fmpDown) return reject(401);
        if (/\/stock-price-change$/.test(u.pathname)) {
          if (moves[sym] === null || moves[sym] === undefined) return Promise.resolve(FMP_DENIED);
          return Promise.resolve([{ symbol: sym, '1D': 0.1, '5D': moves[sym], '1M': 2.5 }]);
        }
        if (/\/quote$/.test(u.pathname)) {
          if (sym === '^IXIC') return Promise.resolve(FMP_IXIC);
          if (sym === '^GSPC') return Promise.resolve([{ symbol: '^GSPC', name: 'S&P 500', price: 6512.34, changePercentage: -0.41, timestamp: 1789070407 }]);
          return Promise.resolve([{ symbol: sym, name: sym + ' Inc.', price: 250, changePercentage: 1.1, marketCap: 1e11, timestamp: 1789070407 }]);
        }
        if (/\/historical-price-eod\/light$/.test(u.pathname)) return Promise.resolve(eodRows(sym, 290, '2026-09-11'));
      }
      if (u.hostname === 'api.coingecko.com') {
        /* the weekly crypto scan: SOL wins on absolute move, DOGE is runner-up,
         * aptos is missing from the response and so counts as skipped */
        var cgMoves = {
          solana: 18.4, ripple: -3.1, binancecoin: 2.2, cardano: -6.5, dogecoin: -15.2,
          'avalanche-2': 7.7, chainlink: 4.4, polkadot: -2.0, litecoin: 1.1, tron: 0.6,
          uniswap: 9.9, stellar: -4.2, 'bitcoin-cash': 3.3, near: -8.8
        };
        return Promise.resolve(Object.keys(cgMoves).map(function (id, i) {
          return { id: id, symbol: id.slice(0, 3), name: id, current_price: 10 + i,
            price_change_percentage_24h: 0.5, price_change_percentage_7d_in_currency: cgMoves[id],
            market_cap: 1e10, market_cap_rank: i + 3 };
        }));
      }
      if (u.hostname === 'www.alphavantage.co') {
        if (opts.avLimited) return Promise.resolve(AV_LIMITED);
        var fn = u.searchParams.get('function');
        if (fn === 'GLOBAL_QUOTE') return Promise.resolve(AV_QUOTE);
        if (fn === 'TIME_SERIES_DAILY') return Promise.resolve(AV_DAILY);
      }
      return Promise.reject(new Error('unexpected URL ' + url));
    }
    return { fetchJson: fetchJson, log: log };
  }

  /* In-memory stand-in for docs/data. */
  function store() {
    var files = {};
    return {
      files: files,
      read: function (name) { return files[name] ? JSON.parse(JSON.stringify(files[name])) : null; },
      apply: function (out) { Object.keys(out).forEach(function (k) { files[k] = out[k]; }); }
    };
  }

  var KEYS = { FMP_API_KEY: 'test-fmp-key', ALPHAVANTAGE_API_KEY: 'test-av-key' };

  async function runPipeline() {
    var t = harness();
    var P = MP.pipeline;
    if (!P) { t.ok('pipeline module is loaded', false, 'MP.pipeline missing'); return t.summary(); }

    async function step(db, api, iso, env) {
      var r = await P.run({ now: Date.parse(iso), env: env || KEYS, fetchJson: api.fetchJson, read: db.read });
      db.apply(r.out);
      return r;
    }

    /* 1. first run, Monday pre-market: everything is due */
    var db = store(), api = mockApi();
    var r1 = await step(db, api, '2026-09-14T13:05:00Z');
    var s1 = r1.out.spotlight;
    t.ok('first run writes all three snapshots', s1 && r1.out.quotes && r1.out.history);
    t.eq('scan picks the largest absolute move', s1.current.symbol, 'ADBE');
    t.eq('pick is keyed to this week', s1.current.weekOf, '2026-09-14');
    t.eq('runner-up recorded', s1.current.runnerUp.symbol, 'AMD');
    t.eq('plan-denied symbol counted as skipped', s1.current.skipped, 1);
    t.eq('scanned excludes the denial', s1.current.scanned, 14);
    t.ok('denial surfaces as a warning', r1.warnings.some(function (w) { return w.indexOf('AVGO') === 0; }));
    t.close('pick change reused from the scan', s1.change.d5, -9.34);
    t.ok('pick series fetched', s1.series && s1.series.length > 50);
    t.eq('history of picks starts with this week', s1.history[0].weekOf, '2026-09-14');
    t.close('index quote written', r1.out.quotes.ixic.price, 26081.7245);
    t.eq('spotlight quote follows the pick', r1.out.quotes.spotlight.symbol, 'ADBE');
    t.close('QQQ quote from Alpha Vantage', r1.out.quotes.qqq.price, 708.69);
    t.eq('pre-market read is final for Friday', r1.out.quotes.finalFor, '2026-09-11');
    t.ok('index history covers the 252-session window', r1.out.history.ixic.length > 252);
    t.eq('history checked for the last completed session', r1.out.history.checkedFor, '2026-09-11');
    t.eq('QQQ history present', r1.out.history.qqq.length, 2);
    t.close('S&P quote written', r1.out.quotes.spx.price, 6512.34);
    t.ok('S&P history covers the 252-session window', r1.out.history.spx.length > 252);
    t.eq('crypto scan picks the largest absolute 7d move', s1.crypto.symbol, 'SOL');
    t.eq('crypto pick keeps its CoinGecko id', s1.crypto.id, 'solana');
    t.eq('crypto pick is keyed to this week', s1.crypto.weekOf, '2026-09-14');
    t.eq('crypto runner-up recorded', s1.crypto.runnerUp.symbol, 'DOGE');
    t.eq('missing coin counted as skipped', s1.crypto.skipped, 1);
    t.eq('crypto history starts with this week', s1.cryptoHistory[0].symbol, 'SOL');
    t.eq('FMP calls: 15 scan + 1 series + 3 quotes + 3 history', r1.calls.fmp, 22);
    t.eq('Alpha Vantage calls: quote + daily', r1.calls.av, 2);
    t.eq('CoinGecko calls: one scan', r1.calls.cg, 1);
    t.ok('keys redacted from every logged URL', api.log.every(function (u) {
      var red = P.redact(u);
      return red.indexOf('test-fmp-key') < 0 && red.indexOf('test-av-key') < 0;
    }));

    /* 2. fifteen minutes later, still pre-market: nothing is due */
    var r2 = await step(db, api, '2026-09-14T13:20:00Z');
    t.eq('quiet pre-market run writes nothing', Object.keys(r2.out).length, 0);
    t.eq('quiet run makes no FMP calls', r2.calls.fmp, 0);
    t.eq('quiet run makes no Alpha Vantage calls', r2.calls.av, 0);
    t.eq('quiet run makes no CoinGecko calls', r2.calls.cg, 0);

    /* 3. market open, 45 minutes after the last QQQ read */
    var r3 = await step(db, api, '2026-09-14T13:50:00Z');
    t.ok('open market refreshes quotes', !!r3.out.quotes);
    t.ok('open market leaves history alone', !r3.out.history);
    t.ok('open market leaves the pick alone', !r3.out.spotlight);
    t.eq('open market costs three FMP calls', r3.calls.fmp, 3);
    t.eq('QQQ is throttled inside the hour', r3.calls.av, 0);
    t.eq('finalFor is untouched while open', r3.out.quotes.finalFor, '2026-09-11');

    /* 4. more than 55 minutes after the last QQQ read */
    var r4 = await step(db, api, '2026-09-14T14:10:00Z');
    t.eq('QQQ refreshes after the hour', r4.calls.av, 1);

    /* 5. after the close: one final quote read, history waits for the bars */
    var r5 = await step(db, api, '2026-09-14T20:25:00Z');
    t.eq('final read marks the session', r5.out.quotes && r5.out.quotes.finalFor, '2026-09-14');
    t.ok('history waits an hour after the close', !r5.out.history);

    var r6 = await step(db, api, '2026-09-14T21:05:00Z');
    t.ok('history refreshes after the grace', !!r6.out.history);
    t.ok('no further quote reads once final', !r6.out.quotes);
    t.ok('pick detail refreshes with history', !!r6.out.spotlight);

    /* the canned bars stop on Friday, so Monday's bar is "late": retry spacing */
    var r7 = await step(db, api, '2026-09-14T21:20:00Z');
    t.eq('late bar is not re-asked within two hours', Object.keys(r7.out).length, 0);

    /* 6. no FMP key */
    var bare = store(), bareApi = mockApi();
    var r8 = await step(bare, bareApi, '2026-09-14T13:05:00Z', {});
    t.ok('missing key skips the run with a reason', !!r8.skipped);
    t.eq('missing key makes no requests', bareApi.log.length, 0);

    /* 7. FMP down on a fresh repo */
    var down = store(), downApi = mockApi({ fmpDown: true });
    var r9 = await step(down, downApi, '2026-09-14T13:05:00Z');
    t.ok('every FMP call failed', r9.calls.fmp > 0 && r9.failed.fmp === r9.calls.fmp);
    t.ok('failed scan keeps no pick', r9.out.spotlight && r9.out.spotlight.current === null);
    t.eq('failed read is not marked final', r9.out.quotes.finalFor, null);
    var r10 = await step(down, downApi, '2026-09-14T13:20:00Z');
    t.eq('failed scan is not retried within three hours', r10.calls.fmp, 2);
    t.ok('crypto pick survives FMP being down', r9.out.spotlight && r9.out.spotlight.crypto && r9.out.spotlight.crypto.symbol === 'SOL');

    /* 8. Alpha Vantage rate-limited */
    var lim = store();
    var r11 = await step(lim, mockApi({ avLimited: true }), '2026-09-14T13:05:00Z');
    t.ok('rate-limited QQQ stays empty', r11.out.quotes.qqq === null);
    t.ok('rate limit reported', r11.warnings.some(function (w) { return w.indexOf('QQQ quote') === 0; }));

    /* 9. no Alpha Vantage key */
    var noav = store(), noavApi = mockApi();
    var r12 = await step(noav, noavApi, '2026-09-14T13:05:00Z', { FMP_API_KEY: 'test-fmp-key' });
    t.ok('QQQ quote omitted without a key', r12.out.quotes.qqq === null);
    t.ok('QQQ history omitted without a key', r12.out.history.qqq === null);
    t.eq('no Alpha Vantage calls without a key', r12.calls.av, 0);

    return t.summary();
  }

  MP.dataTest = { run: run, runPipeline: runPipeline };
})(typeof globalThis !== 'undefined' ? globalThis : this);
