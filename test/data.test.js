/* ============================================================================
 * data.test.js: the data layer: session clock, payload normalizers, and the
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

  /* Coinbase Exchange WebSocket frames, from the feed's documentation. */
  var CB_TICKER = {
    type: 'ticker', sequence: 37475248783, product_id: 'ETH-USD', price: '1285.22',
    open_24h: '1310.79', volume_24h: '245532.79269678', low_24h: '1280.52', high_24h: '1313.8',
    volume_30d: '9788783.60117027', best_bid: '1285.04', best_bid_size: '0.46688654',
    best_ask: '1285.27', best_ask_size: '1.56637040', side: 'buy',
    time: '2022-10-19T23:28:22.061769Z', trade_id: 370843401, last_size: '11.4396987'
  };
  var CB_HEARTBEAT = { type: 'heartbeat', sequence: 90, last_trade_id: 20, product_id: 'BTC-USD', time: '2014-11-07T08:19:28.464459Z' };
  var CB_ERROR = { type: 'error', message: 'Failed to subscribe', reason: 'BNB-USD is not a valid product' };

  /* The daily reading: a Messages API reply that follows the rules, one that
   * does not, and the two-coin quote the job fetches for it. */
  var CLAUDE_TEXT = 'On 11 Sep 26 the Nasdaq Composite closed at 26,081.72, down 0.65% on the day. ' +
    'Bitcoin was at $76,908.00, down 1.44% over 24 hours. This is a description of the figures, not advice.';
  var CLAUDE_REPLY = {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: CLAUDE_TEXT }],
    stop_reason: 'end_turn', usage: { input_tokens: 612, output_tokens: 140 }
  };
  var CLAUDE_BAD = {
    id: 'msg_bad', type: 'message', role: 'assistant', model: 'claude-opus-5',
    content: [{ type: 'text', text: 'You should buy bitcoin now at 76,908, it will go up. Sell the Nasdaq. Not advice.' }],
    stop_reason: 'end_turn', usage: { input_tokens: 612, output_tokens: 40 }
  };
  var CG_NOTE_COINS = [
    { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 76908, price_change_percentage_24h: -1.43882, market_cap: 1.5e12 },
    { id: 'ethereum', symbol: 'eth', name: 'Ethereum', current_price: 2459.76, price_change_percentage_24h: -2.04, market_cap: 3e11 }
  ];

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

  /* Yahoo's chart endpoint, as observed for HOOD. The third bar is a null
   * close, which Yahoo writes for a halt or a half-session. Timestamps are
   * the session open in exchange time: 13:30 UTC is the same calendar day in
   * New York and in UTC alike. The null sits on 2026-09-11, so the surviving
   * rows are the 9th, the 10th and the 14th. */
  var YAHOO_HOOD = {
    chart: {
      result: [{
        meta: { symbol: 'HOOD', longName: 'Robinhood Markets, Inc.', shortName: 'Robinhood Markets, Inc' },
        timestamp: [1788960600, 1789047000, 1789133400, 1789392600],
        indicators: {
          quote: [{ close: [115.28, 113.33, null, 112.57] }],
          adjclose: [{ adjclose: [115.28, 113.33, null, 112.57] }]
        }
      }],
      error: null
    }
  };

  var YAHOO_EMPTY = { chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } };

  var FMP_CHANGE_ADBE = [{
    symbol: 'ADBE', '1D': -2.366, '5D': -9.34164, '1M': -8.84012, '3M': 6.6201,
    '6M': -9.55912, ytd: -28.90368, '1Y': -28.9382
  }];

  var FMP_DENIED = { 'Error Message': 'Premium Query Parameter: this symbol requires a higher plan.' };
  var FMP_LIMIT = { 'Error Message': 'Limit Reach . Please upgrade your plan or visit our documentation for more details at https://site.financialmodelingprep.com/' };

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
    eq('chart keeps a stamp per point', parsedChart.stamps.length, 3);

    /* note snapshot */
    ok('note snapshot without text is null', SRC.normalizeNoteSnapshot({ forSession: '2026-09-11' }) === null);
    var nsnap = SRC.normalizeNoteSnapshot({ forSession: '2026-09-11', text: ' Words 1. Not advice. ', source: 'claude', model: 'claude-opus-5', generatedAt: '2026-09-11T21:05:00Z' });
    eq('note snapshot trims the text', nsnap.text, 'Words 1. Not advice.');
    eq('note snapshot keeps the source', nsnap.source, 'claude');
    eq('an unknown source reads as the fallback', SRC.normalizeNoteSnapshot({ text: 'x', source: 'other' }).source, 'fallback');
    ok('note snapshot stamps the time', nsnap.generatedAt > 0);

    /* findings snapshot */
    ok('findings snapshot without pairs is null', SRC.normalizeFindingsSnapshot({ version: 1 }) === null);
    var fsnap = SRC.normalizeFindingsSnapshot({ pairs: { ixic: { coupling: [], rolling90: [{ date: '2026-01-02', value: 0.4 }, { bad: 1 }], regimes: {}, vol: {}, scatter: {} } } });
    ok('findings snapshot keeps the good rolling rows', fsnap && fsnap.pairs.ixic.rolling90.length === 1);
    ok('findings snapshot fills missing collections', fsnap && Array.isArray(fsnap.pairs.ixic.breaks) && typeof fsnap.drawdowns === 'object');

    /* CoinGecko search (the probe jack) */
    var search = SRC.coinSearch('sol coin');
    ok('search URL encodes the query', search.url.indexOf('/search?query=sol%20coin') > 0);
    var found = search.normalize({ coins: [
      { id: 'solana', name: 'Solana', api_symbol: 'solana', symbol: 'SOL', market_cap_rank: 6 },
      { id: 'solar', name: 'Solar', symbol: 'sxp', market_cap_rank: null },
      { id: '', symbol: 'bad' }
    ] });
    eq('search keeps usable coins only', found.length, 2);
    eq('search upper-cases the symbol', found[1].symbol, 'SXP');
    eq('search carries the rank', found[0].rank, 6);
    ok('search with no coins array is null', search.normalize({ exchanges: [] }) === null);
    var many = search.normalize({ coins: 'abcdefghijkl'.split('').map(function (c) { return { id: c, symbol: c, name: c }; }) });
    eq('search offers at most eight', many.length, 8);

    /* CoinGecko daily points date as the previous day's close, like FMP */
    var D = Date.parse('2026-09-10T00:00:00Z');
    var daily = SRC.dailySeries({
      prices: [1, 2, 3, 4],
      stamps: [D, D + 86400000, D + 86400000 + 14 * 3600000, D + 86400000 + 15 * 3600000]
    });
    eq('daily series has one point per day', daily.length, 3);
    eq('a midnight point belongs to the day before', daily[0].date, '2026-09-09');
    eq('second midnight point dates likewise', daily[1].date, '2026-09-10');
    eq('an intra-day point keeps its own day', daily[2].date, '2026-09-11');
    eq('the last point of a day wins', daily[2].price, 4);
    ok('daily series without stamps is null', SRC.dailySeries({ prices: [1, 2] }) === null);

    /* Coinbase WebSocket */
    var CB = SRC.coinbaseWs;
    var tick = CB.normalizeTicker(CB_TICKER);
    eq('ticker product', tick.product, 'ETH-USD');
    close('ticker price', tick.price, 1285.22);
    close('ticker 24h change from its open', tick.pct24h, (1285.22 / 1310.79 - 1) * 100, 1e-9);
    ok('ticker time parsed', tick.time > 0);
    ok('heartbeat normalizes to null', CB.normalizeTicker(CB_HEARTBEAT) === null);
    close('string frames are accepted', CB.normalizeTicker(JSON.stringify(CB_TICKER)).price, 1285.22);
    eq('error reason extracted', CB.errorReason(CB_ERROR), 'BNB-USD is not a valid product');
    eq('rejected product named', CB.productIn(CB.errorReason(CB_ERROR)), 'BNB-USD');
    ok('a ticker carries no error reason', CB.errorReason(CB_TICKER) === null);
    var sub = CB.subscribeMessage(['BTC-USD']);
    eq('subscribe type', sub.type, 'subscribe');
    eq('subscribe product', sub.product_ids[0], 'BTC-USD');
    ok('subscribe asks for ticker and heartbeat', sub.channels.indexOf('ticker') >= 0 && sub.channels.indexOf('heartbeat') >= 0);
    eq('symbol to product', CB.productFor('sol'), 'SOL-USD');
    ok('empty symbol has no product', CB.productFor('') === null);

    var L = MP.live;
    if (!L) {
      ok('live module is loaded', false, 'MP.live missing');
    } else {
      var half = function () { return 0.5; };
      eq('backoff starts at one second', L.backoffDelay(0, half), 1000);
      eq('backoff doubles', L.backoffDelay(2, half), 4000);
      eq('backoff caps at thirty seconds', L.backoffDelay(9, half), 30000);
      ok('backoff jitter stays within 20 percent',
        L.backoffDelay(0, function () { return 1; }) === 1200 && L.backoffDelay(0, function () { return 0; }) === 800);
      var diff = L.diffProducts(['BTC-USD', 'ETH-USD'], ['ETH-USD', 'SOL-USD']);
      eq('diff adds the new product', diff.add.join(','), 'SOL-USD');
      eq('diff removes the dropped product', diff.remove.join(','), 'BTC-USD');
    }

    /* the share card's helpers */
    var SH = MP.share;
    if (!SH) {
      ok('share module is loaded', false, 'MP.share missing');
    } else {
      var sized = SH.svgWithSize('<svg viewBox="0 0 10 10" width="10" class="chart"><path d="M0,0"/></svg>', 100, 50);
      ok('share sizes the svg for rasterising', sized.indexOf('width="100" height="50"') > 0);
      ok('share drops the original width', sized.indexOf('width="10"') < 0);
      ok('share keeps the viewBox', sized.indexOf('viewBox="0 0 10 10"') > 0);
      ok('share adds the svg namespace a standalone image needs', sized.indexOf('xmlns="http://www.w3.org/2000/svg"') > 0);
      eq('share does not double an existing namespace', (SH.svgWithSize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>', 1, 1).match(/xmlns=/g) || []).length, 1);
      eq('share falls back to a colour for an unknown token', SH.token('--no-such-token'), '#888888');
      ok('share resolves a declared token', /^(#[0-9a-f]{3,8}|rgb)/i.test(SH.token('--up')));
    }

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

    /* Yahoo, the keyless fallback behind api/history.js and the data job */
    var yc = SRC.normalizeYahooChart(YAHOO_HOOD);
    eq('Yahoo drops the null close', yc.length, 3);
    eq('Yahoo rows sorted ascending', yc[0].date, '2026-09-09');
    eq('Yahoo keeps the row after the gap', yc[2].date, '2026-09-14');
    close('Yahoo last close', yc[2].price, 112.57);
    eq('Yahoo prefers the long name', SRC.yahooName(YAHOO_HOOD), 'Robinhood Markets, Inc.');
    ok('Yahoo error body normalizes to null', SRC.normalizeYahooChart(YAHOO_EMPTY) === null);
    ok('Yahoo url spells a class share with a dash',
      SRC.yahooChartUrl('BRK.B').indexOf('/chart/BRK-B?') > 0);
    ok('Yahoo url refuses a path', SRC.yahooChartUrl('../etc') === null);

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

    /* session before a day */
    eq('the session before Tuesday skips Labor Day', SES.sessionBefore('2026-09-08'), '2026-09-04');
    eq('the session before Monday is Friday', SES.sessionBefore('2026-09-14'), '2026-09-11');
    eq('the session before a Saturday is that Friday', SES.sessionBefore('2026-09-12'), '2026-09-11');

    /* stock files and the Nasdaq-100 summary */
    eq('a ticker maps to its file', SRC.stockPath('AAPL'), 'data/stocks/AAPL.json');
    eq('a class suffix is allowed', SRC.stockPath('BRK.B'), 'data/stocks/BRK.B.json');
    ok('a path is not a ticker', SRC.stockPath('../x') === null);
    ok('a path after a ticker is refused', SRC.stockPath('AAPL/../x') === null);
    ok('lower case is refused', SRC.stockPath('aapl') === null);
    var sfile = SRC.normalizeStockFile({ symbol: 'AAPL', name: 'Apple Inc.', closes: [['2026-09-11', 334.1], ['2026-09-10', 326.57], ['bad'], ['2026-09-09', 'x']] });
    eq('stock file keeps the good closes', sfile.series.length, 2);
    eq('stock file sorts ascending', sfile.series[0].date, '2026-09-10');
    ok('stock file without closes is null', SRC.normalizeStockFile({ symbol: 'AAPL' }) === null);
    var ssnap = SRC.normalizeStocksSnapshot({ session: '2026-09-11', complete: true, count: { listed: 102, priced: 1, denied: 1 },
      rows: [{ symbol: 'AAPL', name: 'Apple Inc.', close: 334.1, date: '2026-09-11', change1d: 2.3, change5d: null }, { symbol: '../x', close: 1 }, { symbol: 'MSFT' }] });
    eq('stocks snapshot drops rows without a ticker or a close', ssnap.rows.length, 1);
    ok('a missing change reads as NaN', isNaN(ssnap.rows[0].change5d));
    ok('stocks snapshot keeps the coverage', ssnap.complete === true && ssnap.count.listed === 102);
    ok('stocks snapshot without rows is null', SRC.normalizeStocksSnapshot({ session: 'x' }) === null);

    var U = MP.universe;
    if (!U) {
      ok('universe module is loaded', false, 'MP.universe missing');
    } else {
      var syms = U.UNIVERSE.map(function (s) { return s.symbol; });
      ok('the universe holds the whole index', syms.length >= U.LIST.length);
      ok('the majors are in it too', syms.indexOf('HOOD') >= 100);
      ok('the list has no duplicates', syms.every(function (s, i) { return syms.indexOf(s) === i; }));
      ok('every listed ticker makes a file name', syms.every(function (s) { return SRC.stockPath(s) !== null; }));
      /* The index is kept sorted so a rebalance is easy to diff. The majors
         are ordered by how likely a newcomer is to reach for them, because
         that is the order the untyped search screen offers them in. */
      var idx = U.LIST.map(function (s) { return s.symbol; });
      ok('the index is sorted by ticker', idx.every(function (s, i) { return i === 0 || idx[i - 1] < s; }));
      ok('no major repeats an index member', U.MAJORS.every(function (m) { return idx.indexOf(m.symbol) < 0; }));
      eq('names come from the list', U.nameFor('NVDA'), 'NVIDIA Corporation');
      ok('an unlisted ticker has no name', U.nameFor('ZZZZ') === null);

      var m = U.mergeSeries([{ date: '2026-09-09', price: 10 }, { date: '2026-09-10', price: 11 }],
        [{ date: '2026-09-10', price: 11.02 }, { date: '2026-09-11', price: 12 }]);
      eq('merge de-duplicates by date', m.series.length, 3);
      eq('merge counts the new closes', m.added, 1);
      close('fresh closes win on a shared date', m.series[1].price, 11.02);
      ok('a small revision is not a split', m.mismatch === false);
      ok('a re-based close is flagged', U.mergeSeries([{ date: '2026-09-10', price: 11 }], [{ date: '2026-09-10', price: 2.75 }]).mismatch === true);
      var long = [];
      for (var li = 0; li < 310; li++) long.push({ date: new Date(Date.UTC(2025, 0, 1) + li * 86400000).toISOString().slice(0, 10), price: li + 1 });
      var capped = U.mergeSeries(long, []);
      eq('merge caps the stored sessions', capped.series.length, U.MAX_SESSIONS);
      close('the cap keeps the newest', capped.series[capped.series.length - 1].price, 310);

      var weekS = [100, 101, 102, 103, 104, 105, 110].map(function (p, i) { return { date: '2026-09-0' + (i + 1), price: p }; });
      close('five-session change', U.weekChange(weekS), (110 / 101 - 1) * 100, 1e-9);
      close('change ending on an earlier day', U.weekChange(weekS, '2026-09-06'), 5, 1e-9);
      ok('too short a series has no change', isNaN(U.changeOver(weekS, 7)));
      var wrow = U.row('AAPL', weekS);
      ok('a row carries the last close and its date', wrow.close === 110 && wrow.date === '2026-09-07' && wrow.name === 'Apple Inc.');
      ok('a row without a month of closes has no 1m change', wrow.change1m === null);

      var byS = {};
      var justComplete = Math.ceil(syms.length * U.COMPLETE_SHARE);
      syms.slice(0, justComplete).forEach(function (s) { byS[s] = { symbol: s, close: 1, date: '2026-09-11' }; });
      ok('the complete share of the universe priced is complete', U.summary(byS, '2026-09-11', 0, 'x').complete === true);
      delete byS[syms[0]];
      ok('one fewer is not', U.summary(byS, '2026-09-11', 0, 'x').complete === false);
      ok('denials shrink what completeness asks for', U.summary(byS, '2026-09-11', 5, 'x').complete === true);
      eq('an older close is not priced for the session', U.summary({ AAPL: { symbol: 'AAPL', close: 1, date: '2026-09-10' } }, '2026-09-11', 0, 'x').count.priced, 0);

      var T0 = Date.parse('2026-09-14T13:05:00Z'), H = 3600000, D = 86400000;
      var p0 = U.planUniverse({}, '2026-09-11', T0);
      eq('a fresh plan takes one slice', p0.due.length, U.PER_RUN);
      eq('the rest wait', p0.waiting, syms.length - U.PER_RUN);
      eq('a fresh plan starts at the top of the list', p0.due[0], 'AAPL');
      var led = {
        AAPL: { checkedFor: '2026-09-11', last: '2026-09-11', at: T0 - H },
        ABNB: { checkedFor: '2026-09-10', last: '2026-09-10', at: T0 - D },
        ADBE: { deniedAt: T0 - 34 * D, at: T0 - 34 * D },
        ADI: { deniedAt: T0 - 36 * D, at: T0 - 36 * D },
        ADP: { failedFor: '2026-09-11', tries: 1, at: T0 - H },
        ADSK: { failedFor: '2026-09-11', tries: 1, at: T0 - 3 * H },
        AEP: { failedFor: '2026-09-11', tries: 3, at: T0 - 3 * H },
        ALAB: { checkedFor: '2026-09-11', at: T0 - 2 * D, full: true }
      };
      var p1 = U.planUniverse(led, '2026-09-11', T0, { limit: 200 });
      ok('a checked member is not asked again', p1.due.indexOf('AAPL') < 0);
      ok('a member from an older session is asked', p1.due.indexOf('ABNB') >= 0);
      ok('a recent denial waits', p1.due.indexOf('ADBE') < 0 && p1.denied.indexOf('ADBE') >= 0);
      ok('a denial is asked again after 35 days', p1.due.indexOf('ADI') >= 0);
      ok('a fresh failure waits two hours', p1.due.indexOf('ADP') < 0);
      ok('an older failure is retried', p1.due.indexOf('ADSK') >= 0);
      ok('three failures end the session for a member', p1.due.indexOf('AEP') < 0);
      ok('never-fetched members come first', p1.due[0] === 'ALNY');
      var firstFetched = p1.due.filter(function (s) { return led[s] && led[s].at; })[0];
      eq('a suspected split comes before routine refreshes', firstFetched, 'ALAB');
      eq('force asks everything', U.planUniverse(led, '2026-09-11', T0, { limit: Infinity, force: true }).due.length, syms.length);

      eq('a 429 is the limit', U.classify({ status: 429, message: 'HTTP 429' }), 'limit');
      eq('the limit message is the limit', U.classify(new Error(FMP_LIMIT['Error Message'])), 'limit');
      eq('a premium message is a denial', U.classify(new Error(FMP_DENIED['Error Message'])), 'denied');
      eq('a 402 is a denial', U.classify({ status: 402, message: 'HTTP 402' }), 'denied');
      eq('anything else is a failure', U.classify({ status: 500, message: 'HTTP 500' }), 'failed');
      eq('a new fetch reads a full year', U.fromDay(null, T0), '2025-08-10');
      eq('a later fetch overlaps ten days', U.fromDay([{ date: '2026-09-11', price: 1 }], T0), '2026-09-01');
      eq('a suspected split reads a full year again', U.fromDay([{ date: '2026-09-11', price: 1 }], T0, true), '2025-08-10');
    }

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

  /* A close that depends only on the symbol and the date, so a later fetch
   * agrees with an earlier one on every shared day, the way FMP does. */
  function priceOn(symbol, day) {
    var t = (Date.parse(day + 'T00:00:00Z') - Date.parse('2025-01-01T00:00:00Z')) / 86400000;
    var h = 0;
    for (var i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) % 1000;
    var drift = ((h % 21) - 10) / 4000;
    return Math.round((50 + h / 10) * Math.exp(drift * t + 0.02 * Math.sin(t / 3 + h)) * 100) / 100;
  }

  /* Newest-first weekday closes from `lastDay` back to `fromDay` (or 290 of
   * them without one), as FMP returns them. `scale` stands in for a split. */
  function eodRows(symbol, lastDay, fromDay, scale) {
    var rows = [], d = new Date(lastDay + 'T12:00:00Z');
    while (rows.length < 290) {
      var day = d.toISOString().slice(0, 10);
      if (fromDay && day < fromDay) break;
      var dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) {
        rows.push({ symbol: symbol, date: day, price: Math.round(priceOn(symbol, day) * (scale || 1) * 10000) / 10000, volume: 1 });
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
    var fmpCalls = 0;
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
        fmpCalls += 1;
        if (opts.fmpLimitAfter && fmpCalls > opts.fmpLimitAfter) return Promise.resolve(FMP_LIMIT);
        if (/\/stock-price-change$/.test(u.pathname)) {
          if (moves[sym] === null || moves[sym] === undefined) return Promise.resolve(FMP_DENIED);
          return Promise.resolve([{ symbol: sym, '1D': 0.1, '5D': moves[sym], '1M': 2.5 }]);
        }
        if (/\/quote$/.test(u.pathname)) {
          if (sym === '^IXIC') return Promise.resolve(FMP_IXIC);
          if (sym === '^GSPC') return Promise.resolve([{ symbol: '^GSPC', name: 'S&P 500', price: 6512.34, changePercentage: -0.41, timestamp: 1789070407 }]);
          return Promise.resolve([{ symbol: sym, name: sym + ' Inc.', price: 250, changePercentage: 1.1, marketCap: 1e11, timestamp: 1789070407 }]);
        }
        if (/\/historical-price-eod\/light$/.test(u.pathname)) {
          /* AVGO is not on the free plan; the bars end on eodLast (Friday by default) */
          if (sym === 'AVGO') return Promise.resolve(FMP_DENIED);
          var last = opts.eodLast || '2026-09-11', to = u.searchParams.get('to');
          return Promise.resolve(eodRows(sym, to && to < last ? to : last, u.searchParams.get('from'), opts.split === sym ? 0.25 : 1));
        }
      }
      if (u.hostname === 'api.coingecko.com') {
        /* exact ids: the scan's universe includes bitcoin-cash */
        if ((u.searchParams.get('ids') || '').split(',').indexOf('bitcoin') >= 0) return Promise.resolve(CG_NOTE_COINS);
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
    /* stands in for scripts/update-data.js askClaude: records each request
     * and answers from the options */
    var asked = [];
    function askClaude(req) {
      asked.push(req);
      if (opts.claudeDown) return Promise.reject(new Error('API error 529: Overloaded'));
      return Promise.resolve(JSON.parse(JSON.stringify(opts.claudeReply || CLAUDE_REPLY)));
    }
    return { fetchJson: fetchJson, askClaude: askClaude, log: log, asked: asked };
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

  var KEYS = { FMP_API_KEY: 'test-fmp-key', ALPHAVANTAGE_API_KEY: 'test-av-key', ANTHROPIC_API_KEY: 'sk-ant-test-claude-key' };

  async function runPipeline() {
    var t = harness();
    var P = MP.pipeline;
    if (!P) { t.ok('pipeline module is loaded', false, 'MP.pipeline missing'); return t.summary(); }
    var U = MP.universe;
    if (!U) { t.ok('universe module is loaded', false, 'MP.universe missing'); return t.summary(); }
    var N = U.LIST.length, PER = U.PER_RUN;
    function stockKeys(out) { return Object.keys(out).filter(function (k) { return k.indexOf('stocks/') === 0; }); }

    async function step(db, api, iso, env) {
      var r = await P.run({ now: Date.parse(iso), env: env || KEYS, fetchJson: api.fetchJson, askClaude: api.askClaude, read: db.read });
      db.apply(r.out);
      return r;
    }

    /* 1. first run, Monday pre-market: everything is due */
    var db = store(), api = mockApi();
    var r1 = await step(db, api, '2026-09-14T13:05:00Z');
    var s1 = r1.out.spotlight;
    t.ok('first run writes all three snapshots', s1 && r1.out.quotes && r1.out.history);
    t.eq('spotlight.json is version 2', s1.version, 2);
    t.eq('the file is keyed to this week', s1.weekOf, '2026-09-14');
    t.ok('no stock movers before a complete pass', s1.movers.stocks === null);
    t.ok('older pages see no stock of the week yet', s1.current === null);
    t.eq('the history starts with this week', s1.movers.history[0].weekOf, '2026-09-14');
    t.close('index quote written', r1.out.quotes.ixic.price, 26081.7245);
    t.ok('no mover quotes before there are movers', r1.out.quotes.picks === null);
    t.close('QQQ quote from Alpha Vantage', r1.out.quotes.qqq.price, 708.69);
    t.eq('pre-market read is final for Friday', r1.out.quotes.finalFor, '2026-09-11');
    t.ok('index history covers the 252-session window', r1.out.history.ixic.length > 252);
    t.eq('history checked for the last completed session', r1.out.history.checkedFor, '2026-09-11');
    t.eq('QQQ history present', r1.out.history.qqq.length, 2);
    t.close('S&P quote written', r1.out.quotes.spx.price, 6512.34);
    t.ok('S&P history covers the 252-session window', r1.out.history.spx.length > 252);
    var mc1 = s1.movers.crypto;
    t.eq('the crypto mover is the largest seven-day gain', mc1.mover.symbol, 'SOL');
    t.eq('the crypto loser is the largest seven-day drop', mc1.loser.symbol, 'DOGE');
    t.eq('the crypto mover keeps its CoinGecko id', mc1.mover.id, 'solana');
    t.eq('the crypto movers are keyed to this week', mc1.weekOf, '2026-09-14');
    t.eq('the next highest coin is recorded', mc1.moverNext.symbol, 'UNI');
    t.eq('the next lowest coin is recorded', mc1.loserNext.symbol, 'NEAR');
    t.eq('a missing coin counts as skipped', mc1.skipped, 1);
    t.eq('the crypto board holds five at each end', mc1.top.length + ':' + mc1.bottom.length, '5:5');
    t.eq('older pages see the crypto mover as the crypto of the week', s1.crypto.symbol, 'SOL');
    t.eq('older pages keep the crypto history', s1.cryptoHistory[0].symbol, 'SOL');
    t.eq('the old normalizer still reads the new file', MP.sources.normalizeSpotlightSnapshot(s1).crypto.symbol, 'SOL');
    t.eq('the new normalizer reads the movers', MP.sources.normalizeSpotlightSnapshot(s1).movers.crypto.loser.symbol, 'DOGE');
    t.ok('findings written with the history', !!r1.out.findings);
    t.eq('findings keyed to the completed session', r1.out.findings.forSession, '2026-09-11');
    t.eq('findings carry three coupling windows', r1.out.findings.pairs.ixic.coupling.length, 3);
    t.ok('findings rolling series matches the sessions', r1.out.findings.pairs.ixic.rolling90.length === r1.out.findings.sessions - 90);
    t.ok('findings regime shares are sane', (function (g) { return g.coupledShare >= 0 && g.coupledShare <= 1 && g.coupledShare + g.decoupledShare <= 1.0001; })(r1.out.findings.pairs.ixic.regimes));
    t.ok('findings regime is one of the three', ['coupled', 'middle', 'decoupled'].indexOf(r1.out.findings.pairs.ixic.regimes.current) >= 0);
    t.ok('findings include the S&P pair', !!r1.out.findings.pairs.spx);
    t.eq('FMP calls: 3 history + one slice of members + 2 index quotes', r1.calls.fmp, 5 + PER);
    t.eq('the first slice stores every member it could price', stockKeys(r1.out).length, PER - 1);
    t.eq('the summary counts the priced members', r1.out.stocks.count.priced, PER - 1);
    t.eq('the summary counts the denial', r1.out.stocks.count.denied, 1);
    t.ok('one slice is not complete', r1.out.stocks.complete === false);
    t.eq('a plan denial is parked in the ledger', r1.out.job.universe.symbols.AVGO.deniedAt, Date.parse('2026-09-14T13:05:00Z'));
    t.ok('the denial is a warning', r1.warnings.some(function (w) { return w.indexOf('universe: not on this FMP plan') === 0 && w.indexOf('AVGO') > 0; }));
    t.ok('the run logs its coverage', r1.log.some(function (l) { return l.indexOf((PER - 1) + ' of ' + N + ' priced for 2026-09-11') > 0; }));
    t.ok('a member file covers the 1Y range', db.files['stocks/AAPL'].closes.length > 252 && db.files['stocks/AAPL'].closes.length <= U.MAX_SESSIONS);
    t.eq('a member file names the company', db.files['stocks/AAPL'].name, 'Apple Inc.');
    t.eq('a summary row carries the last close date', r1.out.stocks.rows[0].date, '2026-09-11');
    t.close('a summary row carries the last close', r1.out.stocks.rows[0].close, priceOn('AAPL', '2026-09-11'));
    t.ok('a summary row carries the five-session change', typeof r1.out.stocks.rows[0].change5d === 'number');
    t.ok('the history step runs before the members', api.log.indexOf(api.log.filter(function (u) { return u.indexOf('BTCUSD') > 0; })[0]) < api.log.indexOf(api.log.filter(function (u) { return /eod\/light\?symbol=AAPL/.test(u); })[0]));
    t.eq('Alpha Vantage calls: quote + daily', r1.calls.av, 2);
    t.eq('CoinGecko calls: one scan + one quote for the reading', r1.calls.cg, 2);

    var n1 = r1.out.note;
    t.ok('the daily reading is written after the close', !!n1);
    t.eq('the reading is keyed to the completed session', n1 && n1.forSession, '2026-09-11');
    t.eq('Claude wrote it', n1 && n1.source, 'claude');
    t.eq('the reading is the model text, unchanged', n1 && n1.text, CLAUDE_TEXT);
    t.eq('the reading names its model', n1 && n1.model, 'claude-opus-5');
    t.close('the reading keeps the index figure it was given', n1.inputs.ixic.price, 26081.7245);
    t.close('the reading keeps the bitcoin figure it was given', n1.inputs.btc.price, 76908);
    t.eq('one Claude call', r1.calls.claude, 1);
    t.ok('the request carries the rules', api.asked[0] && api.asked[0].system.indexOf('not advice') >= 0);
    t.ok('the request cites the figures as given', api.asked[0] && api.asked[0].user.indexOf('26,081.72') >= 0);
    t.eq('the request names the model', api.asked[0] && api.asked[0].model, 'claude-opus-5');
    t.ok('the key never reaches the reading', JSON.stringify(n1).indexOf('sk-ant') < 0);
    t.ok('the key never reaches the request', JSON.stringify(api.asked[0]).indexOf('sk-ant') < 0);
    t.ok('an Anthropic key is redacted in logs', P.redact('failed: sk-ant-test-claude-key').indexOf('test-claude-key') < 0);
    t.ok('keys redacted from every logged URL', api.log.every(function (u) {
      var red = P.redact(u);
      return red.indexOf('test-fmp-key') < 0 && red.indexOf('test-av-key') < 0;
    }));

    /* 2. fifteen minutes later, still pre-market: only the next slice of members */
    var r2 = await step(db, api, '2026-09-14T13:20:00Z');
    t.eq('the next run fetches the next slice of members', r2.calls.fmp, PER);
    t.ok('the next run writes only member files and their summary', Object.keys(r2.out).every(function (k) {
      return k === 'stocks' || k === 'job' || k.indexOf('stocks/') === 0;
    }));
    t.ok('the second slice starts where the first stopped', !!r2.out['stocks/' + U.LIST[PER].symbol] && !r2.out['stocks/AAPL']);
    t.eq('the denial is not asked again', api.log.filter(function (u) { return /eod\/light\?symbol=AVGO/.test(u); }).length, 1);
    t.eq('that run makes no Alpha Vantage calls', r2.calls.av, 0);
    t.eq('that run makes no CoinGecko calls', r2.calls.cg, 0);
    t.eq('that run makes no Claude calls', r2.calls.claude, 0);

    /* 3. market open, 45 minutes after the last QQQ read */
    var r3 = await step(db, api, '2026-09-14T13:50:00Z');
    t.ok('open market refreshes quotes', !!r3.out.quotes);
    t.ok('open market leaves history alone', !r3.out.history);
    t.eq('open market: two index quotes, two mover quotes and the last slice of members', r3.calls.fmp, 4 + N - 2 * PER);
    var ms3 = r3.out.spotlight && r3.out.spotlight.movers.stocks;
    t.ok('a complete pass names the movers of the week', !!ms3);
    var ranked3 = U.LIST.map(function (s) {
      var closes = U.readCloses(db.files['stocks/' + s.symbol]);
      return { symbol: s.symbol, change: closes ? U.weekChange(closes) : NaN };
    }).filter(function (r) { return typeof r.change === 'number' && isFinite(r.change); }).sort(function (a, b) {
      return b.change - a.change || (a.symbol < b.symbol ? -1 : 1);
    });
    t.eq('the mover is the largest five-session gain', ms3 && ms3.mover.symbol, ranked3[0].symbol);
    t.eq('the loser is the largest five-session drop', ms3 && ms3.loser.symbol, ranked3[ranked3.length - 1].symbol);
    t.eq('the movers are measured to the last session before the week', ms3 && ms3.measuredTo, '2026-09-11');
    t.eq('the movers rank every priced member', ms3 && ms3.scanned, N - 1);
    t.eq('the board holds five at each end', ms3 && ms3.top.length + ':' + ms3.bottom.length, '5:5');
    t.eq('the bottom of the board starts with the loser', ms3 && ms3.bottom[0].symbol, ms3 && ms3.loser.symbol);
    t.eq('the movers are quoted', r3.out.quotes.picks && r3.out.quotes.picks.mover.symbol + ',' + r3.out.quotes.picks.loser.symbol,
      ms3 && ms3.mover.symbol + ',' + ms3.loser.symbol);
    t.eq('older pages see the mover as the stock of the week', r3.out.spotlight.current.symbol, ms3 && ms3.mover.symbol);
    t.eq('older pages get its chart', r3.out.spotlight.series && r3.out.spotlight.series.length, 100);
    t.eq('older pages get its quote', r3.out.quotes.spotlight && r3.out.quotes.spotlight.symbol, ms3 && ms3.mover.symbol);
    t.ok('the week joins the history', r3.out.spotlight.movers.history.some(function (h) {
      return h.kind === 'stocks' && h.weekOf === '2026-09-14' && h.rule === 'gain-drop';
    }));
    t.eq('the pass prices every member but the denial', r3.out.stocks.count.priced, N - 1);
    t.ok('the pass is complete', r3.out.stocks.complete === true);
    t.eq('the summary lists every priced member', r3.out.stocks.rows.length, N - 1);
    t.eq('QQQ is throttled inside the hour', r3.calls.av, 0);
    t.eq('finalFor is untouched while open', r3.out.quotes.finalFor, '2026-09-11');

    /* 4. more than 55 minutes after the last QQQ read */
    var r4 = await step(db, api, '2026-09-14T14:10:00Z');
    t.eq('QQQ refreshes after the hour', r4.calls.av, 1);
    t.eq('the mover quotes skip a run', r4.calls.fmp, 2);
    t.ok('a finished pass rewrites nothing', !r4.out.stocks && !r4.out.job);
    var r4b = await step(db, api, '2026-09-14T14:20:00Z');
    t.eq('the mover quotes return on the next run', r4b.calls.fmp, 4);
    t.ok('the movers are not recomputed within the week', !r4b.out.spotlight);

    /* 5. after the close: one final quote read, history waits for the bars */
    var r5 = await step(db, api, '2026-09-14T20:25:00Z');
    t.eq('final read marks the session', r5.out.quotes && r5.out.quotes.finalFor, '2026-09-14');
    t.ok('history waits an hour after the close', !r5.out.history);
    t.ok('the reading waits for the history grace too', !r5.out.note);

    var r6 = await step(db, api, '2026-09-14T21:05:00Z');
    t.ok('history refreshes after the grace', !!r6.out.history);
    t.ok('findings recomputed with the history', !!r6.out.findings && r6.out.findings.forSession === '2026-09-14');
    t.eq('a new reading for the new session', r6.out.note && r6.out.note.forSession, '2026-09-14');
    t.ok('no further quote reads once final', !r6.out.quotes);
    t.ok('new history does not move the movers', !r6.out.spotlight);
    t.ok('members wait until the index has the new session', !r6.out.stocks && stockKeys(r6.out).length === 0);

    /* the canned bars stop on Friday, so Monday's bar is "late": retry spacing */
    var r7 = await step(db, api, '2026-09-14T21:20:00Z');
    t.eq('late bar is not re-asked within two hours', Object.keys(r7.out).length, 0);

    /* Monday's bars land; AAPL has split 4:1 since it was stored */
    var apiMon = mockApi({ eodLast: '2026-09-14', split: 'AAPL' });
    var abnbBefore = db.files['stocks/ABNB'].closes.length;
    var rMon = await step(db, apiMon, '2026-09-14T23:30:00Z');
    t.ok('the late index bar is asked again after two hours', !!rMon.out.history);
    t.eq('FMP calls: 3 history + one slice of members', rMon.calls.fmp, 3 + PER);
    var abnbUrl = apiMon.log.filter(function (u) { return /eod\/light\?symbol=ABNB/.test(u); })[0] || '';
    t.ok('a stored member asks only for the recent closes', abnbUrl.indexOf('from=2026-09-01') > 0);
    t.eq('the new close is appended', db.files['stocks/ABNB'].closes.length, abnbBefore + 1);
    t.eq('the member file ends on the new session', db.files['stocks/ABNB'].closes[db.files['stocks/ABNB'].closes.length - 1][0], '2026-09-14');
    t.ok('a split is caught', rMon.out.job.universe.lastRun.rebased.indexOf('AAPL') >= 0);
    t.ok('the split is a warning', rMon.warnings.some(function (w) { return w.indexOf('refetched in full: AAPL') > 0; }));
    var aapl = db.files['stocks/AAPL'].closes;
    var aaplFri = aapl.filter(function (c) { return c[0] === '2026-09-11'; })[0];
    t.close('after a split the whole history is re-based', aaplFri && aaplFri[1], Math.round(priceOn('AAPL', '2026-09-11') * 0.25 * 10000) / 10000, 1e-9);
    t.ok('the re-based history is complete', aapl.length > 252);
    t.eq('the refetch counts against the slice', rMon.out.job.universe.lastRun.fetched, PER - 1);
    t.eq('the summary moves to the new session', rMon.out.stocks.session, '2026-09-14');
    t.eq('members still on Friday are not priced for Monday', rMon.out.stocks.count.priced, PER - 1);

    /* the daily limit mid-pass */
    var capped = store(), cappedApi = mockApi({ fmpLimitAfter: 25 });
    var rCap = await step(capped, cappedApi, '2026-09-14T13:05:00Z');
    /* calls 1-3 history, 4-25 members (AVGO denied), 26 hits the limit, 27-28 the index quotes */
    t.eq('the step stops at the limit', rCap.calls.fmp, 28);
    t.eq('members before the limit are kept', stockKeys(rCap.out).length, 21);
    t.ok('the limit is recorded', !!rCap.out.job.universe.lastRun.stopped);
    t.ok('the limit is a warning', rCap.warnings.some(function (w) { return w.indexOf('daily limit') > 0; }));
    t.ok('the member that hit the limit is not marked', !rCap.out.job.universe.symbols[U.LIST[22].symbol]);

    /* FORCE=universe: every member in one run */
    var forced = store();
    var rForce = await step(forced, mockApi(), '2026-09-14T13:05:00Z', Object.assign({}, KEYS, { FORCE: 'universe' }));
    t.eq('force: 3 history, every member once, 2 index and 2 mover quotes', rForce.calls.fmp, N + 7);
    t.ok('a forced pass names the movers in the same run', !!(rForce.out.spotlight && rForce.out.spotlight.movers.stocks));
    t.ok('a forced pass is complete', rForce.out.stocks.complete === true);
    t.eq('a forced pass prices all but the denial', rForce.out.stocks.count.priced, N - 1);
    t.ok('a forced pass logs its coverage', rForce.log.some(function (l) { return l.indexOf('complete') > 0; }));
    t.ok('no stock file name escapes the folder', Object.keys(forced.files).every(function (k) {
      return k.indexOf('stocks/') !== 0 || MP.sources.stockPath(k.slice(7)) !== null;
    }));

    /* the spotlight.json in production today: version 1, one pick of each kind */
    var legacy = store();
    legacy.files.spotlight = {
      generatedAt: '2026-09-11T01:48:37.000Z',
      current: { weekOf: '2026-09-07', symbol: 'ADBE', name: 'Adobe Inc.', changePct5d: -9.34164, direction: 'down', scanned: 14, skipped: 1,
        runnerUp: { symbol: 'AMD', changePct5d: 9.00433 }, rule: 'Largest absolute 5-session move across a fixed 15-name Nasdaq-100 universe.' },
      history: [{ weekOf: '2026-09-07', symbol: 'ADBE', changePct5d: -9.34164 }],
      change: { symbol: 'ADBE', d1: -2.366, d5: -9.34164, m1: -8.84012 }, series: null, detailFor: '2026-09-10',
      scanTriedWeek: '2026-09-07', scanTriedAt: Date.parse('2026-09-08T13:05:00Z'),
      crypto: { weekOf: '2026-09-07', id: 'solana', symbol: 'SOL', name: 'Solana', changePct7d: 12.1 },
      cryptoHistory: [{ weekOf: '2026-09-07', id: 'solana', symbol: 'SOL', changePct7d: 12.1 }],
      cryptoTriedWeek: '2026-09-07', cryptoTriedAt: Date.parse('2026-09-08T13:05:00Z')
    };
    var rLeg = await step(legacy, mockApi(), '2026-09-14T13:05:00Z');
    var sLeg = rLeg.out.spotlight;
    t.eq('an old spotlight file is rewritten as version 2', sLeg && sLeg.version, 2);
    var oldStock = sLeg ? sLeg.movers.history.filter(function (h) { return h.kind === 'stocks' && h.rule === 'absolute'; })[0] : null;
    t.ok('its stock pick joins the history under the old rule', !!oldStock && oldStock.mover.symbol === 'ADBE' && oldStock.weekOf === '2026-09-07');
    t.ok('its crypto pick joins the history too', !!sLeg && sLeg.movers.history.some(function (h) {
      return h.kind === 'crypto' && h.rule === 'absolute' && h.mover.symbol === 'SOL' && h.mover.id === 'solana';
    }));
    t.eq('the crypto movers for the new week are worked out afresh', sLeg && sLeg.movers.crypto.weekOf, '2026-09-14');
    t.ok('older pages still list the old pick', !!sLeg && sLeg.history.some(function (h) { return h.symbol === 'ADBE'; }));
    t.ok('a version 2 file reads back without migrating', !P.readSpotlight(sLeg).migrated);
    t.ok('a file without a version migrates',
      P.readSpotlight({ current: { symbol: 'ADBE' }, history: [] }).migrated === true);

    /* 6. no FMP key */
    var bare = store(), bareApi = mockApi();
    var r8 = await step(bare, bareApi, '2026-09-14T13:05:00Z', {});
    t.ok('missing key skips the run with a reason', !!r8.skipped);
    t.eq('missing key makes no requests', bareApi.log.length, 0);

    /* 7. FMP down on a fresh repo */
    var down = store(), downApi = mockApi({ fmpDown: true });
    var r9 = await step(down, downApi, '2026-09-14T13:05:00Z');
    t.ok('every FMP call failed', r9.calls.fmp > 0 && r9.failed.fmp === r9.calls.fmp);
    t.ok('without members there are no stock movers', r9.out.spotlight && r9.out.spotlight.movers.stocks === null && r9.out.spotlight.current === null);
    t.ok('no findings without history', !r9.out.findings);
    t.ok('no reading without a final quote read', !r9.out.note);
    t.eq('failed read is not marked final', r9.out.quotes.finalFor, null);
    var r10 = await step(down, downApi, '2026-09-14T13:20:00Z');
    t.eq('a failed read retries only the two index quotes', r10.calls.fmp, 2);
    t.ok('the crypto movers survive FMP being down', r9.out.spotlight && r9.out.spotlight.movers.crypto && r9.out.spotlight.movers.crypto.mover.symbol === 'SOL');

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
    t.eq('without an Anthropic key the reading comes from the numbers', r12.out.note && r12.out.note.source, 'fallback');
    t.ok('the fallback reading passes its own checker', r12.out.note && MP.note.validate(r12.out.note.text).ok);
    t.ok('a missing key is not a rejection', r12.out.note && !r12.out.note.invalidReason);
    t.eq('no Claude calls without a key', r12.calls.claude, 0);

    /* 10. a reply that breaks the rules is not published */
    var bad = store(), badApi = mockApi({ claudeReply: CLAUDE_BAD });
    var r13 = await step(bad, badApi, '2026-09-14T13:05:00Z');
    t.eq('a rule-breaking reply falls back', r13.out.note && r13.out.note.source, 'fallback');
    t.ok('the reason names the broken rule', /^banned word/.test((r13.out.note && r13.out.note.invalidReason) || ''));
    t.ok('the rejection is a warning', r13.warnings.some(function (w) { return w.indexOf('daily note:') === 0; }));
    t.ok('the model text never ships', r13.out.note && r13.out.note.text.indexOf('buy') < 0);
    t.eq('the rejected reply cost one call', r13.calls.claude, 1);
    var r14 = await step(bad, badApi, '2026-09-14T13:20:00Z');
    t.eq('no retry within two hours', r14.calls.claude, 0);
    var r15 = await step(bad, badApi, '2026-09-14T15:10:00Z');
    t.eq('one retry after two hours', r15.calls.claude, 1);
    t.eq('the retry is counted', r15.out.note && r15.out.note.attempts, 2);
    var r16 = await step(bad, badApi, '2026-09-14T19:15:00Z');
    t.eq('no third attempt', r16.calls.claude, 0);

    /* 11. the API is down */
    var down2 = store();
    var r17 = await step(down2, mockApi({ claudeDown: true }), '2026-09-14T13:05:00Z');
    t.eq('an unreachable API falls back', r17.out.note && r17.out.note.source, 'fallback');
    t.eq('the failure is counted', r17.failed.claude, 1);
    t.ok('the failure is recorded on the reading', /request failed/.test((r17.out.note && r17.out.note.invalidReason) || ''));

    return t.summary();
  }

  MP.dataTest = { run: run, runPipeline: runPipeline };
})(typeof globalThis !== 'undefined' ? globalThis : this);
