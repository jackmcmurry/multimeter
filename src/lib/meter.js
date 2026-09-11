/* ============================================================================
 * meter.js — the instrument itself: the rotary dial, the knob, and the LCD.
 *
 * The dial has ten stops over 320 degrees, clockwise from OFF at the top,
 * with a dead zone at eleven o'clock like a real range switch. Each
 * stop is a router view; turning the knob navigates, and navigation turns the
 * knob, so the back button and a typed hash both move the dial.
 *
 * The LCD paints from MP.app.reading(stop). HOLD freezes the display only:
 * data keeps arriving, the drawer keeps updating, and releasing HOLD shows
 * the current reading at once. Changing the stop releases it too, since a
 * held number under a different mode label would mislead.
 *
 * Colour never appears in this file; the SVG it builds is styled by class.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});
  var G = MP.geom, SEG = MP.sevenseg;

  var STOPS = [
    { id: 'off', label: 'OFF' },
    { id: 'btc', label: 'BTC' },
    { id: 'eth', label: 'ETH' },
    { id: 'nasdaq', label: 'NASDAQ' },
    { id: 'spx', label: 'S&P' },
    { id: 'stock', label: 'STOCK' },
    { id: 'crypto', label: 'CRYPTO' },
    { id: 'corr', label: 'CORR' },
    { id: 'vol', label: 'VOL' },
    { id: 'dd', label: 'DD' }
  ];
  var SWEEP_DEG = 320;                              /* OFF at the top to the last stop */
  var STEP_DEG = SWEEP_DEG / (STOPS.length - 1);    /* the dead zone takes the rest */
  var DETENT_MS = 240;                              /* how long the click feedback lasts */

  /* plate geometry, in viewBox units; MARGIN leaves room for the longest label
   * at three o'clock, which would otherwise clip at the plate's edge */
  var SIZE = 300, CX = 150, CY = 150, MARGIN = 34;
  var R_FACE = 92, R_ARC = 105, R_TICK_IN = 100, R_TICK_OUT = 112, R_LABEL = 144, R_HIT = 18;

  var TAP_PX = 4;   /* pointer travel below which a press is a tap, not a drag */

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function el(id) { return document.getElementById(id); }
  function setText(id, text) { var n = el(id); if (n) n.textContent = text; }

  /* ---- pure geometry ------------------------------------------------------ */
  function angleOf(index) { return index * STEP_DEG; }

  /* Nearest stop to a bearing in degrees clockwise from twelve o'clock. The
   * dead zone splits in the middle: its first half snaps back to the last
   * stop, its second half forward to OFF. */
  function stopAt(deg) {
    var d = ((deg % 360) + 360) % 360;
    return Math.round(d / STEP_DEG) % STOPS.length;
  }

  function indexOf(id) {
    for (var i = 0; i < STOPS.length; i++) if (STOPS[i].id === id) return i;
    return -1;
  }

  function polar(r, deg) {
    var t = deg * Math.PI / 180;
    return { x: (CX + r * Math.sin(t)).toFixed(2), y: (CY - r * Math.cos(t)).toFixed(2) };
  }

  function escapeText(s) {
    return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; });
  }

  /* The printed face plate: recessed ring, arc, one tick and label per stop. */
  function plateSvg() {
    var s = '<svg class="dial-plate" viewBox="' + (-MARGIN) + ' ' + (-MARGIN) + ' ' +
      (SIZE + 2 * MARGIN) + ' ' + (SIZE + 2 * MARGIN) + '" aria-hidden="true">';
    s += '<circle class="dial-face" cx="' + CX + '" cy="' + CY + '" r="' + R_FACE + '"/>';
    var a0 = polar(R_ARC, angleOf(0)), a1 = polar(R_ARC, angleOf(STOPS.length - 1));
    s += '<path class="dial-arc" d="M' + a0.x + ',' + a0.y + ' A' + R_ARC + ',' + R_ARC + ' 0 1 1 ' + a1.x + ',' + a1.y + '"/>';
    for (var i = 0; i < STOPS.length; i++) {
      var deg = angleOf(i);
      var t0 = polar(R_TICK_IN, deg), t1 = polar(R_TICK_OUT, deg), lp = polar(R_LABEL, deg);
      s += '<line class="dial-tick" x1="' + t0.x + '" y1="' + t0.y + '" x2="' + t1.x + '" y2="' + t1.y + '"/>';
      s += '<g class="dial-stop" data-stop="' + STOPS[i].id + '">' +
        '<circle class="dial-hit" cx="' + lp.x + '" cy="' + lp.y + '" r="' + R_HIT + '"/>' +
        '<text class="dial-lab" x="' + lp.x + '" y="' + lp.y + '" text-anchor="middle" dominant-baseline="central">' +
        escapeText(STOPS[i].label) + '</text></g>';
    }
    return s + '</svg>';
  }

  /* ---- state -------------------------------------------------------------- */
  var currentId = null;
  var shownAngle = 0;      /* continuous, so the knob always takes the short way */
  var held = false;

  /* ---- knob --------------------------------------------------------------- */
  function rotateTo(index) {
    var knob = el('knob');
    var target = angleOf(index);
    var cur = ((shownAngle % 360) + 360) % 360;
    var delta = ((target - cur + 540) % 360) - 180;
    shownAngle += delta;
    if (knob) {
      knob.style.transform = 'rotate(' + shownAngle + 'deg)';
      knob.setAttribute('aria-valuenow', String(index));
      var title = MP.router && MP.router.TITLES ? MP.router.TITLES[STOPS[index].id] : STOPS[index].label;
      knob.setAttribute('aria-valuetext', title);
    }
  }

  function markLabel(id) {
    var labels = document.querySelectorAll('.dial-stop[data-stop]');
    for (var i = 0; i < labels.length; i++) {
      labels[i].classList.toggle('is-on', labels[i].getAttribute('data-stop') === id);
    }
  }

  function go(id) {
    if (MP.router) MP.router.go(id);
  }

  function step(by) {
    var i = indexOf(currentId);
    if (i < 0) i = 0;
    go(STOPS[(i + by + STOPS.length) % STOPS.length].id);
  }

  function wireDial(dial, knob) {
    var drag = null;

    function bearing(ev) {
      var r = dial.getBoundingClientRect();
      var dx = ev.clientX - (r.left + r.width / 2);
      var dy = ev.clientY - (r.top + r.height / 2);
      return (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    }

    dial.addEventListener('pointerdown', function (ev) {
      if (ev.button !== undefined && ev.button !== 0) return;
      var stopEl = ev.target.closest ? ev.target.closest('.dial-stop[data-stop]') : null;
      drag = {
        id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, moved: false,
        onKnob: knob.contains(ev.target),
        tapStop: stopEl ? stopEl.getAttribute('data-stop') : null
      };
      if (dial.setPointerCapture) { try { dial.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ } }
      /* preventDefault below also suppresses the focus a press would give,
       * so hand the knob focus explicitly: the arrow keys then work at once. */
      if (drag.onKnob && knob.focus) knob.focus({ preventScroll: true });
      ev.preventDefault();
    });

    dial.addEventListener('pointermove', function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      if (!drag.moved) {
        var dx = ev.clientX - drag.x0, dy = ev.clientY - drag.y0;
        if (Math.sqrt(dx * dx + dy * dy) < TAP_PX) return;
        drag.moved = true;
      }
      var idx = stopAt(bearing(ev));
      if (STOPS[idx].id !== currentId) go(STOPS[idx].id);
    });

    function release(ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      var d = drag;
      drag = null;
      if (ev.type === 'pointercancel' || d.moved) return;
      if (d.tapStop) go(d.tapStop);
      else if (d.onKnob) step(1);
    }
    dial.addEventListener('pointerup', release);
    dial.addEventListener('pointercancel', release);
  }

  function wireKeys(knob) {
    knob.addEventListener('keydown', function (ev) {
      var k = ev.key;
      if (k === 'ArrowRight' || k === 'ArrowUp') step(1);
      else if (k === 'ArrowLeft' || k === 'ArrowDown') step(-1);
      else if (k === 'Home') go(STOPS[0].id);
      else if (k === 'End') go(STOPS[STOPS.length - 1].id);
      else if (k === 'Enter' || k === ' ') step(1);
      else return;
      ev.preventDefault();
    });
  }

  /* ---- hold and drawer ---------------------------------------------------- */
  function setHold(on) {
    held = !!on;
    var btn = el('holdBtn');
    if (btn) {
      btn.classList.toggle('is-held', held);
      btn.setAttribute('aria-pressed', held ? 'true' : 'false');
    }
    var ann = el('lcdHold');
    if (ann) ann.classList.toggle('is-on', held);
    if (!held) refresh();
  }

  function openDrawer(open) {
    var drawer = el('drawer'), btn = el('detailBtn');
    if (!drawer) return;
    var show = open === undefined ? drawer.hidden : !!open;
    drawer.hidden = !show;
    if (btn) {
      btn.setAttribute('aria-expanded', show ? 'true' : 'false');
      btn.classList.toggle('is-on', show);
    }
  }

  function wireButtons() {
    var hold = el('holdBtn'), detail = el('detailBtn'), lcd = el('lcd');
    if (hold) hold.addEventListener('click', function () { setHold(!held); });
    if (detail) detail.addEventListener('click', function () { openDrawer(); });
    if (lcd) {
      lcd.addEventListener('click', function () { openDrawer(); });
      lcd.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { openDrawer(); ev.preventDefault(); }
      });
    }
  }

  /* ---- the screen --------------------------------------------------------- */
  function changeText(c) {
    if (!c || !isNum(c.value)) return '----';
    var arrow = c.value >= 0 ? '▲' : '▼';
    return arrow + Math.abs(c.value).toFixed(isNum(c.dp) ? c.dp : 2) + (c.suffix || '');
  }

  function describe(r, off) {
    if (off) return 'Meter off. Press to open the details.';
    var title = MP.router && MP.router.TITLES ? MP.router.TITLES[currentId] : currentId;
    var value = r.empty ? 'no reading yet' : (r.neg ? '-' : '') + r.digits + (r.unit ? ' ' + r.unit : '');
    var c = r.change;
    var change = c && isNum(c.value)
      ? ', ' + (c.value >= 0 ? 'up ' : 'down ') + Math.abs(c.value).toFixed(isNum(c.dp) ? c.dp : 2) + (c.suffix || '') + ' over ' + c.label
      : '';
    return title + ': ' + value + change + '. Press to open the details.';
  }

  function paint(r) {
    var lcd = el('lcd');
    if (!lcd) return;
    var off = currentId === 'off';
    lcd.classList.toggle('is-off', off);
    setText('lcdMode', off ? '' : r.mode || '');
    setText('lcdUnit', off ? '' : r.unit || '');
    var digits = el('lcdDigits');
    if (digits) digits.innerHTML = SEG.svg(off ? '' : r.digits, !off && r.neg);
    setText('lcdChange', off ? '' : changeText(r.change));
    setText('lcdChangeLabel', off ? '' : (r.change && r.change.label) || '');
    var chart = el('lcdChart');
    if (chart) {
      var series = r.spark || [];
      var c = r.change;
      /* the line takes the colour of the move: the change if known, else the
       * series' own direction */
      var down = c && isNum(c.value) ? c.value < 0
        : series.length > 1 && series[series.length - 1] < series[0];
      chart.innerHTML = !off && series.length > 1
        ? G.smoothLine({ values: series, w: 600, h: 200, color: down ? 'var(--down)' : 'var(--up)', strokeWidth: 2.4 })
        : '';
    }
    lcd.setAttribute('aria-label', describe(r, off));
  }

  function refresh() {
    if (held || !currentId) return;
    var app = MP.app;
    if (!app || !app.reading) return;
    paint(app.reading(currentId));
  }

  /* ---- detent feedback ---------------------------------------------------- */
  var detentTimer = null;

  /* The knob dips for a moment and the screen's readout refreshes with a
   * short fade, so a change of stop is felt as well as seen. A phone that
   * supports it also gets a tiny haptic tick. */
  function detent() {
    var knob = el('knob'), lcd = el('lcd');
    if (knob) knob.classList.remove('is-detent');
    if (lcd) lcd.classList.remove('is-swap');
    /* restart the animation even when two stops arrive back to back */
    void (knob && knob.offsetWidth);
    if (knob) knob.classList.add('is-detent');
    if (lcd) lcd.classList.add('is-swap');
    clearTimeout(detentTimer);
    detentTimer = setTimeout(function () {
      if (knob) knob.classList.remove('is-detent');
      if (lcd) lcd.classList.remove('is-swap');
    }, DETENT_MS);
    if (root.navigator && typeof root.navigator.vibrate === 'function') {
      try { root.navigator.vibrate(8); } catch (e) { /* not permitted */ }
    }
  }

  /* ---- routing ------------------------------------------------------------ */
  function onStop(id) {
    var idx = indexOf(id);
    if (idx < 0) return;
    var changed = currentId !== null && currentId !== id;
    currentId = id;
    rotateTo(idx);
    markLabel(id);
    if (changed) detent();
    if (changed && held) setHold(false);   /* setHold(false) repaints */
    else refresh();
  }

  function init() {
    var dial = el('dial'), knob = el('knob');
    if (!dial || !knob) return;
    if (!dial.querySelector('.dial-plate')) dial.insertAdjacentHTML('afterbegin', plateSvg());
    knob.setAttribute('aria-valuemin', '0');
    knob.setAttribute('aria-valuemax', String(STOPS.length - 1));
    wireDial(dial, knob);
    wireKeys(knob);
    wireButtons();
    if (MP.router) MP.router.onChange(onStop);
  }

  MP.meter = {
    STOPS: STOPS,
    STEP_DEG: STEP_DEG,
    SWEEP_DEG: SWEEP_DEG,
    angleOf: angleOf,
    stopAt: stopAt,
    plateSvg: plateSvg,
    init: init,
    refresh: refresh,
    setHold: setHold,
    isHeld: function () { return held; },
    openDrawer: openDrawer,
    current: function () { return currentId; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
