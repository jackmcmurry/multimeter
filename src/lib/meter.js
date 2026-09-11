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

  var STOPS = [
    { id: 'off', label: 'OFF' },
    { id: 'btc', label: 'BTC' },
    { id: 'eth', label: 'ETH' },
    { id: 'nasdaq', label: 'NASDAQ' },
    { id: 'spx', label: 'S&P' },
    { id: 'mover', label: 'MOVER' },      /* the week's highest move, stocks or crypto */
    { id: 'loser', label: 'LOSER' },      /* and the lowest */
    { id: 'watch', label: 'WATCH' },      /* the viewer's own Nasdaq-100 stocks */
    { id: 'probe', label: 'PROBE' },      /* relabelled with the chosen coin's symbol */
    { id: 'corr', label: 'CORR' },
    { id: 'vol', label: 'VOL' },
    { id: 'dd', label: 'DD' },
    { id: 'note', label: 'NOTE' }         /* the daily reading */
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

  /* The probe stop wears the chosen coin's symbol. */
  function setStopLabel(id, text) {
    var label = String(text || '').toUpperCase().replace(/[^A-Z0-9&$.]/g, '').slice(0, 5) || 'PROBE';
    for (var i = 0; i < STOPS.length; i++) if (STOPS[i].id === id) STOPS[i].label = label;
    var node = document.querySelector('.dial-stop[data-stop="' + id + '"] .dial-lab');
    if (node) node.textContent = label;
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
  var master = null;     /* every sound goes through this */
  var noise = null;      /* 80 ms of white noise, made once, for the tick and the tock */
  var lastClickAt = 0;
  var SOUND_KEY = 'sound';
  var soundIsOn = readSound();

  function readSound() {
    return (MP.store ? MP.store.get(SOUND_KEY, true) : true) !== false;
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
      var n = Math.floor(audio.sampleRate * 0.08);
      noise = audio.createBuffer(1, n, audio.sampleRate);
      var ch = noise.getChannelData(0);
      for (var i = 0; i < n; i++) ch[i] = Math.random() * 2 - 1;
    } catch (e) { audio = null; master = null; }
  }

  function canPlay() {
    return soundIsOn && !!audio && !!master && !!noise && audio.state === 'running';
  }

  /* The click's recipe, pure so the tests can hold it to account. Each
   * detent sounds like a key on a mechanical keyboard: a sharp tick as the
   * cap lands (high-passed noise), the hollow tock of the plastic (noise in
   * a narrow band around 520 Hz), a low thump as the switch bottoms out (a
   * sine whose pitch falls), and a softer upstroke as the key springs back.
   * Every press varies a little, so a spin never repeats itself. Presses
   * closer than FAST_MS apart come shorter and softer and skip the
   * upstroke, so a fast spin purrs. The end stop is a deeper, longer
   * bottom-out; the settle tap is a whisper.
   * kind: 'detent' | 'stop' | 'settle'; sinceMs: time since the last click;
   * rand: a function returning [0, 1). */
  var FAST_MS = 45;
  function clickParams(kind, sinceMs, rand) {
    var r = typeof rand === 'function' ? rand : Math.random;
    var pitch = 1 + (r() * 2 - 1) * 0.04;
    var level = 1 + (r() * 2 - 1) * 0.08;
    var p = {
      tickHz: 2400 * pitch, tickDur: 0.003, tickGain: 0.14,
      bodyHz: 520 * pitch, bodyQ: 3.5, bodyDur: 0.028, bodyGain: 2.6,
      thockHz: 150 * pitch, thockEndHz: 95 * pitch, thockDur: 0.03, thockGain: 0.2,
      upDelay: 0.055, upGain: 0.35
    };
    if (kind === 'stop') {
      p.tickGain = 0.18;
      p.bodyHz = 300 * pitch; p.bodyQ = 2.5; p.bodyDur = 0.045; p.bodyGain = 3.2;
      p.thockHz = 90 * pitch; p.thockEndHz = 55 * pitch; p.thockDur = 0.06; p.thockGain = 0.32;
      p.upGain = 0;
    } else if (kind === 'settle') {
      p.tickGain = 0.05;
      p.bodyHz = 760 * pitch; p.bodyDur = 0.012; p.bodyGain = 0.8;
      p.thockGain = 0;
      p.upGain = 0;
    } else if (typeof sinceMs === 'number' && sinceMs < FAST_MS) {
      p.tickDur *= 0.6; p.bodyDur *= 0.6; p.thockDur *= 0.6;
      p.tickGain *= 0.6; p.bodyGain *= 0.6; p.thockGain *= 0.6;
      p.upGain = 0;
    }
    p.tickGain *= level;
    p.bodyGain *= level;
    p.thockGain *= level;
    p.dur = Math.max(p.tickDur, p.bodyDur, p.thockDur);
    p.gain = Math.max(p.tickGain, p.bodyGain, p.thockGain);
    return p;
  }

  function envelope(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  /* A burst of filtered noise: the tick and the tock. */
  function noiseHit(t, type, freq, q, peak, attack, decay) {
    if (!(peak > 0)) return;
    var src = audio.createBufferSource(), f = audio.createBiquadFilter(), g = audio.createGain();
    src.buffer = noise;
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    envelope(g, t, peak, attack, decay);
    src.connect(f);
    f.connect(g);
    g.connect(master);
    src.start(t, Math.random() * 0.02);   /* a different stretch of noise each press */
    src.stop(t + attack + decay + 0.01);
  }

  /* A falling sine: the thump as the switch bottoms out. */
  function sineHit(t, f0, f1, peak, attack, decay) {
    if (!(peak > 0)) return;
    var osc = audio.createOscillator(), g = audio.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + decay * 0.85);
    envelope(g, t, peak, attack, decay);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + attack + decay + 0.01);
  }

  /* One key press, `delay` seconds from now. */
  function click(kind, delay) {
    if (!canPlay()) return;
    var now = Date.now(), since = now - lastClickAt;
    if (kind !== 'settle') lastClickAt = now;
    var p = clickParams(kind || 'detent', since);
    try {
      var t = audio.currentTime + (delay || 0);
      noiseHit(t, 'highpass', p.tickHz, 0.7, p.tickGain, 0.0003, p.tickDur);
      noiseHit(t, 'bandpass', p.bodyHz, p.bodyQ, p.bodyGain, 0.0008, p.bodyDur);
      sineHit(t, p.thockHz, p.thockEndHz, p.thockGain, 0.001, p.thockDur);
      if (p.upGain > 0) {
        var u = t + p.upDelay;   /* the key springs back up */
        noiseHit(u, 'highpass', p.tickHz * 1.15, 0.7, p.tickGain * p.upGain, 0.0003, p.tickDur);
        noiseHit(u, 'bandpass', p.bodyHz * 1.25, p.bodyQ, p.bodyGain * p.upGain, 0.0008, p.bodyDur * 0.7);
      }
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

  function touchedDial() {
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

  /* ---- REL, MIN/MAX, ALERT ------------------------------------------------ */
  var lastReading = null;   /* the reading last painted, for the function keys */

  function pressKey(id, on, attr) {
    var btn = el(id);
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
    if (!form || !input || !lastReading || currentId === 'off' || !isNum(lastReading.value)) return;
    primeAudio();
    var dp = isNum(lastReading.dp) ? lastReading.dp : 2;
    input.value = String(Number(lastReading.value.toFixed(dp)));
    input.step = dp ? String(Math.pow(10, -dp)) : '1';
    form.hidden = false;
    pressKey('alertBtn', true, 'aria-expanded');
    input.focus();
    input.select();
  }

  function closeEditor() {
    var form = el('lcdEdit');
    if (form) form.hidden = true;
    pressKey('alertBtn', false, 'aria-expanded');
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
    var hold = el('holdBtn'), detail = el('detailBtn'), lcd = el('lcd'), ranges = el('lcdRanges');
    var rel = el('relBtn'), minmax = el('minmaxBtn'), alertBtn = el('alertBtn');
    var form = el('lcdEdit'), cancel = el('lcdEditCancel'), bell = el('lcdBell');
    if (hold) hold.addEventListener('click', function () { setHold(!held); });
    if (detail) detail.addEventListener('click', function () { openDrawer(); });
    if (rel) rel.addEventListener('click', relPress);
    if (minmax) minmax.addEventListener('click', minmaxPress);
    if (alertBtn) alertBtn.addEventListener('click', function () {
      if (form && !form.hidden) closeEditor(); else openEditor();
    });
    if (form) {
      form.addEventListener('submit', submitEditor);
      form.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { closeEditor(); ev.preventDefault(); } });
    }
    if (cancel) cancel.addEventListener('click', closeEditor);
    if (bell) bell.addEventListener('click', showAlerts);
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
        /* the tabs, the editor, the bell are controls of their own */
        if (ev.target.closest && ev.target.closest('#lcdRanges, #lcdEdit, #lcdBell, #lcdSound')) return;
        openDrawer();
      });
      lcd.addEventListener('keydown', function (ev) {
        if (ev.target !== lcd) return;
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
        if (tab === 'ranges' && app.setRange) {
          app.setRange(parseInt(value, 10));
        } else if (tab === 'switch' && app.setMoversKind) {
          app.setMoversKind(value);
          tickSound();
          swapScreen();
        } else if (tab === 'step' && app.stepWatch) {
          app.stepWatch(parseInt(value, 10));
          tickSound();
          swapScreen();
        } else if (tab === 'watch' && app.setWatchRange) {
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
    return html;
  }

  function renderTabs(model) {
    var host = el('lcdRanges');
    if (!host) return;
    var idle = !model;
    host.classList.toggle('is-idle', idle);
    host.setAttribute('aria-hidden', idle ? 'true' : 'false');
    if (model) {
      var sig = model.kind + '|' + (model.options || []).map(function (o) { return o[0]; }).join(',');
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
        modeEl.textContent = off ? '' : r.mode || '';
      }
    }

    var chart = el('lcdChart');
    if (chart) {
      /* the NOTE stop shows words where the other stops draw a line */
      chart.innerHTML = !off && typeof r.note === 'string'
        ? '<div class="lcd-note">' + escapeText(r.note) + '</div>'
        : !off && series.length > 1
          ? G.smoothLine({ values: series, w: 600, h: 250, color: (r.headDir || dir) === 'down' ? 'var(--down)' : 'var(--up)', strokeWidth: 2.4 })
          : '';
    }

    var priceEl = el('lcdPrice');
    if (priceEl) {
      /* MOVER, LOSER and WATCH lead with the ticker; MOVER and LOSER colour
       * the week's move by its sign */
      if (!off && r.ticker) priceEl.innerHTML = '<span class="lcd-ticker">' + escapeText(r.ticker) + '</span>' + escapeText(r.text || '');
      else priceEl.textContent = off ? '' : r.text || '';
      priceEl.className = 'lcd-price' + (!off && r.headDir ? ' is-' + r.headDir : '');
    }
    setText('lcdUnit', off ? '' : r.unit || '');

    var chg = el('lcdChange');
    if (chg) {
      var plain = r.caption || (r.empty && r.hint);
      var line = r.caption ? r.caption : r.empty && r.hint ? r.hint : changeText(r.change, r.unit);
      chg.textContent = off ? '' : (r.lead && !r.empty ? r.lead + '   ' + line : line);
      chg.className = 'lcd-chg' + (dir && !off && !plain ? ' is-' + dir : '') + (r.caption ? ' is-caption' : '');
    }
    setText('lcdChangeLabel', off ? '' : (r.change && r.change.label) || '');

    /* instrument functions and alerts */
    var relAnn = el('lcdRel');
    if (relAnn) relAnn.classList.toggle('is-on', !off && !!r.rel);
    pressKey('relBtn', !off && MP.funcs && MP.funcs.rel.get(currentId) !== null);
    pressKey('minmaxBtn', !off && MP.funcs && MP.funcs.minmax.isShown(currentId));
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

    lcd.setAttribute('aria-label', describe(r, off));
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
    if (idx < 0) return;
    var changed = currentId !== null && currentId !== id;
    currentId = id;
    if (!hintArmed) { hintArmed = true; hint(); }   /* the first stop, once the page knows it */
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
    if (!dial.querySelector('.dial-plate')) dial.insertAdjacentHTML('afterbegin', plateSvg());
    knob.setAttribute('aria-valuemin', '0');
    knob.setAttribute('aria-valuemax', String(STOPS.length - 1));
    wireDial(dial, knob);
    wireKeys(knob);
    wireButtons();
    wireSkins();
    markSound();
    if (MP.router) MP.router.onChange(onStop);

    fitToWindow();
    var fitQueued = false;
    root.addEventListener('resize', function () {
      if (fitQueued) return;
      fitQueued = true;
      (root.requestAnimationFrame || setTimeout)(function () { fitQueued = false; fitToWindow(); });
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitToWindow).catch(function () { /* fine */ });
  }

  /* ---- skins -------------------------------------------------------------- */
  /* Gold is the default and carries no attribute. The colours live in the
   * stylesheet; this only picks one and remembers it. */
  var SKINS = ['gold', 'blue', 'pink', 'green', 'red', 'purple', 'silver'];

  function currentSkin() {
    var s = document.documentElement.getAttribute('data-skin');
    return SKINS.indexOf(s) >= 0 ? s : 'gold';
  }

  function markSkin() {
    var cur = currentSkin();
    var buttons = document.querySelectorAll('.skin[data-skin]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', buttons[i].getAttribute('data-skin') === cur ? 'true' : 'false');
    }
    var btn = el('skinBtn');
    if (btn) btn.setAttribute('aria-label', 'Skin: ' + cur + '. Choose a colour.');
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
    if (name === 'gold') document.documentElement.removeAttribute('data-skin');
    else document.documentElement.setAttribute('data-skin', name);
    if (MP.store) MP.store.set('skin', name);
    markSkin();
    return name;
  }

  function wireSkins() {
    var saved = MP.store ? MP.store.get('skin', 'gold') : 'gold';
    if (SKINS.indexOf(saved) >= 0 && saved !== currentSkin()) setSkin(saved);
    else markSkin();
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
  var FIT_MIN_W = 300;   /* narrower than this and the dial is too small to turn; scroll instead */

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
    var stage = meter.parentNode;
    var pad = stage ? parseFloat(root.getComputedStyle(stage).paddingTop) || 0 : 0;
    var avail = h - pad - 12;
    var w1 = meter.offsetWidth, h1 = meter.offsetHeight, w = w1;
    if (h1 > avail && w1 > FIT_MIN_W) {
      var w2 = Math.max(FIT_MIN_W, Math.round(w1 * 0.6));
      meter.style.width = w2 + 'px';
      var h2 = meter.offsetHeight;
      var slope = w1 > w2 ? (h1 - h2) / (w1 - w2) : 0;
      w = slope > 0 ? Math.floor(w2 + (avail - h2) / slope) : w1;
      w = Math.max(FIT_MIN_W, Math.min(w1, w));
      meter.style.width = w + 'px';
      var over = meter.offsetHeight - avail;
      if (over > 0 && slope > 0 && w > FIT_MIN_W) {
        w = Math.max(FIT_MIN_W, Math.floor(w - over / slope) - 2);
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
    clickParams: clickParams,
    toggleSkins: toggleSkins,
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
