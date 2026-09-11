/* ============================================================================
 * stats.test.js: assertions for MP.stats against hand-computed values.
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
        { symbol: 'AAA', name: 'Aaa Corp.', change5d: 2.1 },
        { symbol: 'BBB', change5d: -9.4 },
        { symbol: 'CCC', change5d: 5.2 },
        { symbol: 'DDD', change5d: 12.0 },
        { symbol: 'EEE', change5d: -0.5 },
        { symbol: 'FFF', change5d: NaN }
      ];
      var mv = SP.selectMovers(scan, 'change5d');
      eq('the mover is the largest gain, not the largest absolute move', mv.mover.symbol, 'DDD');
      eq('the loser is the largest drop', mv.loser.symbol, 'BBB');
      eq('the next highest follows the mover', mv.moverNext.symbol, 'CCC');
      eq('the next lowest follows the loser', mv.loserNext.symbol, 'EEE');
      eq('counts the names actually priced', mv.scanned, 5);
      eq('an unpriced name is skipped and counted', mv.skipped, 1);
      eq('ranks run from the top', mv.mover.rank + ',' + mv.loser.rank, '1,5');
      eq('the board top runs highest first', mv.top.map(function (e) { return e.symbol; }).join(','), 'DDD,CCC,AAA,EEE,BBB');
      eq('with five names the bottom repeats none of them', mv.bottom.length, 0);
      eq('a row without a name is named by its symbol', mv.loser.name, 'BBB');
      eq('a name is carried through', mv.top[2].name, 'Aaa Corp.');
      close('the change is carried through', mv.mover.change, 12.0);

      var twelve = [];
      for (var q12 = 0; q12 < 12; q12++) twelve.push({ symbol: 'S' + (q12 < 10 ? '0' : '') + q12, change5d: q12 });
      var b12 = SP.selectMovers(twelve, 'change5d');
      eq('twelve names fill both ends of the board', b12.top.length + ':' + b12.bottom.length, '5:5');
      eq('the bottom starts with the lowest', b12.bottom[0].symbol, 'S00');
      eq('the lowest ranks last', b12.bottom[0].rank, 12);
      var seven = SP.selectMovers(twelve.slice(0, 7), 'change5d');
      eq('seven names split five and two', seven.top.length + ':' + seven.bottom.length, '5:2');

      var one = SP.selectMovers([{ symbol: 'ONE', change5d: -3 }], 'change5d');
      ok('a single priced name has no loser', one.mover.symbol === 'ONE' && one.loser === null && one.moverNext === null);
      ok('returns null when nothing is priced', SP.selectMovers([{ symbol: 'AAA', change5d: NaN }], 'change5d') === null);
      ok('returns null on an empty scan', SP.selectMovers([], 'change5d') === null);
      ok('a null move is skipped', SP.selectMovers([{ symbol: 'A', change5d: null }, { symbol: 'B', change5d: 1 }], 'change5d').skipped === 1);
      var tie = SP.selectMovers([{ symbol: 'ZZZ', change5d: 5 }, { symbol: 'AAA', change5d: 5 }, { symbol: 'MMM', change5d: 1 }], 'change5d');
      eq('equal moves break on symbol for a stable result', tie.mover.symbol, 'AAA');
      var coinsMv = SP.selectMovers([{ id: 'solana', symbol: 'SOL', changePct7d: 18.4 }, { id: 'dogecoin', symbol: 'DOGE', changePct7d: -15.2 }], 'changePct7d');
      eq('a coin keeps its id', coinsMv.mover.id + ',' + coinsMv.loser.id, 'solana,dogecoin');

      /* week identity: every day of a week resolves to the same Monday */
      eq('Thursday resolves to its Monday', SP.weekOf(new Date('2026-09-10T12:00:00Z')), '2026-09-07');
      eq('Monday resolves to itself', SP.weekOf(new Date('2026-09-07T00:00:00Z')), '2026-09-07');
      eq('Sunday resolves back, not forward', SP.weekOf(new Date('2026-09-13T23:00:00Z')), '2026-09-07');
      eq('week boundary crosses a month correctly', SP.weekOf(new Date('2026-10-01T12:00:00Z')), '2026-09-28');
      eq('a symbol without a name stands for itself', SP.nameFor('XYZ'), 'XYZ');
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
      eq('twelve stops share 320 degrees', Math.round(M.STEP_DEG), 29);

      /* skins */
      var skinBefore = M.currentSkin();
      ok('gold is among the skins', M.SKINS.indexOf('gold') === 0 && M.SKINS.length >= 6);
      eq('a skin can be chosen', M.setSkin('blue'), 'blue');
      eq('the chosen skin is on the page', document.documentElement.getAttribute('data-skin'), 'blue');
      eq('an unknown skin is ignored', M.setSkin('plaid'), 'blue');
      M.setSkin('gold');
      ok('gold needs no attribute', !document.documentElement.hasAttribute('data-skin'));
      M.setSkin(skinBefore);
      eq('the reading hash routes', R ? R.parseHash('#reading') : '', 'note');
      eq('the probe hash routes', R ? R.parseHash('#probe') : '', 'probe');
    }

    /* ---- findings ---------------------------------------------------------- */
    var FD = MP.findings;
    if (!FD) {
      ok('findings module is loaded', false, 'MP.findings missing');
    } else {
      /* coin = index squared: log returns exactly double, correlation exactly 1 */
      var fIdx = [], fCoin = [], fPx = 100;
      for (var fd = 0; fd < 330; fd++) {
        fPx *= 1 + (((fd * 7919) % 13) - 6) / 400;
        var fDay = new Date(Date.UTC(2025, 9, 1 + fd)).toISOString().slice(0, 10);
        fIdx.push({ date: fDay, price: fPx });
        fCoin.push({ date: fDay, price: fPx * fPx / 100 });
      }
      var fnd = FD.compute({ btc: fCoin, ixic: fIdx }, Date.UTC(2026, 8, 11));
      ok('findings computed for a year of closes', !!fnd);
      eq('findings count the common sessions', fnd.sessions, 330);
      close('findings 90-session correlation is 1', fnd.pairs.ixic.coupling[1].correlation, 1, 1e-3);
      close('findings 90-session beta is 2', fnd.pairs.ixic.coupling[1].beta, 2, 1e-3);
      eq('rolling series has one point per window end', fnd.pairs.ixic.rolling90.length, 330 - 1 - 90 + 1);
      eq('a perfectly coupled pair is coupled throughout', fnd.pairs.ixic.regimes.coupledShare, 1);
      eq('a perfectly coupled pair is never decoupled', fnd.pairs.ixic.regimes.decoupledShare, 0);
      eq('regime now reads coupled', fnd.pairs.ixic.regimes.current, 'coupled');
      eq('longest coupled run spans the whole series', fnd.pairs.ixic.regimes.longestCoupled.sessions, fnd.pairs.ixic.rolling90.length);
      eq('no breaks when the correlation never falls', fnd.pairs.ixic.breaks.length, 0);
      eq('same-sign share is 1 for a squared series', fnd.pairs.ixic.agreement.all, 1);
      close('volatility ratio is 2', fnd.pairs.ixic.vol.ratio, 2, 1e-2);
      ok('the S&P pair is null when absent', fnd.pairs.spx === null);
      ok('drawdown block present for bitcoin', fnd.drawdowns.btc && fnd.drawdowns.btc.max <= 0);
      ok('too little history yields null', FD.compute({ btc: fCoin.slice(0, 40), ixic: fIdx }, 0) === null);
      ok('missing history yields null', FD.compute(null, 0) === null);
      eq('label reads coupled', FD.label(fnd), 'coupled');

      /* a regime flip: coupled for 160 sessions, then the coin mirrors the index */
      var gIdx = [], gCoin = [], gPx = 100, gCoinPx = 100;
      for (var gd = 0; gd < 260; gd++) {
        var r = (((gd * 7919) % 13) - 6) / 400;
        gPx *= 1 + r;
        gCoinPx *= gd < 160 ? Math.pow(1 + r, 2) : Math.pow(1 + r, -2);
        var gDay = new Date(Date.UTC(2025, 9, 1 + gd)).toISOString().slice(0, 10);
        gIdx.push({ date: gDay, price: gPx });
        gCoin.push({ date: gDay, price: gCoinPx });
      }
      var flip = FD.compute({ btc: gCoin, ixic: gIdx }, 0);
      ok('a flipped pair spends time decoupled', flip.pairs.ixic.regimes.decoupledShare > 0);
      eq('the decoupled run ends at the last date', flip.pairs.ixic.regimes.longestDecoupled.to, gIdx[gIdx.length - 1].date);
      /* a 90-session window turns over 20 sessions at most 20/90 of the way, so
       * the largest 20-session fall from +1 to -1 is about 0.44 */
      ok('the flip is recorded as the largest break', flip.pairs.ixic.breaks.length > 0 && flip.pairs.ixic.breaks[0].drop > 0.3);
      ok('the largest break happens while the flip is in the window', flip.pairs.ixic.breaks[0].to > gIdx[160].date);
      eq('regime now reads decoupled', flip.pairs.ixic.regimes.current, 'decoupled');

      var words = FD.narrative(fnd);
      ok('narrative has several sentences', words.length >= 4);
      ok('every narrative sentence ends with a period', words.every(function (s) { return /\.$/.test(s); }));
      ok('every narrative sentence carries a number', words.every(function (s) { return /\d/.test(s); }));
      eq('narrative of nothing is empty', FD.narrative(null).length, 0);
    }

    /* ---- the daily reading ------------------------------------------------- */
    var NT = MP.note;
    if (!NT) {
      ok('note module is loaded', false, 'MP.note missing');
    } else {
      var good = 'On 11 Sep 26 the Nasdaq Composite closed at 26,081.72, down 0.65% on the day. ' +
        'Bitcoin was at $76,908.00, down 1.44% over 24 hours. This is a description of the figures, not advice.';
      ok('a plain three-sentence reading passes', NT.validate(good).ok, NT.validate(good).reason);
      ok('a tip is rejected by word', /banned word/.test(NT.validate('You should buy bitcoin at 76,908. This is not advice.').reason || ''));
      eq('the checker names the word it caught', NT.validate('Holders should note 76,908. This is not advice.').reason, 'banned word "should"');
      ok('a forecast is rejected', !NT.validate('Bitcoin will reach 80,000 soon. The index fell 1%. This is not advice.').ok);
      ok('one sentence is not a reading', !NT.validate('Bitcoin rose 2% today, not advice.').ok);
      ok('a reading without a figure is rejected', /figure/.test(NT.validate('Bitcoin rose today. The Nasdaq fell. This is not advice.').reason || ''));
      ok('a reading without the not-advice line is rejected', !NT.validate('Bitcoin rose 2%. The Nasdaq fell 1%. Both moved.').ok);
      var longText = new Array(46).join('word ') + '1. ' + new Array(46).join('word ') + 'end. This is not advice.';
      ok('more than 90 words is rejected', /words/.test(NT.validate(longText).reason || ''));
      ok('markup is rejected', !NT.validate('**Bitcoin** rose 2%. The index fell. This is not advice.').ok);
      eq('an em dash is rejected', NT.validate('Bitcoin rose 2% ' + String.fromCharCode(0x2014) + ' the index fell 1%. This is not advice.').reason, 'an em dash');
      ok('a year in the text is not mistaken for a dash', NT.validate('Bitcoin rose 2% since 2014. The index fell 1%. This is not advice.').ok);
      ok('house-style filler is rejected', /banned word "pivotal"/.test(NT.validate('The index fell 1% on a pivotal day. This is not advice.').reason || ''));
      ok('"serves as" is rejected', /serves as/.test(NT.validate('The 0.52 correlation serves as a guide. This is not advice.').reason || ''));
      ok('the prompt asks for the house style', NT.SYSTEM.indexOf('em dashes') >= 0 && NT.SYSTEM.indexOf('declarative') >= 0);

      var parsedReply = NT.parse({ model: 'claude-opus-5', stop_reason: 'end_turn',
        content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '  Bitcoin rose   2%.\nNot advice.  ' }] });
      eq('parse joins and tidies the text', parsedReply.text, 'Bitcoin rose 2%. Not advice.');
      eq('parse keeps the model', parsedReply.model, 'claude-opus-5');
      ok('a refusal parses to nothing', NT.parse({ stop_reason: 'refusal', content: [] }) === null);
      ok('junk parses to nothing', NT.parse('junk') === null);

      var inp = NT.inputs({
        session: '2026-09-11',
        quotes: { ixic: { price: 26081.7245, changePct: -0.65369 }, spx: { price: 6512.34, changePct: -0.41 } },
        coins: { bitcoin: { price: 76908, changePct: -1.43882 } },
        findings: typeof fnd !== 'undefined' ? fnd : null,
        movers: {
          stocks: { mover: { symbol: 'NVDA', change: 12.3 }, loser: { symbol: 'ADBE', change: -9.34 }, scanned: 99 },
          crypto: { mover: { symbol: 'SOL', change: 18.4 }, loser: { symbol: 'DOGE', change: -15.2 } }
        }
      });
      var ask = NT.buildRequest(inp);
      ok('the request cites the index as given', ask.user.indexOf('26,081.72') >= 0);
      ok('the request labels horizons', ask.user.indexOf('over 24 hours') >= 0 && ask.user.indexOf('on the day') >= 0);
      ok('the request names the highest and lowest movers', ['NVDA', 'ADBE', 'SOL', 'DOGE'].every(function (s) { return ask.user.indexOf(s) >= 0; }));
      ok('the request says how many members were ranked', ask.user.indexOf('among 99 Nasdaq-100 members') >= 0);
      ok('the request says highest and lowest', ask.user.indexOf('Highest five-session move') >= 0 && ask.user.indexOf('; lowest: ADBE, -9.3%') >= 0);
      ok('the inputs read the movers from a spotlight file too', NT.inputs({ spotlight: { movers: { stocks: { mover: { symbol: 'NVDA', change: 1 } } } } }).stocks.mover.symbol === 'NVDA');
      ok('the system prompt forbids advice', ask.system.indexOf('not advice') >= 0);
      ok('missing figures are left out, not invented', ask.user.indexOf('Ether') < 0);

      ok('a first note is due', NT.due(null, 0, '2026-09-11', ''));
      ok('the same session is not due twice', !NT.due({ forSession: '2026-09-11' }, 0, '2026-09-11', ''));
      ok('force brings it back', NT.due({ forSession: '2026-09-11' }, 0, '2026-09-11', 'note'));
      var rejected = { forSession: '2026-09-11', invalidReason: 'x', attempts: 1, generatedAt: '2026-09-11T21:00:00Z' };
      ok('a rejected reply waits before a retry', !NT.due(rejected, Date.parse('2026-09-11T22:00:00Z'), '2026-09-11', ''));
      ok('a rejected reply is retried after two hours', NT.due(rejected, Date.parse('2026-09-11T23:01:00Z'), '2026-09-11', ''));
      ok('and only once', !NT.due(Object.assign({}, rejected, { attempts: 2 }), Date.parse('2026-09-12T09:00:00Z'), '2026-09-11', ''));

      if (typeof fnd !== 'undefined' && fnd) ok('the fallback from findings passes its own checker', NT.validate(NT.fallback(fnd, inp)).ok, NT.fallback(fnd, inp));
      ok('the fallback from figures alone passes', NT.validate(NT.fallback(null, inp)).ok, NT.fallback(null, inp));
      ok('the fallback with nothing at all passes', NT.validate(NT.fallback(null, { session: '2026-09-14' })).ok, NT.fallback(null, { session: '2026-09-14' }));
    }

    /* ---- statistics for any pair ------------------------------------------ */
    var APP = MP.app;
    if (APP && APP.analyticsFor) {
      /* coin = index squared: log returns exactly double, so beta is 2 and
       * correlation is 1 on every window */
      var idx = [], coin = [], px = 100;
      for (var d = 0; d < 60; d++) {
        px *= 1 + (((d * 7919) % 13) - 6) / 400;
        var day = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
        idx.push({ date: day, price: px });
        coin.push({ date: day, price: px * px / 100 });
      }
      var an = APP.analyticsFor(coin, idx, null, { coin: 'SOL', index: '^GSPC', indexShort: 'SPX' });
      ok('analytics computed for a custom pair', !!an);
      close('beta of the squared series is 2', an.coupling[0].beta, 2, 1e-9);
      close('correlation of the squared series is 1', an.coupling[0].correlation, 1, 1e-9);
      eq('labels travel with the result', an.labels.coin + '/' + an.labels.indexShort, 'SOL/SPX');
      ok('too little overlap yields null', APP.analyticsFor(coin.slice(0, 10), idx, null, {}) === null);
    }

    /* ---- REL and MIN/MAX -------------------------------------------------- */
    var FN = MP.funcs;
    if (!FN) {
      ok('funcs module is loaded', false, 'MP.funcs missing');
    } else {
      FN.reset();
      ok('REL is off by default', FN.rel.get('btc') === null);
      eq('REL press switches on with a value', FN.rel.toggle('btc', 100), true);
      eq('REL holds the reference', FN.rel.get('btc'), 100);
      eq('REL press again switches off', FN.rel.toggle('btc', 120), false);
      eq('REL cannot hold a non-number', FN.rel.toggle('btc', NaN), false);
      FN.rel.set('btc', 100);
      var priced = FN.decorate({ value: 110, dp: 2, unit: 'USD', change: { pct: 1, abs: 1 } }, 'btc');
      close('REL price shows percent since reference', priced.change.pct, 10, 1e-12);
      close('REL price shows absolute move', priced.change.abs, 10, 1e-12);
      eq('REL labels the change', priced.change.label, 'REL');
      ok('REL flags the reading', priced.rel === true);
      FN.rel.set('corr', 0.4);
      var ratio = FN.decorate({ value: 0.55, dp: 2, unit: '', change: {} }, 'corr');
      ok('REL statistic has no percent', isNaN(ratio.change.pct));
      close('REL statistic shows a plain delta', ratio.change.delta, 0.15, 1e-12);
      var untouched = FN.decorate({ value: 5, dp: 2, unit: 'USD', change: { pct: 2 } }, 'eth');
      eq('no reference leaves the change alone', untouched.change.pct, 2);
      FN.minmax.track('vol', 50);
      ok('MIN/MAX ignores values while off', FN.minmax.get('vol') === null);
      FN.minmax.show('vol', true);
      FN.minmax.track('vol', 50); FN.minmax.track('vol', NaN); FN.minmax.track('vol', 42); FN.minmax.track('vol', 61);
      eq('MIN/MAX minimum', FN.minmax.get('vol').min, 42);
      eq('MIN/MAX maximum', FN.minmax.get('vol').max, 61);
      eq('MIN/MAX ignores NaN in its count', FN.minmax.get('vol').n, 3);
      ok('decorate attaches the capture when shown', FN.decorate({ value: 50, unit: '%', change: {} }, 'vol').minmax.max === 61);
      FN.minmax.reset('vol');
      ok('MIN/MAX reset clears the capture', FN.minmax.get('vol') === null);
      FN.reset();
    }

    /* ---- alerts ----------------------------------------------------------- */
    var AL = MP.alerts;
    if (!AL) {
      ok('alerts module is loaded', false, 'MP.alerts missing');
    } else {
      eq('a level above the reading fires on the way up', AL.infer(110, 100), 'above');
      eq('a level below the reading fires on the way down', AL.infer(90, 100), 'below');
      var list = [
        { id: 'x1', stop: 'btc', level: 110, dir: 'above', unit: 'USD', created: 1, fired: null },
        { id: 'x2', stop: 'btc', level: 90, dir: 'below', unit: 'USD', created: 1, fired: null },
        { id: 'x3', stop: 'eth', level: 5, dir: 'above', unit: 'USD', created: 1, fired: null },
        { id: 'x4', stop: 'btc', level: 100, dir: 'above', unit: 'USD', created: 1, fired: 7 }
      ];
      var quiet = AL.evaluate(list, 'btc', 100, 9);
      eq('nothing fires between the levels', quiet.fired.length, 0);
      var up = AL.evaluate(list, 'btc', 110, 9);
      eq('reaching the level fires above', up.fired.length, 1);
      eq('the right alert fired', up.fired[0].id, 'x1');
      eq('fired alerts carry the time', up.fired[0].fired, 9);
      ok('the input list is not mutated', list[0].fired === null);
      var down = AL.evaluate(list, 'btc', 80, 9);
      eq('falling through the level fires below', down.fired[0].id, 'x2');
      eq('other stops are untouched', AL.evaluate(list, 'btc', 999, 9).fired.filter(function (a) { return a.stop === 'eth'; }).length, 0);
      eq('already fired alerts stay fired once', AL.evaluate(list, 'btc', 999, 9).fired.filter(function (a) { return a.id === 'x4'; }).length, 0);
      eq('a missing value fires nothing', AL.evaluate(list, 'btc', NaN, 9).fired.length, 0);
      var desc = AL.describe(list[0], function (stop, v) { return '$' + v; });
      eq('description reads as a sentence', desc, 'Bitcoin above $110');
    }

    if (R && R.overridePanel) {
      eq('panel override accepts a known panel', R.overridePanel('alerts'), 'alerts');
      eq('panel override rejects an unknown panel', R.overridePanel('nope'), null);
      R.overridePanel(null);   /* back to the stop's own panel */
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
