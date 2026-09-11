/* ============================================================================
 * sources.js — where every number comes from, and the normalizers that turn
 * each upstream payload into the app's own shapes.
 *
 * Two kinds of source:
 *   - CoinGecko's public REST API, fetched straight from the visitor's
 *     browser. No key, CORS-enabled, so bitcoin stays live.
 *   - Snapshot files under data/, written by the scheduled GitHub Action
 *     (scripts/update-data.js) from Financial Modeling Prep and Alpha
 *     Vantage. Those APIs need keys, and a key must never ship in a public
 *     page, so the job holds them as repository secrets and publishes only
 *     the results.
 *
 * The FMP and Alpha Vantage normalizers live here too, so the page's tests and
 * the data job share one reading of every payload. Each was written against a
 * response observed from the live API; see test/data.test.js for the fixtures.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var COINGECKO = 'https://api.coingecko.com/api/v3';

  /* Relative to the page, so the site works under any GitHub Pages path. */
  var SNAPSHOT = {
    quotes: 'data/quotes.json',
    history: 'data/history.json',
    spotlight: 'data/spotlight.json'
  };

  function parsePayload(payload) {
    if (typeof payload === 'string') {
      try { return JSON.parse(payload); } catch (e) { return null; }
    }
    return payload;
  }

  function toNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (typeof v !== 'string') return NaN;
    var n = parseFloat(v.replace(/[%,$\s]/g, ''));
    return isFinite(n) ? n : NaN;
  }

  function ascendingByDate(rows) {
    return rows.slice().sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
  }

  function isoDay(d) {
    return d.toISOString().slice(0, 10);
  }

  /* ---- CoinGecko (browser) ------------------------------------------------ */

  /* GET /coins/markets?vs_currency=usd&ids=bitcoin&sparkline=true
   * -> [ { current_price, price_change_percentage_24h, market_cap,
   *        total_volume, circulating_supply, max_supply, market_cap_rank,
   *        last_updated, sparkline_in_7d: { price: [...] } } ]              */
  function coinSpot(coin) {
    return {
      id: coin.id || null,
      symbol: coin.symbol ? String(coin.symbol).toUpperCase() : null,
      name: coin.name || null,
      price: toNum(coin.current_price),
      changePct: toNum(coin.price_change_percentage_24h),   /* percentage points */
      change7d: toNum(coin.price_change_percentage_7d_in_currency),
      marketCap: toNum(coin.market_cap),
      volume: toNum(coin.total_volume),
      supply: toNum(coin.circulating_supply),
      maxSupply: toNum(coin.max_supply),
      rank: toNum(coin.market_cap_rank),
      sparkline: ((coin.sparkline_in_7d && coin.sparkline_in_7d.price) || []).map(toNum),
      updatedAt: Date.parse(coin.last_updated) || null
    };
  }

  var btcSpot = {
    url: COINGECKO + '/coins/markets?vs_currency=usd&ids=bitcoin&sparkline=true',
    normalize: function (payload) {
      var p = parsePayload(payload);
      var coin = Array.isArray(p) ? p[0] : null;
      if (!coin || !isFinite(toNum(coin.current_price))) return null;
      return coinSpot(coin);
    }
  };

  /* The same endpoint for several coins in one request, with the 7-day change
   * included: the page reads BTC, ETH and the crypto of the week together,
   * and the data job's weekly scan reads a whole universe. Resolves to a map
   * of CoinGecko id -> coinSpot, or null when nothing usable came back. */
  function coinsMarkets(ids, opts) {
    var spark = !(opts && opts.sparkline === false);
    return {
      url: COINGECKO + '/coins/markets?vs_currency=usd&ids=' + encodeURIComponent(ids.join(',')) +
        '&sparkline=' + (spark ? 'true' : 'false') + '&price_change_percentage=7d',
      normalize: function (payload) {
        var p = parsePayload(payload);
        if (!Array.isArray(p)) return null;
        var out = {}, any = false;
        for (var i = 0; i < p.length; i++) {
          var coin = p[i];
          if (!coin || !coin.id || !isFinite(toNum(coin.current_price))) continue;
          out[coin.id] = coinSpot(coin);
          any = true;
        }
        return any ? out : null;
      }
    };
  }

  /* GET /coins/{id}/market_chart?vs_currency=usd&days=N
   * -> { prices: [[ms, price], ...], market_caps: [...], total_volumes: [...] }
   * CoinGecko picks the granularity: ~5-minute for 1 day, hourly up to 90
   * days, daily beyond. */
  function btcChart(days) { return coinChart('bitcoin', days); }

  function coinChart(id, days) {
    return {
      url: COINGECKO + '/coins/' + encodeURIComponent(id) + '/market_chart?vs_currency=usd&days=' + encodeURIComponent(days),
      normalize: function (payload) {
        var p = parsePayload(payload);
        if (!p || !Array.isArray(p.prices)) return null;
        var prices = [], stamps = [];
        for (var i = 0; i < p.prices.length; i++) {
          var row = p.prices[i];
          var v = toNum(row && row[1]);
          if (isFinite(v)) { prices.push(v); stamps.push(toNum(row[0])); }
        }
        if (prices.length < 2) return null;
        return { prices: prices, startTs: stamps[0], endTs: stamps[stamps.length - 1] };
      }
    };
  }

  /* ---- Financial Modeling Prep (data job) --------------------------------- */

  /* /stable/quote?symbol=
   * -> [ { symbol, name, price, changePercentage, change, volume, dayLow,
   *        dayHigh, yearHigh, yearLow, marketCap, priceAvg50, priceAvg200,
   *        exchange, open, previousClose, timestamp } ]
   * The same shape for an index (^IXIC) and a stock. `timestamp` is seconds. */
  function normalizeFmpQuote(payload) {
    var p = parsePayload(payload);
    var q = Array.isArray(p) ? p[0] : p;
    if (!q || !q.symbol || !isFinite(toNum(q.price))) return null;
    var ts = toNum(q.timestamp);
    return {
      symbol: q.symbol,
      name: q.name || null,
      price: toNum(q.price),
      changePct: toNum(q.changePercentage),        /* percentage points */
      change: toNum(q.change),
      dayLow: toNum(q.dayLow),
      dayHigh: toNum(q.dayHigh),
      prevClose: toNum(q.previousClose),
      open: toNum(q.open),
      volume: toNum(q.volume),
      marketCap: toNum(q.marketCap),
      yearHigh: toNum(q.yearHigh),
      yearLow: toNum(q.yearLow),
      avg50: toNum(q.priceAvg50),
      avg200: toNum(q.priceAvg200),
      exchange: q.exchange || null,
      timestamp: isFinite(ts) ? ts * 1000 : null
    };
  }

  /* /stable/historical-price-eod/light?symbol=&from=&to=
   * -> [ { symbol, date: 'YYYY-MM-DD', price, volume } ] (newest first).
   * Serves indexes (^IXIC), crypto pairs (BTCUSD) and stocks alike. */
  function normalizeEodLight(payload) {
    var p = parsePayload(payload);
    if (!Array.isArray(p)) return null;
    var rows = [];
    for (var i = 0; i < p.length; i++) {
      var d = p[i] && p[i].date ? String(p[i].date).slice(0, 10) : null;
      var v = toNum(p[i] && p[i].price);
      if (d && isFinite(v)) rows.push({ date: d, price: v });
    }
    return rows.length ? ascendingByDate(rows) : null;
  }

  /* /stable/stock-price-change?symbol=
   * -> [ { symbol, '1D', '5D', '1M', '3M', '6M', ytd, '1Y', ... } ]
   * All values are percentage points. '5D' is the spotlight's selection basis. */
  function normalizeQuoteChange(payload) {
    var p = parsePayload(payload);
    var q = Array.isArray(p) ? p[0] : p;
    if (!q || !q.symbol) return null;
    return {
      symbol: q.symbol,
      d1: toNum(q['1D']),
      d5: toNum(q['5D']),
      m1: toNum(q['1M']),
      m3: toNum(q['3M']),
      m6: toNum(q['6M']),
      ytd: toNum(q.ytd),
      y1: toNum(q['1Y'])
    };
  }

  /* ---- Alpha Vantage (data job) ------------------------------------------- */

  /* function=GLOBAL_QUOTE
   * -> { 'Global Quote': { '01. symbol', '05. price', '08. previous close',
   *      '10. change percent': '-1.0638%', ... } }                           */
  function normalizeAvQuote(payload) {
    var p = parsePayload(payload);
    var q = p && p['Global Quote'];
    if (!q || !isFinite(toNum(q['05. price']))) return null;
    return {
      symbol: q['01. symbol'] || null,
      price: toNum(q['05. price']),
      changePct: toNum(q['10. change percent']),    /* percentage points */
      change: toNum(q['09. change']),
      dayLow: toNum(q['04. low']),
      dayHigh: toNum(q['03. high']),
      open: toNum(q['02. open']),
      prevClose: toNum(q['08. previous close']),
      volume: toNum(q['06. volume']),
      tradingDay: q['07. latest trading day'] || null
    };
  }

  /* function=TIME_SERIES_DAILY, outputsize=compact (100 sessions)
   * -> { 'Time Series (Daily)': { 'YYYY-MM-DD': { '4. close': '708.6900' } } } */
  function normalizeAvDaily(payload) {
    var p = parsePayload(payload);
    var table = p && p['Time Series (Daily)'];
    if (!table) return null;
    var rows = [];
    Object.keys(table).forEach(function (day) {
      var close = toNum(table[day]['4. close']);
      if (isFinite(close)) rows.push({ date: String(day).slice(0, 10), price: close });
    });
    return rows.length ? ascendingByDate(rows) : null;
  }

  /* ---- snapshot files (browser) ------------------------------------------- */
  /* The job has already normalized everything, so the page only re-checks
   * shapes: a hand-edited or half-written file degrades to "no data". */

  function readSeries(rows) {
    if (!Array.isArray(rows)) return null;
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r && typeof r.date === 'string' && isFinite(toNum(r.price))) {
        out.push({ date: r.date.slice(0, 10), price: toNum(r.price) });
      }
    }
    return out.length ? ascendingByDate(out) : null;
  }

  function readQuote(q) {
    return q && typeof q === 'object' && isFinite(toNum(q.price)) ? q : null;
  }

  function stampOf(iso) {
    var t = Date.parse(iso);
    return isFinite(t) ? t : null;
  }

  function normalizeQuotesSnapshot(payload) {
    var p = parsePayload(payload);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    return {
      generatedAt: stampOf(p.generatedAt),
      ixic: readQuote(p.ixic),
      spx: readQuote(p.spx),
      qqq: readQuote(p.qqq),
      spotlight: readQuote(p.spotlight)
    };
  }

  function normalizeHistorySnapshot(payload) {
    var p = parsePayload(payload);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    return {
      generatedAt: stampOf(p.generatedAt),
      btc: readSeries(p.btc),
      ixic: readSeries(p.ixic),
      spx: readSeries(p.spx),
      qqq: readSeries(p.qqq)
    };
  }

  function normalizeSpotlightSnapshot(payload) {
    var p = parsePayload(payload);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    return {
      generatedAt: stampOf(p.generatedAt),
      current: p.current && p.current.symbol ? p.current : null,
      history: Array.isArray(p.history) ? p.history.filter(function (h) { return h && h.symbol; }) : [],
      change: p.change && typeof p.change === 'object' ? p.change : null,
      series: readSeries(p.series),
      crypto: p.crypto && p.crypto.id && p.crypto.symbol ? p.crypto : null,
      cryptoHistory: Array.isArray(p.cryptoHistory) ? p.cryptoHistory.filter(function (h) { return h && h.symbol; }) : []
    };
  }

  MP.sources = {
    COINGECKO: COINGECKO,
    SNAPSHOT: SNAPSHOT,
    btcSpot: btcSpot,
    coinsMarkets: coinsMarkets,
    btcChart: btcChart,
    coinChart: coinChart,
    normalizeFmpQuote: normalizeFmpQuote,
    normalizeEodLight: normalizeEodLight,
    normalizeQuoteChange: normalizeQuoteChange,
    normalizeAvQuote: normalizeAvQuote,
    normalizeAvDaily: normalizeAvDaily,
    normalizeQuotesSnapshot: normalizeQuotesSnapshot,
    normalizeHistorySnapshot: normalizeHistorySnapshot,
    normalizeSpotlightSnapshot: normalizeSpotlightSnapshot,
    isoDay: isoDay,
    parsePayload: parsePayload,
    toNum: toNum
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
