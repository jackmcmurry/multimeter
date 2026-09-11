/* ============================================================================
 * geom.js — SVG chart kit. Rectilinear only: stair-stepped paths, hard-edged
 * columns, square point marks, diagonal hatching, tick-marked crosshair axes.
 * No curves, no gradients, no rounded joins anywhere.
 *
 * Every renderer returns an SVG string sized in viewBox units. Text is drawn
 * with fill="currentColor" so the caller's theme token decides its colour.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});
  var isNum = function (x) { return typeof x === 'number' && isFinite(x); };

  var uid = 0;
  function nextId(prefix) { uid += 1; return prefix + uid; }

  var PAD = { l: 46, r: 12, t: 12, b: 20 };

  function scale(domain, range) {
    var d0 = domain[0], span = (domain[1] - domain[0]) || 1;
    var r0 = range[0], rSpan = range[1] - range[0];
    return function (v) { return r0 + ((v - d0) / span) * rSpan; };
  }

  function extent(values) {
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < values.length; i++) {
      if (!isNum(values[i])) continue;
      if (values[i] < lo) lo = values[i];
      if (values[i] > hi) hi = values[i];
    }
    if (lo === Infinity) return [0, 1];
    if (lo === hi) return [lo - Math.abs(lo || 1) * 0.05, hi + Math.abs(hi || 1) * 0.05];
    return [lo, hi];
  }

  function niceTicks(min, max, count) {
    if (!isNum(min) || !isNum(max)) return [];
    if (min === max) { min -= 0.5; max += 0.5; }
    var span = max - min;
    var raw = span / Math.max(1, count);
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var err = raw / mag;
    var step = mag * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1);
    var out = [];
    var start = Math.ceil(min / step) * step;
    for (var v = start; v <= max + step * 1e-9; v += step) {
      out.push(Math.abs(v) < step * 1e-9 ? 0 : Math.round(v / step) * step);
    }
    return out;
  }

  function pad(over) {
    return {
      l: over && over.l !== undefined ? over.l : PAD.l,
      r: over && over.r !== undefined ? over.r : PAD.r,
      t: over && over.t !== undefined ? over.t : PAD.t,
      b: over && over.b !== undefined ? over.b : PAD.b
    };
  }

  /* Stair path through evenly spaced values: horizontal then vertical only. */
  function stairPath(values, x, y) {
    var d = '', started = false, prevY = null;
    for (var i = 0; i < values.length; i++) {
      if (!isNum(values[i])) continue;
      var xi = x(i), yi = y(values[i]);
      if (!started) { d += 'M' + xi.toFixed(2) + ',' + yi.toFixed(2); started = true; }
      else { d += 'H' + xi.toFixed(2) + 'V' + yi.toFixed(2); }
      prevY = yi;
    }
    return { d: d, started: started, lastY: prevY };
  }

  function axisText(x, yPos, text, anchor, cls) {
    return '<text x="' + x.toFixed(2) + '" y="' + yPos.toFixed(2) + '" text-anchor="' + anchor +
      '" class="' + (cls || 'gx-tick') + '" fill="currentColor">' + text + '</text>';
  }

  /* Y grid: hairline rules with left-hand labels. */
  function yAxis(ticks, y, p, w, fmt) {
    var s = '';
    for (var i = 0; i < ticks.length; i++) {
      var yy = y(ticks[i]);
      s += '<line x1="' + p.l + '" y1="' + yy.toFixed(2) + '" x2="' + (w - p.r) + '" y2="' + yy.toFixed(2) +
        '" class="gx-grid"/>';
      s += axisText(p.l - 5, yy + 3, fmt(ticks[i]), 'end');
    }
    return s;
  }

  /* X labels at first / middle / last index. */
  function xLabels(labels, x, p, h) {
    if (!labels || !labels.length) return '';
    var yPos = h - p.b + 13;
    var last = labels.length - 1;
    var mid = Math.floor(last / 2);
    var s = axisText(p.l, yPos, labels[0], 'start');
    if (last > 1) s += axisText(x(mid), yPos, labels[mid], 'middle');
    if (last > 0) s += axisText(x(last), yPos, labels[last], 'end');
    return s;
  }

  function open(w, h, cls) {
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" class="chart ' + (cls || '') +
      '" role="img" preserveAspectRatio="xMidYMid meet">';
  }

  /* -------------------------------------------------------------------------
   * 1. sparkStep — axis-free stair line with a square end mark.
   * ---------------------------------------------------------------------- */
  function sparkStep(opts) {
    var values = (opts.values || []).filter(isNum);
    var w = opts.w || 300, h = opts.h || 56;
    var color = opts.color || 'currentColor';
    if (values.length < 2) {
      return open(w, h, 'chart-empty') +
        axisText(w / 2, h / 2 + 3, 'no series', 'middle') + '</svg>';
    }
    var p = { l: 2, r: 8, t: 6, b: 6 };
    var dom = extent(values);
    var x = scale([0, values.length - 1], [p.l, w - p.r]);
    var y = scale(dom, [h - p.b, p.t]);
    var path = stairPath(values, x, y);
    var lastX = x(values.length - 1), lastY = y(values[values.length - 1]);
    var s = open(w, h);
    /* Flat-opacity fill, no gradient — keeps the chart rectilinear. */
    if (opts.area) {
      s += '<path d="' + path.d + 'V' + (h - p.b).toFixed(2) + 'H' + x(0).toFixed(2) + 'Z" ' +
        'fill="' + color + '" fill-opacity="0.12" stroke="none"/>';
    }
    s += '<path d="' + path.d + '" fill="none" stroke="' + color + '" stroke-width="' +
      (opts.strokeWidth || 1.5) + '" stroke-linejoin="miter" stroke-linecap="butt" ' +
      'vector-effect="non-scaling-stroke"/>';
    s += '<rect x="' + (lastX - 2.5).toFixed(2) + '" y="' + (lastY - 2.5).toFixed(2) +
      '" width="5" height="5" fill="' + color + '"/>';
    return s + '</svg>';
  }

  /* -------------------------------------------------------------------------
   * 2. stepChart — one or more stair series on a shared scale, optional zero
   *    rule. Used for the rolling-correlation panel.
   * ---------------------------------------------------------------------- */
  function stepChart(opts) {
    var series = opts.series || [];
    var w = opts.w || 900, h = opts.h || 190;
    var p = pad(opts.pad);
    var fmt = opts.yFmt || function (v) { return String(v); };
    var all = [];
    series.forEach(function (s) { all = all.concat((s.values || []).filter(isNum)); });
    if (all.length < 2) {
      return open(w, h, 'chart-empty') + axisText(w / 2, h / 2 + 3, 'awaiting series', 'middle') + '</svg>';
    }
    var dom = opts.yDomain || extent(all);
    var maxLen = series.reduce(function (m, s) { return Math.max(m, (s.values || []).length); }, 0);
    var x = scale([0, Math.max(1, maxLen - 1)], [p.l, w - p.r]);
    var y = scale(dom, [h - p.b, p.t]);
    var ticks = niceTicks(dom[0], dom[1], opts.tickCount || 4);

    var s = open(w, h);
    /* optional horizontal bands (regime thresholds), under everything else */
    (opts.bands || []).forEach(function (b) {
      var top = Math.min(b.to, dom[1]), bottom = Math.max(b.from, dom[0]);
      if (!(top > bottom)) return;
      s += '<rect x="' + p.l + '" y="' + y(top).toFixed(2) + '" width="' + (w - p.r - p.l) + '" height="' +
        (y(bottom) - y(top)).toFixed(2) + '" fill="' + (b.color || 'currentColor') + '" fill-opacity="' + (b.opacity || 0.08) + '"/>';
    });
    s += yAxis(ticks, y, p, w, fmt);
    /* plot frame: left and bottom rules only */
    s += '<line x1="' + p.l + '" y1="' + p.t + '" x2="' + p.l + '" y2="' + (h - p.b) + '" class="gx-axis"/>';
    s += '<line x1="' + p.l + '" y1="' + (h - p.b) + '" x2="' + (w - p.r) + '" y2="' + (h - p.b) + '" class="gx-axis"/>';
    if (opts.zeroLine && dom[0] < 0 && dom[1] > 0) {
      s += '<line x1="' + p.l + '" y1="' + y(0).toFixed(2) + '" x2="' + (w - p.r) + '" y2="' + y(0).toFixed(2) +
        '" class="gx-zero"/>';
    }
    series.forEach(function (ser) {
      var path = stairPath(ser.values || [], x, y);
      if (!path.started) return;
      s += '<path d="' + path.d + '" fill="none" stroke="' + (ser.color || 'currentColor') +
        '" stroke-width="1.6" stroke-linejoin="miter" stroke-linecap="butt" vector-effect="non-scaling-stroke"/>';
      var li = (ser.values || []).length - 1;
      if (isNum(ser.values[li])) {
        s += '<rect x="' + (x(li) - 2.5).toFixed(2) + '" y="' + (y(ser.values[li]) - 2.5).toFixed(2) +
          '" width="5" height="5" fill="' + (ser.color || 'currentColor') + '"/>';
      }
    });
    s += xLabels(opts.xLabels, x, p, h);
    s += '</svg>';
    return s;
  }

  /* -------------------------------------------------------------------------
   * 3. columnChart — grouped hard-edged columns. Used for rolling volatility.
   * ---------------------------------------------------------------------- */
  function columnChart(opts) {
    var series = opts.series || [];
    var w = opts.w || 900, h = opts.h || 190;
    var p = pad(opts.pad);
    var fmt = opts.yFmt || function (v) { return String(v); };
    var all = [];
    series.forEach(function (s) { all = all.concat((s.values || []).filter(isNum)); });
    if (!all.length) {
      return open(w, h, 'chart-empty') + axisText(w / 2, h / 2 + 3, 'awaiting series', 'middle') + '</svg>';
    }
    var hi = Math.max.apply(null, all);
    var dom = [0, hi * 1.08];
    var maxLen = series.reduce(function (m, s) { return Math.max(m, (s.values || []).length); }, 0);
    var plotW = (w - p.r) - p.l;
    var slot = plotW / Math.max(1, maxLen);
    var groupW = Math.max(1.2, Math.min(slot * 0.84, 14));
    var barW = Math.max(0.8, groupW / Math.max(1, series.length));
    var y = scale(dom, [h - p.b, p.t]);
    var ticks = niceTicks(dom[0], dom[1], opts.tickCount || 4);

    var s = open(w, h);
    s += yAxis(ticks, y, p, w, fmt);
    s += '<line x1="' + p.l + '" y1="' + p.t + '" x2="' + p.l + '" y2="' + (h - p.b) + '" class="gx-axis"/>';
    s += '<line x1="' + p.l + '" y1="' + (h - p.b) + '" x2="' + (w - p.r) + '" y2="' + (h - p.b) + '" class="gx-axis"/>';

    var base = h - p.b;
    series.forEach(function (ser, si) {
      var vals = ser.values || [];
      for (var i = 0; i < vals.length; i++) {
        if (!isNum(vals[i])) continue;
        var cx = p.l + slot * (i + 0.5);
        var x0 = cx - groupW / 2 + si * barW;
        var yTop = y(vals[i]);
        var barH = Math.max(0.6, base - yTop);
        s += '<rect x="' + x0.toFixed(2) + '" y="' + yTop.toFixed(2) + '" width="' + barW.toFixed(2) +
          '" height="' + barH.toFixed(2) + '" fill="' + (ser.color || 'currentColor') + '"/>';
      }
    });
    s += xLabels(opts.xLabels, scale([0, Math.max(1, maxLen - 1)], [p.l + slot / 2, w - p.r - slot / 2]), p, h);
    s += '</svg>';
    return s;
  }

  /* -------------------------------------------------------------------------
   * 4. scatterFit — square marks with an OLS line and zero crosshairs. The
   *    slope drawn here IS the beta reported in the table.
   * ---------------------------------------------------------------------- */
  function scatterFit(opts) {
    var xs = opts.xs || [], ys = opts.ys || [];
    var w = opts.w || 420, h = opts.h || 300;
    var p = pad(opts.pad || { l: 44, r: 14, t: 14, b: 30 });
    var fmt = opts.fmt || function (v) { return (v * 100).toFixed(0) + '%'; };
    var n = Math.min(xs.length, ys.length);
    if (n < 3) {
      return open(w, h, 'chart-empty') + axisText(w / 2, h / 2 + 3, 'awaiting returns', 'middle') + '</svg>';
    }
    var xd = extent(xs), yd = extent(ys);
    /* Each axis is scaled to its own spread, kept symmetric about zero so the
     * crosshairs stay centred and the sign of a move stays readable. The axes
     * are NOT squared to a common scale: bitcoin's returns run several times
     * the index's, and forcing one scale collapses the cloud into a vertical
     * sliver. The slope therefore reads as a shape, not a gradient, so the
     * numeric beta is reported in the caption beside the chart. */
    var xLim = Math.max(Math.abs(xd[0]), Math.abs(xd[1])) * 1.08 || 0.01;
    var yLim = Math.max(Math.abs(yd[0]), Math.abs(yd[1])) * 1.08 || 0.01;
    var x = scale([-xLim, xLim], [p.l, w - p.r]);
    var y = scale([-yLim, yLim], [h - p.b, p.t]);
    var yTicks = niceTicks(-yLim, yLim, 4);
    var xTicks = niceTicks(-xLim, xLim, 4);

    var s = open(w, h);
    for (var t = 0; t < yTicks.length; t++) {
      s += '<line x1="' + p.l + '" y1="' + y(yTicks[t]).toFixed(2) + '" x2="' + (w - p.r) +
        '" y2="' + y(yTicks[t]).toFixed(2) + '" class="gx-grid"/>';
      s += axisText(p.l - 5, y(yTicks[t]) + 3, fmt(yTicks[t]), 'end');
    }
    for (var xt = 0; xt < xTicks.length; xt++) {
      if (xTicks[xt] === 0) continue;
      s += axisText(x(xTicks[xt]), h - p.b + 13, fmt(xTicks[xt]), 'middle');
    }
    /* zero crosshair */
    s += '<line x1="' + p.l + '" y1="' + y(0).toFixed(2) + '" x2="' + (w - p.r) + '" y2="' + y(0).toFixed(2) + '" class="gx-zero"/>';
    s += '<line x1="' + x(0).toFixed(2) + '" y1="' + p.t + '" x2="' + x(0).toFixed(2) + '" y2="' + (h - p.b) + '" class="gx-zero"/>';

    /* OLS line, clipped to the square domain */
    var fit = opts.fit;
    if (fit && isNum(fit.slope) && isNum(fit.intercept)) {
      var x1 = -xLim, x2 = xLim;
      var y1 = fit.intercept + fit.slope * x1, y2 = fit.intercept + fit.slope * x2;
      /* Clamp each endpoint to the y domain, solving back for x, so the line
       * spans the plot without escaping the viewBox. */
      if (fit.slope !== 0) {
        if (y1 < -yLim) { y1 = -yLim; x1 = (y1 - fit.intercept) / fit.slope; }
        else if (y1 > yLim) { y1 = yLim; x1 = (y1 - fit.intercept) / fit.slope; }
        if (y2 < -yLim) { y2 = -yLim; x2 = (y2 - fit.intercept) / fit.slope; }
        else if (y2 > yLim) { y2 = yLim; x2 = (y2 - fit.intercept) / fit.slope; }
      }
      s += '<line x1="' + x(x1).toFixed(2) + '" y1="' + y(y1).toFixed(2) + '" x2="' + x(x2).toFixed(2) +
        '" y2="' + y(y2).toFixed(2) + '" stroke="' + (opts.fitColor || 'currentColor') +
        '" stroke-width="1.6" vector-effect="non-scaling-stroke"/>';
    }

    /* square marks */
    var mark = opts.markSize || 3.2;
    for (var i = 0; i < n; i++) {
      if (!isNum(xs[i]) || !isNum(ys[i])) continue;
      s += '<rect x="' + (x(xs[i]) - mark / 2).toFixed(2) + '" y="' + (y(ys[i]) - mark / 2).toFixed(2) +
        '" width="' + mark + '" height="' + mark + '" fill="' + (opts.pointColor || 'currentColor') +
        '" fill-opacity="0.72"/>';
    }

    if (opts.xTitle) s += axisText(w - p.r, h - 4, opts.xTitle, 'end', 'gx-title');
    if (opts.yTitle) {
      s += '<text x="' + (p.l - 34) + '" y="' + (p.t + 4) + '" class="gx-title" fill="currentColor" ' +
        'transform="rotate(-90 ' + (p.l - 34) + ' ' + (p.t + 4) + ')" text-anchor="end">' + opts.yTitle + '</text>';
    }
    s += '</svg>';
    return s;
  }

  /* -------------------------------------------------------------------------
   * 5. underwaterChart — drawdown depth as a hatched region hanging from 0.
   * ---------------------------------------------------------------------- */
  function underwaterChart(opts) {
    var values = opts.values || [];
    var w = opts.w || 900, h = opts.h || 150;
    var p = pad(opts.pad);
    var color = opts.color || 'currentColor';
    var fmt = opts.yFmt || function (v) { return (v * 100).toFixed(0) + '%'; };
    var finite = values.filter(isNum);
    if (finite.length < 2) {
      return open(w, h, 'chart-empty') + axisText(w / 2, h / 2 + 3, 'awaiting series', 'middle') + '</svg>';
    }
    var lo = Math.min.apply(null, finite);
    var dom = [Math.min(lo * 1.1, -0.02), 0];
    var x = scale([0, values.length - 1], [p.l, w - p.r]);
    var y = scale(dom, [h - p.b, p.t]);
    var ticks = niceTicks(dom[0], dom[1], 3);
    var hatchId = nextId('hatch');

    var s = open(w, h);
    s += '<defs><pattern id="' + hatchId + '" patternUnits="userSpaceOnUse" width="5" height="5">' +
      '<path d="M0,5 L5,0" stroke="' + color + '" stroke-width="0.9" fill="none"/></pattern></defs>';
    s += yAxis(ticks, y, p, w, fmt);

    /* stair outline, then close it back along the zero line to make the region */
    var path = stairPath(values, x, y);
    if (path.started) {
      var lastIdx = values.length - 1;
      var area = path.d + 'V' + y(0).toFixed(2) + 'H' + x(0).toFixed(2) + 'Z';
      s += '<path d="' + area + '" fill="url(#' + hatchId + ')" stroke="none" fill-opacity="0.85"/>';
      s += '<path d="' + path.d + '" fill="none" stroke="' + color + '" stroke-width="1.4" ' +
        'stroke-linejoin="miter" stroke-linecap="butt" vector-effect="non-scaling-stroke"/>';
      if (isNum(values[lastIdx])) {
        s += '<rect x="' + (x(lastIdx) - 2.5).toFixed(2) + '" y="' + (y(values[lastIdx]) - 2.5).toFixed(2) +
          '" width="5" height="5" fill="' + color + '"/>';
      }
    }
    /* zero rule sits on top of the hatching */
    s += '<line x1="' + p.l + '" y1="' + y(0).toFixed(2) + '" x2="' + (w - p.r) + '" y2="' + y(0).toFixed(2) +
      '" class="gx-axis"/>';
    s += '<line x1="' + p.l + '" y1="' + p.t + '" x2="' + p.l + '" y2="' + (h - p.b) + '" class="gx-axis"/>';
    s += xLabels(opts.xLabels, x, p, h);
    s += '</svg>';
    return s;
  }

  /* -------------------------------------------------------------------------
   * 6. smoothLine — the one curved chart in the kit, for the meter's screen.
   *    A monotone cubic line (no overshoot between samples) over a soft
   *    gradient, with the latest point marked: the shape a phone's price
   *    chart has, so the display reads as a modern backlit panel while the
   *    printed charts in the drawer stay rectilinear.
   * ---------------------------------------------------------------------- */
  function sign(x) { return x < 0 ? -1 : 1; }

  /* Tangent at the middle of three points, limited so the curve stays
   * monotone between samples (Fritsch–Carlson, as d3's curveMonotoneX). */
  function slope3(x0, y0, x1, y1, x2, y2) {
    var h0 = x1 - x0, h1 = x2 - x1;
    var s0 = (y1 - y0) / (h0 || (h1 < 0 && -0));
    var s1 = (y2 - y1) / (h1 || (h0 < 0 && -0));
    var p = (s0 * h1 + s1 * h0) / (h0 + h1);
    return (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  }

  function slope2(x0, y0, x1, y1, t) {
    var h = x1 - x0;
    return h ? (3 * (y1 - y0) / h - t) / 2 : t;
  }

  function monotonePath(xs, ys) {
    var n = xs.length;
    if (n < 2) return '';
    if (n === 2) return 'M' + xs[0].toFixed(2) + ',' + ys[0].toFixed(2) + 'L' + xs[1].toFixed(2) + ',' + ys[1].toFixed(2);
    var t = new Array(n);
    for (var i = 1; i < n - 1; i++) t[i] = slope3(xs[i - 1], ys[i - 1], xs[i], ys[i], xs[i + 1], ys[i + 1]);
    t[0] = slope2(xs[0], ys[0], xs[1], ys[1], t[1]);
    t[n - 1] = slope2(xs[n - 2], ys[n - 2], xs[n - 1], ys[n - 1], t[n - 2]);
    var d = 'M' + xs[0].toFixed(2) + ',' + ys[0].toFixed(2);
    for (var k = 0; k < n - 1; k++) {
      var dx = (xs[k + 1] - xs[k]) / 3;
      d += 'C' + (xs[k] + dx).toFixed(2) + ',' + (ys[k] + dx * t[k]).toFixed(2) +
        ' ' + (xs[k + 1] - dx).toFixed(2) + ',' + (ys[k + 1] - dx * t[k + 1]).toFixed(2) +
        ' ' + xs[k + 1].toFixed(2) + ',' + ys[k + 1].toFixed(2);
    }
    return d;
  }

  function smoothLine(opts) {
    var values = (opts.values || []).filter(isNum);
    var w = opts.w || 600, h = opts.h || 200;
    var color = opts.color || 'currentColor';
    if (values.length < 2) return open(w, h, 'chart-empty') + '</svg>';
    var p = { l: 4, r: 12, t: 12, b: 4 };
    var dom = extent(values);
    var x = scale([0, values.length - 1], [p.l, w - p.r]);
    var y = scale(dom, [h - p.b, p.t]);
    var xs = [], ys = [];
    for (var i = 0; i < values.length; i++) { xs.push(x(i)); ys.push(y(values[i])); }
    var d = monotonePath(xs, ys);
    var gid = nextId('glow');
    var lastX = xs[xs.length - 1], lastY = ys[ys.length - 1];

    var s = open(w, h, 'chart-smooth');
    s += '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" style="stop-color:' + color + ';stop-opacity:0.32"/>' +
      '<stop offset="1" style="stop-color:' + color + ';stop-opacity:0"/></linearGradient></defs>';
    s += '<path d="' + d + 'V' + (h - p.b).toFixed(2) + 'H' + xs[0].toFixed(2) + 'Z" fill="url(#' + gid + ')" stroke="none"/>';
    s += '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="' + (opts.strokeWidth || 2.4) +
      '" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
    s += '<circle cx="' + lastX.toFixed(2) + '" cy="' + lastY.toFixed(2) + '" r="8" fill="' + color + '" fill-opacity="0.22"/>';
    s += '<circle cx="' + lastX.toFixed(2) + '" cy="' + lastY.toFixed(2) + '" r="3.4" fill="' + color + '"/>';
    return s + '</svg>';
  }

  MP.geom = {
    sparkStep: sparkStep,
    smoothLine: smoothLine,
    monotonePath: monotonePath,
    stepChart: stepChart,
    columnChart: columnChart,
    scatterFit: scatterFit,
    underwaterChart: underwaterChart,
    niceTicks: niceTicks,
    extent: extent
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
