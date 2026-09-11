/* ============================================================================
 * share.js: the share card: the screen's reading as a 1200 x 630 picture.
 *
 * Draws what the screen shows (mode, chart, price, change) onto a canvas
 * and hands the PNG to the system share sheet where there is one, else to
 * the clipboard, else as a download. The chart is the same smoothLine SVG
 * the screen uses, rasterised through an Image; a standalone SVG cannot
 * resolve the page's CSS variables, so colours are passed as resolved hex.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});
  var G = MP.geom;

  var W = 1200, H = 630;

  /* used when a token cannot be read (a detached document, a test) */
  var FALLBACK = {
    '--bg': '#0b0d12', '--lcd': '#0a1216', '--lcd-ink': '#e6fff5', '--lcd-dim': '#6d8c86',
    '--up': '#2ee59d', '--down': '#ff6b6b', '--holster': '#f6b71f', '--lcd-tab': '#17303a'
  };

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function el(id) { return document.getElementById(id); }

  function token(name) {
    try {
      var v = root.getComputedStyle(document.documentElement).getPropertyValue(name);
      if (v && v.trim()) return v.trim();
    } catch (e) { /* no document */ }
    return FALLBACK[name] || '#888888';
  }

  /* A standalone SVG document needs the namespace inline HTML lets it skip,
   * and Safari draws one without width/height at 300 x 150. */
  function svgWithSize(svg, w, h) {
    return String(svg).replace(/<svg\b([^>]*)>/, function (m, attrs) {
      var a = attrs.replace(/\s(?:width|height)="[^"]*"/g, '');
      if (a.indexOf('xmlns=') < 0) a += ' xmlns="http://www.w3.org/2000/svg"';
      return '<svg' + a + ' width="' + w + '" height="' + h + '">';
    });
  }

  function svgToImage(svg, w, h) {
    return new Promise(function (resolve, reject) {
      var blob = new Blob([svgWithSize(svg, w, h)], { type: 'image/svg+xml;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.width = w;
      img.height = h;
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('chart image failed')); };
      img.src = url;
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fontsReady() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    return Promise.all([
      document.fonts.load('700 88px "Space Grotesk"'),
      document.fonts.load('600 30px "Space Grotesk"'),
      document.fonts.load('600 22px "JetBrains Mono"'),
      document.fonts.load('900 28px "Inter Tight"')
    ]).then(function () { return document.fonts.ready; }).catch(function () { /* system fonts then */ });
  }

  /* r: a reading from MP.app.reading; meta: { mode, dir, change, label, site, when } */
  function renderCard(r, meta) {
    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d');
    var color = meta.dir === 'down' ? token('--down') : token('--up');
    var series = r.spark || [];

    return fontsReady().then(function () {
      return series.length > 1
        ? svgToImage(G.smoothLine({ values: series, w: 1040, h: 250, color: color, strokeWidth: 3 }), 1040, 250)
        : null;
    }).then(function (chart) {
      ctx.fillStyle = token('--bg');
      ctx.fillRect(0, 0, W, H);

      ctx.fillStyle = token('--lcd');
      roundRect(ctx, 40, 40, W - 80, H - 80, 28);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.textBaseline = 'top';
      ctx.fillStyle = token('--lcd-dim');
      ctx.font = '600 22px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillText(String(meta.mode || '').toUpperCase(), 80, 74);
      ctx.textAlign = 'right';
      ctx.fillStyle = token('--holster');
      ctx.font = '900 28px "Neue Haas Grotesk Display Pro", "Helvetica Neue", "Inter Tight", sans-serif';   /* the wordmark, as on the meter */
      ctx.fillText('MULTIMETER', W - 80, 70);
      ctx.textAlign = 'left';

      if (chart) ctx.drawImage(chart, 80, 118, 1040, 250);

      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(80, 392, 1040, 2);

      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = token('--lcd-ink');
      ctx.font = '700 88px "Space Grotesk", sans-serif';
      var price = r.text || '—';
      ctx.fillText(price, 80, 492);
      var pw = ctx.measureText(price).width;
      ctx.fillStyle = token('--lcd-dim');
      ctx.font = '600 22px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillText(r.unit || '', 80 + pw + 20, 492);

      ctx.fillStyle = color;
      ctx.font = '600 30px "Space Grotesk", sans-serif';
      ctx.fillText(meta.change || '', 80, 548);
      var cw = ctx.measureText(meta.change || '').width;
      ctx.fillStyle = token('--lcd-dim');
      ctx.font = '600 22px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillText(meta.label || '', 80 + cw + 18, 546);

      ctx.textAlign = 'right';
      ctx.font = '500 18px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillText(meta.site + '  ·  ' + meta.when, W - 80, 548);
      ctx.textAlign = 'left';
      return canvas;
    });
  }

  function toBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) { if (blob) resolve(blob); else reject(new Error('no image')); }, 'image/png');
    });
  }

  function direction(r) {
    var c = r.change;
    if (c && isNum(c.pct)) return c.pct < 0 ? 'down' : 'up';
    if (c && isNum(c.delta)) return c.delta < 0 ? 'down' : 'up';
    var s = r.spark || [];
    return s.length > 1 && s[s.length - 1] < s[0] ? 'down' : 'up';
  }

  /* Resolves to how the card left: 'shared', 'copied', 'downloaded', or 'off'. */
  function share() {
    var stop = MP.meter && MP.meter.current ? MP.meter.current() : null;
    if (!stop || stop === 'off' || !MP.app || !MP.app.reading) return Promise.resolve('off');
    var r = MP.app.reading(stop);
    /* MOVER, LOSER and WATCH carry a badge, a ticker and a leading price */
    var changeLine = MP.meter.changeText ? MP.meter.changeText(r.change, r.unit) : '';
    var meta = {
      mode: (r.badge && r.badge.text ? r.badge.text + '  ' : '') + (r.ticker ? r.ticker + '  ' : '') + (r.mode || ''),
      dir: r.headDir || direction(r),
      change: r.lead && !r.empty ? r.lead + '  ' + changeLine : changeLine,
      label: r.change ? r.change.label : '',
      site: root.location.host + root.location.pathname.replace(/index\.html$/, ''),
      when: new Date().toUTCString().replace(/:\d\d GMT$/, ' UTC')
    };
    var name = 'multimeter-' + stop + '.png';
    return renderCard(r, meta).then(toBlob).then(function (blob) {
      var nav = root.navigator;
      var file = typeof root.File === 'function' ? new root.File([blob], name, { type: 'image/png' }) : null;
      if (file && nav.canShare && nav.share && nav.canShare({ files: [file] })) {
        return nav.share({ files: [file], title: 'Multimeter', text: meta.mode + ' ' + r.text }).then(function () { return 'shared'; });
      }
      if (nav.clipboard && nav.clipboard.write && root.ClipboardItem) {
        return nav.clipboard.write([new root.ClipboardItem({ 'image/png': blob })]).then(function () { return 'copied'; });
      }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      return 'downloaded';
    });
  }

  var flashTimer = null;
  function flash(btn, text) {
    btn.textContent = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { btn.textContent = 'SHARE'; }, 1600);
  }

  function wire() {
    var btn = el('shareBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      btn.classList.add('is-busy');
      share().then(function (how) {
        flash(btn, how === 'copied' ? 'COPIED' : how === 'shared' ? 'SHARED' : how === 'downloaded' ? 'SAVED' : 'SHARE');
      }, function () {
        flash(btn, 'FAILED');
      }).then(function () { btn.classList.remove('is-busy'); });
    });
  }

  if (root.document) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  }

  MP.share = { FALLBACK: FALLBACK, token: token, svgWithSize: svgWithSize, renderCard: renderCard, share: share };
})(typeof globalThis !== 'undefined' ? globalThis : this);
