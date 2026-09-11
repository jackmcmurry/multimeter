/* ============================================================================
 * meter.js — the instrument itself: the rotary dial, the knob, and the screen.
 *
 * The dial has ten stops over 320 degrees, clockwise from OFF at the top,
 * with a dead zone at eleven o'clock like a real range switch. Each stop is
 * a router view; turning the knob navigates, and navigation turns the knob,
 * so the back button and a typed hash both move the dial.
 *
 * The knob is meant to be fiddled with. While a finger or pointer holds it,
 * it follows exactly; every detent it passes clicks (a dip, a soft tick, a
 * haptic pulse where the device has one) and the screen changes under it.
 * Let go and it springs onto the nearest stop. The wheel steps it, so do the
 * arrow keys, and a tap on the knob advances it one stop.
 *
 * The screen paints from MP.app.reading(stop). HOLD freezes the display
 * only: data keeps arriving, the drawer keeps updating, and releasing HOLD
 * shows the current reading at once. Changing the stop releases it too.
 *
 * Colour never appears in this file; the SVG it builds is styled by class.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});
  var G = MP.geom;

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
  var DETENT_MS = 220;                              /* how long the click feedback lasts */
  var WHEEL_MS = 110;                               /* one step per wheel notch, no faster */

  /* plate geometry, in viewBox units; MARGIN leaves room for the longest label
   * at three o'clock, which would otherwise clip at the plate's edge */
  var SIZE = 300, CX = 150, CY = 150, MARGIN = 34;
  var R_FACE = 92, R_ARC = 105, R_TICK_IN = 100, R_TICK_OUT = 112, R_LABEL = 144, R_HIT = 18;

  var TAP_PX = 4;   /* pointer travel below which a press is a tap, not a drag */

  var UP = '↗', DOWN = '↘';

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

  /* A bearing the knob may actually point at: inside the sweep it is itself;
   * in the dead zone it clamps to whichever end is nearer, so the pointer
   * never rests in the gap. */
  function clampToSweep(deg) {
    var d = ((deg % 360) + 360) % 360;
    if (d <= SWEEP_DEG) return d;
    return d - SWEEP_DEG < 360 - d ? SWEEP_DEG : 0;
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
  var dragging = false;
  var held = false;

  /* ---- knob --------------------------------------------------------------- */

  /* Turns the knob to a bearing by the shortest way. immediate = no spring,
   * for following a pointer. */
  function turnKnob(targetDeg, immediate) {
    var knob = el('knob');
    var cur = ((shownAngle % 360) + 360) % 360;
    var delta = ((targetDeg - cur + 540) % 360) - 180;
    shownAngle += delta;
    if (knob) {
      knob.classList.toggle('is-dragging', !!immediate);
      knob.style.transform = 'rotate(' + shownAngle + 'deg)';
    }
  }

  function settleOn(index) {
    turnKnob(angleOf(index), false);
    var knob = el('knob');
    if (knob) {
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

  /* ---- detent feedback ---------------------------------------------------- */
  var detentTimer = null;
  var audio = null;

  /* The audio context has to be born inside a user gesture, so the pointer
   * and key handlers prime it; the detent then only has to play. */
  function primeAudio() {
    if (audio) {
      if (audio.state === 'suspended' && audio.resume) audio.resume().catch(function () { /* later */ });
      return;
    }
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return;
    try { audio = new AC(); } catch (e) { audio = null; }
  }

  /* A short, quiet mechanical tick: a fast square chirp with a 40 ms decay. */
  function tickSound() {
    if (!audio || audio.state !== 'running') return;
    try {
      var t = audio.currentTime;
      var osc = audio.createOscillator(), gain = audio.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(2400, t);
      osc.frequency.exponentialRampToValueAtTime(520, t + 0.03);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.045, t + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start(t);
      osc.stop(t + 0.045);
    } catch (e) { /* no sound is fine */ }
  }

  /* The knob dips, the readout refreshes with a short fade, the phone gives
   * a tiny pulse: a change of stop is felt as well as seen. */
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
    tickSound();
    if (root.navigator && typeof root.navigator.vibrate === 'function') {
      try { root.navigator.vibrate(8); } catch (e) { /* not permitted */ }
    }
  }

  /* ---- pointer, wheel, keys ----------------------------------------------- */
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
      primeAudio();
      var stopEl = ev.target.closest ? ev.target.closest('.dial-stop[data-stop]') : null;
      drag = {
        id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, moved: false,
        onKnob: knob.contains(ev.target),
        tapStop: stopEl ? stopEl.getAttribute('data-stop') : null,
        lastIdx: indexOf(currentId)
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
        dragging = true;
      }
      var b = bearing(ev);
      turnKnob(clampToSweep(b), true);          /* the knob follows the finger */
      var idx = stopAt(b);
      if (idx !== drag.lastIdx) {                /* crossed a detent */
        drag.lastIdx = idx;
        detent();
        go(STOPS[idx].id);
      }
    });

    function release(ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      var d = drag;
      drag = null;
      dragging = false;
      if (d.moved) {
        var idx = indexOf(currentId);
        settleOn(idx < 0 ? 0 : idx);             /* spring onto the stop */
        return;
      }
      if (ev.type === 'pointercancel') return;
      if (d.tapStop) go(d.tapStop);
      else if (d.onKnob) step(1);
    }
    dial.addEventListener('pointerup', release);
    dial.addEventListener('pointercancel', release);

    var wheelAt = 0;
    dial.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var now = Date.now();
      if (now - wheelAt < WHEEL_MS) return;
      wheelAt = now;
      primeAudio();
      step(ev.deltaY > 0 || ev.deltaX > 0 ? 1 : -1);
    }, { passive: false });
  }

  function wireKeys(knob) {
    knob.addEventListener('keydown', function (ev) {
      var k = ev.key;
      primeAudio();
      if (k === 'ArrowRight' || k === 'ArrowUp') step(1);
      else if (k === 'ArrowLeft' || k === 'ArrowDown') step(-1);
      else if (k === 'Home') go(STOPS[0].id);
      else if (k === 'End') go(STOPS[STOPS.length - 1].id);
      else if (k === 'Enter' || k === ' ') step(1);
      else return;
      ev.preventDefault();
    });
  }

  /* ---- hold, drawer, range tabs ------------------------------------------- */
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
    var hold = el('holdBtn'), detail = el('detailBtn'), lcd = el('lcd'), ranges = el('lcdRanges');
    if (hold) hold.addEventListener('click', function () { setHold(!held); });
    if (detail) detail.addEventListener('click', function () { openDrawer(); });
    if (lcd) {
      lcd.addEventListener('click', function (ev) {
        if (ranges && ranges.contains(ev.target)) return;   /* the tabs are their own control */
        openDrawer();
      });
      lcd.addEventListener('keydown', function (ev) {
        if (ev.target !== lcd) return;
        if (ev.key === 'Enter' || ev.key === ' ') { openDrawer(); ev.preventDefault(); }
      });
    }
    if (ranges) {
      ranges.addEventListener('click', function (ev) {
        var btn = ev.target.closest ? ev.target.closest('.rng[data-days]') : null;
        if (!btn) return;
        ev.stopPropagation();
        var days = parseInt(btn.getAttribute('data-days'), 10);
        if (days && MP.app && MP.app.setRange) MP.app.setRange(days);
      });
    }
  }

  /* ---- the screen --------------------------------------------------------- */
  function absText(abs, unit) {
    if (!isNum(abs)) return '';
    var a = Math.abs(abs);
    if (unit === 'USD') return MP.fmt.usd(a, a < 10 ? 4 : 2);
    return MP.fmt.num(a, 2);
  }

  /* "↘ $1,480.12 (1.94%)" for a price; "↗ 0.16" for a statistic. */
  function changeText(c, unit) {
    if (!c) return MP.fmt.DASH;
    if (isNum(c.pct)) {
      var abs = absText(c.abs, unit);
      return (c.pct >= 0 ? UP : DOWN) + ' ' + (abs ? abs + ' ' : '') + '(' + Math.abs(c.pct).toFixed(2) + '%)';
    }
    if (isNum(c.delta)) {
      return (c.delta >= 0 ? UP : DOWN) + ' ' + Math.abs(c.delta).toFixed(isNum(c.dp) ? c.dp : 2) + (c.suffix || '');
    }
    return MP.fmt.DASH;
  }

  function direction(c, series) {
    if (c && isNum(c.pct)) return c.pct < 0 ? 'down' : 'up';
    if (c && isNum(c.delta)) return c.delta < 0 ? 'down' : 'up';
    if (series && series.length > 1) return series[series.length - 1] < series[0] ? 'down' : 'up';
    return null;
  }

  function describe(r, off) {
    if (off) return 'Meter off. Press to open the details.';
    var title = MP.router && MP.router.TITLES ? MP.router.TITLES[currentId] : currentId;
    var value = r.empty ? 'no reading yet' : r.text + (r.unit ? ' ' + r.unit : '');
    var c = r.change;
    var moved = c && (isNum(c.pct) || isNum(c.delta));
    var change = moved ? ', ' + changeText(c, r.unit).replace(UP, 'up').replace(DOWN, 'down') + ' over ' + c.label : '';
    return title + ': ' + value + change + '. Press to open the details.';
  }

  function paint(r) {
    var lcd = el('lcd');
    if (!lcd) return;
    var off = currentId === 'off';
    var series = r.spark || [];
    var dir = direction(r.change, series);

    lcd.classList.toggle('is-off', off);
    setText('lcdMode', off ? '' : r.mode || '');

    var chart = el('lcdChart');
    if (chart) {
      chart.innerHTML = !off && series.length > 1
        ? G.smoothLine({ values: series, w: 600, h: 250, color: dir === 'down' ? 'var(--down)' : 'var(--up)', strokeWidth: 2.4 })
        : '';
    }

    setText('lcdPrice', off ? '' : r.text || '');
    setText('lcdUnit', off ? '' : r.unit || '');

    var chg = el('lcdChange');
    if (chg) {
      chg.textContent = off ? '' : changeText(r.change, r.unit);
      chg.className = 'lcd-chg' + (dir && !off ? ' is-' + dir : '');
    }
    setText('lcdChangeLabel', off ? '' : (r.change && r.change.label) || '');

    var ranges = el('lcdRanges');
    if (ranges) {
      /* kept in the layout even when idle: the screen must not change height
       * between stops, or the dial would move under a dragging finger */
      var idle = off || !r.ranges;
      ranges.classList.toggle('is-idle', idle);
      ranges.setAttribute('aria-hidden', idle ? 'true' : 'false');
      var btns = ranges.querySelectorAll('.rng');
      for (var b = 0; b < btns.length; b++) btns[b].tabIndex = idle ? -1 : 0;
      var days = MP.app && MP.app.state ? MP.app.state.hero.days : 1;
      var tabs = ranges.querySelectorAll('.rng[data-days]');
      for (var i = 0; i < tabs.length; i++) {
        var on = parseInt(tabs[i].getAttribute('data-days'), 10) === days;
        tabs[i].classList.toggle('is-on', on);
        tabs[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }

    lcd.setAttribute('aria-label', describe(r, off));
  }

  function refresh() {
    if (held || !currentId) return;
    var app = MP.app;
    if (!app || !app.reading) return;
    paint(app.reading(currentId));
  }

  /* ---- routing ------------------------------------------------------------ */
  function onStop(id) {
    var idx = indexOf(id);
    if (idx < 0) return;
    var changed = currentId !== null && currentId !== id;
    currentId = id;
    if (!dragging) settleOn(idx);      /* while dragging, the knob is the finger's */
    markLabel(id);
    if (changed && !dragging) detent(); /* a drag already clicked at the crossing */
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
    clampToSweep: clampToSweep,
    plateSvg: plateSvg,
    init: init,
    refresh: refresh,
    setHold: setHold,
    isHeld: function () { return held; },
    openDrawer: openDrawer,
    current: function () { return currentId; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
