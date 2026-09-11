/* ============================================================================
 * sevenseg.js — the LCD's seven-segment readout, as inline SVG.
 *
 * Pure: strings in, an SVG string out, no DOM. Every segment of every cell is
 * always drawn; lit ones carry the `on` class, so unlit segments ghost faintly
 * behind the reading the way a real liquid-crystal display does. Colour comes
 * from the stylesheet (.seg / .seg.on), never from this file.
 *
 * The readout is one half-width sign cell followed by seven digit cells,
 * right-aligned. A '.' in the text lights the decimal point of the cell before
 * it. fit() turns a number into text that fits those seven cells, dropping
 * decimals first and reporting 'OL' (overload) when the integer part alone
 * will not fit — which is what a meter does too.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var DIGITS = 7;
  var CELL_W = 20, CELL_H = 36, PITCH = 30, SIGN_W = 14, GAP = 6;
  var VIEW_W = 232, VIEW_H = 40;

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  /* Chamfered segment polygons for a 20 x 36 cell, thickness 3.5. */
  var SEGMENTS = {
    a: '2,0 18,0 15,3.5 5,3.5',
    b: '20,2 20,17 16.5,15 16.5,5',
    c: '20,19 20,34 16.5,31 16.5,21',
    d: '2,36 18,36 15,32.5 5,32.5',
    e: '0,19 0,34 3.5,31 3.5,21',
    f: '0,2 0,17 3.5,15 3.5,5',
    g: '3,18 5,16.25 15,16.25 17,18 15,19.75 5,19.75'
  };
  var ORDER = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  var SIGN_SEGMENT = '0,18 2,16.25 12,16.25 14,18 12,19.75 2,19.75';

  var GLYPHS = {
    '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg',
    '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
    '-': 'g', ' ': '',
    'O': 'abcdef', 'L': 'def', 'H': 'bcefg', 'd': 'bcdeg', 'E': 'adefg',
    'r': 'eg', 'n': 'ceg', 'o': 'cdeg', 'P': 'abefg'
  };

  /* 'text' -> [{ glyph, dp }] right-aligned into DIGITS cells. Unknown
   * characters render blank rather than throwing. */
  function cells(text) {
    var out = [];
    var s = String(text === undefined || text === null ? '' : text);
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '.') {
        if (!out.length) out.push({ glyph: ' ', dp: false });
        out[out.length - 1].dp = true;
        continue;
      }
      out.push({ glyph: GLYPHS.hasOwnProperty(ch) ? ch : ' ', dp: false });
    }
    if (out.length > DIGITS) out = out.slice(out.length - DIGITS);
    while (out.length < DIGITS) out.unshift({ glyph: ' ', dp: false });
    return out;
  }

  /* value -> { text, neg }. dp is the preferred number of decimals; it is
   * reduced until the digits fit, then the reading overloads. */
  function fit(value, opts) {
    var dp = opts && isNum(opts.dp) ? Math.max(0, Math.floor(opts.dp)) : 2;
    if (!isNum(value)) return { text: '----', neg: false };
    var abs = Math.abs(value);
    var s;
    for (;;) {
      s = abs.toFixed(dp);
      if (s.replace('.', '').length <= DIGITS) break;
      if (dp === 0) return { text: 'OL', neg: false };
      dp -= 1;
    }
    return { text: s, neg: value < 0 && Number(s) !== 0 };
  }

  function segClass(on) { return on ? 'seg on' : 'seg'; }

  function cellSvg(x, cell) {
    var lit = GLYPHS[cell.glyph] || '';
    var s = '<g transform="translate(' + x + ',0)">';
    for (var i = 0; i < ORDER.length; i++) {
      var k = ORDER[i];
      s += '<polygon class="' + segClass(lit.indexOf(k) >= 0) + '" points="' + SEGMENTS[k] + '"/>';
    }
    s += '<rect class="' + segClass(cell.dp) + ' seg-dp" x="' + (CELL_W + 2) + '" y="' + (CELL_H - 4) +
      '" width="4" height="4"/>';
    return s + '</g>';
  }

  /* text: what fit() produced; neg lights the sign cell. */
  function svg(text, neg, opts) {
    var cls = opts && opts.className ? ' ' + opts.className : '';
    var s = '<svg viewBox="0 0 ' + VIEW_W + ' ' + VIEW_H + '" class="lcd-seg' + cls +
      '" aria-hidden="true" preserveAspectRatio="xMidYMid meet">';
    s += '<g transform="translate(4,2) skewX(-6)">';
    s += '<polygon class="' + segClass(!!neg) + '" points="' + SIGN_SEGMENT + '"/>';
    var list = cells(text);
    for (var i = 0; i < list.length; i++) {
      s += cellSvg(SIGN_W + GAP + i * PITCH, list[i]);
    }
    return s + '</g></svg>';
  }

  MP.sevenseg = {
    DIGITS: DIGITS,
    GLYPHS: GLYPHS,
    cells: cells,
    fit: fit,
    svg: svg
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
