/* ============================================================================
 * router.js — hash routing between sections.
 *
 * The page is one document with several views; only one is ever shown. Charts
 * render into hidden views quite happily because every SVG carries a viewBox
 * and sizes from CSS, so nothing needs re-rendering on reveal.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var VIEWS = ['home', 'markets', 'weekly', 'coupling', 'volatility', 'drawdown', 'about'];

  var TITLES = {
    home: 'Home',
    markets: 'Markets',
    weekly: 'Stock of the week',
    coupling: 'Coupling',
    volatility: 'Volatility',
    drawdown: 'Drawdown',
    about: 'About'
  };

  var DEFAULT_VIEW = 'home';

  /* Pure: '#coupling' -> 'coupling'; anything unrecognised -> the default. */
  function parseHash(hash) {
    var raw = String(hash || '').replace(/^#\/?/, '').split('?')[0].split('&')[0].toLowerCase().trim();
    return VIEWS.indexOf(raw) >= 0 ? raw : DEFAULT_VIEW;
  }

  var current = null;
  var listeners = [];

  function show(view) {
    var target = VIEWS.indexOf(view) >= 0 ? view : DEFAULT_VIEW;
    if (current === target) return target;
    current = target;

    var sections = document.querySelectorAll('.view[data-view]');
    for (var i = 0; i < sections.length; i++) {
      sections[i].hidden = sections[i].getAttribute('data-view') !== target;
    }

    var items = document.querySelectorAll('.navitem[data-view]');
    for (var j = 0; j < items.length; j++) {
      var on = items[j].getAttribute('data-view') === target;
      items[j].classList.toggle('is-on', on);
      if (on) items[j].setAttribute('aria-current', 'page');
      else items[j].removeAttribute('aria-current');
    }

    var title = document.getElementById('viewTitle');
    if (title) title.textContent = TITLES[target] || TITLES[DEFAULT_VIEW];

    for (var k = 0; k < listeners.length; k++) {
      try { listeners[k](target); } catch (e) { /* a listener must not break navigation */ }
    }
    return target;
  }

  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  function start() {
    show(parseHash(root.location && root.location.hash));
    if (root.addEventListener) {
      root.addEventListener('hashchange', function () {
        show(parseHash(root.location.hash));
        if (root.scrollTo) root.scrollTo(0, 0);
      });
    }
  }

  MP.router = {
    VIEWS: VIEWS,
    TITLES: TITLES,
    DEFAULT_VIEW: DEFAULT_VIEW,
    parseHash: parseHash,
    show: show,
    onChange: onChange,
    start: start,
    currentView: function () { return current; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
