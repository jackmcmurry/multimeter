/* ============================================================================
 * spotlight.js: MOVER and LOSER: the week's highest and lowest move, among
 * the Nasdaq-100 or among 15 large coins.
 *
 * Selection is mechanical and descriptive. The data job (src/lib/pipeline.js)
 * ranks the week with selectMovers() and publishes both ends, the next name
 * at each end and the five names at each end of the board in
 * data/spotlight.json. The page shows one kind at a time: the switch on the
 * screen picks stocks or crypto, and the choice stays in this browser. Stock
 * prices come from the job's quotes (data/quotes.json picks) or, failing
 * those, the last close; crypto prices come from the page's CoinGecko poll.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});
  var S = MP.stats, F = MP.fmt, G = MP.geom;

  /* The stock movers rank every Nasdaq-100 member the data job priced (see
   * universe.js); the crypto movers rank the fixed list below. */
  var STOCK_RULE = 'Highest and lowest five-session move among the Nasdaq-100 members the data job could price.';
  var BOARD_SIZE = 5;   /* names at each end of the leaderboard */

  /* The large caps beyond BTC and ETH, which have dial stops of their own.
   * CoinGecko ids, so the page and the data job ask for exactly these. */
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

  var KINDS = ['stocks', 'crypto'];
  var KIND_KEY = 'movers';
  var SCREEN_SESSIONS = 30;    /* the screen charts six weeks of a stock's closes */
  var DRAWER_SESSIONS = 63;    /* the drawer, three months */
  var LOGO_URL = 'https://financialmodelingprep.com/image-stock/';
  var BADGE = { mover: 'MOVER ▲', loser: 'LOSER ▼' };

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

  /* ---- state -------------------------------------------------------------- */
  function readKind(v) { return KINDS.indexOf(v) >= 0 ? v : 'stocks'; }

  var view = {
    movers: null,    /* spotlight.json movers (version 2), normalized */
    kind: readKind(MP.store ? MP.store.get(KIND_KEY, 'stocks') : 'stocks'),
    picks: null,     /* { mover, loser }: the stock movers' quotes, from data/quotes.json */
    coins: {},       /* CoinGecko id -> coinSpot, for the crypto movers */
    notice: null
  };
  var failedLogos = {};

  function kind() { return view.kind; }

  function setKind(k) {
    view.kind = readKind(k);
    if (MP.store) MP.store.set(KIND_KEY, view.kind);
    render();
    return view.kind;
  }

  function setOf(k) { return view.movers ? view.movers[k || view.kind] || null : null; }

  function entryFor(which, k) {
    var set = setOf(k);
    return set ? (which === 'loser' ? set.loser : set.mover) : null;
  }

  function idsOf(set, key) {
    var out = [];
    if (set) [set.mover, set.loser].forEach(function (e) { if (e && e[key] && out.indexOf(e[key]) < 0) out.push(e[key]); });
    return out;
  }

  /* The CoinGecko ids the page polls alongside BTC and ETH. */
  function cryptoIds() { return idsOf(setOf('crypto'), 'id'); }

  /* The stock files the screens need. */
  function stockSymbols() { return idsOf(setOf('stocks'), 'symbol'); }

  /* Coinbase products for the live feed, while the switch is on crypto. */
  function products() {
    if (view.kind !== 'crypto' || !MP.sources) return [];
    return idsOf(setOf('crypto'), 'symbol').map(MP.sources.coinbaseWs.productFor).filter(Boolean);
  }

  function productFor(which) {
    if (view.kind !== 'crypto' || !MP.sources) return null;
    var e = entryFor(which);
    return e ? MP.sources.coinbaseWs.productFor(e.symbol) : null;
  }

  /* A stock's latest price: the job's quote when it is for this symbol,
   * otherwise its last close from stocks.json. */
  function stockPrice(sym) {
    var p = view.picks, q = null;
    if (p && p.mover && p.mover.symbol === sym) q = p.mover;
    else if (p && p.loser && p.loser.symbol === sym) q = p.loser;
    if (q && S.isNum(q.price)) {
      return { price: q.price, changePct: S.isNum(q.changePct) ? q.changePct : NaN, marketCap: q.marketCap, name: q.name, source: 'quote' };
    }
    var row = MP.app && MP.app.stockRow ? MP.app.stockRow(sym) : null;
    if (row && S.isNum(row.close)) {
      return { price: row.close, changePct: row.change1d, marketCap: NaN, name: row.name, source: 'close', date: row.date };
    }
    return null;
  }

  function coinPrice(id) {
    var c = id ? view.coins[id] : null;
    return c && S.isNum(c.price) ? c : null;
  }

  function priceOf(e, k) { return e ? (k === 'crypto' ? coinPrice(e.id) : stockPrice(e.symbol)) : null; }

  /* The chart: a stock's closes, or a coin's seven days of hourly prices. */
  function seriesOf(e, k, sessions) {
    if (!e) return null;
    if (k === 'crypto') {
      var c = coinPrice(e.id);
      return c && c.sparkline && c.sparkline.length > 2 ? c.sparkline : null;
    }
    var s = MP.app && MP.app.stockSeries ? MP.app.stockSeries(e.symbol) : null;
    return s && s.length > 1 ? S.tail(s, sessions).map(function (p) { return p.price; }) : null;
  }

  /* ---- the screen ----------------------------------------------------------- */

  /* MOVER or LOSER on the screen: a badge, the ticker and the week's move as
   * the headline, the price and its day change beneath, and the rank on the
   * mode line. No value, so REL, MIN/MAX and ALERT pass it by. */
  function reading(which) {
    var k = view.kind, set = setOf(k), e = entryFor(which, k);
    var r = {
      text: F.DASH, value: NaN, dp: 2, unit: k === 'crypto' ? '7D' : '5D', mode: '',
      badge: { text: BADGE[which] || BADGE.mover, dir: which === 'loser' ? 'down' : 'up' },
      ticker: '', lead: '', headDir: null, symbol: null, say: '',
      change: { pct: NaN, abs: NaN, delta: NaN, suffix: '', label: k === 'crypto' ? '24H' : '1D', dp: 2, usd: true },
      spark: null, empty: true, ranges: false, coin: null
    };
    if (!e) {
      r.hint = k === 'crypto' ? 'Appears after the weekly crypto scan' : 'Appears after a full pass over the Nasdaq-100';
      return r;
    }
    r.empty = false;
    r.symbol = e.symbol;
    r.ticker = e.symbol;
    r.text = F.signedPctPoints(e.change, 2);
    r.headDir = e.change < 0 ? 'down' : 'up';
    /* the switch below names the kind, so the mode line holds only the rank */
    r.mode = S.isNum(e.rank) && S.isNum(set.scanned) ? 'Rank ' + e.rank + ' of ' + set.scanned : '';
    var px = priceOf(e, k);
    if (px) {
      var dp = Math.abs(px.price) < 10 ? 4 : 2;
      r.lead = F.usd(px.price, dp);
      r.change.dp = dp;
      if (S.isNum(px.changePct)) {
        r.change.pct = px.changePct;
        r.change.abs = px.price - px.price / (1 + px.changePct / 100);
      }
    }
    r.spark = seriesOf(e, k, SCREEN_SESSIONS);
    r.say = (which === 'loser' ? 'lowest ' : 'highest ') + (k === 'crypto' ? 'seven-day' : 'five-session') + ' move, ' +
      e.symbol + ' ' + F.signedPctPoints(e.change, 2) + (r.lead ? ', price ' + r.lead : '');
    return r;
  }

  /* ---- the drawer ----------------------------------------------------------- */
  function el(id) { return document.getElementById(id); }
  function setText(id, text) { var n = el(id); if (n) n.textContent = text; }
  function setHtml(id, html) { var n = el(id); if (n) n.innerHTML = html; }

  function noticeHtml(n) {
    return n ? '<p class="notice notice-' + n.level + '">' + F.escapeHtml(n.text) + '</p>' : '';
  }

  function repaint() {
    if (MP.meter && MP.meter.refresh) MP.meter.refresh();
  }

  function which() {
    var v = MP.router && MP.router.currentView ? MP.router.currentView() : null;
    return v === 'loser' ? 'loser' : 'mover';
  }

  /* A company logo from FMP's public images, a coin's from CoinGecko; a
   * monogram when there is none or it fails to load. */
  function logoHtml(e, k) {
    var mono = F.escapeHtml(e.symbol.slice(0, 4));
    var coin = k === 'crypto' ? coinPrice(e.id) : null;
    var src = k === 'crypto' ? (coin && coin.image) : LOGO_URL + encodeURIComponent(e.symbol) + '.png';
    if (!src || failedLogos[src]) return '<span class="mv-logo mv-mono" aria-hidden="true">' + mono + '</span>';
    return '<img class="mv-logo" alt="" loading="lazy" referrerpolicy="no-referrer" src="' + F.escapeHtml(src) + '" data-mono="' + mono + '">';
  }

  function strip(items) {
    return items.map(function (it) {
      return '<div><div class="stat-label">' + F.escapeHtml(it[0]) + '</div>' +
        '<div class="stat-value">' + F.escapeHtml(it[1]) + '</div></div>';
    }).join('');
  }

  /* Both ends of the week, always together: the highest five and the lowest
   * five, each with a bar in proportion to its move. */
  function boardHtml(set, pick, k) {
    var all = set.top.concat(set.bottom);
    var max = all.reduce(function (m, e) { return Math.max(m, Math.abs(e.change)); }, 0) || 1;
    function li(e) {
      var d = e.change < 0 ? 'down' : 'up';
      var width = Math.max(2, Math.round(Math.abs(e.change) / max * 100));
      return '<li class="is-' + d + (e.symbol === pick ? ' is-pick' : '') + '" title="' + F.escapeHtml(e.name || e.symbol) + '">' +
        '<span class="b-rank">' + (S.isNum(e.rank) ? e.rank : '') + '</span>' +
        '<span class="b-sym">' + F.escapeHtml(e.symbol) + '</span>' +
        '<span class="b-bar"><i style="width:' + width + '%"></i></span>' +
        '<span class="b-chg">' + F.escapeHtml(F.signedPctPoints(e.change, 1)) + '</span></li>';
    }
    var between = S.isNum(set.scanned) ? set.scanned - set.top.length - set.bottom.length : 0;
    return '<h3 class="mv-sub">' + (k === 'crypto' ? 'Seven-day moves, ' + set.scanned + ' coins' : 'Five-session moves, ' + set.scanned + ' Nasdaq-100 members') + '</h3>' +
      '<ol class="board">' + set.top.map(li).join('') +
      (between > 0 ? '<li class="b-gap">' + between + ' more in between</li>' : '') +
      set.bottom.slice().reverse().map(li).join('') + '</ol>';
  }

  function render() {
    var w = which(), k = view.kind, set = setOf(k), e = entryFor(w, k);
    setHtml('moversKind', KINDS.map(function (kk) {
      return '<button type="button" class="pill' + (kk === k ? ' is-on' : '') + '" data-movers-kind="' + kk + '" aria-pressed="' + (kk === k) + '">' +
        (kk === 'crypto' ? 'Crypto' : 'Stocks') + '</button>';
    }).join(''));

    if (!e) {
      ['mvHead', 'mvStrip', 'mvChart', 'mvBoard'].forEach(function (id) { setHtml(id, ''); });
      ['mvChartFoot', 'mvRunner', 'mvRule'].forEach(function (id) { setText(id, ''); });
      setHtml('mvNotice', noticeHtml(view.notice || {
        level: 'quiet',
        text: k === 'crypto' ? 'The crypto movers appear after the weekly scan.' : 'The stock movers appear once the data job has priced the Nasdaq-100 for a full week.'
      }));
      repaint();
      return;
    }

    var px = priceOf(e, k);
    var dir = e.change < 0 ? 'down' : 'up';
    var watching = MP.app && MP.app.isWatched ? MP.app.isWatched(e.symbol) : false;
    var watchBtn = k === 'stocks'
      ? '<button type="button" class="pill" data-watch-add="' + F.escapeHtml(e.symbol) + '"' + (watching ? ' disabled' : '') + '>' + (watching ? 'Watching' : 'Watch') + '</button>'
      : '';
    setHtml('mvHead', logoHtml(e, k) +
      '<div class="mv-id"><div class="mv-title">' + F.escapeHtml(e.symbol) +
      '<span class="mv-badge is-' + (w === 'loser' ? 'down' : 'up') + '">' + BADGE[w] + '</span>' + watchBtn + '</div>' +
      '<div class="mv-name">' + F.escapeHtml((px && px.name) || e.name || e.symbol) + '</div></div>' +
      '<div class="mv-move is-' + dir + '">' + F.escapeHtml(F.signedPctPoints(e.change, 2)) +
      '<span class="mv-move-label">' + (k === 'crypto' ? '7 days' : '5 sessions') + '</span></div>');

    var row = k === 'stocks' && MP.app && MP.app.stockRow ? MP.app.stockRow(e.symbol) : null;
    var items = [
      [px && px.source === 'close' ? 'Last close' : 'Price', px ? F.usd(px.price, Math.abs(px.price) < 10 ? 4 : 2) : F.DASH],
      [k === 'crypto' ? '24 hours' : '1 day', px && S.isNum(px.changePct) ? F.signedPctPoints(px.changePct, 2) : F.DASH]
    ];
    if (k === 'stocks') items.push(['1 month', row && S.isNum(row.change1m) ? F.signedPctPoints(row.change1m, 1) : F.DASH]);
    items.push(['Market cap', px && S.isNum(px.marketCap) && px.marketCap > 0 ? F.compact(px.marketCap) : F.DASH]);
    setHtml('mvStrip', strip(items));

    var vals = seriesOf(e, k, DRAWER_SESSIONS);
    setHtml('mvChart', vals && vals.length > 1
      ? G.sparkStep({ values: vals, w: 900, h: 200, color: dir === 'down' ? 'var(--neg)' : 'var(--pos)', area: true, strokeWidth: 1.8 })
      : '');
    setText('mvChartFoot', k === 'crypto' ? 'Seven days, hourly.' : vals ? 'Daily closes, the last three months.' : 'The closes load with the stock’s file.');

    setHtml('mvBoard', boardHtml(set, e.symbol, k));

    var bits = [];
    var nxt = w === 'loser' ? set.loserNext : set.moverNext;
    if (nxt) bits.push((w === 'loser' ? 'Next lowest: ' : 'Next highest: ') + nxt.symbol + ' ' + F.signedPctPoints(nxt.change, 1) + '.');
    var past = ((view.movers && view.movers.history) || []).filter(function (h) {
      return h.kind === k && h.weekOf !== set.weekOf;
    }).slice(0, 3);
    if (past.length) {
      bits.push('Earlier weeks: ' + past.map(function (h) {
        return F.shortDate(h.weekOf) + ' ' + (h.loser ? h.mover.symbol + ' and ' + h.loser.symbol : h.mover.symbol + ' (largest move either way)');
      }).join('; ') + '.');
    }
    setText('mvRunner', bits.join(' '));
    setText('mvRule', set.rule + (set.measuredTo ? ' Measured to the close of ' + F.shortDate(set.measuredTo) + '.' : '') +
      ' This ranks the past week. It is not advice.');
    setHtml('mvNotice', noticeHtml(view.notice));
    repaint();
  }

  /* A logo that fails to load becomes the monogram, and stays one. */
  function wire() {
    if (!root.document) return;
    document.addEventListener('error', function (ev) {
      var img = ev.target;
      if (!img || img.tagName !== 'IMG' || !img.classList || !img.classList.contains('mv-logo')) return;
      failedLogos[img.getAttribute('src')] = true;
      var span = document.createElement('span');
      span.className = 'mv-logo mv-mono';
      span.setAttribute('aria-hidden', 'true');
      span.textContent = img.getAttribute('data-mono') || '';
      if (img.parentNode) img.parentNode.replaceChild(span, img);
    }, true);
  }

  /* ---- data in ------------------------------------------------------------ */

  /* snap: MP.sources.normalizeSpotlightSnapshot output. A version 1 file has
   * no movers; the panels say so until the job rewrites it. */
  function applySnapshot(snap) {
    if (!snap) return;
    view.movers = snap.movers || null;
    view.notice = null;
    render();
  }

  /* picks: quotes.json picks, { mover, loser }. */
  function setPicks(picks) {
    view.picks = picks || null;
    render();
  }

  /* coins: CoinGecko id -> coinSpot for the crypto movers. */
  function setCoinQuotes(coins) {
    view.coins = coins || {};
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
    KINDS: KINDS,
    selectMovers: selectMovers,
    weekOf: weekOf,
    nameFor: nameFor,
    view: view,
    kind: kind,
    setKind: setKind,
    reading: reading,
    render: render,
    wire: wire,
    applySnapshot: applySnapshot,
    setPicks: setPicks,
    setCoinQuotes: setCoinQuotes,
    setNotice: setNotice,
    cryptoIds: cryptoIds,
    stockSymbols: stockSymbols,
    products: products,
    productFor: productFor
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
