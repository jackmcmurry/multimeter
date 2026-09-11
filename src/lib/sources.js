/* ============================================================================
 * sources.js: where every number comes from, and the normalizers that turn
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
    spotlight: 'data/spotlight.json',
    findings: 'data/findings.json',
    note: 'data/note.json',
    stocks: 'data/stocks.json'
  };

  /* Nasdaq-style tickers only (AAPL, GOOGL, BRK.B): anything else, a path
   * included, never becomes a file name. */
  var SYMBOL_RE = /^[A-Z0-9]{1,6}(?:[.-][A-Z0-9]{1,4})?$/;

  function stockPath(symbol) {
    return typeof symbol === 'string' && SYMBOL_RE.test(symbol) ? 'data/stocks/' + symbol + '.json' : null;
  }

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
        return { prices: prices, stamps: stamps, startTs: stamps[0], endTs: stamps[stamps.length - 1] };
      }
    };
  }

  /* GET /search?query=sol -> { coins: [{ id, name, api_symbol, symbol,
   * market_cap_rank, thumb, large }], exchanges, ... } sorted by market cap.
   * Keyless. The probe jack offers the first eight. */
  function coinSearch(query) {
    return {
      url: COINGECKO + '/search?query=' + encodeURIComponent(String(query || '').trim()),
      normalize: function (payload) {
        var p = parsePayload(payload);
        if (!p || !Array.isArray(p.coins)) return null;
        var out = [];
        for (var i = 0; i < p.coins.length && out.length < 8; i++) {
          var c = p.coins[i];
          if (!c || !c.id || !c.symbol) continue;
          out.push({
            id: String(c.id),
            symbol: String(c.symbol).toUpperCase(),
            name: c.name || String(c.symbol).toUpperCase(),
            rank: toNum(c.market_cap_rank)
          });
        }
        return out;
      }
    };
  }

  /* A coinChart result over 365 days arrives as one point per day, stamped
   * 00:00 UTC, which is the close of the PREVIOUS day, the way FMP dates its
   * daily bars. Shifting each stamp back one millisecond dates midnight
   * points to the day they close and leaves an intra-day "now" point on its
   * own day; the last point per day wins. */
  function dailySeries(entry) {
    if (!entry || !Array.isArray(entry.prices) || !Array.isArray(entry.stamps)) return null;
    var byDay = {}, order = [];
    for (var i = 0; i < entry.prices.length; i++) {
      var ts = toNum(entry.stamps[i]), v = toNum(entry.prices[i]);
      if (!isFinite(ts) || !isFinite(v)) continue;
      var day = isoDay(new Date(ts - 1));
      if (!byDay.hasOwnProperty(day)) order.push(day);
      byDay[day] = v;
    }
    if (!order.length) return null;
    return ascendingByDate(order.map(function (d) { return { date: d, price: byDay[d] }; }));
  }

  /* ---- Coinbase Exchange WebSocket (browser) ------------------------------ */

  /* wss://ws-feed.exchange.coinbase.com, channels ticker + heartbeat.
   * A ticker frame:
   *   { type:'ticker', product_id:'BTC-USD', price:'76780.01', open_24h:'78290.5',
   *     volume_24h, low_24h, high_24h, best_bid, best_ask, side, time, trade_id,
   *     last_size }
   * A rejected subscription:
   *   { type:'error', message:'Failed to subscribe', reason:'XYZ-USD is not a valid product' }
   * No key and no headers: the feed is public. */
  var COINBASE_WS = 'wss://ws-feed.exchange.coinbase.com';

  var coinbaseWs = {
    url: COINBASE_WS,

    /* 'sol' -> 'SOL-USD' */
    productFor: function (symbol) {
      var s = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      return s ? s + '-USD' : null;
    },

    subscribeMessage: function (products) {
      return { type: 'subscribe', product_ids: (products || []).slice(), channels: ['ticker', 'heartbeat'] };
    },

    unsubscribeMessage: function (products) {
      return { type: 'unsubscribe', product_ids: (products || []).slice(), channels: ['ticker', 'heartbeat'] };
    },

    /* -> { product, price, open24h, pct24h, time } or null for anything that
     * is not a priced ticker (heartbeats, subscriptions, errors). */
    normalizeTicker: function (msg) {
      var p = parsePayload(msg);
      if (!p || p.type !== 'ticker' || !p.product_id) return null;
      var price = toNum(p.price);
      if (!isFinite(price)) return null;
      var open = toNum(p.open_24h);
      return {
        product: String(p.product_id),
        price: price,
        open24h: isFinite(open) ? open : NaN,
        pct24h: isFinite(open) && open > 0 ? (price / open - 1) * 100 : NaN,   /* percentage points */
        time: Date.parse(p.time) || null
      };
    },

    errorReason: function (msg) {
      var p = parsePayload(msg);
      if (!p || p.type !== 'error') return null;
      return p.reason || p.message || 'error';
    },

    /* The product a rejection names, if any: 'XYZ-USD is not a valid product' -> 'XYZ-USD'. */
    productIn: function (text) {
      var m = /\b([A-Z0-9]{2,10}-USD)\b/.exec(String(text || ''));
      return m ? m[1] : null;
    }
  };

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
      spotlight: readQuote(p.spotlight),
      /* the stock movers' quotes (spotlight.json version 2) */
      picks: p.picks && typeof p.picks === 'object'
        ? { mover: readQuote(p.picks.mover), loser: readQuote(p.picks.loser) }
        : null
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

  /* One ranked entry of a movers set: { symbol, name, id?, change, rank }. */
  function readMoverEntry(e) {
    if (!e || typeof e.symbol !== 'string' || !isFinite(toNum(e.change))) return null;
    var out = { symbol: e.symbol, name: typeof e.name === 'string' ? e.name : e.symbol, change: toNum(e.change), rank: toNum(e.rank) };
    if (typeof e.id === 'string') out.id = e.id;
    return out;
  }

  function readMoverSet(m) {
    var mover = m && readMoverEntry(m.mover);
    if (!mover) return null;
    function list(v) { return Array.isArray(v) ? v.map(readMoverEntry).filter(Boolean) : []; }
    return {
      weekOf: typeof m.weekOf === 'string' ? m.weekOf : null,
      measuredTo: typeof m.measuredTo === 'string' ? m.measuredTo : null,
      mover: mover,
      loser: readMoverEntry(m.loser),
      moverNext: readMoverEntry(m.moverNext),
      loserNext: readMoverEntry(m.loserNext),
      top: list(m.top),
      bottom: list(m.bottom),
      scanned: toNum(m.scanned),
      skipped: toNum(m.skipped),
      listed: toNum(m.listed),
      rule: typeof m.rule === 'string' ? m.rule : ''
    };
  }

  /* spotlight.json version 2: { movers: { stocks, crypto, history } }. */
  function readMovers(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    return {
      stocks: readMoverSet(m.stocks),
      crypto: readMoverSet(m.crypto),
      history: Array.isArray(m.history) ? m.history.filter(function (h) {
        return h && typeof h.weekOf === 'string' && (h.kind === 'stocks' || h.kind === 'crypto') && h.mover && typeof h.mover.symbol === 'string';
      }) : []
    };
  }

  function normalizeSpotlightSnapshot(payload) {
    var p = parsePayload(payload);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    return {
      version: toNum(p.version),
      weekOf: typeof p.weekOf === 'string' ? p.weekOf : null,
      movers: readMovers(p.movers),
      generatedAt: stampOf(p.generatedAt),
      current: p.current && p.current.symbol ? p.current : null,
      history: Array.isArray(p.history) ? p.history.filter(function (h) { return h && h.symbol; }) : [],
      change: p.change && typeof p.change === 'object' ? p.change : null,
      series: readSeries(p.series),
      crypto: p.crypto && p.crypto.id && p.crypto.symbol ? p.crypto : null,
      cryptoHistory: Array.isArray(p.cryptoHistory) ? p.cryptoHistory.filter(function (h) { return h && h.symbol; }) : []
    };
  }

  /* findings.json is the data job's own output; the page re-checks only the
   * parts it dereferences without guards. */
  function normalizeFindingsSnapshot(payload) {
    var p = parsePayload(payload);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    var ix = p.pairs && p.pairs.ixic;
    if (!ix || !Array.isArray(ix.coupling) || !Array.isArray(ix.rolling90) || !ix.regimes || !ix.vol || !ix.scatter) return null;
    ix.rolling90 = ix.rolling90.filter(function (e) { return e && typeof e.date === 'string' && (e.value === null || isFinite(toNum(e.value))); });
    ix.breaks = Array.isArray(ix.breaks) ? ix.breaks : [];
    if (!p.drawdowns || typeof p.drawdowns !== 'object') p.drawdowns = {};
    if (p.pairs.spx && (!Array.isArray(p.pairs.spx.coupling) || !p.pairs.spx.regimes)) p.pairs.spx = null;
    return p;
  }

  /* note.json: the daily reading. Only text is required; everything else is
   * shown when present. */
  function normalizeNoteSnapshot(payload) {
    var p = parsePayload(payload);
    if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.text !== 'string' || !p.text.trim()) return null;
    return {
      generatedAt: stampOf(p.generatedAt),
      forSession: typeof p.forSession === 'string' ? p.forSession : null,
      text: p.text.trim(),
      source: p.source === 'claude' ? 'claude' : 'fallback',
      model: typeof p.model === 'string' ? p.model : null,
      promptVersion: toNum(p.promptVersion),
      inputs: p.inputs && typeof p.inputs === 'object' && !Array.isArray(p.inputs) ? p.inputs : null,
      invalidReason: typeof p.invalidReason === 'string' ? p.invalidReason : null
    };
  }

  /* stocks.json: the Nasdaq-100 with each member's last close. Rows without
   * a symbol or a numeric close are dropped. */
  function normalizeStocksSnapshot(payload) {
    var p = parsePayload(payload);
    if (!p || typeof p !== 'object' || !Array.isArray(p.rows)) return null;
    function pct(v) { var n = toNum(v); return isFinite(n) ? n : NaN; }
    var rows = [];
    for (var i = 0; i < p.rows.length; i++) {
      var r = p.rows[i];
      if (!r || typeof r.symbol !== 'string' || !SYMBOL_RE.test(r.symbol) || !isFinite(toNum(r.close))) continue;
      rows.push({
        symbol: r.symbol,
        name: typeof r.name === 'string' ? r.name : r.symbol,
        close: toNum(r.close),
        date: typeof r.date === 'string' ? r.date.slice(0, 10) : null,
        change1d: pct(r.change1d),
        change5d: pct(r.change5d),
        change1m: pct(r.change1m)
      });
    }
    var c = p.count || {};
    return {
      generatedAt: stampOf(p.generatedAt),
      session: typeof p.session === 'string' ? p.session : null,
      listAsOf: typeof p.listAsOf === 'string' ? p.listAsOf : null,
      count: { listed: toNum(c.listed), priced: toNum(c.priced), denied: toNum(c.denied) },
      complete: p.complete === true,
      rows: rows
    };
  }

  /* stocks/SYM.json: [[date, close]] -> [{ date, price }] ascending. */
  function normalizeStockFile(payload) {
    var p = parsePayload(payload);
    if (!p || typeof p !== 'object' || typeof p.symbol !== 'string' || !Array.isArray(p.closes)) return null;
    var series = readSeries(p.closes.map(function (c) {
      return Array.isArray(c) ? { date: c[0], price: c[1] } : null;
    }));
    if (!series) return null;
    return { symbol: p.symbol, name: typeof p.name === 'string' ? p.name : p.symbol, series: series };
  }

  MP.sources = {
    COINGECKO: COINGECKO,
    COINBASE_WS: COINBASE_WS,
    SNAPSHOT: SNAPSHOT,
    stockPath: stockPath,
    normalizeStocksSnapshot: normalizeStocksSnapshot,
    normalizeStockFile: normalizeStockFile,
    coinbaseWs: coinbaseWs,
    btcSpot: btcSpot,
    coinsMarkets: coinsMarkets,
    btcChart: btcChart,
    coinChart: coinChart,
    coinSearch: coinSearch,
    dailySeries: dailySeries,
    normalizeFmpQuote: normalizeFmpQuote,
    normalizeEodLight: normalizeEodLight,
    normalizeQuoteChange: normalizeQuoteChange,
    normalizeAvQuote: normalizeAvQuote,
    normalizeAvDaily: normalizeAvDaily,
    normalizeQuotesSnapshot: normalizeQuotesSnapshot,
    normalizeHistorySnapshot: normalizeHistorySnapshot,
    normalizeSpotlightSnapshot: normalizeSpotlightSnapshot,
    normalizeFindingsSnapshot: normalizeFindingsSnapshot,
    normalizeNoteSnapshot: normalizeNoteSnapshot,
    isoDay: isoDay,
    parsePayload: parsePayload,
    toNum: toNum
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
