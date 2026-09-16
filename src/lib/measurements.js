/* Student-facing measurement panels. Calculations remain in stats/app; this
 * module only describes and draws the supplied measurements. */
(function (root) {
  'use strict';
  var MP = root.MP = root.MP || {};
  var S = MP.stats, F = MP.fmt, G = MP.geom;
  var esc = F.escapeHtml;
  function paragraph(text, cls) { return '<p class="' + (cls || 'measurement-guide') + '">' + esc(text) + '</p>'; }
  function pct(v) { return S.isNum(v) ? F.pct(v, 1) : 'Unavailable'; }
  function number(v) { return S.isNum(v) ? F.ratio(v, 2) : 'Unavailable'; }
  function period(dates) {
    return dates && dates.length ? F.shortDate(dates[0]) + ' – ' + F.shortDate(dates[dates.length - 1]) : 'Dates unavailable';
  }
  function card(title, guide, body, takeaway) {
    return '<article class="measurement-card"><h3>' + esc(title) + '</h3>' + paragraph(guide) + body +
      (takeaway ? paragraph(takeaway, 'measurement-takeaway') : '') + '</article>';
  }
  function options(width, description) {
    return { w: Math.max(220, Math.round(width || 560)), h: 260, readable: true,
      pad: { l: 48, r: 16, t: 22, b: 36 }, description: description };
  }
  function chart(svg) { return '<div class="chartbox">' + svg + '</div>'; }
  function details(body) { return '<details class="measurement-details"><summary>Calculation details</summary>' + body + '</details>'; }
  function correlationText(v) {
    if (!S.isNum(v)) return 'There is not enough variation to measure this relationship.';
    var size = Math.abs(v);
    if (size < 0.2) return 'Their daily changes show little linear relationship in this period.';
    var strength = size < 0.5 ? 'a loose' : size < 0.8 ? 'a moderate' : 'a strong';
    return 'Their daily changes show ' + strength + ' pattern of moving ' + (v < 0 ? 'in opposite directions' : 'together') + '.';
  }
  function volatilityText(mine, theirs, names) {
    if (!S.isNum(mine) || !S.isNum(theirs)) return 'There is not enough history to compare their swings.';
    if (Math.abs(mine - theirs) < 0.0005) return 'Their measured swings are about the same size.';
    return (mine > theirs ? names.coinName : names.indexName) + ' had more variable daily changes over the latest 30 trading days.';
  }
  function drawdownText(dd) {
    if (!dd || !S.isNum(dd.now) || !S.isNum(dd.max)) return 'There is not enough history to measure the decline.';
    return (dd.now === 0 ? 'Currently at its previous high.' : 'Currently ' + pct(Math.abs(dd.now)) + ' below its previous high.') +
      ' Deepest decline in this history: ' + pct(Math.abs(dd.max)) + '.';
  }
  function rolling(entries, dates, count) {
    var tail = S.tail(entries || [], count);
    return { values: tail.map(function (e) { return e.value; }), dates: tail.map(function (e) { return dates[e.index] || ''; }) };
  }
  function table(rows, title) {
    return paragraph(title) + '<div class="table-scroll" tabindex="0" role="region" aria-label="' + esc(title) + '"><table class="data"><thead><tr>' +
      '<th scope="col">Trading days requested</th><th scope="col">Correlation</th><th scope="col">Beta</th><th scope="col">R²</th><th scope="col">Days available</th>' +
      '</tr></thead><tbody>' + (rows || []).map(function (r) {
        return '<tr><th scope="row">' + r.window + '</th><td>' + number(r.correlation) + '</td><td>' + number(r.beta) + '</td><td>' + number(r.r2) + '</td><td>' + r.n + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function correlation(a, names, width) {
    var c = a.coupling.filter(function (r) { return r.window === 90; })[0] || a.coupling[0];
    var summary = paragraph(names.coinName + ' and ' + names.indexName, 'measurement-pair') +
      paragraph('Relationship score: ' + number(c.correlation) + ' · ' + c.n + ' trading days' + (c.n < 90 ? ' available (90 requested)' : ''), 'measurement-score') +
      paragraph(correlationText(c.correlation), 'measurement-takeaway');
    var scatterDates = S.tail(a.dates, a.scatter.fit.n);
    var hasFit = S.isNum(a.scatter.fit.slope) && S.isNum(a.scatter.fit.intercept);
    var lineGuide = hasFit ? 'The gold line shows the overall pattern, not a prediction.' : 'There is not enough variation to draw an overall pattern line.';
    var description = 'Each square is one shared trading day. Across: ' + names.indexName + '. Up: ' + names.coinName + '. Approximate daily changes in percent. ' + lineGuide;
    var scatter = G.scatterFit(Object.assign(options(width, description), {
      h: width < 480 ? 290 : 340, xs: a.scatter.xs, ys: a.scatter.ys, fit: a.scatter.fit,
      pointColor: 'var(--gold)', fitColor: 'var(--gold)'
    }));
    var body = paragraph('Up / down: ' + names.coinName + ' · Approximate daily change (%)', 'measurement-axis') +
      '<div class="measurement-quadrants"><span>' + esc(names.indexName + ' fell · ' + names.coinName + ' rose') + '</span><span>Both rose</span></div>' +
      chart(scatter) +
      '<div class="measurement-quadrants"><span>Both fell</span><span>' + esc(names.indexName + ' rose · ' + names.coinName + ' fell') + '</span></div>' +
      paragraph('Left / right: ' + names.indexName + ' · Approximate daily change (%)', 'measurement-axis') +
      '<div class="measurement-legend"><span>■ One trading day</span><span>' + (hasFit ? '━ Overall pattern (not a prediction)' : esc(lineGuide)) + '</span></div>' +
      paragraph(period(scatterDates), 'measurement-period');
    var scatterCard = card('Do these assets move together?', 'Each square is one day both markets traded. Right means the index rose; up means the other asset rose. Zero means no change.', body,
      'Squares in “Both rose” or “Both fell” show days they moved in the same direction. Read the percentages on each axis: the two scales differ.');
    var roll = rolling(a.rollCorr, a.dates, 180), latest = roll.values[roll.values.length - 1];
    var history = card('Has their relationship changed?', 'Each point measures the previous 30 shared trading days. The score above uses up to 90 trading days, so it can differ.',
      '<div class="measurement-scale"><span><b>+1</b> Move together</span><span><b>0</b> Little linear relationship</span><span><b>−1</b> Move oppositely</span></div>' +
      chart(G.stepChart(Object.assign(options(width, 'Relationship over time, on a scale from minus one (opposite) to plus one (together). ' + correlationText(latest)), {
        series: [{ values: roll.values, color: 'var(--c-idx)' }], yDomain: [-1, 1], yTicks: [-1, 0, 1], zeroLine: true,
        yFmt: function (v) { return v > 0 ? '+1' : String(v).replace('-', '−'); }, xLabels: roll.dates.map(F.shortDate)
      }))) + paragraph(period(roll.dates), 'measurement-period'),
      'Latest 30-day score: ' + number(latest) + '. ' + correlationText(latest));
    return summary + scatterCard + history + paragraph('Moving together does not prove that one asset causes the other to move.') + details(
      paragraph('Correlation measures a linear relationship from −1 to +1; it is not the percentage of days that matched. The descriptions use the size of the score: below 0.2 is little relationship, below 0.5 loose, below 0.8 moderate, and 0.8 or above strong. These are reading guides, not universal cutoffs.') +
      paragraph('Daily changes use log returns: ln(new close ÷ previous close). Multiplying these by 100 gives an approximation to ordinary percent changes, with larger differences on unusually large moves. Only dates shared by both assets are used; a weekend or holiday gap is included in the next shared return.') +
      paragraph('The gold line is a least-squares fit through those log returns. Beta is its numerical slope: ' + number(a.scatter.fit.slope) + '. The axes use different scales, so the line’s angle alone does not measure beta. R² is the share of variation captured by this straight-line fit; it does not establish cause.') +
      table(a.coupling, names.coinName + ' compared with ' + names.indexName) +
      (a.qqqCoupling ? table(a.qqqCoupling, names.coinName + ' compared with Invesco QQQ Trust') : ''));
  }
  function volatility(a, names, width) {
    var mine = rolling(a.coinVol, a.dates, 120), theirs = rolling(a.indexVol, a.dates, 120);
    var description = names.coinName + ' is the solid gold line; ' + names.indexName + ' is the dashed blue line. Higher values mean more variable daily changes.';
    return card('Which asset has had bigger swings?', 'Higher means daily changes have varied more. Each point uses the previous 30 shared trading days, expressed on a yearly scale (annualized). This is not a predicted yearly gain or loss.',
      '<div class="measurement-legend"><span><i class="measurement-swatch"></i>' + esc(names.coinName) + ' · solid · ' + pct(a.currentCoinVol) +
      '</span><span><i class="measurement-swatch dashed"></i>' + esc(names.indexName) + ' · dashed · ' + pct(a.currentIndexVol) + '</span></div>' +
      paragraph('Yearly scale (%) · Latest values shown in the legend', 'measurement-axis') +
      chart(G.stepChart(Object.assign(options(width, description), {
        series: [{ values: mine.values, color: 'var(--gold)' }, { values: theirs.values, color: 'var(--c-idx)', dash: '7 4' }],
        yDomain: [0, Math.max(0.01, Math.max.apply(null, mine.values.concat(theirs.values).filter(S.isNum)) * 1.1)],
        yFmt: function (v) { return Number((v * 100).toPrecision(3)) + '%'; }, xLabels: mine.dates.map(F.shortDate)
      }))) + paragraph(period(mine.dates), 'measurement-period'), volatilityText(a.currentCoinVol, a.currentIndexVol, names)) +
      details(paragraph('Volatility is the sample standard deviation of 30 shared trading days of log returns, multiplied by √252 to express it on a yearly scale. Both lines use the same vertical scale. It measures variation, not the direction prices will move.'));
  }
  function drawdown(a, names, width) {
    var low = Math.min(a.coinDd.max || 0, a.indexDd.max || 0);
    var domain = [Math.min(low * 1.1, -0.02), 0];
    var html = [[names.coinName, a.coinDd, 'var(--gold)'], [names.indexName, a.indexDd, 'var(--c-idx)']].map(function (entry) {
      var dd = entry[1];
      return card('How far below its previous high? — ' + entry[0], '0% means at its previous high. −20% means 20% below that high. Lower points show a deeper decline.',
        paragraph('0% · At its previous high', 'measurement-axis') +
        chart(G.underwaterChart(Object.assign(options(width, entry[0] + ': percentage below the highest earlier price in this history. ' + drawdownText(dd)), {
          values: dd.series, color: entry[2], yDomain: domain, xLabels: dd.dates.map(F.shortDate)
        }))) + paragraph(period(dd.dates) + ' · Both charts use the same percentage scale.', 'measurement-period'), drawdownText(dd));
    }).join('');
    var episodes = (a.coinEpisodes || []).map(function (e) { return { name: names.coinName, e: e }; })
      .concat((a.indexEpisodes || []).map(function (e) { return { name: names.indexName, e: e }; })).sort(function (p, q) { return p.e.depth - q.e.depth; });
    return html + details(paragraph('A previous high is the highest closing price reached so far within the available history, not necessarily an all-time high. Each asset uses its own trading dates.') +
      (episodes.length ? '<div class="table-scroll" tabindex="0" role="region" aria-label="Decline periods"><table class="data"><thead><tr><th scope="col">Asset</th><th scope="col">Largest drop</th><th scope="col">Previous high date</th><th scope="col">Lowest point date</th><th scope="col">Back to previous high</th></tr></thead><tbody>' +
        episodes.map(function (row) { var e = row.e; return '<tr><th scope="row">' + esc(row.name) + '</th><td>' + pct(Math.abs(e.depth)) + '</td><td>' + F.shortDate(e.peakDate) + '</td><td>' + F.shortDate(e.troughDate) + '</td><td>' + (e.ongoing ? 'Not yet' : F.shortDate(e.recoveryDate)) + '</td></tr>'; }).join('') + '</tbody></table></div>' : paragraph('No decline periods in this history.')));
  }
  function empty(pending) {
    return paragraph(pending ? 'Loading price history…' : 'Not enough shared price history to draw these measurements. Choose another asset or comparison.', 'measurement-empty');
  }
  MP.measurements = { correlation: correlation, volatility: volatility, drawdown: drawdown, empty: empty,
    correlationText: correlationText, volatilityText: volatilityText, drawdownText: drawdownText };
})(typeof globalThis !== 'undefined' ? globalThis : this);
