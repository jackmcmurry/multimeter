/* ============================================================================
 * findings-page.js: fills the write-up (findings.html) from data/findings.json.
 *
 * The prose is written by hand in the template; every number in it is a
 * <span data-f="…"> slot filled here, so the page can never disagree with
 * the data. Charts are the meter's own kit. Nothing is fetched but the one
 * findings file, which the data job writes from the daily history.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});
  var F = MP.fmt, G = MP.geom, SRC = MP.sources, FI = MP.findings;

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function el(id) { return document.getElementById(id); }
  function setHtml(id, html) { var n = el(id); if (n) n.innerHTML = html; }
  function pct(v, dp) { return isNum(v) ? (v * 100).toFixed(dp === undefined ? 1 : dp) + '%' : F.DASH; }
  function num(v, dp) { return isNum(v) ? v.toFixed(dp === undefined ? 2 : dp) : F.DASH; }
  function pair(f, k) { return f.pairs && f.pairs[k] ? f.pairs[k] : null; }
  function win(f, k, w) {
    var p = pair(f, k);
    if (!p) return null;
    for (var i = 0; i < p.coupling.length; i++) if (p.coupling[i].window === w) return p.coupling[i];
    return null;
  }
  function run(r) { return r ? r.sessions + ' sessions, ' + F.shortDate(r.from) + ' to ' + F.shortDate(r.to) : 'none in this sample'; }
  function utc(iso) { var t = Date.parse(iso); return isFinite(t) ? new Date(t).toUTCString().replace(/:\d\d GMT$/, ' UTC') : F.DASH; }

  var SLOTS = {
    sessions: function (f) { return String(f.sessions); },
    from: function (f) { return F.shortDate(f.from); },
    to: function (f) { return F.shortDate(f.to); },
    asOf: function (f) { return F.shortDate(f.asOf); },
    generatedAt: function (f) { return utc(f.generatedAt || f.computedAt); },
    regime: function (f) { return FI.label(f); },
    'corr90-ixic': function (f) { var c = win(f, 'ixic', 90); return c ? num(c.correlation) : F.DASH; },
    'beta90-ixic': function (f) { var c = win(f, 'ixic', 90); return c ? num(c.beta) : F.DASH; },
    'r2-90-ixic': function (f) { var c = win(f, 'ixic', 90); return c ? num(c.r2) : F.DASH; },
    'corr90-spx': function (f) { var c = win(f, 'spx', 90); return c ? num(c.correlation) : F.DASH; },
    'beta252-ixic': function (f) { var c = win(f, 'ixic', 252); return c ? num(c.beta) : F.DASH; },
    'r2-252-ixic': function (f) { var c = win(f, 'ixic', 252); return c ? num(c.r2) : F.DASH; },
    'r2-252-pct': function (f) { var c = win(f, 'ixic', 252); return c ? pct(c.r2, 0) : F.DASH; },
    coupledShare: function (f) { var p = pair(f, 'ixic'); return p ? pct(p.regimes.coupledShare, 0) : F.DASH; },
    decoupledShare: function (f) { var p = pair(f, 'ixic'); return p ? pct(p.regimes.decoupledShare, 0) : F.DASH; },
    middleShare: function (f) { var p = pair(f, 'ixic'); return p ? pct(p.regimes.middleShare, 0) : F.DASH; },
    longestCoupled: function (f) { var p = pair(f, 'ixic'); return p ? run(p.regimes.longestCoupled) : F.DASH; },
    longestDecoupled: function (f) { var p = pair(f, 'ixic'); return p ? run(p.regimes.longestDecoupled) : F.DASH; },
    scatterN: function (f) { var p = pair(f, 'ixic'); return p ? String(p.scatter.fit.n) : F.DASH; },
    scatterBeta: function (f) { var p = pair(f, 'ixic'); return p ? num(p.scatter.fit.slope) : F.DASH; },
    volBtc: function (f) { var p = pair(f, 'ixic'); return p ? pct(p.vol.coin, 0) : F.DASH; },
    volIdx: function (f) { var p = pair(f, 'ixic'); return p ? pct(p.vol.index, 0) : F.DASH; },
    volRatio: function (f) { var p = pair(f, 'ixic'); return p && isNum(p.vol.ratio) ? p.vol.ratio.toFixed(1) + '×' : F.DASH; },
    volBtcYear: function (f) { var p = pair(f, 'ixic'); return p ? pct(p.vol.coinYear, 0) : F.DASH; },
    volIdxYear: function (f) { var p = pair(f, 'ixic'); return p ? pct(p.vol.indexYear, 0) : F.DASH; },
    ddBtcNow: function (f) { var d = f.drawdowns && f.drawdowns.btc; return d ? pct(d.now, 1) : F.DASH; },
    ddBtcMax: function (f) { var d = f.drawdowns && f.drawdowns.btc; return d ? pct(d.max, 1) : F.DASH; },
    ddIdxMax: function (f) { var d = f.drawdowns && f.drawdowns.ixic; return d ? pct(d.max, 1) : F.DASH; },
    agreement252: function (f) { var p = pair(f, 'ixic'); return p ? pct(p.agreement.last252, 0) : F.DASH; },
    agreementAll: function (f) { var p = pair(f, 'ixic'); return p ? pct(p.agreement.all, 0) : F.DASH; }
  };

  function fill(f) {
    var nodes = document.querySelectorAll('[data-f]');
    for (var i = 0; i < nodes.length; i++) {
      var name = nodes[i].getAttribute('data-f');
      var fn = SLOTS[name];
      var text = F.DASH;
      if (fn) { try { text = fn(f); } catch (e) { text = F.DASH; } }
      nodes[i].textContent = text;
    }
  }

  function couplingRows(f, k, code) {
    var p = pair(f, k);
    if (!p) return '';
    return '<tr class="row-rule"><th scope="row" colspan="5">BTC vs ' + F.escapeHtml(code) + '</th></tr>' +
      p.coupling.map(function (c) {
        return '<tr><th scope="row">' + c.window + 'd</th><td>' + num(c.correlation, 3) + '</td><td>' + num(c.beta, 3) +
          '</td><td>' + num(c.r2, 3) + '</td><td class="dim">' + c.n + '</td></tr>';
      }).join('');
  }

  function charts(f) {
    var p = pair(f, 'ixic');
    if (!p) return;
    setHtml('chartRoll', G.stepChart({
      series: [{ values: p.rolling90.map(function (e) { return e.value; }), color: 'var(--c-idx)' }],
      w: 900, h: 230, yDomain: [-1, 1], zeroLine: true, tickCount: 4,
      yFmt: function (v) { return v.toFixed(1); },
      xLabels: p.rolling90.map(function (e) { return F.shortDate(e.date); }),
      bands: [{ from: FI.config.COUPLED, to: 1, color: 'var(--pos)' }, { from: -1, to: FI.config.DECOUPLED, color: 'var(--neg)' }]
    }));
    setHtml('couplingTable',
      '<table class="data"><thead><tr><th scope="col">Window</th><th scope="col">Corr</th><th scope="col">Beta</th>' +
      '<th scope="col">R²</th><th scope="col">n</th></tr></thead><tbody>' +
      couplingRows(f, 'ixic', '^IXIC') + couplingRows(f, 'spx', '^GSPC') + '</tbody></table>');
    setHtml('breaksTable', p.breaks.length
      ? '<table class="data"><thead><tr><th scope="col">Sessions</th><th scope="col">Before</th><th scope="col">After</th><th scope="col">Fall</th></tr></thead><tbody>' +
        p.breaks.map(function (b) {
          return '<tr><th scope="row">' + F.shortDate(b.from) + ' → ' + F.shortDate(b.to) + '</th><td>' + num(b.before) + '</td><td>' + num(b.after) +
            '</td><td class="neg">−' + num(b.drop) + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<p class="foot">No fall of note: the correlation never dropped over any 20-session span in this window.</p>');
    setHtml('chartScatter', G.scatterFit({
      xs: p.scatter.xs, ys: p.scatter.ys, fit: p.scatter.fit, w: 560, h: 320,
      pointColor: 'var(--c-btc)', fitColor: 'var(--gold)', xTitle: '^IXIC', yTitle: 'BTC'
    }));
    setHtml('chartVol', G.columnChart({
      series: [{ values: p.vol.series.coin, color: 'var(--c-btc)' }, { values: p.vol.series.index, color: 'var(--c-idx)' }],
      w: 900, h: 190, yFmt: function (v) { return (v * 100).toFixed(0) + '%'; },
      xLabels: p.vol.series.dates.map(F.shortDate)
    }));
    var dd = f.drawdowns || {};
    var rows = [['BTC', dd.btc], ['^IXIC', dd.ixic], ['^GSPC', dd.spx]].filter(function (r) { return r[1]; });
    setHtml('ddTable', '<table class="data"><thead><tr><th scope="col">Asset</th><th scope="col">Now</th><th scope="col">Deepest</th>' +
      '<th scope="col">Peak</th><th scope="col">Trough</th><th scope="col">Recovered</th><th scope="col">Episodes</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var d = r[1], e = d.deepest;
        return '<tr><th scope="row">' + F.escapeHtml(r[0]) + '</th><td class="neg">' + pct(d.now, 1) + '</td><td class="neg">' + pct(d.max, 1) + '</td>' +
          '<td class="dim">' + (e ? F.shortDate(e.peakDate) : F.DASH) + '</td><td class="dim">' + (e ? F.shortDate(e.troughDate) : F.DASH) + '</td>' +
          '<td>' + (e ? (e.ongoing ? '<span class="tag">not yet</span>' : F.shortDate(e.recoveryDate)) : F.DASH) + '</td>' +
          '<td class="dim">' + d.episodes + '</td></tr>';
      }).join('') + '</tbody></table>');
    setHtml('narrative', FI.narrative(f).map(function (s) { return '<p>' + F.escapeHtml(s) + '</p>'; }).join(''));
  }

  function notice(level, text) {
    setHtml('findingsNotice', '<p class="notice notice-' + level + '">' + F.escapeHtml(text) + '</p>');
  }

  function load() {
    var url = SRC.SNAPSHOT.findings + '?t=' + Math.floor(Date.now() / 60000);
    return fetch(url).then(function (res) {
      if (res.status === 404) throw Object.assign(new Error('missing'), { status: 404 });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (payload) {
      var f = SRC.normalizeFindingsSnapshot(payload);
      if (!f) throw new Error('unusable');
      fill(f);
      charts(f);
      setHtml('findingsNotice', '');
      document.body.classList.add('has-findings');
    }).catch(function (err) {
      if (err && err.status === 404) notice('quiet', 'Findings appear after the first scheduled update writes daily history. The prose below describes the method; the numbers fill in then.');
      else notice('bad', 'Could not load the findings. Retrying on the next visit.');
    });
  }

  function start() {
    load();
    var nav = root.navigator;
    if (nav && 'serviceWorker' in nav && root.location && root.location.protocol !== 'file:') {
      try { nav.serviceWorker.register('sw.js').catch(function () { /* no offline shell */ }); } catch (e) { /* unavailable */ }
    }
  }

  MP.findingsPage = { SLOTS: SLOTS, fill: fill, charts: charts, load: load };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(typeof globalThis !== 'undefined' ? globalThis : this);
