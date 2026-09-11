/* ============================================================================
 * spotlight.js — "Stock of the Week": the pinned panel at the top of the page.
 *
 * Selection is mechanical and descriptive, never advisory: the largest
 * ABSOLUTE 5-session move across a fixed Nasdaq-100 universe. Absolute rather
 * than largest gain, so the panel reports what actually moved instead of
 * reading like a tip.
 *
 * The data job (src/lib/pipeline.js) runs the scan once a week with this
 * module's selectSpotlight() and publishes the pick, its daily closes and its
 * multi-horizon change in data/spotlight.json. The pick's quote refreshes with
 * the Nasdaq quotes in data/quotes.json, so the price is never as stale as
 * the pick.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});
  var S = MP.stats, F = MP.fmt, G = MP.geom;

  /* Fixed universe: large Nasdaq-100 constituents. A deliberate subset, not
   * the whole index — the panel says so rather than implying full coverage. */
  var UNIVERSE = [
    { symbol: 'AAPL', name: 'Apple Inc.' },
    { symbol: 'MSFT', name: 'Microsoft Corporation' },
    { symbol: 'NVDA', name: 'NVIDIA Corporation' },
    { symbol: 'AMZN', name: 'Amazon.com, Inc.' },
    { symbol: 'GOOGL', name: 'Alphabet Inc. Class A' },
    { symbol: 'META', name: 'Meta Platforms, Inc.' },
    { symbol: 'AVGO', name: 'Broadcom Inc.' },
    { symbol: 'TSLA', name: 'Tesla, Inc.' },
    { symbol: 'COST', name: 'Costco Wholesale Corporation' },
    { symbol: 'NFLX', name: 'Netflix, Inc.' },
    { symbol: 'AMD', name: 'Advanced Micro Devices, Inc.' },
    { symbol: 'ADBE', name: 'Adobe Inc.' },
    { symbol: 'CSCO', name: 'Cisco Systems, Inc.' },
    { symbol: 'PEP', name: 'PepsiCo, Inc.' },
    { symbol: 'INTC', name: 'Intel Corporation' }
  ];

  var RULE = 'Largest absolute 5-session move across a fixed 15-name Nasdaq-100 universe.';

  /* ---- pure selection ----------------------------------------------------- */

  /* rows: [{ symbol, changePct5d }] — entries with a non-finite change are
   * treated as unavailable (a plan denial, a dead symbol) and skipped.
   * Ties break on symbol so the same scan always yields the same winner. */
  function selectSpotlight(rows) {
    var usable = (rows || []).filter(function (r) {
      return r && typeof r.symbol === 'string' && S.isNum(r.changePct5d);
    });
    if (!usable.length) return null;

    var ranked = usable.slice().sort(function (a, b) {
      var d = Math.abs(b.changePct5d) - Math.abs(a.changePct5d);
      if (d !== 0) return d;
      return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
    });

    var win = ranked[0];
    var next = ranked[1] || null;
    return {
      symbol: win.symbol,
      changePct5d: win.changePct5d,
      direction: win.changePct5d >= 0 ? 'up' : 'down',
      scanned: usable.length,
      skipped: (rows || []).length - usable.length,
      runnerUp: next ? { symbol: next.symbol, changePct5d: next.changePct5d } : null,
      rule: RULE
    };
  }

  /* Monday (UTC) of the week containing `date`, as YYYY-MM-DD. Used as the
   * week identifier and the history key. */
  function weekOf(date) {
    var d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    var dow = d.getUTCDay();                 /* 0 = Sunday */
    var back = dow === 0 ? 6 : dow - 1;      /* rewind to Monday */
    d.setUTCDate(d.getUTCDate() - back);
    return d.toISOString().slice(0, 10);
  }

  function nameFor(symbol, fallback) {
    for (var i = 0; i < UNIVERSE.length; i++) {
      if (UNIVERSE[i].symbol === symbol) return UNIVERSE[i].name;
    }
    return fallback || symbol;
  }

  /* ---- rendering ---------------------------------------------------------- */
  var view = {
    pick: null,      /* the week's pick */
    quote: null,     /* latest quote for the pick's symbol */
    change: null,    /* multi-horizon change for the pick's symbol */
    series: null,    /* daily closes for the sparkline */
    history: [],     /* previous weeks */
    notice: null
  };

  function el(id) { return document.getElementById(id); }
  function setText(id, text) { var n = el(id); if (n) n.textContent = text; }
  function setHtml(id, html) { var n = el(id); if (n) n.innerHTML = html; }

  function statStrip(items) {
    return items.map(function (it) {
      return '<div><div class="stat-label">' + F.escapeHtml(it[0]) + '</div>' +
        '<div class="stat-value">' + F.escapeHtml(it[1]) + '</div></div>';
    }).join('');
  }

  function noticeHtml() {
    return view.notice
      ? '<p class="notice notice-' + view.notice.level + '">' + F.escapeHtml(view.notice.text) + '</p>'
      : '';
  }

  function render() {
    var pick = view.pick, q = view.quote, ch = view.change;

    /* the one-line strip on Home */
    setText('pinSymbol', pick ? pick.symbol : '—');
    var pin = el('pinMove');
    if (pin) {
      if (pick && S.isNum(pick.changePct5d)) {
        pin.textContent = F.signedPctPoints(pick.changePct5d, 1);
        pin.className = 'chg ' + (pick.changePct5d >= 0 ? 'is-up' : 'is-down');
      } else {
        pin.textContent = F.DASH;
        pin.className = 'chg is-flat';
      }
    }

    if (!pick) {
      setText('spotSymbol', '—');
      setText('spotWeek', '');
      setText('spotName', 'No pick yet');
      setText('spotRunner', '');
      setHtml('spotStrip', '');
      setHtml('spotNotice', noticeHtml());
      return;
    }

    setText('spotSymbol', pick.symbol);
    setText('spotWeek', 'Week of ' + F.shortDate(pick.weekOf));
    setText('spotName', (q && q.name) || pick.name || nameFor(pick.symbol));

    var px = el('spotPx');
    if (px) {
      px.textContent = q && S.isNum(q.price) ? F.usd(q.price, 2) : F.DASH;
      px.classList.toggle('is-empty', !(q && S.isNum(q.price)));
    }
    var chg = el('spotChg');
    if (chg) {
      if (q && S.isNum(q.changePct)) {
        chg.textContent = F.signedPctPoints(q.changePct);
        chg.className = 'chg ' + (q.changePct >= 0 ? 'is-up' : 'is-down');
      } else {
        chg.textContent = F.DASH;
        chg.className = 'chg is-flat';
      }
    }

    if (view.series && view.series.length > 2) {
      setHtml('spotSpark', G.sparkStep({
        values: S.tail(view.series, 60).map(function (p) { return p.price; }),
        w: 900, h: 200, color: 'var(--gold)', area: true, strokeWidth: 1.8
      }));
    } else {
      setHtml('spotSpark', '');
    }

    setHtml('spotStrip', statStrip([
      ['5d move', F.signedPctPoints(pick.changePct5d, 1)],
      ['1 month', ch && S.isNum(ch.m1) ? F.signedPctPoints(ch.m1, 1) : F.DASH],
      ['Market cap', q && S.isNum(q.marketCap) && q.marketCap > 0 ? F.compact(q.marketCap) : F.DASH]
    ]));

    var bits = [];
    if (pick.runnerUp) {
      bits.push('Runner-up ' + pick.runnerUp.symbol + ' ' + F.signedPctPoints(pick.runnerUp.changePct5d, 1));
    }
    if (view.history.length) {
      bits.push('before: ' + view.history.map(function (h) { return h.symbol; }).join(', '));
    }
    setText('spotRunner', bits.join(' · '));
    setHtml('spotNotice', noticeHtml());
  }

  /* ---- data in ------------------------------------------------------------ */

  /* snap: MP.sources.normalizeSpotlightSnapshot output. */
  function applySnapshot(snap) {
    if (!snap) return;
    var pick = snap.current;
    view.pick = pick;
    view.change = pick && snap.change && snap.change.symbol === pick.symbol ? snap.change : null;
    view.series = pick ? snap.series : null;
    if (view.quote && (!pick || view.quote.symbol !== pick.symbol)) view.quote = null;
    view.history = (snap.history || []).filter(function (h) {
      return !pick || h.weekOf !== pick.weekOf;
    }).slice(0, 4);
    view.notice = pick ? null : { level: 'quiet', text: 'This week’s pick appears after the Monday scan runs.' };
    render();
  }

  /* q: a normalized quote from data/quotes.json. Kept only if it is for the
   * current pick; before the pick has loaded, kept provisionally. */
  function setQuote(q) {
    view.quote = q && (!view.pick || q.symbol === view.pick.symbol) ? q : null;
    render();
  }

  function setNotice(notice) {
    view.notice = notice || null;
    render();
  }

  MP.spotlight = {
    UNIVERSE: UNIVERSE,
    RULE: RULE,
    selectSpotlight: selectSpotlight,
    weekOf: weekOf,
    nameFor: nameFor,
    applySnapshot: applySnapshot,
    setQuote: setQuote,
    setNotice: setNotice,
    view: view,
    render: render
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
