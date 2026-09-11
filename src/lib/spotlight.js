/* ============================================================================
 * spotlight.js: "Stock of the Week": the pinned panel at the top of the page.
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

  /* The stock movers rank every Nasdaq-100 member the data job priced (see
   * universe.js); the crypto movers rank the fixed list below. */
  var STOCK_RULE = 'Highest and lowest five-session move among the Nasdaq-100 members the data job could price.';
  var BOARD_SIZE = 5;   /* names at each end of the leaderboard */

  /* The crypto of the week draws from the large caps beyond BTC and ETH, which
   * have dial stops of their own. CoinGecko ids, so the page and the data job
   * ask for exactly these. */
  var CRYPTO_UNIVERSE = [
    { id: 'solana', symbol: 'SOL', name: 'Solana' },
    { id: 'ripple', symbol: 'XRP', name: 'XRP' },
    { id: 'binancecoin', symbol: 'BNB', name: 'BNB' },
    { id: 'cardano', symbol: 'ADA', name: 'Cardano' },
    { id: 'dogecoin', symbol: 'DOGE', name: 'Dogecoin' },
    { id: 'avalanche-2', symbol: 'AVAX', name: 'Avalanche' },
    { id: 'chainlink', symbol: 'LINK', name: 'Chainlink' },
    { id: 'polkadot', symbol: 'DOT', name: 'Polkadot' },
    { id: 'litecoin', symbol: 'LTC', name: 'Litecoin' },
    { id: 'tron', symbol: 'TRX', name: 'TRON' },
    { id: 'uniswap', symbol: 'UNI', name: 'Uniswap' },
    { id: 'stellar', symbol: 'XLM', name: 'Stellar' },
    { id: 'bitcoin-cash', symbol: 'BCH', name: 'Bitcoin Cash' },
    { id: 'near', symbol: 'NEAR', name: 'NEAR Protocol' },
    { id: 'aptos', symbol: 'APT', name: 'Aptos' }
  ];

  var CRYPTO_RULE = 'Highest and lowest seven-day move across a fixed 15-name large-cap universe, BTC and ETH excluded.';

  /* ---- pure selection ----------------------------------------------------- */

  /* rows: [{ symbol, name?, id?, <field> }], field a percentage-point move.
   * Ranks highest first; ties break on symbol, so the same data always gives
   * the same answer. Rows without a finite value (a plan denial, a coin
   * missing from the response) are skipped and counted.
   * -> { mover, loser, moverNext, loserNext, top, bottom, scanned, skipped },
   * or null when nothing is priced. Each entry is { symbol, name, id?,
   * change, rank }. The loser is null when only one row is priced. top holds
   * the highest BOARD_SIZE and bottom the lowest, lowest first; the two
   * never share a row. */
  function selectMovers(rows, field) {
    var all = rows || [];
    var usable = all.filter(function (r) {
      return r && typeof r.symbol === 'string' && S.isNum(r[field]);
    });
    if (!usable.length) return null;
    var ranked = usable.slice().sort(function (a, b) {
      var d = b[field] - a[field];
      if (d !== 0) return d;
      return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
    });
    var n = ranked.length;
    function entry(i) {
      var r = ranked[i];
      var e = { symbol: r.symbol, name: r.name || r.symbol, change: r[field], rank: i + 1 };
      if (r.id) e.id = r.id;
      return e;
    }
    var top = [], bottom = [];
    var topN = Math.min(BOARD_SIZE, n);
    for (var i = 0; i < topN; i++) top.push(entry(i));
    for (var j = n - 1; j >= Math.max(topN, n - BOARD_SIZE); j--) bottom.push(entry(j));
    return {
      mover: entry(0),
      loser: n > 1 ? entry(n - 1) : null,
      moverNext: n > 2 ? entry(1) : null,
      loserNext: n > 2 ? entry(n - 2) : null,
      top: top,
      bottom: bottom,
      scanned: n,
      skipped: all.length - n
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

  /* Names arrive with the data now; the symbol stands in without one. */
  function nameFor(symbol, fallback) {
    return fallback || symbol;
  }

  /* ---- rendering ---------------------------------------------------------- */
  var view = {
    pick: null,      /* the week's pick */
    quote: null,     /* latest quote for the pick's symbol */
    change: null,    /* multi-horizon change for the pick's symbol */
    series: null,    /* daily closes for the sparkline */
    history: [],     /* previous weeks */
    notice: null,
    crypto: null,        /* the week's crypto pick */
    cryptoQuote: null,   /* its live CoinGecko reading, with the 7-day sparkline */
    cryptoHistory: [],
    cryptoNotice: null
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

  function repaint() {
    if (MP.meter && MP.meter.refresh) MP.meter.refresh();
  }

  /* What the meter shows at the STOCK stop, or null before a pick exists.
   * The live quote's day change is preferred; before it arrives the scan's
   * own five-session move stands in, labelled as such. */
  function reading() {
    var pick = view.pick, q = view.quote;
    if (!pick) return null;
    var live = q && S.isNum(q.changePct);
    return {
      price: q && S.isNum(q.price) ? q.price : NaN,
      changePct: live ? q.changePct : pick.changePct5d,
      changeLabel: live ? '1D' : '5D',
      mode: pick.symbol,
      series: view.series && view.series.length > 2
        ? view.series.map(function (p) { return p.price; })
        : null
    };
  }

  /* What the meter shows at the CRYPTO stop, or null before a pick exists. */
  function cryptoReading() {
    var pick = view.crypto, q = view.cryptoQuote;
    if (!pick) return null;
    var live = q && S.isNum(q.changePct);
    return {
      price: q && S.isNum(q.price) ? q.price : NaN,
      changePct: live ? q.changePct : pick.changePct7d,
      changeLabel: live ? '24H' : '7D',
      mode: pick.symbol,
      series: q && q.sparkline && q.sparkline.length > 2 ? q.sparkline : null
    };
  }

  function renderCrypto() {
    var pick = view.crypto, q = view.cryptoQuote;
    var notice = view.cryptoNotice
      ? '<p class="notice notice-' + view.cryptoNotice.level + '">' + F.escapeHtml(view.cryptoNotice.text) + '</p>'
      : '';

    if (!pick) {
      setText('cryptoSymbol', '—');
      setText('cryptoWeek', '');
      setText('cryptoName', 'No pick yet');
      setText('cryptoRunner', '');
      setHtml('cryptoStrip', '');
      setHtml('cryptoSpark', '');
      setHtml('cryptoNotice', notice);
      return;
    }

    setText('cryptoSymbol', pick.symbol);
    setText('cryptoWeek', 'Week of ' + F.shortDate(pick.weekOf));
    setText('cryptoName', (q && q.name) || pick.name || pick.symbol);

    var px = el('cryptoPx');
    if (px) {
      px.textContent = q && S.isNum(q.price) ? F.usd(q.price, q.price < 10 ? 4 : 2) : F.DASH;
      px.classList.toggle('is-empty', !(q && S.isNum(q.price)));
    }
    var chg = el('cryptoChg');
    if (chg) {
      if (q && S.isNum(q.changePct)) {
        chg.textContent = F.signedPctPoints(q.changePct);
        chg.className = 'chg ' + (q.changePct >= 0 ? 'is-up' : 'is-down');
      } else {
        chg.textContent = F.DASH;
        chg.className = 'chg is-flat';
      }
    }

    setHtml('cryptoSpark', q && q.sparkline && q.sparkline.length > 2
      ? G.sparkStep({ values: q.sparkline, w: 900, h: 200, color: 'var(--gold)', area: true, strokeWidth: 1.8 })
      : '');

    setHtml('cryptoStrip', statStrip([
      ['7d move', F.signedPctPoints(pick.changePct7d, 1)],
      ['24h', q && S.isNum(q.changePct) ? F.signedPctPoints(q.changePct, 2) : F.DASH],
      ['Market cap', q && S.isNum(q.marketCap) && q.marketCap > 0 ? F.compact(q.marketCap) : F.DASH]
    ]));

    var bits = [];
    if (pick.runnerUp) {
      bits.push('Runner-up ' + pick.runnerUp.symbol + ' ' + F.signedPctPoints(pick.runnerUp.changePct7d, 1));
    }
    if (view.cryptoHistory.length) {
      bits.push('before: ' + view.cryptoHistory.map(function (h) { return h.symbol; }).join(', '));
    }
    setText('cryptoRunner', bits.join(' · '));
    setHtml('cryptoNotice', notice);
  }

  function render() {
    var pick = view.pick, q = view.quote, ch = view.change;
    renderCrypto();

    if (!pick) {
      setText('spotSymbol', '—');
      setText('spotWeek', '');
      setText('spotName', 'No pick yet');
      setText('spotRunner', '');
      setHtml('spotStrip', '');
      setHtml('spotNotice', noticeHtml());
      repaint();
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
    repaint();
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

    var crypto = snap.crypto || null;
    view.crypto = crypto;
    if (view.cryptoQuote && (!crypto || view.cryptoQuote.id !== crypto.id)) view.cryptoQuote = null;
    view.cryptoHistory = (snap.cryptoHistory || []).filter(function (h) {
      return !crypto || h.weekOf !== crypto.weekOf;
    }).slice(0, 4);
    view.cryptoNotice = crypto ? null : { level: 'quiet', text: 'This week’s crypto pick appears after the Monday scan runs.' };
    render();
  }

  /* The CoinGecko id the page should ask for alongside BTC and ETH. */
  function cryptoId() {
    return view.crypto ? view.crypto.id : null;
  }

  /* q: a coinSpot from MP.sources.coinsMarkets, for the current crypto pick. */
  function setCryptoQuote(q) {
    view.cryptoQuote = q && (!view.crypto || q.id === view.crypto.id) ? q : null;
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
    STOCK_RULE: STOCK_RULE,
    CRYPTO_UNIVERSE: CRYPTO_UNIVERSE,
    CRYPTO_RULE: CRYPTO_RULE,
    BOARD_SIZE: BOARD_SIZE,
    selectMovers: selectMovers,
    weekOf: weekOf,
    nameFor: nameFor,
    applySnapshot: applySnapshot,
    setQuote: setQuote,
    setCryptoQuote: setCryptoQuote,
    cryptoId: cryptoId,
    setNotice: setNotice,
    reading: reading,
    cryptoReading: cryptoReading,
    view: view,
    render: render
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
