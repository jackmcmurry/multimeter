/* ============================================================================
 * dial.js: which functions occupy the physical dial.
 *
 * The application has more views than the instrument has detents, and that is
 * deliberate. The dial is a curated control surface, not a menu of everything
 * built. Every view remains reachable by hash, by search and by the actions
 * inside the screen; the dial carries the handful a student turns to.
 *
 * Two positions are fixed. OFF is the manual. SUBJECT is whatever market the
 * student is currently looking at, so one detent covers every asset instead
 * of one detent per asset. The rest are the measuring and reasoning tools,
 * and those the student may switch off.
 *
 * Pure apart from two calls to storage. Anything stored that is not a known
 * function, or that would leave the instrument unable to show a subject, is
 * discarded rather than honoured.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var KEY = 'dial';

  /* Always present, in this order, at the head of the dial. */
  var FIXED = ['off', 'subject'];

  /* What a student may add, remove or reorder, in their default order. */
  var OPTIONAL = ['watch', 'mover', 'vol', 'corr', 'dd', 'investigate', 'learn'];

  /* Without at least one of these the instrument can measure but never
   * explain, so one must survive whatever the student switches off. */
  var KEEP_ONE_OF = ['investigate', 'learn'];

  var DEFAULT = FIXED.concat(OPTIONAL);

  var MAX = FIXED.length + OPTIONAL.length;

  /* What each position is called on the plate. SUBJECT wears the current
   * subject's ticker, so its label is set at runtime, not here. */
  var LABELS = {
    off: 'OFF',
    subject: 'SUBJECT',
    watch: 'WATCH',
    mover: 'MOVER',
    vol: 'VOL',
    corr: 'CORR',
    dd: 'DD',
    investigate: 'PROBE',
    learn: 'LEARN'
  };

  /* What each position does, for the configuration screen. */
  var NOTES = {
    off: 'What this instrument is, and where every figure comes from.',
    subject: 'The market you are looking at. Search changes what it points at.',
    watch: 'The assets you chose to follow.',
    mover: 'The week’s largest rise, and its largest fall.',
    vol: 'How much the subject’s returns move around.',
    corr: 'Whether the subject and an index move on the same days.',
    dd: 'How far the subject sits below its own peak.',
    investigate: 'Investigate the measurement on the screen.',
    learn: 'What the measurement on the screen means.'
  };

  function known(id) { return LABELS.hasOwnProperty(id); }

  /* Whatever was stored -> a layout the instrument can actually present:
   * the fixed positions first, then known optional ones, no repeats, and
   * never without a way to explain a reading. */
  function read(v) {
    var out = FIXED.slice();
    var wanted = Array.isArray(v) ? v : DEFAULT;
    wanted.forEach(function (id) {
      if (typeof id !== 'string') return;
      if (OPTIONAL.indexOf(id) < 0) return;      /* unknown, or a fixed one repeated */
      if (out.indexOf(id) >= 0) return;
      if (out.length < MAX) out.push(id);
    });
    var hasExplainer = KEEP_ONE_OF.some(function (id) { return out.indexOf(id) >= 0; });
    if (!hasExplainer) out.push('learn');
    return out;
  }

  function load() {
    return read(MP.store ? MP.store.get(KEY, null) : null);
  }

  function save(list) {
    var clean = read(list);
    if (MP.store) MP.store.set(KEY, clean);
    return clean;
  }

  function reset() {
    if (MP.store) MP.store.remove(KEY);
    return DEFAULT.slice();
  }

  /* Whether a given optional function may be switched off right now. */
  function canRemove(list, id) {
    if (OPTIONAL.indexOf(id) < 0) return false;
    var after = read(list.filter(function (x) { return x !== id; }));
    return after.indexOf(id) < 0;
  }

  function labelFor(id, subjectLabel) {
    if (id === 'subject') return subjectLabel || LABELS.subject;
    return LABELS[id] || String(id).toUpperCase();
  }

  MP.dial = {
    KEY: KEY,
    FIXED: FIXED,
    OPTIONAL: OPTIONAL,
    DEFAULT: DEFAULT,
    LABELS: LABELS,
    NOTES: NOTES,
    MAX: MAX,
    known: known,
    read: read,
    load: load,
    save: save,
    reset: reset,
    canRemove: canRemove,
    labelFor: labelFor
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
