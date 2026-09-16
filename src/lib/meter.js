/* ============================================================================
 * meter.js: the instrument itself: the rotary dial, the knob, and the screen.
 *
 * The dial has thirteen stops over 320 degrees, clockwise from OFF at the top,
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

  /* The dial's positions come from the stored layout (dial.js), not from a
   * list of every view the application has. The array is mutated in place
   * rather than replaced, so anything already holding MP.meter.STOPS keeps a
   * live reference. */
  var STOPS = [];
  var SWEEP_DEG = 320;                              /* OFF at the top to the last stop */
  var STEP_DEG = SWEEP_DEG;                         /* recomputed by applyDial */

  function stopsFrom(layout) {
    return layout.map(function (id) {
      return { id: id, label: MP.dial ? MP.dial.labelFor(id) : String(id).toUpperCase() };
    });
  }

  /* Rebuilds the plate for a layout: the stops, the angle between them, the
   * printed face and the knob's range. Safe to call before the DOM exists. */
  function applyDial(list) {
    var layout = MP.dial ? MP.dial.read(list) : ['off', 'subject'];
    var next = stopsFrom(layout);
    STOPS.length = 0;
    for (var i = 0; i < next.length; i++) STOPS.push(next[i]);
    STEP_DEG = SWEEP_DEG / Math.max(1, STOPS.length - 1);
    if (MP.meter) MP.meter.STEP_DEG = STEP_DEG;     /* the export carries the live value */
    renderPlate();
    var knob = el('knob');
    if (knob) knob.setAttribute('aria-valuemax', String(STOPS.length - 1));
    var idx = indexOf(currentId);
    if (idx >= 0) settleOn(idx);
    markLabel(currentId);
    return STOPS.slice();
  }

  function renderPlate() {
    var dial = el('dial');
    if (!dial) return;
    var old = dial.querySelector('.dial-plate');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    dial.insertAdjacentHTML('afterbegin', plateSvg());
  }

  STOPS.push.apply(STOPS, stopsFrom(MP.dial ? MP.dial.load() : ['off', 'subject']));
  STEP_DEG = SWEEP_DEG / Math.max(1, STOPS.length - 1);
  var DETENT_MS = 220;                              /* how long the click feedback lasts */
  var DRAW_MS = 700;                                /* how long a new trace takes to sweep in */
  var WHEEL_MS = 110;                               /* one step per wheel notch, no faster */

  /* plate geometry, in viewBox units; MARGIN leaves room for the longest label
   * at three o'clock, which would otherwise clip at the plate's edge */
  var SIZE = 300, CX = 150, CY = 150, MARGIN = 34;
  var R_FACE = 92, R_ARC = 105, R_TICK_IN = 100, R_TICK_OUT = 112, R_LABEL = 144;
  /* The labels stay put, but a touch target is a wedge, not a small circle at
   * the label: it spans the whole angular slice from one tick to the next, so
   * a tap anywhere between two ticks lands on the stop between them, and the
   * ring never has a dead spot between labels. The first and last stop's
   * outer edge reaches across half the gap to OFF, matching the same split
   * stopAt() already gives a drag that lands in that gap. */
  var R_HIT_IN = 96, R_HIT_OUT = 176;
  var HALF_DEAD = (360 - SWEEP_DEG) / 2;

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

  function changedFrom(was, id) { return was !== null && was !== id; }

  function polar(r, deg) {
    var t = deg * Math.PI / 180;
    return { x: (CX + r * Math.sin(t)).toFixed(2), y: (CY - r * Math.cos(t)).toFixed(2) };
  }

  /* One stop's touch target: an annular sector (a pie slice with the middle
   * cut out) from aStart to aEnd degrees, between R_HIT_IN and R_HIT_OUT.
   * Every wedge on the plate stays under 180 degrees, so the arc flags below
   * are always the simple case. */
  function sectorPath(aStart, aEnd) {
    var o0 = polar(R_HIT_OUT, aStart), o1 = polar(R_HIT_OUT, aEnd);
    var i1 = polar(R_HIT_IN, aEnd), i0 = polar(R_HIT_IN, aStart);
    return 'M' + o0.x + ',' + o0.y + 'A' + R_HIT_OUT + ',' + R_HIT_OUT + ' 0 0 1 ' + o1.x + ',' + o1.y +
      'L' + i1.x + ',' + i1.y + 'A' + R_HIT_IN + ',' + R_HIT_IN + ' 0 0 0 ' + i0.x + ',' + i0.y + 'Z';
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
    var half = STEP_DEG / 2;
    for (var i = 0; i < STOPS.length; i++) {
      var deg = angleOf(i);
      var t0 = polar(R_TICK_IN, deg), t1 = polar(R_TICK_OUT, deg), lp = polar(R_LABEL, deg);
      /* interior edges are shared evenly with a neighbor; the two outer
       * edges (first stop's start, last stop's end) reach into the dead
       * zone instead, since there is no neighbor there to share with */
      var sa = deg - (i === 0 ? HALF_DEAD : half);
      var ea = deg + (i === STOPS.length - 1 ? HALF_DEAD : half);
      s += '<line class="dial-tick" x1="' + t0.x + '" y1="' + t0.y + '" x2="' + t1.x + '" y2="' + t1.y + '"/>';
      s += '<g class="dial-stop" data-stop="' + STOPS[i].id + '">' +
        '<path class="dial-hit" d="' + sectorPath(sa, ea) + '"/>' +
        '<text class="dial-lab" x="' + lp.x + '" y="' + lp.y + '" text-anchor="middle" dominant-baseline="central">' +
        (STOPS[i].id === 'mover' ? '<tspan x="' + lp.x + '" dy="-5">MOVER</tspan><tspan x="' + lp.x + '" dy="12">LOSER</tspan>' : escapeText(STOPS[i].label)) + '</text></g>';
    }
    return s + '</svg>';
  }

  /* ---- state -------------------------------------------------------------- */
  var currentId = null;
  var lastStop = null;     /* the stop before this one, so BACK out of LEARN has somewhere to go */
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

  /* The probe stop wears the chosen coin's symbol. */
  function setStopLabel(id, text) {
    var label = String(text || '').toUpperCase().replace(/[^A-Z0-9&$.]/g, '').slice(0, 5) || 'PROBE';
    for (var i = 0; i < STOPS.length; i++) if (STOPS[i].id === id) STOPS[i].label = label;
    var node = document.querySelector('.dial-stop[data-stop="' + id + '"] .dial-lab');
    if (node) node.textContent = label;
    if (id === currentId) setCaption(id);   /* the caption names the stop, so it follows the ticker */
  }

  /* The label printed on the plate for a stop right now, which for SUBJECT
   * and PROBE is whatever ticker they are currently wearing. */
  function plateLabel(id) {
    for (var i = 0; i < STOPS.length; i++) if (STOPS[i].id === id) return STOPS[i].label;
    return MP.dial ? MP.dial.labelFor(id) : String(id).toUpperCase();
  }

  /* The plate can only print a code. This prints what the code measures, in
   * the same plain words the customize screen uses, which until now was the
   * only place they appeared. It is what lets VOL and CORR and DD stay on
   * the dial without stranding a reader who has not met them before. */
  function setCaption(id) {
    var node = el('dialCaption');
    if (!node) return;
    var note = MP.dial && MP.dial.NOTES ? MP.dial.NOTES[id] : '';
    if (!note) { node.textContent = ''; return; }
    node.innerHTML = '<b>' + escapeText(plateLabel(id)) + '</b> · ' + escapeText(note);
  }

  function markLabel(id) {
    var labels = document.querySelectorAll('.dial-stop[data-stop]');
    for (var i = 0; i < labels.length; i++) {
      labels[i].classList.toggle('is-on', labels[i].getAttribute('data-stop') === id);
    }
    setCaption(id);
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
  var drawTimer = null;
  var audio = null;
  var master = null;     /* every sound goes through this */
  var softClick = null;  /* option 15: quiet camera-button press and release */
  var lastClickAt = 0;
  var SOUND_KEY = 'sound';
  var soundIsOn = readSound();

  function readSound() {
    return (MP.store ? MP.store.get(SOUND_KEY, false) : false) === true;
  }

  /* The audio context has to be born inside a user gesture, so the pointer
   * and key handlers prime it; the detent then only has to play. */
  function primeAudio() {
    if (audio) {
      if (audio.state === 'suspended' && audio.resume) audio.resume().catch(function () { /* later */ });
      return;
    }
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return;
    try {
      try { audio = new AC({ latencyHint: 'interactive' }); } catch (e1) { audio = new AC(); }
      master = audio.createGain();
      master.gain.value = 1;
      /* a gentle limiter, so presses that overlap on a fast spin never clip */
      var limiter = audio.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.ratio.value = 4;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.05;
      master.connect(limiter);
      limiter.connect(audio.destination);
      softClick = makeSoftClick(audio);
    } catch (e) { audio = null; master = null; }
  }

  function canPlay() {
    return soundIsOn && !!audio && !!master && !!softClick && audio.state === 'running';
  }

  /* Same filtered-noise recipe and quiet peak as sample 15. Fixed 48 kHz
   * synthesis keeps its tone consistent across devices; Web Audio resamples. */
  function makeSoftClick(ctx) {
    var rate = 48000, n = Math.floor(rate * 0.14);
    var buffer = ctx.createBuffer(1, n, rate), ch = buffer.getChannelData(0);
    var seed = 2464184175, low = 0, band = 0, smooth = 0, peak = 0;
    var f = 2 * Math.sin(Math.PI * 1900 / rate);
    for (var i = 0; i < n; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      var t = i / rate;
      smooth += 0.18 * (seed / 4294967296 * 2 - 1 - smooth);
      low += f * band;
      var high = smooth - low - 1.2 * band;
      band += f * high;
      var v = band * (1 - Math.exp(-t / 0.0012)) * Math.exp(-t / 0.0035);
      var u = t - 0.048;
      if (u > 0) v += band * 0.22 * (1 - Math.exp(-u / 0.0015)) * Math.exp(-u / 0.0035);
      ch[i] = v;
      peak = Math.max(peak, Math.abs(v));
    }
    if (peak > 0) for (var j = 0; j < n; j++) ch[j] *= 0.135 / peak;
    return buffer;
  }

  var FAST_MS = 45;
  function clickParams(kind, sinceMs) {
    var fast = typeof sinceMs === 'number' && sinceMs < FAST_MS;
    return { gain: kind === 'settle' ? 0.35 : (fast ? 0.65 : 1), dur: 0.14 };
  }

  function click(kind, delay) {
    if (!canPlay()) return;
    var now = Date.now(), since = now - lastClickAt;
    if (kind !== 'settle') lastClickAt = now;
    var p = clickParams(kind || 'detent', since);
    try {
      var src = audio.createBufferSource(), gain = audio.createGain();
      src.buffer = softClick;
      gain.gain.value = p.gain;
      src.connect(gain);
      gain.connect(master);
      src.onended = function () { src.disconnect(); gain.disconnect(); };
      src.start(audio.currentTime + (delay || 0));
    } catch (e) { /* no sound is fine */ }
  }

  /* The detent click, under the name the switch, the stepper and the skin
   * dots already use. */
  function tickSound() { click('detent'); }

  /* ---- the speaker: sound on or off ----------------------------------------- */
  function soundOn() { return soundIsOn; }

  function markSound() {
    var btn = el('lcdSound');
    if (!btn) return;
    btn.classList.toggle('is-on', soundIsOn);
    btn.setAttribute('aria-pressed', soundIsOn ? 'true' : 'false');
    btn.setAttribute('aria-label', soundIsOn ? 'Sound on. Press to mute.' : 'Sound off. Press to turn it on.');
  }

  function setSound(on) {
    soundIsOn = !!on;
    if (MP.store) MP.store.set(SOUND_KEY, soundIsOn);
    markSound();
    return soundIsOn;
  }

  /* ---- the first-visit hint ------------------------------------------------- */
  /* Once per browser: 1.2 s after the first stop, the knob wiggles and a
   * label says it turns. Any touch of the dial, or the label running its
   * three seconds, retires it for good. */
  var HINT_KEY = 'hinted';
  var hintTimer = null, hintLive = false, hintArmed = false;

  function endHint() {
    clearTimeout(hintTimer);
    hintLive = false;
    var knob = el('knob'), label = el('dialHint');
    if (knob) knob.classList.remove('is-hint');
    if (label) label.classList.remove('is-on');
    if (MP.store) MP.store.set(HINT_KEY, true);
  }

  function hint() {
    if (!MP.store || MP.store.get(HINT_KEY, false) || currentId === 'off') return;
    hintLive = true;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () {
      var knob = el('knob'), label = el('dialHint');
      if (knob) knob.classList.add('is-hint');
      if (label) label.classList.add('is-on');
      hintTimer = setTimeout(endHint, 3000);
    }, 1200);
  }

  function firstVisit() {
    return !!MP.store && !MP.store.get(HINT_KEY, false);
  }

  /* Choosing a starting point, or simply turning the dial, puts the welcome
   * away and never brings it back. */
  function dismissWelcome() {
    if (MP.store) MP.store.set(HINT_KEY, true);
    if (screenMode === 'welcome') setScreen('reading');
    return true;
  }

  function touchedDial() {
    if (screenMode === 'welcome') { dismissWelcome(); return; }
    if (hintLive) endHint();
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
    sweepChart();
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
      touchedDial();
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
      /* pushing into the dead zone past either end: one heavier clunk */
      var inGap = b > SWEEP_DEG;
      if (inGap && !drag.atStop) click('stop');
      drag.atStop = inGap;
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
        click('settle', 0.12);                   /* where the spring lands */
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
      touchedDial();
      step(ev.deltaY > 0 || ev.deltaX > 0 ? 1 : -1);
    }, { passive: false });
  }

  function wireKeys(knob) {
    knob.addEventListener('keydown', function (ev) {
      var k = ev.key;
      primeAudio();
      touchedDial();
      if (k === 'ArrowRight' || k === 'ArrowUp') step(1);
      else if (k === 'ArrowLeft' || k === 'ArrowDown') step(-1);
      else if (k === 'Home') go(STOPS[0].id);
      else if (k === 'End') go(STOPS[STOPS.length - 1].id);
      else if (k === 'Enter' || k === ' ') step(1);
      else return;
      ev.preventDefault();
    });
  }

  /* Arrows move the dial from anywhere on the page, not only once the knob
   * has focus, so this listens on the document rather than the knob alone.
   * It steps back only for a field that gives arrows a meaning of their own:
   * typing, a native select, or a modal that should hold focus. A plain
   * button (a soft key, a skin swatch, a watch row) has no such meaning, so
   * it must not be excluded here either: browsers leave focus sitting on
   * whatever button was last clicked, and excluding buttons meant the very
   * first soft-key press permanently silenced the dial's arrow keys for the
   * rest of the visit. */
  function wireGlobalKeys() {
    document.addEventListener('keydown', function (ev) {
      var k = ev.key;
      if (k !== 'ArrowRight' && k !== 'ArrowUp' && k !== 'ArrowLeft' && k !== 'ArrowDown' && k !== 'Home' && k !== 'End') return;
      if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
      var target = ev.target;
      if (target && (target.matches('input, textarea, select, [contenteditable="true"]') || target.closest('dialog[open]'))) return;
      primeAudio();
      touchedDial();
      if (k === 'ArrowRight' || k === 'ArrowUp') step(1);
      else if (k === 'ArrowLeft' || k === 'ArrowDown') step(-1);
      else if (k === 'Home') go(STOPS[0].id);
      else if (k === 'End') go(STOPS[STOPS.length - 1].id);
      ev.preventDefault();
    });
  }

  /* ---- hold, drawer, range tabs ------------------------------------------- */
  function setHold(on) {
    held = !!on;
    markKeys();
    var ann = el('lcdHold');
    if (ann) ann.classList.toggle('is-on', held);
    if (!held) refresh();
  }

  function openDrawer(open) {
    var drawer = el('drawer');
    if (!drawer) return;
    var show = open === undefined ? drawer.hidden : !!open;
    drawer.hidden = !show;
    var btn = keyEl('info');
    if (btn) {
      btn.setAttribute('aria-expanded', show && (screenMode!=='learn'||MP.router.currentPanel()==='learn') ? 'true' : 'false');
      btn.classList.toggle('is-on', show);
    }
    if (show && MP.track) MP.track.event('drawer_opened', MP.router && MP.router.currentView ? MP.router.currentView() : '');
  }

  /* ---- REL, MIN/MAX, ALERT ------------------------------------------------ */
  var lastReading = null;   /* the reading last painted, for the function keys */

  function pressKey(act, on, attr) {
    var btn = keyEl(act);
    if (!btn) return;
    btn.classList.toggle('is-on', !!on);
    btn.setAttribute(attr || 'aria-pressed', on ? 'true' : 'false');
  }

  function relPress() {
    if (!MP.funcs || !lastReading) return;
    primeAudio();
    MP.funcs.rel.toggle(currentId, lastReading.value);
    refresh(true);
  }

  /* On: start capturing. Off: clear. */
  function minmaxPress() {
    if (!MP.funcs) return;
    primeAudio();
    var fm = MP.funcs.minmax;
    if (fm.isShown(currentId)) { fm.show(currentId, false); fm.reset(currentId); }
    else fm.show(currentId, true);
    refresh(true);
  }

  function openEditor() {
    var form = el('lcdEdit'), input = el('lcdEditLevel');
    if (!form || !input || !lastReading || currentId === 'off' || screenMode !== 'reading' || !isNum(lastReading.value)) return;
    primeAudio();
    var dp = isNum(lastReading.dp) ? lastReading.dp : 2;
    input.value = String(Number(lastReading.value.toFixed(dp)));
    input.step = dp ? String(Math.pow(10, -dp)) : '1';
    form.hidden = false;
    pressKey('alert', true, 'aria-expanded');
    input.focus();
    input.select();
  }

  function closeEditor() {
    var form = el('lcdEdit');
    if (form) form.hidden = true;
    pressKey('alert', false, 'aria-expanded');
  }

  function submitEditor(ev) {
    if (ev) ev.preventDefault();
    var input = el('lcdEditLevel');
    var level = input ? parseFloat(input.value) : NaN;
    if (!isNum(level) || !lastReading || !MP.alerts) return;
    /* asked inside the gesture, which is the only time browsers allow it */
    if (root.Notification && root.Notification.permission === 'default') {
      try { root.Notification.requestPermission(); } catch (e) { /* not available */ }
    }
    MP.alerts.add(currentId, level, lastReading.value, lastReading.unit);
    closeEditor();
    if (MP.app && MP.app.renderAlerts) MP.app.renderAlerts();
    refresh(true);
  }

  function showAlerts() {
    if (MP.router && MP.router.overridePanel) MP.router.overridePanel('alerts');
    openDrawer(true);
  }

  /* ---- alarm -------------------------------------------------------------- */
  var alarmTimer = null;

  /* Three 1 kHz pulses: the continuity beep. Silent until a gesture has
   * primed the audio context. */
  function beep() {
    if (!soundIsOn || !audio || audio.state !== 'running') return;
    try {
      var t = audio.currentTime;
      for (var i = 0; i < 3; i++) {
        var t0 = t + i * 0.24;
        var osc = audio.createOscillator(), gain = audio.createGain();
        osc.type = 'square';
        osc.frequency.value = 1000;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.06, t0 + 0.006);
        gain.gain.setValueAtTime(0.06, t0 + 0.11);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.135);
        osc.connect(gain);
        gain.connect(audio.destination);
        osc.start(t0);
        osc.stop(t0 + 0.14);
      }
    } catch (e) { /* no sound is fine */ }
  }

  function notify(text) {
    if (!root.Notification || root.Notification.permission !== 'granted') return;
    var opts = { body: text, tag: 'mm-alert-' + Date.now() };
    function plain() { try { void new root.Notification('Multimeter', opts); } catch (e) { /* page-context constructor unsupported */ } }
    var sw = root.navigator && root.navigator.serviceWorker;
    if (sw && sw.getRegistration) {
      sw.getRegistration().then(function (reg) {
        if (reg && reg.showNotification) return reg.showNotification('Multimeter', opts);
        plain();
      }).catch(plain);
    } else {
      plain();
    }
  }

  /* Once per crossing: beep, flash the screen, pulse the phone and notify. */
  function alarm(messages) {
    beep();
    var lcd = el('lcd');
    if (lcd) {
      lcd.classList.remove('is-alarm');
      void lcd.offsetWidth;
      lcd.classList.add('is-alarm');
      clearTimeout(alarmTimer);
      alarmTimer = setTimeout(function () { lcd.classList.remove('is-alarm'); }, 1300);
    }
    if (root.navigator && typeof root.navigator.vibrate === 'function') {
      try { root.navigator.vibrate([80, 80, 80, 80, 80]); } catch (e) { /* not permitted */ }
    }
    (messages || []).forEach(notify);
  }

  function wireButtons() {
    var lcd = el('lcd'), ranges = el('lcdRanges'), keys = el('keys');
    var form = el('lcdEdit'), cancel = el('lcdEditCancel'), bell = el('lcdBell');
    if (keys) {
      keys.addEventListener('click', function (ev) {
        var btn = ev.target.closest ? ev.target.closest('.key[data-act]') : null;
        if (!btn || btn.disabled) return;
        primeAudio();
        pressSoftKey(btn.getAttribute('data-act'));
      });
    }
    if (form) {
      form.addEventListener('submit', submitEditor);
      form.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { closeEditor(); ev.preventDefault(); } });
    }
    if (cancel) cancel.addEventListener('click', closeEditor);
    if (bell) bell.addEventListener('click', showAlerts);
    /* REL keeps its own annunciator rather than a key: the row has five
     * slots and an explanation earned one of them. */
    var relBtn = el('lcdRel');
    if (relBtn) {
      relBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        primeAudio();
        relPress();
      });
    }
    var speaker = el('lcdSound');
    if (speaker) {
      speaker.addEventListener('click', function (ev) {
        ev.stopPropagation();
        primeAudio();
        setSound(!soundIsOn);
        if (soundIsOn) click('detent');
      });
    }
    if (lcd) {
      lcd.addEventListener('click', function (ev) {
        /* the tabs, the editor, the bell, the panels are controls of their own */
        if (screenMode !== 'reading') return;
        if (ev.target.closest && ev.target.closest('#lcdRanges, #lcdEdit, #lcdBell, #lcdSound, .lcd-panel')) return;
        openDrawer();
      });
      lcd.addEventListener('keydown', function (ev) {
        if (ev.target !== lcd || screenMode !== 'reading') return;
        if (ev.key === 'Enter' || ev.key === ' ') { openDrawer(); ev.preventDefault(); }
      });
    }
    if (ranges) {
      ranges.addEventListener('click', function (ev) {
        var btn = ev.target.closest ? ev.target.closest('.rng[data-tab]') : null;
        if (!btn || btn.disabled) return;
        ev.stopPropagation();
        var app = MP.app;
        if (!app) return;
        var tab = btn.getAttribute('data-tab'), value = btn.getAttribute('data-value');
        primeAudio();
        if (tab === 'end' && app.toggleMoverEnd) {
          app.toggleMoverEnd();
          tickSound();
          swapScreen();
        } else if (tab === 'ranges' && app.setRange) {
          app.setRange(parseInt(value, 10));
        } else if (tab === 'switch' && app.setMoversKind) {
          app.setMoversKind(value);
          tickSound();
          swapScreen();
        } else if (tab === 'step' && app.stepWatch) {
          app.stepWatch(parseInt(value, 10));
          tickSound();
          swapScreen();
        } else if ((tab === 'watch' || tab === 'subject-range') && app.setWatchRange) {
          app.setWatchRange(parseInt(value, 10));
        }
      });
    }
  }

  /* ---- the screen --------------------------------------------------------- */
  /* The absolute move, in the reading's own decimals (a cheap coin's four,
   * everything else's two), never the price rule that would print $0.0100. */
  function absText(abs, unit, dp) {
    if (!isNum(abs)) return '';
    var a = Math.abs(abs), d = isNum(dp) ? dp : 2;
    if (unit === 'USD') return MP.fmt.usd(a, d);
    return MP.fmt.num(a, d);
  }

  /* "↘ $1,480.12 (1.94%)" for a price; "↗ 0.16" for a statistic. */
  function changeText(c, unit) {
    if (!c) return MP.fmt.DASH;
    if (isNum(c.pct)) {
      var abs = absText(c.abs, c.usd ? 'USD' : unit, c.dp);   /* usd: a price move under a non-price headline */
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
    if (typeof r.note === 'string') {
      return title + ', session of ' + r.text + '. ' + r.note + ' ' + (r.caption || '') + '. Press to open the details.';
    }
    if (r.badge && r.badge.dir === 'down') title = 'Largest weekly decline';
    if (r.say) return title + ': ' + r.say + '. Press to open the details.';
    var value = r.empty ? 'no reading yet' : r.text + (r.unit ? ' ' + r.unit : '');
    var c = r.change;
    var moved = c && (isNum(c.pct) || isNum(c.delta));
    var change = moved ? ', ' + changeText(c, r.unit).replace(UP, 'up').replace(DOWN, 'down') + ' over ' + c.label : '';
    return title + ': ' + value + change + '. Press to open the details.';
  }

  /* The row under the readout: the range tabs for the coins, the Stocks |
   * Crypto switch for MOVER and LOSER, a stepper and ranges for WATCH. It
   * keeps its height when idle, so the dial never moves under a dragging
   * finger, and its buttons are rebuilt only when the kind of row changes. */
  function tabsHtml(model) {
    var html = '';
    if (model.kind === 'watch') {
      html += '<button type="button" class="rng rng-step" data-tab="step" data-value="-1" aria-label="Previous stock">‹</button>' +
        '<button type="button" class="rng rng-step" data-tab="step" data-value="1" aria-label="Next stock">›</button>';
    }
    (model.options || []).forEach(function (o) {
      html += '<button type="button" class="rng" data-tab="' + model.kind + '" data-value="' + escapeText(o[0]) +
        '" aria-pressed="false">' + escapeText(o[1]) + '</button>';
    });
    if (model.endLabel) html += '<button type="button" class="rng rng-end" data-tab="end"></button>';
    return html;
  }

  function renderTabs(model) {
    var host = el('lcdRanges');
    if (!host) return;
    var idle = !model;
    host.classList.toggle('is-idle', idle);
    host.setAttribute('aria-hidden', idle ? 'true' : 'false');
    if (model) {
      var sig = model.kind + '|' + (model.options || []).map(function (o) { return o[0]; }).join(',') + (model.endLabel ? '|end' : '');
      if (host.getAttribute('data-sig') !== sig) {
        host.setAttribute('data-sig', sig);
        host.setAttribute('data-kind', model.kind);
        host.setAttribute('aria-label', model.label || 'Chart range');
        host.innerHTML = tabsHtml(model);
      }
    }
    var btns = host.querySelectorAll('.rng');
    for (var i = 0; i < btns.length; i++) {
      btns[i].tabIndex = idle ? -1 : 0;
      if (btns[i].getAttribute('data-tab') === 'end') {
        btns[i].textContent = model && model.endLabel || '';
        btns[i].setAttribute('data-end', model && model.endLabel === 'MOVER' ? 'mover' : 'loser');
        btns[i].setAttribute('aria-label', 'Show ' + (model && model.endLabel === 'MOVER' ? 'movers' : 'losers'));
        continue;
      }
      if (btns[i].getAttribute('data-tab') === 'step') {
        btns[i].disabled = !model || (model.count || 0) < 2;
        continue;
      }
      var on = !!model && String(model.value) === btns[i].getAttribute('data-value');
      btns[i].classList.toggle('is-on', on);
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  /* The readout's short fade, for a change that is not a turn of the dial. */
  function swapScreen() {
    var lcd = el('lcd');
    if (!lcd) return;
    lcd.classList.remove('is-swap');
    void lcd.offsetWidth;
    lcd.classList.add('is-swap');
    clearTimeout(detentTimer);
    detentTimer = setTimeout(function () { lcd.classList.remove('is-swap'); }, DETENT_MS);
    sweepChart();
  }

  /* A new measurement draws its trace in from the left, so the line reads as
   * something the instrument is taking rather than a picture being swapped.
   * It runs on a change of stop or of subject, and deliberately not on a
   * live price tick: the screen stays still while it is being read. The
   * window is longer than the detent's, so it carries its own timer. */
  function sweepChart() {
    var lcd = el('lcd');
    if (!lcd) return;
    lcd.classList.remove('is-drawing');
    void lcd.offsetWidth;
    lcd.classList.add('is-drawing');
    clearTimeout(drawTimer);
    drawTimer = setTimeout(function () { lcd.classList.remove('is-drawing'); }, DRAW_MS);
  }

  /* ---- the screen's modes --------------------------------------------------- */
  /* The display is the workspace. It reads an instrument, searches for one,
   * or lists the watched stocks, and the modes swap inside the same box, so
   * the screen never changes height and the dial never moves. */
  var screenMode = 'reading';
  var MODES = ['search', 'list', 'learn', 'welcome', 'probe', 'config'];

  function screen() { return screenMode; }

  /* topic: for the learn mode, the concept to explain. Re-entering learn with
   * a new topic repaints rather than returning early. */
  function setScreen(mode, topic) {
    var next = MODES.indexOf(mode) >= 0 ? mode : 'reading';
    if (next === screenMode && next !== 'learn') return screenMode;
    screenMode = next;
    var lcd = el('lcd');
    if (lcd) {
      lcd.classList.toggle('is-search', next === 'search');
      lcd.classList.toggle('is-list', next === 'list');
      lcd.classList.toggle('is-learn', next === 'learn');
      lcd.classList.toggle('is-welcome', next === 'welcome');
      lcd.classList.toggle('is-probe', next === 'probe');
      lcd.classList.toggle('is-config', next === 'config');
    }
    [['lcdSearch', 'search'], ['lcdList', 'list'], ['lcdLearn', 'learn'], ['lcdWelcome', 'welcome'], ['lcdProbe', 'probe'], ['lcdConfig', 'config']].forEach(function (p) {
      var node = el(p[0]);
      if (node) node.hidden = next !== p[1];
    });
    swapScreen();
    renderKeys();
    if (next === 'search' && MP.app && MP.app.openSearch) MP.app.openSearch();
    if (next === 'list' && MP.app && MP.app.renderScreenList) MP.app.renderScreenList();
    if (next === 'learn' && MP.app && MP.app.openLearn) MP.app.openLearn(topic);
    if (next === 'probe' && MP.app && MP.app.openProbe) MP.app.openProbe(topic);
    if (next === 'config' && MP.app && MP.app.openDialConfig) MP.app.openDialConfig();
    refresh(true);
    return screenMode;
  }

  /* ---- soft keys ------------------------------------------------------------ */
  /* Five keys whose labels follow the mode, so the row always operates what
   * is on the screen. HOLD keeps the last slot everywhere: a red key that
   * moves is a trap. */
  /* What the screen is doing decides the row first. */
  var MODE_KEYS = {
    search: [['cancel', 'CANCEL'], ['none', ''], ['none', ''], ['none', ''], ['hold', 'HOLD']],
    list: [['open', 'OPEN'], ['add', 'ADD'], ['remove', 'REMOVE'], ['info', 'Explore charts'], ['hold', 'HOLD']],
    learn: [['back', 'BACK'], ['deeper', 'MORE DETAIL'], ['none', ''], ['info', 'Full explanation'], ['hold', 'HOLD']],
    welcome: [['data', 'DATA'], ['none', ''], ['none', ''], ['none', ''], ['hold', 'HOLD']],
    probe: [['back', 'BACK'], ['ask', 'ASK'], ['none', ''], ['source', 'SOURCE'], ['hold', 'HOLD']],
    config: [['back', 'BACK'], ['none', ''], ['reset', 'RESET'], ['save', 'SAVE'], ['hold', 'HOLD']]
  };

  /* Reading a price: the meter's own functions. Slot two is LEARN at every
   * stop, so the way to an explanation never moves. */
  var PRICE_KEYS = [['data', 'DATA'], ['learn', 'LEARN'], ['minmax', 'MIN/MAX'], ['alert', 'ALERT'], ['hold', 'HOLD']];

  /* Stops whose third and fourth keys are worth something else. A statistic
   * takes no alert and no minimum, so those slots carry the pair selector
   * and the drawer instead; a mover is a stock you may want to keep. */
  /* The key says INDEX, not COMPARE: it is the widest label on the row and
   * ran past its own key at every size. The comparison it enables is taught
   * by name inside LEARN, where there is room for the word. */
  /* PROBE takes the fourth slot wherever a measurement exists for it to
   * investigate. The drawer is still one click on the screen away. */
  var STATS_KEYS = [['data', 'DATA'], ['learn', 'LEARN'], ['compare', 'INDEX'], ['probe', 'PROBE'], ['hold', 'HOLD']];
  var STOP_KEYS = {
    corr: STATS_KEYS,
    vol: STATS_KEYS,
    dd: STATS_KEYS,
    mover: [['data', 'DATA'], ['learn', 'LEARN'], ['none', ''], ['probe', 'PROBE'], ['hold', 'HOLD']],
    loser: [['data', 'DATA'], ['learn', 'LEARN'], ['none', ''], ['probe', 'PROBE'], ['hold', 'HOLD']],
    watch: [['data', 'DATA'], ['learn', 'LEARN'], ['list', 'LIST'], ['remove', 'REMOVE'], ['hold', 'HOLD']],
    off: [['data', 'DATA'], ['learn', 'LEARN'], ['none', ''], ['info', 'Explore charts'], ['hold', 'HOLD']]
  };

  function keySet(mode, stop) {
    var m = mode || screenMode;
    if (MODE_KEYS[m]) return MODE_KEYS[m];
    var s = stop === undefined ? currentId : stop;
    return STOP_KEYS[s] || PRICE_KEYS;
  }

  function keyEl(act) { return document.querySelector('.keys .key[data-act="' + act + '"]'); }

  function renderKeys() {
    var set = keySet();
    var keys = document.querySelectorAll('.keys .key');
    for (var i = 0; i < keys.length && i < set.length; i++) {
      var act = set[i][0];
      keys[i].removeAttribute('aria-pressed');
      keys[i].removeAttribute('aria-expanded');
      keys[i].setAttribute('data-act', act);
      keys[i].textContent = set[i][1];
      keys[i].disabled = act === 'none';
      keys[i].hidden = act === 'none';
      keys[i].classList.toggle('key-hold', act === 'hold');
      /* the end key names the side it would turn to, not the side shown */
      if (act === 'end' && MP.app && MP.app.moverEndLabel) keys[i].textContent = MP.app.moverEndLabel();
      if (act === 'info') keys[i].setAttribute('aria-controls', 'drawer');
      else keys[i].removeAttribute('aria-controls');
    }
    markKeys();
  }

  /* the lit states the current row still owns */
  function markKeys() {
    var hold = keyEl('hold');
    if (hold) {
      hold.classList.toggle('is-held', held);
      hold.setAttribute('aria-pressed', held ? 'true' : 'false');
    }
    var info = keyEl('info'), drawer = el('drawer');
    if (info) info.setAttribute('aria-expanded', drawer && !drawer.hidden && (screenMode!=='learn'||MP.router.currentPanel()==='learn') ? 'true' : 'false');
  }

  /* Where CANCEL and BACK land: the list on the watch stop, the explanation
   * on the learn stop, the reading everywhere else. */
  function homeMode() {
    if (currentId === 'watch') return 'list';
    if (currentId === 'learn') return 'learn';
    if (currentId === 'investigate') return 'probe';
    return 'reading';
  }

  function pressSoftKey(act) {
    var form = el('lcdEdit');
    if (act === 'data') { setScreen(screenMode === 'search' ? homeMode() : 'search'); return; }
    if (act === 'cancel') { setScreen(homeMode()); return; }
    if (act === 'back') {
      /* on the learn and investigate stops there is no reading to go back
       * to, so the dial goes instead */
      if (currentId === 'learn' || currentId === 'investigate') go(lastStop || 'btc');
      else setScreen(homeMode());
      return;
    }
    if (act === 'learn') { setScreen('learn'); return; }
    if (act === 'deeper') { if (MP.app && MP.app.learnDeeper) MP.app.learnDeeper(); return; }
    if (act === 'probe') { setScreen('probe'); return; }
    if (act === 'ask') { if (MP.app && MP.app.focusProbeAsk) MP.app.focusProbeAsk(); return; }
    if (act === 'source') { if (MP.app && MP.app.toggleProbeSource) MP.app.toggleProbeSource(); return; }
    if (act === 'end') { if (MP.app && MP.app.toggleMoverEnd) MP.app.toggleMoverEnd(); return; }
    if (act === 'customize') { setScreen('config'); return; }
    if (act === 'save') { if (MP.app && MP.app.saveDialConfig) MP.app.saveDialConfig(); return; }
    if (act === 'reset') { if (MP.app && MP.app.resetDialConfig) MP.app.resetDialConfig(); return; }
    if (act === 'info') { if(screenMode==='learn'){MP.router.overridePanel('learn');openDrawer(true);var heading=el('learnCard');if(heading){heading.setAttribute('tabindex','-1');heading.scrollIntoView({block:'start',behavior:'smooth'});heading.focus({preventScroll:true});}}else openDrawer(); markKeys(); return; }
    if (act === 'minmax') { minmaxPress(); return; }
    if (act === 'alert') { if (form && !form.hidden) closeEditor(); else openEditor(); return; }
    if (act === 'add') { setScreen('search'); return; }
    if (act === 'open') { if (MP.app && MP.app.openWatchRow) MP.app.openWatchRow(-1); return; }
    if (act === 'list') { setScreen('list'); return; }
    if (act === 'watch') { if (MP.app && MP.app.toggleWatchCurrent) MP.app.toggleWatchCurrent(); return; }
    if (act === 'compare') { if (MP.app && MP.app.cycleIndex) MP.app.cycleIndex(); return; }
    if (act === 'remove') { if (MP.app && MP.app.removeCurrentWatch) MP.app.removeCurrentWatch(); return; }
    if (act === 'hold') setHold(!held);
  }

  function paint(r) {
    var lcd = el('lcd');
    if (!lcd) return;
    var off = currentId === 'off';
    var series = r.spark || [];
    var dir = direction(r.change, series);

    lcd.classList.toggle('is-off', off);
    var modeEl = el('lcdMode');
    if (modeEl) {
      if (!off && r.badge && r.badge.text) {
        modeEl.innerHTML = '<b class="lcd-badge is-' + (r.badge.dir === 'down' ? 'down' : 'up') + '">' +
          escapeText(r.badge.text) + '</b>' + escapeText(r.mode || '');
      } else {
        modeEl.textContent = off ? '' : screenMode === 'learn' ? 'LEARN · CURRENT MEASUREMENT' : screenMode === 'probe' ? 'PROBE · CURRENT MEASUREMENT' : r.mode || '';
      }
    }

    var chart = el('lcdChart');
    if (chart) {
      /* the NOTE stop shows words where the other stops draw a line */
      var graph = series.length > 1 && series.some(isNum);
      var title = r.chartTitle || 'PRICE HISTORY';
      var detail = r.chartDetail || (graph ? 'Historical prices. The selected range is shown below.' : 'A chart appears once verified history loads. Press DATA to choose another instrument.');
      chart.innerHTML = off
        ? '<div class="chart-state"><strong>READY TO EXPLORE</strong><p>Press DATA to choose a market.</p><p>Turn the dial to measure it.</p><p>LEARN explains any number on screen.</p></div>'
        : typeof r.note === 'string' ? '<div class="lcd-note">' + escapeText(r.note) + '</div>'
        : graph && ['vol', 'corr', 'dd', 'beta'].indexOf(currentId) < 0 ? G.smoothLine({ values: series, w: 600, h: 250, color: (r.headDir || dir) === 'down' ? 'var(--down)' : 'var(--up)', strokeWidth: 2.4 })
        : graph ? '<div class="measurement-chart"><span class="chart-title">' + escapeText(title) + '</span>' +
          G.smoothLine({ values: series, w: 600, h: 250, color: (r.headDir || dir) === 'down' ? 'var(--down)' : 'var(--up)', strokeWidth: 2.4 }) +
          '<span class="chart-detail">' + escapeText(detail) + '</span></div>'
        : '<div class="chart-state"><strong>' + escapeText(r.chartState || (['vol', 'corr', 'dd'].indexOf(currentId) >= 0 ? 'INSUFFICIENT HISTORY' : 'PRICE HISTORY UNAVAILABLE')) + '</strong><p>' + escapeText(detail) + '</p></div>';
    }

    var priceEl = el('lcdPrice');
    if (priceEl) {
      /* MOVER, LOSER and WATCH lead with the ticker; MOVER and LOSER colour
       * the week's move by its sign */
      if (!off && r.ticker) priceEl.innerHTML = '<span class="lcd-ticker">' + escapeText(r.ticker) + '</span>' + escapeText(r.text || '');
      else priceEl.textContent = off ? '' : r.text || '';
      priceEl.className = 'lcd-price' + (!off && r.headDir ? ' is-' + r.headDir : '');
    }
    var identityEl = el('lcdIdentity');
    if (identityEl) {
      /* The line keeps its place even with nothing to name. Hiding it made
       * the display twenty pixels shorter on every stop without an identity,
       * so the page resized as the dial turned.
       *
       * The trade description rides in its own span. On a phone the line has
       * room for the company name and not for both, and a name cut off at
       * "Advanced Micro Dev..." names nothing, so the span is dropped there
       * rather than the whole line being trimmed from the right. */
      var note = off ? '' : r.identityNote || '';
      identityEl.innerHTML = off ? '' : escapeText(r.identity || '') +
        (note ? '<span class="lcd-identity-note"> · ' + escapeText(note) + '</span>' : '');
    }
    setText('lcdUnit', off || (r.unit === '%' && /%$/.test(r.text)) ? '' : r.unit || '');

    var chg = el('lcdChange');
    if (chg) {
      var plain = r.caption || (r.empty && r.hint);
      var line = r.caption ? r.caption : r.empty && r.hint ? r.hint : changeText(r.change, r.unit);
      chg.textContent = off ? '' : (r.lead && !r.empty ? r.lead + '   ' + line : line);
      /* is-plain marks prose rather than a measurement. A narrow screen may
       * trim a sentence; it may not trim a figure. */
      chg.className = 'lcd-chg' + (dir && !off && !plain ? ' is-' + dir : '') +
        (r.caption ? ' is-caption' : '') + (plain ? ' is-plain' : '');
    }
    setText('lcdChangeLabel', off ? '' : (r.change && r.change.label) || '');
    /* one plain sentence saying what the number above it is */
    setText('lcdWhat', off ? '' : r.what || '');

    /* instrument functions and alerts */
    var relAnn = el('lcdRel');
    if (relAnn) relAnn.classList.toggle('is-on', !off && !!r.rel);
    pressKey('minmax', !off && MP.funcs && MP.funcs.minmax.isShown(currentId));
    var mmRow = el('lcdMinmax');
    if (mmRow) {
      var mm = !off && r.minmax;
      mmRow.classList.toggle('is-idle', !mm);
      setText('lcdMin', mm ? 'MIN ' + fmtLike(r, mm.min) : '');
      setText('lcdMax', mm ? 'MAX ' + fmtLike(r, mm.max) : '');
    }
    var bell = el('lcdBell');
    if (bell) {
      var n = MP.alerts ? MP.alerts.count() : 0;
      bell.classList.toggle('is-on', n > 0);
      setText('lcdBellCount', n ? String(n) : '');
      bell.setAttribute('aria-label', n ? n + ' alert' + (n === 1 ? '' : 's') + ' armed. Open the list.' : 'No alerts. Open the list.');
    }

    renderTabs(off ? null : r.tabs || null);

    var workspaceLabels = { search: 'Select instrument', list: 'Watchlist', learn: 'Learn this measurement', probe: 'Investigate this measurement', config: 'Customize dial', welcome: 'Welcome to Multimeter' };
    lcd.setAttribute('role', screenMode === 'reading' ? 'button' : 'region');
    lcd.setAttribute('tabindex', screenMode === 'reading' ? '0' : '-1');
    lcd.setAttribute('aria-label', workspaceLabels[screenMode] || describe(r, off));
  }

  /* A value formatted the way this reading formats its own. */
  function fmtLike(r, v) {
    if (!isNum(v)) return MP.fmt.DASH;
    if (r.unit === 'USD') return MP.fmt.usd(v, Math.abs(v) < 10 ? 4 : 2);
    if (r.unit === 'INDEX') return MP.fmt.num(v, 2);
    return MP.fmt.num(v, isNum(r.dp) ? r.dp : 2) + (r.unit || '');
  }

  /* force: repaint even under HOLD (a function key was pressed). MIN/MAX
   * keeps capturing under HOLD, as a real meter's does. */
  function refresh(force) {
    if (!currentId) return;
    var app = MP.app;
    if (!app || !app.reading) return;
    var r = app.reading(currentId);
    if (MP.funcs) MP.funcs.minmax.track(currentId, r.value);
    if (held && !force) return;
    lastReading = r;
    paint(MP.funcs ? MP.funcs.decorate(r, currentId) : r);
  }

  /* ---- routing ------------------------------------------------------------ */
  function onStop(id) {
    var idx = indexOf(id);
    /* A view the dial does not carry (an asset reached by search or by hash)
     * is still shown. The knob parks on SUBJECT, which is the position that
     * represents whatever market is being looked at. */
    if (idx < 0) {
      var seat = indexOf('subject');
      var wasOff = currentId;
      if (changedFrom(wasOff, id)) lastStop = wasOff && wasOff !== 'learn' ? wasOff : lastStop;
      currentId = id;
      if (seat >= 0 && !dragging) settleOn(seat);
      markLabel('subject');
      if (screenMode !== 'reading' && screenMode !== 'welcome') setScreen('reading');
      renderKeys();
      refresh();
      return;
    }
    var changed = currentId !== null && currentId !== id;
    if (changed && currentId !== 'learn' && currentId !== 'investigate') lastStop = currentId;
    currentId = id;
    /* the watch list and the explanation are screen modes, not panels below
     * the meter, so the display stays the workspace */
    if (id === 'watch') setScreen('list');
    else if (id === 'learn') setScreen('learn');
    else if (id === 'investigate') setScreen('probe');
    else if (screenMode !== 'reading' && screenMode !== 'welcome') setScreen('reading');
    /* The first-visit orientation is the intro overlay (app.js); the dial
     * keeps only its one-time nudge once that has been dismissed. */
    if (!hintArmed) {
      hintArmed = true;
      hint();
    }
    /* the middle keys belong to the stop, and a stop can change without the
     * screen's mode changing, so the row is rebuilt here rather than only
     * in setScreen */
    renderKeys();
    if (changed) closeEditor();
    if (!dragging) settleOn(idx);      /* while dragging, the knob is the finger's */
    markLabel(id);
    if (changed && !dragging) detent(); /* a drag already clicked at the crossing */
    if (changed && held) setHold(false);   /* setHold(false) repaints */
    else refresh();
  }

  function init() {
    var dial = el('dial'), knob = el('knob');
    if (!dial || !knob) return;
    renderPlate();
    knob.setAttribute('aria-valuemin', '0');
    knob.setAttribute('aria-valuemax', String(STOPS.length - 1));
    wireDial(dial, knob);
    wireKeys(knob);
    wireGlobalKeys();
    wireButtons();
    wireSkins();
    markSound();
    renderKeys();
    if (MP.router) MP.router.onChange(onStop);

    fitToWindow();
    var fitQueued = false;
    function queueFit() {
      if (fitQueued) return;
      fitQueued = true;
      (root.requestAnimationFrame || setTimeout)(function () { fitQueued = false; fitToWindow(); });
    }
    root.addEventListener('resize', queueFit);
    desktopLearning.addEventListener('change', queueFit);
    if (root.ResizeObserver) {
      var layoutObserver = new root.ResizeObserver(queueFit);
      ['studentControls', 'utilityFooter'].forEach(function(id){var node=el(id);if(node)layoutObserver.observe(node);});
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitToWindow).catch(function () { /* fine */ });
  }

  /* ---- skins -------------------------------------------------------------- */
  /* Gold is the default and carries no attribute. The colours live in the
   * stylesheet; this only picks one and remembers it. */
  var SKINS = ['gold', 'blue', 'pink', 'green', 'red', 'purple', 'silver'];

  function currentSkin() {
    var s = document.documentElement.getAttribute('data-skin');
    return SKINS.indexOf(s) >= 0 ? s : 'green';
  }

  function markSkin() {
    var cur = currentSkin();
    var buttons = document.querySelectorAll('.skin[data-skin]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', buttons[i].getAttribute('data-skin') === cur ? 'true' : 'false');
    }
    var btn = el('skinBtn');
    if (btn) btn.setAttribute('aria-label', 'Skin: ' + (cur === 'green' ? 'Meter Mint' : cur) + '. Choose a colour.');
  }

  /* The palette: a small icon in the skin's colour opens a white palette
   * with a dab of every colour. open: true, false, or undefined to toggle.
   * Returns whether it is open. */
  function toggleSkins(open) {
    var menu = el('skins'), btn = el('skinBtn');
    if (!menu) return false;
    var show = open === undefined ? menu.hidden : !!open;
    menu.hidden = !show;
    if (btn) btn.setAttribute('aria-expanded', show ? 'true' : 'false');
    return show;
  }

  /* Unknown names are ignored. Returns the skin in force. */
  function setSkin(name) {
    if (SKINS.indexOf(name) < 0) return currentSkin();
    document.documentElement.setAttribute('data-skin', name);
    if (MP.store) MP.store.set('skin', name);
    markSkin();
    return name;
  }

  function wireSkins() {
    /* The head script has already migrated and applied the saved palette. */
    markSkin();
    var host = el('skins');
    if (!host) return;
    host.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('.skin[data-skin]') : null;
      if (!b) return;
      primeAudio();
      if (setSkin(b.getAttribute('data-skin'))) tickSound();
    });

    /* the palette stays open while colours are tried; a click elsewhere or
     * Escape puts it away */
    var btn = el('skinBtn');
    if (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        primeAudio();
        if (toggleSkins()) {
          var on = host.querySelector('.skin[aria-pressed="true"]');
          if (on && on.focus) on.focus({ preventScroll: true });
        }
      });
    }
    document.addEventListener('click', function (ev) {
      if (host.hidden) return;
      if (ev.target.closest && ev.target.closest('.skin-picker')) return;
      toggleSkins(false);
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || host.hidden) return;
      toggleSkins(false);
      if (btn) btn.focus();
    });
  }

  /* ---- fitting the window ------------------------------------------------- */
  var FIT_READABLE_W = 900; /* Keep desktop controls legible; scroll if height is limited. */
  var desktopLearning = root.matchMedia('(min-width: 860px) and (min-aspect-ratio: 6/5)');

  /* Sizes the meter so the whole instrument, screen and dial, fits the
   * window's height with no scrolling. The meter's height is (almost exactly)
   * a fixed part plus a multiple of its width, so two measurements give the
   * line and one more corrects for the layout's piecewise corners. The CSS
   * decides the layout (stacked, or side by side on wide windows); this only
   * picks the width. */
  function fitToWindow() {
    var meter = document.querySelector('.meter');
    var h = root.innerHeight;
    if (!meter || !h) return;
    meter.style.width = '';
    /* Both paddings, not just the top: counting only the top left the stage's
     * bottom padding hanging past the fold, so the page scrolled by exactly
     * that much on a laptop. */
    var stage = meter.parentNode;
    var cs = stage ? root.getComputedStyle(stage) : null;
    var padTop = cs ? parseFloat(cs.paddingTop) || 0 : 0;
    var padBottom = cs ? parseFloat(cs.paddingBottom) || 0 : 0;
    var controls=el('studentControls'), footer=el('utilityFooter');
    var controlsHeight=controls?Math.ceil(controls.getBoundingClientRect().height):0;
    var footerHeight=footer?Math.ceil(footer.getBoundingClientRect().height):0;
    document.documentElement.style.setProperty('--student-controls-height',controlsHeight+'px');
    document.documentElement.style.setProperty('--utility-footer-height',footerHeight+'px');
    var gap=cs?parseFloat(cs.rowGap)||0:0;
    var avail = h - padTop - Math.max(padBottom, footerHeight+16) - controlsHeight - (controlsHeight ? gap : 0);
    var w1 = meter.offsetWidth, h1 = meter.offsetHeight, w = w1;
    var readableMinimum = Math.min(w1, FIT_READABLE_W);
    /* On phones and zoomed layouts, keep readable width and allow vertical scrolling. */
    if (desktopLearning.matches && h1 > avail && w1 > readableMinimum) {
      var w2 = Math.max(readableMinimum, Math.round(w1 * 0.6));
      meter.style.width = w2 + 'px';
      var h2 = meter.offsetHeight;
      var slope = w1 > w2 ? (h1 - h2) / (w1 - w2) : 0;
      w = slope > 0 ? Math.floor(w2 + (avail - h2) / slope) : w1;
      w = Math.max(readableMinimum, Math.min(w1, w));
      meter.style.width = w + 'px';
      var over = meter.offsetHeight - avail;
      if (over > 0 && slope > 0 && w > readableMinimum) {
        w = Math.max(readableMinimum, Math.floor(w - over / slope) - 2);
        meter.style.width = w + 'px';
      }
    }
    document.documentElement.style.setProperty('--meter-w', w + 'px');

  }

  MP.meter = {
    STOPS: STOPS,
    STEP_DEG: STEP_DEG,
    SWEEP_DEG: SWEEP_DEG,
    angleOf: angleOf,
    stopAt: stopAt,
    clampToSweep: clampToSweep,
    plateSvg: plateSvg,
    setStopLabel: setStopLabel,
    applyDial: applyDial,
    onDial: function (id) { return indexOf(id) >= 0; },
    clickParams: clickParams,
    toggleSkins: toggleSkins,
    setScreen: setScreen,
    screen: screen,
    lastStop: function () { return lastStop; },
    firstVisit: firstVisit,
    dismissWelcome: dismissWelcome,
    keySet: keySet,
    renderKeys: renderKeys,
    setSound: setSound,
    soundOn: soundOn,
    hint: hint,
    endHint: endHint,
    fitToWindow: fitToWindow,
    SKINS: SKINS,
    setSkin: setSkin,
    currentSkin: currentSkin,
    init: init,
    refresh: refresh,
    changeText: changeText,
    alarm: alarm,
    beep: beep,
    showAlerts: showAlerts,
    setHold: setHold,
    isHeld: function () { return held; },
    openDrawer: openDrawer,
    current: function () { return currentId; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
