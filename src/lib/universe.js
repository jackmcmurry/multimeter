/* ============================================================================
 * universe.js: the symbols the data job prices, and the rules for keeping
 * each one's daily closes.
 *
 * The data job fetches one member's closes per FMP call, a slice of the list
 * per run, so a full pass over the index is spread across three runs after
 * each close. This module is pure: it decides which symbols are due, merges
 * what came back into what is stored, and turns a series into the one-line
 * summary the page lists. It runs in Node (the data job) and in the browser
 * test bundle, never in the published page.
 *
 * The list is fixed in code and dated. Nasdaq rebalances every December and
 * replaces members between times, so the job warns once the list is older
 * than STALE_AFTER_DAYS. Refresh it from nasdaq.com's Nasdaq-100 page.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var AS_OF = '2026-09-11';
  var LIST_SOURCE = 'nasdaq.com, Nasdaq-100 constituents';
  var STALE_AFTER_DAYS = 120;

  var PER_RUN = 35;                    /* FMP calls the step may spend in one run */
  var FULL_DAYS = 400;                 /* first fetch: about 275 sessions */
  var OVERLAP_DAYS = 10;               /* later fetches re-read this much, to catch splits */
  var MAX_SESSIONS = 300;              /* stored per symbol: the 1Y range tab plus slack */
  var DENY_RETRY_MS = 35 * 86400000;   /* a plan denial is asked again after 35 days */
  var FAIL_RETRY_MS = 2 * 3600000;     /* any other failure, after two hours */
  var MAX_TRIES = 3;                   /* per symbol per session */
  var MISMATCH = 0.005;                /* stored and fresh closes may differ this much */
  var COMPLETE_SHARE = 0.9;            /* priced share of the askable list that counts as complete */
  var DAY_MS = 86400000;

  /* [symbol, name] as listed on AS_OF, by symbol. */
  var LIST = [
    ['AAPL', 'Apple Inc.'],
    ['ABNB', 'Airbnb, Inc.'],
    ['ADBE', 'Adobe Inc.'],
    ['ADI', 'Analog Devices, Inc.'],
    ['ADP', 'Automatic Data Processing, Inc.'],
    ['ADSK', 'Autodesk, Inc.'],
    ['AEP', 'American Electric Power Company, Inc.'],
    ['ALAB', 'Astera Labs, Inc.'],
    ['ALNY', 'Alnylam Pharmaceuticals, Inc.'],
    ['AMAT', 'Applied Materials, Inc.'],
    ['AMD', 'Advanced Micro Devices, Inc.'],
    ['AMGN', 'Amgen Inc.'],
    ['AMZN', 'Amazon.com, Inc.'],
    ['APP', 'AppLovin Corporation'],
    ['ARM', 'Arm Holdings plc'],
    ['ASML', 'ASML Holding N.V.'],
    ['AVGO', 'Broadcom Inc.'],
    ['AXON', 'Axon Enterprise, Inc.'],
    ['BKNG', 'Booking Holdings Inc.'],
    ['BKR', 'Baker Hughes Company'],
    ['CCEP', 'Coca-Cola Europacific Partners plc'],
    ['CDNS', 'Cadence Design Systems, Inc.'],
    ['CEG', 'Constellation Energy Corporation'],
    ['CMCSA', 'Comcast Corporation'],
    ['COST', 'Costco Wholesale Corporation'],
    ['CPRT', 'Copart, Inc.'],
    ['CRWD', 'CrowdStrike Holdings, Inc.'],
    ['CRWV', 'CoreWeave, Inc.'],
    ['CSCO', 'Cisco Systems, Inc.'],
    ['CSX', 'CSX Corporation'],
    ['CTAS', 'Cintas Corporation'],
    ['DASH', 'DoorDash, Inc.'],
    ['DDOG', 'Datadog, Inc.'],
    ['DXCM', 'DexCom, Inc.'],
    ['EXC', 'Exelon Corporation'],
    ['FANG', 'Diamondback Energy, Inc.'],
    ['FAST', 'Fastenal Company'],
    ['FER', 'Ferrovial N.V.'],
    ['FTNT', 'Fortinet, Inc.'],
    ['GEHC', 'GE HealthCare Technologies Inc.'],
    ['GILD', 'Gilead Sciences, Inc.'],
    ['GOOG', 'Alphabet Inc. Class C'],
    ['GOOGL', 'Alphabet Inc. Class A'],
    ['HON', 'Honeywell International Inc.'],
    ['HONA', 'Honeywell Aerospace Inc.'],
    ['IDXX', 'IDEXX Laboratories, Inc.'],
    ['INTC', 'Intel Corporation'],
    ['INTU', 'Intuit Inc.'],
    ['ISRG', 'Intuitive Surgical, Inc.'],
    ['KDP', 'Keurig Dr Pepper Inc.'],
    ['KHC', 'The Kraft Heinz Company'],
    ['KLAC', 'KLA Corporation'],
    ['LIN', 'Linde plc'],
    ['LITE', 'Lumentum Holdings Inc.'],
    ['LRCX', 'Lam Research Corporation'],
    ['MAR', 'Marriott International, Inc.'],
    ['MCHP', 'Microchip Technology Incorporated'],
    ['MDLZ', 'Mondelez International, Inc.'],
    ['MELI', 'MercadoLibre, Inc.'],
    ['META', 'Meta Platforms, Inc.'],
    ['MNST', 'Monster Beverage Corporation'],
    ['MPWR', 'Monolithic Power Systems, Inc.'],
    ['MRVL', 'Marvell Technology, Inc.'],
    ['MSFT', 'Microsoft Corporation'],
    ['MSTR', 'Strategy Inc'],
    ['MU', 'Micron Technology, Inc.'],
    ['NBIS', 'Nebius Group N.V.'],
    ['NFLX', 'Netflix, Inc.'],
    ['NVDA', 'NVIDIA Corporation'],
    ['NXPI', 'NXP Semiconductors N.V.'],
    ['ODFL', 'Old Dominion Freight Line, Inc.'],
    ['ORLY', 'O’Reilly Automotive, Inc.'],
    ['PANW', 'Palo Alto Networks, Inc.'],
    ['PAYX', 'Paychex, Inc.'],
    ['PCAR', 'PACCAR Inc.'],
    ['PDD', 'PDD Holdings Inc.'],
    ['PEP', 'PepsiCo, Inc.'],
    ['PLTR', 'Palantir Technologies Inc.'],
    ['PYPL', 'PayPal Holdings, Inc.'],
    ['QCOM', 'QUALCOMM Incorporated'],
    ['REGN', 'Regeneron Pharmaceuticals, Inc.'],
    ['RKLB', 'Rocket Lab Corporation'],
    ['ROP', 'Roper Technologies, Inc.'],
    ['ROST', 'Ross Stores, Inc.'],
    ['SBUX', 'Starbucks Corporation'],
    ['SHOP', 'Shopify Inc.'],
    ['SNDK', 'Sandisk Corporation'],
    ['SNPS', 'Synopsys, Inc.'],
    ['SPCX', 'Space Exploration Technologies Corp.'],
    ['STX', 'Seagate Technology Holdings PLC'],
    ['TER', 'Teradyne, Inc.'],
    ['TMUS', 'T-Mobile US, Inc.'],
    ['TRI', 'Thomson Reuters Corporation'],
    ['TSLA', 'Tesla, Inc.'],
    ['TTWO', 'Take-Two Interactive Software, Inc.'],
    ['TXN', 'Texas Instruments Incorporated'],
    ['VRTX', 'Vertex Pharmaceuticals Incorporated'],
    ['WBD', 'Warner Bros. Discovery, Inc.'],
    ['WDAY', 'Workday, Inc.'],
    ['WDC', 'Western Digital Corporation'],
    ['WMT', 'Walmart Inc.'],
    ['XEL', 'Xcel Energy Inc.']
  ].map(function (r) { return { symbol: r[0], name: r[1] }; });

  /* The list the job actually fetches: the index above, plus the majors held
   * in sources.js (the one module both the page and the job load). LIST stays
   * the Nasdaq-100 alone, because AS_OF and the staleness warning describe
   * that index and nothing else. */
  var MAJORS = (MP.sources && MP.sources.MAJORS) || [];
  var UNIVERSE = LIST.concat(MAJORS);

  var NAMES = {};
  UNIVERSE.forEach(function (s) { NAMES[s.symbol] = s.name; });

  var INDEX_SET = {};
  LIST.forEach(function (s) { INDEX_SET[s.symbol] = 1; });

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function round(x, dp) { var f = Math.pow(10, dp); return Math.round(x * f) / f; }

  function nameFor(symbol) { return NAMES.hasOwnProperty(symbol) ? NAMES[symbol] : null; }
  function listed(symbol) { return NAMES.hasOwnProperty(symbol); }
  /* Membership of the index proper, as distinct from the whole fetch
     universe. The MOVER and LOSER stops rank the Nasdaq-100 and say so, so
     they ask this rather than listed(). */
  function inIndex(symbol) { return INDEX_SET.hasOwnProperty(symbol); }


  /* Days since the list was taken, and whether that is old enough to warn. */
  function listAge(now) {
    var days = Math.floor((now - Date.parse(AS_OF + 'T00:00:00Z')) / DAY_MS);
    return { days: days, stale: days > STALE_AFTER_DAYS };
  }

  /* ---- what is due ---------------------------------------------------------- */

  /* A ledger entry is one of:
   *   { checkedFor, last, at }            closes stored for that session
   *   { deniedAt, at, reason }             not on this FMP plan
   *   { failedFor, tries, at, reason }     failed this session, retried later
   * plus `full: true` when a split is suspected and the whole series must be
   * fetched again.
   *
   * opts: { limit, force }. force asks everything again, denials included.
   * -> { due: [symbol], denied: [symbol], waiting: n } where waiting counts
   * symbols due but beyond the limit. */
  function planUniverse(ledger, session, now, opts) {
    ledger = ledger || {};
    opts = opts || {};
    var limit = isNum(opts.limit) || opts.limit === Infinity ? opts.limit : PER_RUN;
    var due = [], denied = [];
    UNIVERSE.forEach(function (s) {
      var e = ledger[s.symbol];
      if (!opts.force && e) {
        if (e.deniedAt && now - e.deniedAt < DENY_RETRY_MS) { denied.push(s.symbol); return; }
        if (!e.full && e.checkedFor === session) return;
        if (e.failedFor === session && ((e.tries || 1) >= MAX_TRIES || now - (e.at || 0) < FAIL_RETRY_MS)) return;
      }
      due.push(s.symbol);
    });
    /* never fetched first, then a suspected split, then the oldest fetch */
    function rank(sym) {
      var e = ledger[sym];
      return !e || !e.at ? 0 : e.full ? 1 : 2;
    }
    due.sort(function (a, b) {
      var d = rank(a) - rank(b);
      if (d) return d;
      var ta = (ledger[a] && ledger[a].at) || 0, tb = (ledger[b] && ledger[b].at) || 0;
      if (ta !== tb) return ta - tb;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return { due: due.slice(0, limit), denied: denied, waiting: Math.max(0, due.length - limit) };
  }

  /* The `from` day for a symbol's next fetch: a full year for a new or
   * suspect series, otherwise a short overlap with what is stored. */
  function fromDay(stored, now, full) {
    if (full || !stored || !stored.length) return isoDay(now - FULL_DAYS * DAY_MS);
    var last = Date.parse(stored[stored.length - 1].date + 'T00:00:00Z');
    return isoDay(last - OVERLAP_DAYS * DAY_MS);
  }

  /* ---- merging -------------------------------------------------------------- */

  /* prev, fresh: [{ date, price }] ascending. Fresh closes win on shared
   * dates. A shared date whose closes differ by more than MISMATCH means FMP
   * has re-based the history (a split), so the caller should fetch the whole
   * series again rather than splice an adjusted run onto an unadjusted one.
   * -> { series, mismatch, added } */
  function mergeSeries(prev, fresh) {
    var byDate = {}, mismatch = false, added = 0;
    (prev || []).forEach(function (p) { if (p && isNum(p.price)) byDate[p.date] = p.price; });
    (fresh || []).forEach(function (p) {
      if (!p || !isNum(p.price)) return;
      var old = byDate[p.date];
      if (old === undefined) added++;
      else if (old > 0 && Math.abs(p.price / old - 1) > MISMATCH) mismatch = true;
      byDate[p.date] = p.price;
    });
    var series = Object.keys(byDate).sort().map(function (d) { return { date: d, price: byDate[d] }; });
    return { series: series.slice(-MAX_SESSIONS), mismatch: mismatch, added: added };
  }

  /* ---- the files ------------------------------------------------------------ */

  /* stocks/SYM.json: { symbol, name, generatedAt, closes: [[date, close]] } */
  function stockFile(symbol, series, generatedAt) {
    return {
      symbol: symbol,
      name: nameFor(symbol),
      generatedAt: generatedAt,
      closes: (series || []).map(function (p) { return [p.date, p.price]; })
    };
  }

  /* The inverse, re-checked: a hand-edited file degrades to nothing. */
  function readCloses(file) {
    if (!file || !Array.isArray(file.closes)) return null;
    var out = [];
    file.closes.forEach(function (c) {
      if (Array.isArray(c) && typeof c[0] === 'string' && isNum(c[1])) out.push({ date: c[0].slice(0, 10), price: c[1] });
    });
    out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return out.length ? out : null;
  }

  /* Percentage-point move over `sessions` closes, ending at the last close on
   * or before `refDay` (the newest close when refDay is omitted). NaN when
   * the series is too short. */
  function changeOver(series, sessions, refDay) {
    if (!series || !series.length) return NaN;
    var i = series.length - 1;
    if (refDay) while (i >= 0 && series[i].date > refDay) i--;
    var j = i - sessions;
    if (i < 0 || j < 0) return NaN;
    var a = series[j].price, b = series[i].price;
    return isNum(a) && isNum(b) && a > 0 ? (b / a - 1) * 100 : NaN;
  }

  /* The five-session move the weekly picks rank on. */
  function weekChange(series, refDay) { return changeOver(series, 5, refDay); }

  /* One line of stocks.json. */
  function row(symbol, series) {
    var last = series && series.length ? series[series.length - 1] : null;
    if (!last) return null;
    function pct(n) { var v = changeOver(series, n); return isNum(v) ? round(v, 4) : null; }
    return {
      symbol: symbol,
      name: nameFor(symbol),
      close: last.price,
      date: last.date,
      change1d: pct(1),
      change5d: pct(5),
      change1m: pct(21)
    };
  }

  /* stocks.json from the rows in hand. Rows for symbols no longer listed are
   * dropped. `complete` once COMPLETE_SHARE of the symbols that can be asked
   * for (the list less plan denials) are priced for the session. */
  function summary(rowsBySymbol, session, deniedCount, generatedAt) {
    var rows = UNIVERSE.map(function (s) { return rowsBySymbol[s.symbol]; }).filter(Boolean);
    var priced = rows.filter(function (r) { return r.date >= session; }).length;
    var askable = UNIVERSE.length - (deniedCount || 0);
    return {
      version: 1,
      generatedAt: generatedAt,
      session: session,
      listAsOf: AS_OF,
      count: { listed: UNIVERSE.length, priced: priced, denied: deniedCount || 0 },
      complete: askable > 0 && priced >= Math.ceil(askable * COMPLETE_SHARE),
      rows: rows
    };
  }

  /* ---- errors ---------------------------------------------------------------- */

  /* FMP's answers, by kind. The daily limit stops the step for the run; a
   * plan denial parks the symbol for DENY_RETRY_MS; anything else is a
   * failure retried later the same session. */
  function classify(err) {
    var status = err && err.status;
    var text = String((err && err.message) || err || '');
    if (status === 429 || /limit reach/i.test(text)) return 'limit';
    if (status === 402 || status === 403 || /premium|subscription|not available under|special endpoint|upgrade/i.test(text)) return 'denied';
    return 'failed';
  }

  MP.universe = {
    AS_OF: AS_OF,
    LIST_SOURCE: LIST_SOURCE,
    LIST: LIST,
    inIndex: inIndex,
    MAJORS: MAJORS,
    UNIVERSE: UNIVERSE,
    PER_RUN: PER_RUN,
    FULL_DAYS: FULL_DAYS,
    OVERLAP_DAYS: OVERLAP_DAYS,
    MAX_SESSIONS: MAX_SESSIONS,
    DENY_RETRY_MS: DENY_RETRY_MS,
    FAIL_RETRY_MS: FAIL_RETRY_MS,
    MAX_TRIES: MAX_TRIES,
    COMPLETE_SHARE: COMPLETE_SHARE,
    nameFor: nameFor,
    listed: listed,
    listAge: listAge,
    planUniverse: planUniverse,
    fromDay: fromDay,
    mergeSeries: mergeSeries,
    stockFile: stockFile,
    readCloses: readCloses,
    changeOver: changeOver,
    weekChange: weekChange,
    row: row,
    summary: summary,
    classify: classify
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
