/* ============================================================================
 * stats.test.js — assertions for MP.stats against hand-computed values.
 *
 * No local JS runtime is installed on this machine (no node/deno/bun), so the
 * suite is written to run in any JS engine and report a plain object:
 *
 *   MP.test.run()  ->  { passed, failed, failures: [...] }
 *
 * It is executed against the browser's engine during the build check; see
 * README.md ("Verification").
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});
  var S = MP.stats;

  var results = [];

  function ok(name, condition, detail) {
    results.push({ name: name, pass: !!condition, detail: condition ? null : (detail || 'assertion failed') });
  }

  function close(name, actual, expected, tol) {
    tol = tol === undefined ? 1e-9 : tol;
    var pass = typeof actual === 'number' && isFinite(actual) && Math.abs(actual - expected) <= tol;
    results.push({
      name: name,
      pass: pass,
      detail: pass ? null : 'expected ' + expected + ' (+/-' + tol + '), got ' + actual
    });
  }

  function eq(name, actual, expected) {
    var pass = actual === expected;
    results.push({ name: name, pass: pass, detail: pass ? null : 'expected ' + expected + ', got ' + actual });
  }

  function run() {
    results = [];

    /* ---- central moments -------------------------------------------------- */
    var sample = [2, 4, 4, 4, 5, 5, 7, 9];
    close('mean of known sample', S.mean(sample), 5);
    close('population variance (ddof 0)', S.variance(sample, 0), 4);
    close('population stdev (ddof 0)', S.stdev(sample, 0), 2);
    close('sample variance (ddof 1)', S.variance(sample, 1), 32 / 7, 1e-12);
    close('sample stdev (ddof 1)', S.stdev(sample, 1), Math.sqrt(32 / 7), 1e-12);
    ok('variance of single observation is NaN', isNaN(S.variance([1])));

    /* ---- correlation ------------------------------------------------------ */
    /* xs=[1..5], ys=[2,4,5,4,5]: Sxy=6, Sxx=10, Syy=6 -> r = 6/sqrt(60) */
    close('pearson on hand-computed pair', S.pearson([1, 2, 3, 4, 5], [2, 4, 5, 4, 5]), 6 / Math.sqrt(60), 1e-12);
    close('pearson of identical series is 1', S.pearson([1, 2, 3, 4], [1, 2, 3, 4]), 1, 1e-12);
    close('pearson of mirrored series is -1', S.pearson([1, 2, 3, 4], [4, 3, 2, 1]), -1, 1e-12);
    ok('pearson of a flat series is NaN', isNaN(S.pearson([1, 1, 1, 1], [1, 2, 3, 4])));

    /* ---- beta / regression ------------------------------------------------ */
    var bench = [0.01, -0.02, 0.015, 0.03, -0.005, 0.02];
    var levered = bench.map(function (r) { return 2 * r; });
    close('beta of exact 2x series is 2', S.beta(levered, bench), 2, 1e-12);
    close('beta of series against itself is 1', S.beta(bench, bench), 1, 1e-12);

    var reg = S.regression(bench, levered.map(function (r) { return r + 0.001; }));
    close('regression slope recovers 2', reg.slope, 2, 1e-12);
    close('regression intercept recovers 0.001', reg.intercept, 0.001, 1e-12);
    close('regression r2 of exact fit is 1', reg.r2, 1, 1e-12);
    eq('regression reports n', reg.n, 6);

    /* ---- log returns ------------------------------------------------------ */
    var lr = S.logReturns([100, 110, 99]);
    eq('logReturns length is n-1', lr.length, 2);
    close('logReturns first value', lr[0], Math.log(1.1), 1e-12);
    close('logReturns second value', lr[1], Math.log(99 / 110), 1e-12);
    ok('logReturns guards non-positive prices', isNaN(S.logReturns([100, 0])[0]));

    /* ---- annualization ---------------------------------------------------- */
    var flatVol = S.annualizedVol([0.01, -0.01, 0.01, -0.01], 252);
    close('annualizedVol scales by sqrt(252)',
      flatVol, S.stdev([0.01, -0.01, 0.01, -0.01]) * Math.sqrt(252), 1e-12);
    ok('annualizedVol of a single return is NaN', isNaN(S.annualizedVol([0.01], 252)));

    /* ---- rolling windows -------------------------------------------------- */
    var roll = S.rolling([1, 2, 3, 4, 5], 3, S.mean);
    eq('rolling produces n-w+1 windows', roll.length, 3);
    eq('rolling indexes the window end', roll[0].index, 2);
    close('rolling mean of first window', roll[0].value, 2, 1e-12);
    close('rolling mean of last window', roll[2].value, 4, 1e-12);
    eq('rolling with window > length is empty', S.rolling([1, 2], 5, S.mean).length, 0);

    var rollPair = S.rollingPair([1, 2, 3, 4], [2, 4, 6, 8], 3, S.pearson);
    eq('rollingPair window count', rollPair.length, 2);
    close('rollingPair correlation is 1', rollPair[0].value, 1, 1e-12);

    /* ---- date alignment --------------------------------------------------- */
    var a = [
      { date: '2026-01-03', price: 10 },  /* weekend-only observation */
      { date: '2026-01-02', price: 9 },
      { date: '2026-01-05', price: 11 }
    ];
    var b = [
      { date: '2026-01-02', price: 100 },
      { date: '2026-01-05', price: 105 },
      { date: '2026-01-06', price: 106 }
    ];
    var aligned = S.alignByDate(a, b);
    eq('alignByDate keeps only common dates', aligned.dates.length, 2);
    eq('alignByDate sorts ascending', aligned.dates[0], '2026-01-02');
    eq('alignByDate second date', aligned.dates[1], '2026-01-05');
    eq('alignByDate maps series A', aligned.a[1], 11);
    eq('alignByDate maps series B', aligned.b[1], 105);

    eq('dayGap counts calendar days', S.dayGap('2026-01-02', '2026-01-05'), 3);
    eq('dayGap across a month boundary', S.dayGap('2026-01-30', '2026-02-02'), 3);

    /* ---- drawdown --------------------------------------------------------- */
    close('maxDrawdown of 100->80->120', S.maxDrawdown([100, 80, 120]), -0.2, 1e-12);
    close('maxDrawdown of a monotonic rise is 0', S.maxDrawdown([1, 2, 3]), 0, 1e-12);

    var ddDates = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07'];
    var ddPrices = [100, 90, 80, 95, 120, 110, 130];
    var eps = S.drawdownEpisodes(ddDates, ddPrices, { minDepth: 0.05 });
    eq('two qualifying episodes found', eps.length, 2);
    eq('deepest episode first', eps[0].peakDate, '2026-01-01');
    close('deepest episode depth', eps[0].depth, -0.2, 1e-12);
    eq('deepest episode trough date', eps[0].troughDate, '2026-01-03');
    eq('deepest episode recovery date', eps[0].recoveryDate, '2026-01-05');
    eq('deepest episode decline length', eps[0].declineDays, 2);
    eq('deepest episode recovery length', eps[0].recoveryDays, 2);
    ok('recovered episode is not ongoing', eps[0].ongoing === false);
    close('second episode depth', eps[1].depth, 110 / 120 - 1, 1e-12);

    var ongoing = S.drawdownEpisodes(
      ['2026-01-01', '2026-01-02', '2026-01-03'], [100, 70, 75], { minDepth: 0.05 });
    eq('unrecovered episode is returned', ongoing.length, 1);
    ok('unrecovered episode flagged ongoing', ongoing[0].ongoing === true);
    eq('unrecovered episode has no recovery date', ongoing[0].recoveryDate, null);
    close('unrecovered episode measures peak-to-trough', ongoing[0].depth, -0.3, 1e-12);

    var shallow = S.drawdownEpisodes(['2026-01-01', '2026-01-02', '2026-01-03'], [100, 99, 101], { minDepth: 0.05 });
    eq('episodes shallower than minDepth are dropped', shallow.length, 0);

    var limited = S.drawdownEpisodes(ddDates, ddPrices, { minDepth: 0.01, limit: 1 });
    eq('limit caps the episode list', limited.length, 1);

    /* ---- helpers ---------------------------------------------------------- */
    eq('tail returns the last k', S.tail([1, 2, 3, 4, 5], 2).join(','), '4,5');
    eq('tail clamps to length', S.tail([1, 2], 9).join(','), '1,2');

    var cw = S.couplingWindows(levered, bench, [3, 6, 400]);
    eq('couplingWindows returns one row per window', cw.length, 3);
    close('couplingWindows beta on full sample', cw[1].beta, 2, 1e-12);
    close('couplingWindows correlation on full sample', cw[1].correlation, 1, 1e-12);
    eq('couplingWindows clamps n to available data', cw[2].n, 6);

    var pc = S.pairwiseClean([1, NaN, 3], [4, 5, NaN]);
    eq('pairwiseClean drops incomplete pairs', pc.a.length, 1);
    eq('pairwiseClean keeps alignment', pc.a[0] + ':' + pc.b[0], '1:4');

    /* ---- spotlight selection ---------------------------------------------- */
    var SP = MP.spotlight;
    if (!SP) {
      ok('spotlight module is loaded', false, 'MP.spotlight missing');
    } else {
      var scan = [
        { symbol: 'AAA', changePct5d: 2.1 },
        { symbol: 'BBB', changePct5d: -9.4 },
        { symbol: 'CCC', changePct5d: 5.2 }
      ];
      var pickA = SP.selectSpotlight(scan);
      eq('selects the largest ABSOLUTE move, not the largest gain', pickA.symbol, 'BBB');
      eq('records the direction of the winner', pickA.direction, 'down');
      eq('runner-up is the next largest absolute move', pickA.runnerUp.symbol, 'CCC');
      eq('counts the names actually priced', pickA.scanned, 3);
      eq('nothing skipped when every name priced', pickA.skipped, 0);

      /* a plan denial arrives as a non-finite change and must not win */
      var withDenial = SP.selectSpotlight([
        { symbol: 'AVGO', changePct5d: NaN },
        { symbol: 'INTC', changePct5d: 8.5 }
      ]);
      eq('unavailable symbols are skipped', withDenial.symbol, 'INTC');
      eq('skipped count reflects denials', withDenial.skipped, 1);
      eq('scanned count excludes denials', withDenial.scanned, 1);

      ok('returns null when nothing is priced', SP.selectSpotlight([
        { symbol: 'AAA', changePct5d: NaN }
      ]) === null);
      ok('returns null on an empty scan', SP.selectSpotlight([]) === null);

      var tie = SP.selectSpotlight([
        { symbol: 'ZZZ', changePct5d: 5 },
        { symbol: 'AAA', changePct5d: -5 }
      ]);
      eq('equal magnitudes break on symbol for a stable result', tie.symbol, 'AAA');

      /* week identity: every day of a week resolves to the same Monday */
      eq('Thursday resolves to its Monday', SP.weekOf(new Date('2026-09-10T12:00:00Z')), '2026-09-07');
      eq('Monday resolves to itself', SP.weekOf(new Date('2026-09-07T00:00:00Z')), '2026-09-07');
      eq('Sunday resolves back, not forward', SP.weekOf(new Date('2026-09-13T23:00:00Z')), '2026-09-07');
      eq('week boundary crosses a month correctly', SP.weekOf(new Date('2026-10-01T12:00:00Z')), '2026-09-28');
      eq('universe names resolve', SP.nameFor('ADBE'), 'Adobe Inc.');
      eq('unknown symbols fall back to themselves', SP.nameFor('XYZ'), 'XYZ');
    }

    /* ---- routing ---------------------------------------------------------- */
    var R = MP.router;
    if (!R) {
      ok('router module is loaded', false, 'MP.router missing');
    } else {
      eq('bare hash resolves to the default stop', R.parseHash(''), 'btc');
      eq('null hash resolves to the default stop', R.parseHash(null), 'btc');
      eq('known hash resolves to its stop', R.parseHash('#corr'), 'corr');
      eq('old section hash aliases to a stop', R.parseHash('#coupling'), 'corr');
      eq('leading slash is tolerated', R.parseHash('#/drawdown'), 'dd');
      eq('case is normalised', R.parseHash('#VOLATILITY'), 'vol');
      eq('query junk is stripped', R.parseHash('#markets?x=1'), 'btc');
      eq('ticker alias resolves', R.parseHash('#ixic'), 'nasdaq');
      eq('S&P alias resolves', R.parseHash('#gspc'), 'spx');
      eq('retired beta stop aliases to corr', R.parseHash('#beta'), 'corr');
      eq('about aliases to the off stop', R.parseHash('#about'), 'off');
      eq('unknown hash falls back rather than showing nothing', R.parseHash('#nope'), 'btc');
      eq('every stop has a title', R.VIEWS.filter(function (v) { return !R.TITLES[v]; }).length, 0);
      eq('every stop has a panel', R.VIEWS.filter(function (v) { return !R.PANELS[v]; }).length, 0);
    }

    /* ---- seven-segment readout -------------------------------------------- */
    var SEG = MP.sevenseg;
    if (!SEG) {
      ok('sevenseg module is loaded', false, 'MP.sevenseg missing');
    } else {
      eq('integer price fits as-is', SEG.fit(116432, { dp: 0 }).text, '116432');
      eq('two decimals kept when they fit', SEG.fit(26081.724, { dp: 2 }).text, '26081.72');
      eq('small ratio keeps its decimals', SEG.fit(0.42, { dp: 2 }).text, '0.42');
      eq('decimals are dropped before overloading', SEG.fit(1234567.89, { dp: 2 }).text, '1234568');
      eq('negative reading lights the sign', SEG.fit(-12.34, { dp: 1 }).neg, true);
      eq('negative reading text is unsigned', SEG.fit(-12.34, { dp: 1 }).text, '12.3');
      eq('rounds-to-zero is not negative', SEG.fit(-0.001, { dp: 2 }).neg, false);
      eq('non-finite reads as dashes', SEG.fit(NaN).text, '----');
      eq('too many digits overloads', SEG.fit(12345678, { dp: 0 }).text, 'OL');
      eq('readout is right-aligned to seven cells', SEG.cells('42').length, 7);
      eq('decimal point attaches to the preceding cell', SEG.cells('4.2')[5].dp, true);
      var lit = SEG.svg('8.8', true);
      ok('lit segments carry the on class', lit.indexOf('class="seg on"') > 0, 'no lit segment');
      eq('every segment is always drawn', (SEG.svg('0').match(/class="seg/g) || []).length, SEG.DIGITS * 8 + 1);
    }

    /* ---- dial ------------------------------------------------------------- */
    var M = MP.meter;
    if (!M) {
      ok('meter module is loaded', false, 'MP.meter missing');
    } else {
      eq('dial stops mirror the router views', M.STOPS.map(function (s) { return s.id; }).join(','), R ? R.VIEWS.join(',') : '');
      eq('last stop sits at 320 degrees', Math.round(M.angleOf(M.STOPS.length - 1)), 320);
      eq('the dead zone past the last stop snaps to OFF', M.stopAt(350), 0);
      eq('the dead zone before the last stop snaps to it', M.stopAt(325), M.STOPS.length - 1);
      eq('just under a detent snaps down', M.stopAt(M.STEP_DEG * 1.5 - 1), 1);
      eq('just over a detent snaps up', M.stopAt(M.STEP_DEG * 1.5 + 1), 2);
      eq('ampersand label is escaped in the plate', M.plateSvg().indexOf('S&amp;P') > 0, true);
    }

    var passed = results.filter(function (r) { return r.pass; }).length;
    var failures = results.filter(function (r) { return !r.pass; });
    return {
      total: results.length,
      passed: passed,
      failed: failures.length,
      failures: failures.map(function (f) { return f.name + ' -> ' + f.detail; })
    };
  }

  MP.test = { run: run };
})(typeof globalThis !== 'undefined' ? globalThis : this);
