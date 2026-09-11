/* ============================================================================
 * pipeline.js: the scheduled data job's logic, runtime-agnostic.
 *
 * Runs inside GitHub Actions through scripts/update-data.js, which supplies
 * fetch, the environment and file access. It holds no Node APIs, so the debug
 * bundle drives this same code against canned payloads in a browser (see
 * test/data.test.js). Not part of the published page.
 *
 * Each run works out what is due, so a skipped or late cron tick heals on the
 * next one. In run order:
 *   history    once per session, an hour after the close: ^IXIC, ^GSPC and
 *              BTCUSD daily closes from FMP, QQQ daily closes from Alpha
 *              Vantage.
 *   findings   whenever history is rewritten (or missing for the session):
 *              the write-up's statistics, computed here from that history
 *              with MP.findings. No calls at all.
 *   universe   after each close, once the index's daily bar is in: the
 *              Nasdaq-100 members' daily closes, one FMP call per member and
 *              at most MP.universe.PER_RUN per run, so a full pass takes three
 *              runs. Plan denials are parked for 35 days (see universe.js).
 *              Writes stocks.json, stocks/SYM.json and the job.json ledger.
 *   movers     once a week: the highest and lowest five-session move among
 *              the members, read from stocks.json once a pass is complete for
 *              a session at or after the week's start. No calls. The crypto
 *              movers come from one keyless CoinGecko coins/markets call over
 *              a fixed universe (seven-day move). Writes spotlight.json.
 *   quotes     every run while the market is open, then one final read after
 *              the close. ^IXIC and ^GSPC from FMP each run, the two stock
 *              movers every other run, and QQQ from Alpha Vantage at most
 *              hourly, because its free tier allows 25 calls a day.
 *   note       once per session after its final quote read: a three-sentence
 *              reading of the figures, written by Claude when a key is set
 *              and checked by MP.note.validate, else the fixed template.
 *              One Messages API call a trading day, plus one retry at most.
 *
 * Budget on the free plans, per weekday: about 190 FMP calls of 250 (index
 * quotes about 56, mover quotes about 28, members about 100, history 3) and
 * 10 Alpha Vantage calls of 25.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var FMP_BASE = 'https://financialmodelingprep.com/stable';
  var AV_BASE = 'https://www.alphavantage.co/query';

  var HISTORY_DAYS = 400;            /* ≈ 275 sessions: the 252-session window plus slack */
  var CLOSE_GRACE_MIN = 20;          /* final quote read after the close */
  var EOD_GRACE_MIN = 60;            /* daily bars settle a little later */
  var EOD_RETRY_MS = 2 * 3600000;    /* re-ask for a late daily bar at most every 2h */
  var SCAN_RETRY_MS = 3 * 3600000;   /* a failed weekly crypto scan retries at most every 3h */
  var AV_QUOTE_EVERY_MS = 55 * 60000;
  var PICK_QUOTE_EVERY_MS = 25 * 60000;   /* the stock movers' quotes: every other 15-minute run */
  var MOVERS_HISTORY_KEEP = 24;      /* twelve weeks of stocks and crypto */
  var LEGACY_SERIES_SESSIONS = 100;  /* the chart older pages draw for the stock pick */
  var MIN_USABLE_SCAN = 3;           /* fewer priced names than this keeps the old movers */
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
    return String(text)
      .replace(/(apikey=)[^&\s"']+/gi, '$1***')
      .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***');
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

  /* ---- spotlight.json -------------------------------------------------------- */

  /* Version 2 holds the week's movers: { stocks, crypto, history }. A file
   * from before it held one "stock of the week" and one "crypto of the week",
   * chosen by absolute move; those picks join the history tagged with that
   * rule, and the movers are worked out afresh. */
  function readSpotlight(p) {
    var empty = { stocks: null, crypto: null, history: [] };
    if (!p || typeof p !== 'object') {
      return { movers: empty, cryptoTriedWeek: null, cryptoTriedAt: null, migrated: false };
    }
    if (p.version === 2 && p.movers && typeof p.movers === 'object') {
      return {
        movers: {
          stocks: p.movers.stocks || null,
          crypto: p.movers.crypto || null,
          history: Array.isArray(p.movers.history) ? p.movers.history.slice() : []
        },
        cryptoTriedWeek: p.cryptoTriedWeek || null,
        cryptoTriedAt: p.cryptoTriedAt || null,
        migrated: false
      };
    }
    var history = [];
    (Array.isArray(p.history) ? p.history : []).forEach(function (h) {
      if (h && h.symbol && h.weekOf) {
        history.push({ weekOf: h.weekOf, kind: 'stocks', rule: 'absolute', mover: { symbol: h.symbol, change: h.changePct5d }, loser: null });
      }
    });
    (Array.isArray(p.cryptoHistory) ? p.cryptoHistory : []).forEach(function (h) {
      if (h && h.symbol && h.weekOf) {
        history.push({ weekOf: h.weekOf, kind: 'crypto', rule: 'absolute', mover: { symbol: h.symbol, id: h.id || null, change: h.changePct7d }, loser: null });
      }
    });
    return { movers: { stocks: null, crypto: null, history: sortHistory(history) }, cryptoTriedWeek: null, cryptoTriedAt: null, migrated: true };
  }

  function sortHistory(history) {
    return history.slice().sort(function (a, b) {
      return a.weekOf < b.weekOf ? 1 : a.weekOf > b.weekOf ? -1 : 0;
    }).slice(0, MOVERS_HISTORY_KEEP);
  }

  function historyEntry(e) {
    if (!e) return null;
    var out = { symbol: e.symbol, change: e.change };
    if (e.id) out.id = e.id;
    return out;
  }

  /* This week's movers of one kind replace any earlier entry for the week. */
  function addHistory(history, week, kind, set) {
    var entry = { weekOf: week, kind: kind, rule: 'gain-drop', mover: historyEntry(set.mover), loser: historyEntry(set.loser) };
    return sortHistory([entry].concat(history.filter(function (h) { return !(h && h.weekOf === week && h.kind === kind); })));
  }

  /* The fields pages built before version 2 read: the stock mover stands in
   * as the stock of the week, the crypto mover as the crypto of the week.
   * Kept for two weeks after the change, then dropped. */
  function legacyFields(movers, stockRows, moverCloses) {
    var ms = movers.stocks, mc = movers.crypto;
    var row = ms && stockRows ? stockRows.filter(function (r) { return r && r.symbol === ms.mover.symbol; })[0] : null;
    function next(set, key) {
      var n = set && set.moverNext;
      if (!n) return null;
      var o = { symbol: n.symbol };
      o[key] = n.change;
      if (n.id) o.id = n.id;
      return o;
    }
    return {
      current: ms ? {
        weekOf: ms.weekOf, symbol: ms.mover.symbol, name: ms.mover.name, changePct5d: ms.mover.change,
        direction: ms.mover.change >= 0 ? 'up' : 'down', scanned: ms.scanned, skipped: ms.skipped,
        runnerUp: next(ms, 'changePct5d'), rule: ms.rule, source: ms.source, computedAt: ms.computedAt
      } : null,
      history: movers.history.filter(function (h) { return h.kind === 'stocks' && h.mover; }).map(function (h) {
        return { weekOf: h.weekOf, symbol: h.mover.symbol, changePct5d: h.mover.change };
      }),
      change: row ? { symbol: row.symbol, d1: row.change1d, d5: row.change5d, m1: row.change1m } : null,
      series: moverCloses ? moverCloses.slice(-LEGACY_SERIES_SESSIONS) : null,
      crypto: mc ? {
        weekOf: mc.weekOf, id: mc.mover.id || null, symbol: mc.mover.symbol, name: mc.mover.name, changePct7d: mc.mover.change,
        direction: mc.mover.change >= 0 ? 'up' : 'down', scanned: mc.scanned, skipped: mc.skipped,
        runnerUp: next(mc, 'changePct7d'), rule: mc.rule, source: mc.source, computedAt: mc.computedAt
      } : null,
      cryptoHistory: movers.history.filter(function (h) { return h.kind === 'crypto' && h.mover; }).map(function (h) {
        return { weekOf: h.weekOf, id: h.mover.id || null, symbol: h.mover.symbol, changePct7d: h.mover.change };
      })
    };
  }

  /* opts: { now, env, fetchJson(url) -> Promise<payload>, read(name) -> object|null,
   * askClaude? }. Names are 'quotes', 'history' and so on, and 'stocks/SYM'
   * for one member's closes. Resolves to { out: { name: snapshot }, calls,
   * failed, warnings, log, skipped }. Only snapshots present in `out` should
   * be written. */
  async function run(opts) {
    var SRC = MP.sources, SES = MP.session, SP = MP.spotlight, U = MP.universe;
    var now = opts.now === undefined ? Date.now() : opts.now;
    var env = opts.env || {};
    var force = String(env.FORCE || '').toLowerCase();
    var fmpKey = env.FMP_API_KEY || '';
    var avKey = env.ALPHAVANTAGE_API_KEY || '';
    var claudeKey = env.ANTHROPIC_API_KEY || '';   /* optional: the daily reading */
    var nowIso = new Date(now).toISOString();
    var today = SRC.isoDay(new Date(now));

    var calls = { fmp: 0, av: 0, cg: 0, claude: 0 };
    var failed = { fmp: 0, av: 0, cg: 0, claude: 0 };
    var warnings = [];
    var log = [];   /* plain progress lines for the run's output */
    var out = {};
    var result = { out: out, calls: calls, failed: failed, warnings: warnings, log: log, skipped: null };

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

    function fmpDaily(symbol, fromDay) {
      return attempt(symbol + ' daily closes', async function () {
        return SRC.normalizeEodLight(await get('fmp', fmpUrl('historical-price-eod/light',
          { symbol: symbol, from: fromDay, to: today }, fmpKey)));
      });
    }

    var prev = {
      spotlight: opts.read('spotlight') || null,
      quotes: opts.read('quotes') || {},
      history: opts.read('history') || {},
      findings: opts.read('findings') || null,
      note: opts.read('note') || null,
      stocks: opts.read('stocks') || null,
      job: opts.read('job') || null
    };
    var session = SES.status(now);
    var closeSession = SES.lastCompletedSession(now, CLOSE_GRACE_MIN);
    var eodSession = SES.lastCompletedSession(now, EOD_GRACE_MIN);
    var week = SP.weekOf(new Date(now));

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

    /* ---- findings: the write-up's numbers, from the history --------------- */
    var histNow = out.history || prev.history;
    var findingsDue = !!out.history || force === 'all' || force === 'findings' ||
      !prev.findings || prev.findings.forSession !== eodSession;
    if (findingsDue && MP.findings) {
      var findings = histNow && histNow.btc && histNow.ixic ? MP.findings.compute(histNow, now) : null;
      if (findings) {
        out.findings = Object.assign(findings, { generatedAt: nowIso, forSession: eodSession });
      } else if (out.history || !prev.findings) {
        warnings.push('findings: not enough daily history yet');
      }
    }

    /* ---- the Nasdaq-100: daily closes, a slice per run -------------------- */
    /* After each close, once the index's own daily bar is in (so FMP has
     * published the session), up to MP.universe.PER_RUN members are fetched
     * per run until every member has that session's close. FORCE=universe
     * asks for all of them in one run, plan denials included. */
    var forceUniverse = force === 'universe';
    if (U && (forceUniverse || lastDate((histNow || {}).ixic) >= eodSession)) {
      var jobPrev = prev.job && prev.job.universe ? prev.job.universe : {};
      var ledger = {};
      Object.keys(jobPrev.symbols || {}).forEach(function (s) {
        if (U.listed(s)) ledger[s] = jobPrev.symbols[s];
      });
      var budget = forceUniverse ? Infinity : U.PER_RUN;
      var plan = U.planUniverse(ledger, eodSession, now, { limit: budget, force: forceUniverse });

      if (plan.due.length) {
        var spent = 0, fetched = 0, deniedNow = [], failedNow = [], rebased = [], stopped = null;
        var rowsBy = {};
        ((prev.stocks && prev.stocks.rows) || []).forEach(function (r) { if (r && r.symbol) rowsBy[r.symbol] = r; });

        var closesFor = async function (s, fromDate) {
          spent += 1;
          try {
            var rows = SRC.normalizeEodLight(await get('fmp', fmpUrl('historical-price-eod/light',
              { symbol: s, from: fromDate, to: today }, fmpKey)));
            return rows ? { series: rows } : { error: new Error('no closes in the response'), kind: 'failed' };
          } catch (err) {
            return { error: err, kind: U.classify(err) };
          }
        };
        var why = function (res) { return redact(res.error && res.error.message ? res.error.message : res.error).slice(0, 160); };

        for (var u = 0; u < plan.due.length && spent < budget; u++) {
          var s = plan.due[u];
          var entry = ledger[s] || {};
          var stored = U.readCloses(opts.read('stocks/' + s));
          var res = await closesFor(s, U.fromDay(stored, now, entry.full));
          if (res.kind === 'limit') { stopped = why(res); break; }
          if (res.kind === 'denied') {
            ledger[s] = { deniedAt: now, at: now, reason: why(res) };
            deniedNow.push(s);
            continue;
          }
          if (res.error) {
            ledger[s] = { failedFor: eodSession, tries: entry.failedFor === eodSession ? (entry.tries || 1) + 1 : 1, at: now, reason: why(res) };
            failedNow.push(s);
            continue;
          }

          var merged = U.mergeSeries(stored, res.series);
          if (merged.mismatch) {
            /* FMP re-based the history (a split): the stored closes cannot be
             * spliced onto it, so fetch the whole series again, now if the
             * budget allows, otherwise first thing next run. */
            var full = spent < budget ? await closesFor(s, U.fromDay(null, now, true)) : null;
            if (full && full.kind === 'limit') stopped = why(full);
            if (!full || full.error) {
              ledger[s] = Object.assign({}, entry, { full: true, at: now });
              if (stopped) break;
              continue;
            }
            merged = U.mergeSeries(null, full.series);
            rebased.push(s);
          }

          out['stocks/' + s] = U.stockFile(s, merged.series, nowIso);
          rowsBy[s] = U.row(s, merged.series);
          ledger[s] = { checkedFor: eodSession, last: lastDate(merged.series), at: now };
          fetched += 1;
        }

        var deniedAll = Object.keys(ledger).filter(function (k) {
          return ledger[k].deniedAt && now - ledger[k].deniedAt < U.DENY_RETRY_MS;
        });
        out.stocks = U.summary(rowsBy, eodSession, deniedAll.length, nowIso);
        out.job = {
          generatedAt: nowIso,
          universe: {
            listAsOf: U.AS_OF,
            listSource: U.LIST_SOURCE,
            session: eodSession,
            symbols: ledger,
            lastRun: { at: now, calls: spent, fetched: fetched, denied: deniedNow, failed: failedNow, rebased: rebased, stopped: stopped }
          }
        };

        var cnt = out.stocks.count;
        log.push('universe: ' + fetched + ' fetched this run; ' + cnt.priced + ' of ' + cnt.listed + ' priced for ' +
          eodSession + ', ' + cnt.denied + ' not on this plan' + (out.stocks.complete ? ', complete' : ''));
        if (deniedNow.length) warnings.push('universe: not on this FMP plan, asked again in 35 days: ' + deniedNow.join(', '));
        if (failedNow.length) warnings.push('universe: failed, retried later: ' + failedNow.join(', '));
        if (rebased.length) warnings.push('universe: stored closes disagreed with FMP (a split?), refetched in full: ' + rebased.join(', '));
        if (stopped) warnings.push('universe: FMP answered with its daily limit, so the step stopped for this run (' + stopped + ')');
        var age = U.listAge(now);
        if (age.stale) warnings.push('universe: the Nasdaq-100 list in src/lib/universe.js is ' + age.days + ' days old; refresh it from nasdaq.com');
      }
    }

    /* ---- the week's movers ------------------------------------------------ */
    var spot = readSpotlight(prev.spotlight);
    var movers = spot.movers;
    var spotDue = spot.migrated || force === 'all' || force === 'spotlight';
    var forceSpot = force === 'all' || force === 'spotlight';

    /* Stocks: from a complete pass over the members, measured to a session
     * at or after the last one before this week began, so Monday's movers
     * describe the week just ended. */
    var stocksNow = out.stocks || prev.stocks || null;
    var stocksReady = !!stocksNow && stocksNow.complete === true && typeof stocksNow.session === 'string' &&
      stocksNow.session >= SES.sessionBefore(week);
    if (stocksReady && (forceSpot || !movers.stocks || movers.stocks.weekOf !== week)) {
      var measured = stocksNow.session;
      var pickS = SP.selectMovers((stocksNow.rows || []).map(function (r) {
        return { symbol: r.symbol, name: r.name, change5d: r.date === measured ? r.change5d : NaN };
      }), 'change5d');
      if (pickS && pickS.scanned >= MIN_USABLE_SCAN) {
        movers.stocks = Object.assign({
          weekOf: week,
          measuredTo: measured,
          listed: stocksNow.count ? stocksNow.count.listed : null
        }, pickS, { rule: SP.STOCK_RULE, source: 'FMP daily closes', computedAt: nowIso });
        movers.history = addHistory(movers.history, week, 'stocks', movers.stocks);
        spotDue = true;
      } else {
        warnings.push('stock movers: only ' + (pickS ? pickS.scanned : 0) + ' members priced for ' + measured + ', so the previous movers stand');
      }
    }

    /* Crypto: one keyless CoinGecko call a week over the fixed universe. */
    var cryptoTried = { week: spot.cryptoTriedWeek, at: spot.cryptoTriedAt };
    var cryptoDue = forceSpot ||
      ((!movers.crypto || movers.crypto.weekOf !== week) && (spot.cryptoTriedWeek !== week || now - (spot.cryptoTriedAt || 0) >= SCAN_RETRY_MS));
    if (cryptoDue) {
      var scanSpec = SRC.coinsMarkets(SP.CRYPTO_UNIVERSE.map(function (c) { return c.id; }), { sparkline: false });
      var markets = await attempt('crypto scan', async function () {
        return scanSpec.normalize(await get('cg', scanSpec.url));
      });
      cryptoTried = { week: week, at: now };
      spotDue = true;

      var pickC = SP.selectMovers(SP.CRYPTO_UNIVERSE.map(function (c) {
        var m = markets && markets[c.id];
        return { id: c.id, symbol: c.symbol, name: c.name, changePct7d: m ? m.change7d : NaN };
      }), 'changePct7d');
      if (pickC && pickC.scanned >= MIN_USABLE_SCAN) {
        movers.crypto = Object.assign({ weekOf: week }, pickC, {
          rule: SP.CRYPTO_RULE, source: 'CoinGecko coins/markets 7d', computedAt: nowIso
        });
        movers.history = addHistory(movers.history, week, 'crypto', movers.crypto);
      } else {
        warnings.push('crypto scan: only ' + (pickC ? pickC.scanned : 0) + ' usable coins, so the previous movers stand');
      }
    }

    /* Older pages chart the stock mover from spotlight.json, so its closes
     * are copied in whenever the mover's own file changes. */
    var moverSym = movers.stocks && movers.stocks.mover ? movers.stocks.mover.symbol : null;
    if (moverSym && out['stocks/' + moverSym]) spotDue = true;

    if (spotDue) {
      var moverCloses = moverSym && U ? U.readCloses(out['stocks/' + moverSym] || opts.read('stocks/' + moverSym)) : null;
      out.spotlight = Object.assign({
        version: 2,
        generatedAt: nowIso,
        weekOf: week,
        movers: movers,
        cryptoTriedWeek: cryptoTried.week || null,
        cryptoTriedAt: cryptoTried.at || null
      }, legacyFields(movers, stocksNow ? stocksNow.rows : null, moverCloses));
    }

    /* ---- quotes ----------------------------------------------------------- */
    var q = prev.quotes;
    var quotesDue = force === 'all' || force === 'quotes' || session.open || q.finalFor !== closeSession;

    if (quotesDue) {
      var ixic = await fmpQuote('^IXIC');
      var spx = await fmpQuote('^GSPC');

      /* The stock movers: every other run while open, and in every read
       * while closed (the final read, a pre-market read). */
      var ms = movers.stocks;
      var oldPicks = q.picks || {};
      var samePicks = !!ms && !!oldPicks.mover && oldPicks.mover.symbol === ms.mover.symbol &&
        (!ms.loser || (!!oldPicks.loser && oldPicks.loser.symbol === ms.loser.symbol));
      var picks = samePicks ? oldPicks : null;
      var picksDue = !!ms && (!samePicks || !session.open || force === 'all' || force === 'quotes' ||
        now - (oldPicks.fetchedAt || 0) >= PICK_QUOTE_EVERY_MS);
      if (picksDue) {
        var mq = await fmpQuote(ms.mover.symbol);
        var lq = ms.loser ? await fmpQuote(ms.loser.symbol) : null;
        picks = {
          fetchedAt: now,
          mover: mq ? stamp(mq) : (samePicks ? oldPicks.mover : null),
          loser: lq ? stamp(lq) : (samePicks ? oldPicks.loser : null)
        };
      }

      var qqq = avKey ? (q.qqq || null) : null;
      var qqqDue = avKey && (!q.qqq || !session.open || now - (q.qqq.fetchedAt || 0) >= AV_QUOTE_EVERY_MS);
      if (qqqDue) {
        var freshQqq = await attempt('QQQ quote', async function () {
          return SRC.normalizeAvQuote(await get('av', avUrl({ function: 'GLOBAL_QUOTE', symbol: 'QQQ' }, avKey)));
        });
        if (freshQqq) qqq = stamp(freshQqq);
      }

      out.quotes = {
        generatedAt: nowIso,
        /* A closed-market read counts as that session's final only if it landed. */
        finalFor: !session.open && ixic ? closeSession : (q.finalFor || null),
        ixic: ixic ? stamp(ixic) : (q.ixic || null),
        spx: spx ? stamp(spx) : (q.spx || null),
        qqq: qqq,
        picks: picks,
        /* read by pages built before spotlight.json version 2 */
        spotlight: picks && picks.mover ? picks.mover : null
      };
    }

    /* ---- the daily reading ------------------------------------------------ */
    /* Once per completed session, and only once that session's final quote
     * read has landed, so it never describes stale index figures. Claude
     * writes it when ANTHROPIC_API_KEY is set and opts.askClaude is supplied
     * (the Node entry point does; the tests pass a stand-in). A reply that
     * fails MP.note.validate is not published: the fixed template is. */
    var quotesNow = out.quotes || prev.quotes || {};
    var findingsNow = out.findings || prev.findings || null;
    var noteDue = !!MP.note && MP.note.due(prev.note, now, eodSession, force) &&
      (force === 'all' || force === 'note' || quotesNow.finalFor === eodSession);

    if (noteDue) {
      var coinSpec = SRC.coinsMarkets(['bitcoin', 'ethereum'], { sparkline: false });
      var coins = await attempt('reading coin quotes', async function () {
        return coinSpec.normalize(await get('cg', coinSpec.url));
      });
      var noteInputs = MP.note.inputs({
        session: eodSession, quotes: quotesNow, coins: coins, findings: findingsNow, movers: movers
      });
      var sameSession = prev.note && prev.note.forSession === eodSession;
      var note = {
        generatedAt: nowIso,
        forSession: eodSession,
        promptVersion: MP.note.PROMPT_VERSION,
        source: 'fallback',
        model: null,
        text: null,
        inputs: noteInputs,
        attempts: sameSession ? (prev.note.attempts || 1) + 1 : 1
      };

      if (claudeKey && typeof opts.askClaude === 'function') {
        var ask = MP.note.buildRequest(noteInputs);
        var reply = null, reason = null;
        calls.claude += 1;
        try {
          reply = await opts.askClaude({ system: ask.system, user: ask.user, model: MP.note.MODEL, maxTokens: MP.note.MAX_TOKENS });
        } catch (err) {
          failed.claude += 1;
          reason = 'request failed (' + redact(err && err.message ? err.message : err) + ')';
        }
        if (reply) {
          var parsed = MP.note.parse(reply);
          if (!parsed) {
            reason = 'no usable text in the reply';
          } else {
            var check = MP.note.validate(parsed.text);
            if (check.ok) {
              note.text = parsed.text;
              note.source = 'claude';
              note.model = parsed.model || MP.note.MODEL;
            } else {
              reason = check.reason;
            }
          }
        }
        if (reason) {
          note.invalidReason = reason;
          warnings.push('daily note: ' + reason + '; using the fallback');
        }
      }
      if (!note.text) note.text = MP.note.fallback(findingsNow, noteInputs);
      out.note = note;
    }

    return result;
  }

  MP.pipeline = {
    run: run,
    redact: redact,
    fmpUrl: fmpUrl,
    avUrl: avUrl,
    readSpotlight: readSpotlight,
    config: {
      HISTORY_DAYS: HISTORY_DAYS,
      CLOSE_GRACE_MIN: CLOSE_GRACE_MIN,
      EOD_GRACE_MIN: EOD_GRACE_MIN,
      AV_QUOTE_EVERY_MS: AV_QUOTE_EVERY_MS,
      PICK_QUOTE_EVERY_MS: PICK_QUOTE_EVERY_MS
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
