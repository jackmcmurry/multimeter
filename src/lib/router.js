/* ============================================================================
 * router.js — hash routing between the dial's stops.
 *
 * Each stop is one reading on the meter's screen and one panel in the detail
 * drawer below it; several stops can share a panel (ETH and S&P both open
 * the markets panel). Only one panel is ever shown. Charts render into
 * hidden panels quite happily because every SVG carries a viewBox and sizes
 * from CSS, so nothing needs re-rendering on reveal.
 *
 * Old section hashes are kept as aliases so links out in the world still land
 * somewhere sensible.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  /* Dial order, clockwise from the top. */
  var VIEWS = ['off', 'btc', 'eth', 'nasdaq', 'spx', 'stock', 'crypto', 'probe', 'corr', 'vol', 'dd', 'note'];

  var ALIASES = {
    ixic: 'nasdaq',
    ndq: 'nasdaq',
    qqq: 'nasdaq',
    gspc: 'spx',
    sp500: 'spx',
    home: 'btc',
    markets: 'btc',
    weekly: 'stock',
    coupling: 'corr',
    beta: 'corr',
    volatility: 'vol',
    drawdown: 'dd',
    about: 'off',
    reading: 'note',
    daily: 'note'
  };

  /* Which drawer panel (.view[data-panel]) each stop opens. */
  var PANELS = {
    off: 'about',
    btc: 'hero',
    eth: 'markets',
    nasdaq: 'markets',
    spx: 'markets',
    stock: 'weekly',
    crypto: 'crypto',
    probe: 'probe',
    corr: 'coupling',
    vol: 'volatility',
    dd: 'drawdown',
    note: 'note'
  };

  var TITLES = {
    off: 'Off',
    btc: 'Bitcoin',
    eth: 'Ether',
    nasdaq: 'Nasdaq Composite',
    spx: 'S&P 500',
    stock: 'Stock of the week',
    crypto: 'Crypto of the week',
    probe: 'Probe',
    corr: 'Correlation',
    vol: 'Volatility',
    dd: 'Drawdown',
    note: 'Daily reading'
  };

  /* Panels that belong to no stop; shown by overridePanel() until the dial moves. */
  var PANEL_TITLES = { alerts: 'Alerts' };

  var DEFAULT_VIEW = 'btc';

  /* Pure: '#corr' -> 'corr', '#coupling' -> 'corr'; anything unrecognised ->
   * the default. */
  function parseHash(hash) {
    var raw = String(hash || '').replace(/^#\/?/, '').split('?')[0].split('&')[0].toLowerCase().trim();
    raw = ALIASES[raw] || raw;
    return VIEWS.indexOf(raw) >= 0 ? raw : DEFAULT_VIEW;
  }

  var current = null;
  var override = null;
  var listeners = [];

  function applyPanel(target) {
    var panel = override || PANELS[target];
    var sections = document.querySelectorAll('.view[data-panel]');
    for (var i = 0; i < sections.length; i++) {
      sections[i].hidden = sections[i].getAttribute('data-panel') !== panel;
    }
    var title = document.getElementById('viewTitle');
    if (title) title.textContent = (override && PANEL_TITLES[override]) || TITLES[target] || TITLES[DEFAULT_VIEW];
  }

  function show(view) {
    var target = VIEWS.indexOf(view) >= 0 ? view : DEFAULT_VIEW;
    if (current === target) return target;
    current = target;
    override = null;
    applyPanel(target);

    for (var k = 0; k < listeners.length; k++) {
      try { listeners[k](target); } catch (e) { /* a listener must not break navigation */ }
    }
    return target;
  }

  /* Shows a stop-less panel (the alerts list) until the next stop change. */
  function overridePanel(name) {
    override = name && PANEL_TITLES[name] ? name : null;
    if (current) applyPanel(current);
    return override;
  }

  /* Navigate: writes the hash so the back button works, and shows the view
   * directly when the hash already matches (a reload, or a repeated click). */
  function go(view) {
    var target = VIEWS.indexOf(view) >= 0 ? view : DEFAULT_VIEW;
    if (root.location && root.location.hash !== '#' + target) {
      root.location.hash = target;
    } else {
      show(target);
    }
    return target;
  }

  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  function start() {
    show(parseHash(root.location && root.location.hash));
    if (root.addEventListener) {
      root.addEventListener('hashchange', function () {
        show(parseHash(root.location.hash));
      });
    }
  }

  MP.router = {
    VIEWS: VIEWS,
    ALIASES: ALIASES,
    PANELS: PANELS,
    TITLES: TITLES,
    DEFAULT_VIEW: DEFAULT_VIEW,
    parseHash: parseHash,
    show: show,
    go: go,
    overridePanel: overridePanel,
    currentPanel: function () { return override || (current ? PANELS[current] : null); },
    onChange: onChange,
    start: start,
    currentView: function () { return current; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
