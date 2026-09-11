/* ============================================================================
 * pipeline.js — the scheduled data job's logic, runtime-agnostic.
 *
 * Runs inside GitHub Actions through scripts/update-data.js, which supplies
 * fetch, the environment and file access. It holds no Node APIs, so the debug
 * bundle drives this same code against canned payloads in a browser (see
 * test/data.test.js). Not part of the published page.
 *
 * Each run works out what is due, so a skipped or late cron tick heals on the
 * next one:
 *   spotlight  once a week: FMP stock-price-change across the fixed universe,
 *              largest absolute five-session move wins (the MP.spotlight
 *              rule). The pick's daily closes refresh once per session. The
 *              crypto of the week is scanned the same way from one keyless
 *              CoinGecko coins/markets call (largest absolute 7-day move).
 *   quotes     every run while the market is open, then one final read after
 *              the close. ^IXIC, ^GSPC and the spotlight name from FMP; QQQ
 *              from Alpha Vantage at most hourly, because its free tier
 *              allows 25 calls a day.
 *   history    once per session, an hour after the close: ^IXIC, ^GSPC and
 *              BTCUSD daily closes from FMP, QQQ daily closes from Alpha
 *              Vantage.
 *
 * Budget on the free plans, per weekday: about 90 FMP calls of 250 and 10
 * Alpha Vantage calls of 25.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var FMP_BASE = 'https://financialmodelingprep.com/stable';
  var AV_BASE = 'https://www.alphavantage.co/query';

  var HISTORY_DAYS = 400;            /* ≈ 275 sessions: the 252-session window plus slack */
  var SPOTLIGHT_SERIES_DAYS = 150;   /* ≈ 100 sessions for the pick's chart */
  var CLOSE_GRACE_MIN = 20;          /* final quote read after the close */
  var EOD_GRACE_MIN = 60;            /* daily bars settle a little later */
  var EOD_RETRY_MS = 2 * 3600000;    /* re-ask for a late daily bar at most every 2h */
  var SCAN_RETRY_MS = 3 * 3600000;   /* a failed weekly scan retries at most every 3h */
  var AV_QUOTE_EVERY_MS = 55 * 60000;
  var SPOTLIGHT_HISTORY_KEEP = 12;
  var MIN_USABLE_SCAN = 3;           /* fewer priced names than this keeps the old pick */
  var DAY_MS = 86400000;

  function query(params) {
    return Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
  }

  function fmpUrl(endpoint, params, key) {
    return FMP_BASE + '/' + endpoint + '?' + query(Object.assign({}, params, { apikey: key }));
  }

  function avUrl(params, key) {
    return AV_BASE + '?' + query(Object.assign({}, params, { apikey: key }));
  }

  /* Keys must never reach a log line or an Actions annotation. */
  function redact(text) {
    return String(text).replace(/(apikey=)[^&\s"']+/gi, '$1***');
  }

  /* FMP reports plan denials and bad keys as {"Error Message": ...}; Alpha
   * Vantage reports rate limits as {"Information": ...} or {"Note": ...}.
   * Both can arrive with HTTP 200. */
  function upstreamMessage(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    var cg = payload.status && payload.status.error_message;   /* CoinGecko */
    return payload['Error Message'] || payload.Information || payload.Note || cg || null;
  }

  function lastDate(series) {
    return series && series.length ? series[series.length - 1].date : '';
  }

  /* opts: { now, env, fetchJson(url) -> Promise<payload>, read(name) -> object|null }
   * Resolves to { out: { spotlight?, quotes?, history? }, calls, failed,
   * warnings, skipped }. Only snapshots present in `out` should be written. */
  async function run(opts) {
    var SRC = MP.sources, SES = MP.session, SP = MP.spotlight;
    var now = opts.now === undefined ? Date.now() : opts.now;
    var env = opts.env || {};
    var force = String(env.FORCE || '').toLowerCase();
    var fmpKey = env.FMP_API_KEY || '';
    var avKey = env.ALPHAVANTAGE_API_KEY || '';
    var nowIso = new Date(now).toISOString();
    var today = SRC.isoDay(new Date(now));

    var calls = { fmp: 0, av: 0, cg: 0 };
    var failed = { fmp: 0, av: 0, cg: 0 };
    var warnings = [];
    var out = {};
    var result = { out: out, calls: calls, failed: failed, warnings: warnings, skipped: null };

    if (!fmpKey) {
      result.skipped = 'FMP_API_KEY is not set, so no market data was fetched. ' +
        'Add it under Settings → Secrets and variables → Actions.';
      return result;
    }

    async function get(source, url) {
      calls[source] += 1;
      var payload;
      try {
        payload = await opts.fetchJson(url);
      } catch (err) {
        failed[source] += 1;
        throw err;
      }
      var msg = upstreamMessage(payload);
      if (msg) {
        failed[source] += 1;
        throw new Error(String(msg));
      }
      return payload;
    }

    /* One failing step never sinks the run: it is recorded as a warning and
     * the previous value stands. */
    async function attempt(label, fn) {
      try {
        var value = await fn();
        if (value === null || value === undefined) {
          warnings.push(label + ': response had no usable data');
          return null;
        }
        return value;
      } catch (err) {
        warnings.push(label + ': ' + redact(err && err.message ? err.message : err));
        return null;
      }
    }

    function stamp(quote) {
      return Object.assign({}, quote, { fetchedAt: now });
    }

    function fmpQuote(symbol) {
      return attempt(symbol + ' quote', async function () {
        return SRC.normalizeFmpQuote(await get('fmp', fmpUrl('quote', { symbol: symbol }, fmpKey)));
      });
    }

    function fmpChange(symbol) {
      return attempt(symbol + ' price change', async function () {
        return SRC.normalizeQuoteChange(await get('fmp', fmpUrl('stock-price-change', { symbol: symbol }, fmpKey)));
      });
    }

    function fmpDaily(symbol, fromDay) {
      return attempt(symbol + ' daily closes', async function () {
        return SRC.normalizeEodLight(await get('fmp', fmpUrl('historical-price-eod/light',
          { symbol: symbol, from: fromDay, to: today }, fmpKey)));
      });
    }

    var prev = {
      spotlight: opts.read('spotlight') || {},
      quotes: opts.read('quotes') || {},
      history: opts.read('history') || {}
    };
    var session = SES.status(now);
    var closeSession = SES.lastCompletedSession(now, CLOSE_GRACE_MIN);
    var eodSession = SES.lastCompletedSession(now, EOD_GRACE_MIN);

    /* ---- spotlight: weekly scan ------------------------------------------- */
    var spot = prev.spotlight;
    var week = SP.weekOf(new Date(now));
    var current = spot.current && spot.current.symbol ? spot.current : null;
    var needsScan = !current || current.weekOf !== week;
    var scanDue = force === 'all' || force === 'spotlight' ||
      (needsScan && (spot.scanTriedWeek !== week || now - (spot.scanTriedAt || 0) >= SCAN_RETRY_MS));
    var spotHistory = Array.isArray(spot.history) ? spot.history.slice() : [];
    var scanChanges = {};
    var scanTried = { week: spot.scanTriedWeek || null, at: spot.scanTriedAt || null };
    var pickChanged = false;

    if (scanDue) {
      var rows = [];
      for (var i = 0; i < SP.UNIVERSE.length; i++) {
        var symbol = SP.UNIVERSE[i].symbol;
        var change = await fmpChange(symbol);
        if (change) scanChanges[symbol] = change;
        rows.push({ symbol: symbol, changePct5d: change ? change.d5 : NaN });
      }
      scanTried = { week: week, at: now };

      var pick = SP.selectSpotlight(rows);
      if (pick && pick.scanned >= MIN_USABLE_SCAN) {
        pickChanged = !current || current.symbol !== pick.symbol || current.weekOf !== week;
        current = {
          weekOf: week,
          symbol: pick.symbol,
          name: SP.nameFor(pick.symbol),
          changePct5d: pick.changePct5d,
          direction: pick.direction,
          scanned: pick.scanned,
          skipped: pick.skipped,
          runnerUp: pick.runnerUp,
          rule: pick.rule,
          source: 'FMP stock-price-change 5D',
          computedAt: nowIso
        };
        spotHistory = [{ weekOf: week, symbol: pick.symbol, changePct5d: pick.changePct5d }]
          .concat(spotHistory.filter(function (h) { return h && h.weekOf !== week; }))
          .slice(0, SPOTLIGHT_HISTORY_KEEP);
      } else {
        warnings.push('spotlight scan: only ' + (pick ? pick.scanned : 0) +
          ' usable quotes, so the previous pick stands');
      }
    }

    /* ---- spotlight: the pick's detail, once per session ------------------- */
    var detail = { change: spot.change || null, series: spot.series || null, detailFor: spot.detailFor || null };
    var detailDue = !!current && (pickChanged || force === 'all' || force === 'spotlight' ||
      spot.detailFor !== eodSession);

    if (detailDue) {
      var sym = current.symbol;
      var sameSymbol = detail.change && detail.change.symbol === sym;
      var freshChange = scanChanges[sym] || await fmpChange(sym);
      var fromDay = SRC.isoDay(new Date(now - SPOTLIGHT_SERIES_DAYS * DAY_MS));
      var freshSeries = await fmpDaily(sym, fromDay);
      detail = {
        change: freshChange || (sameSymbol ? detail.change : null),
        series: freshSeries || (sameSymbol ? detail.series : null),
        detailFor: eodSession
      };
    }

    /* ---- crypto of the week: weekly scan (CoinGecko, no key) -------------- */
    var crypto = spot.crypto && spot.crypto.id ? spot.crypto : null;
    var cryptoNeedsScan = !crypto || crypto.weekOf !== week;
    var cryptoDue = force === 'all' || force === 'spotlight' ||
      (cryptoNeedsScan && (spot.cryptoTriedWeek !== week || now - (spot.cryptoTriedAt || 0) >= SCAN_RETRY_MS));
    var cryptoHistory = Array.isArray(spot.cryptoHistory) ? spot.cryptoHistory.slice() : [];
    var cryptoTried = { week: spot.cryptoTriedWeek || null, at: spot.cryptoTriedAt || null };

    if (cryptoDue) {
      var scanSpec = SRC.coinsMarkets(SP.CRYPTO_UNIVERSE.map(function (c) { return c.id; }), { sparkline: false });
      var markets = await attempt('crypto scan', async function () {
        return scanSpec.normalize(await get('cg', scanSpec.url));
      });
      cryptoTried = { week: week, at: now };

      var cryptoRows = SP.CRYPTO_UNIVERSE.map(function (c) {
        var m = markets && markets[c.id];
        return { id: c.id, symbol: c.symbol, name: c.name, changePct7d: m ? m.change7d : NaN };
      });
      var cryptoPick = SP.selectCrypto(cryptoRows);
      if (cryptoPick && cryptoPick.scanned >= MIN_USABLE_SCAN) {
        crypto = Object.assign({ weekOf: week }, cryptoPick, {
          source: 'CoinGecko coins/markets 7d',
          computedAt: nowIso
        });
        cryptoHistory = [{ weekOf: week, id: cryptoPick.id, symbol: cryptoPick.symbol, changePct7d: cryptoPick.changePct7d }]
          .concat(cryptoHistory.filter(function (h) { return h && h.weekOf !== week; }))
          .slice(0, SPOTLIGHT_HISTORY_KEEP);
      } else {
        warnings.push('crypto scan: only ' + (cryptoPick ? cryptoPick.scanned : 0) +
          ' usable coins, so the previous pick stands');
      }
    }

    if (scanDue || detailDue || cryptoDue) {
      out.spotlight = {
        generatedAt: nowIso,
        current: current,
        history: spotHistory,
        change: detail.change,
        series: detail.series,
        detailFor: detail.detailFor,
        scanTriedWeek: scanTried.week,
        scanTriedAt: scanTried.at,
        crypto: crypto,
        cryptoHistory: cryptoHistory,
        cryptoTriedWeek: cryptoTried.week,
        cryptoTriedAt: cryptoTried.at
      };
    }

    /* ---- quotes ----------------------------------------------------------- */
    var q = prev.quotes;
    var quotesDue = force === 'all' || force === 'quotes' || session.open || q.finalFor !== closeSession;

    if (quotesDue) {
      var ixic = await fmpQuote('^IXIC');
      var spx = await fmpQuote('^GSPC');
      var pickQuote = current ? await fmpQuote(current.symbol) : null;

      var qqq = avKey ? (q.qqq || null) : null;
      var qqqDue = avKey && (!q.qqq || !session.open || now - (q.qqq.fetchedAt || 0) >= AV_QUOTE_EVERY_MS);
      if (qqqDue) {
        var freshQqq = await attempt('QQQ quote', async function () {
          return SRC.normalizeAvQuote(await get('av', avUrl({ function: 'GLOBAL_QUOTE', symbol: 'QQQ' }, avKey)));
        });
        if (freshQqq) qqq = stamp(freshQqq);
      }

      var keptPick = q.spotlight && current && q.spotlight.symbol === current.symbol ? q.spotlight : null;
      out.quotes = {
        generatedAt: nowIso,
        /* A closed-market read counts as that session's final only if it landed. */
        finalFor: !session.open && ixic ? closeSession : (q.finalFor || null),
        ixic: ixic ? stamp(ixic) : (q.ixic || null),
        spx: spx ? stamp(spx) : (q.spx || null),
        qqq: qqq,
        spotlight: pickQuote ? stamp(pickQuote) : keptPick
      };
    }

    /* ---- daily history ---------------------------------------------------- */
    var h = prev.history;
    var historyDue = force === 'all' || force === 'history' || h.checkedFor !== eodSession ||
      (lastDate(h.ixic) < eodSession && now - (h.fetchedAt || 0) >= EOD_RETRY_MS);

    if (historyDue) {
      var from = SRC.isoDay(new Date(now - HISTORY_DAYS * DAY_MS));
      var ixicDaily = await fmpDaily('^IXIC', from);
      var spxDaily = await fmpDaily('^GSPC', from);
      var btcDaily = await fmpDaily('BTCUSD', from);
      var qqqDaily = null;
      if (avKey) {
        qqqDaily = await attempt('QQQ daily closes', async function () {
          return SRC.normalizeAvDaily(await get('av', avUrl(
            { function: 'TIME_SERIES_DAILY', symbol: 'QQQ', outputsize: 'compact' }, avKey)));
        });
      }
      out.history = {
        generatedAt: nowIso,
        fetchedAt: now,
        checkedFor: eodSession,
        from: from,
        to: today,
        btc: btcDaily || h.btc || null,
        ixic: ixicDaily || h.ixic || null,
        spx: spxDaily || h.spx || null,
        qqq: avKey ? (qqqDaily || h.qqq || null) : null
      };
    }

    return result;
  }

  MP.pipeline = {
    run: run,
    redact: redact,
    fmpUrl: fmpUrl,
    avUrl: avUrl,
    config: {
      HISTORY_DAYS: HISTORY_DAYS,
      CLOSE_GRACE_MIN: CLOSE_GRACE_MIN,
      EOD_GRACE_MIN: EOD_GRACE_MIN,
      AV_QUOTE_EVERY_MS: AV_QUOTE_EVERY_MS
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
