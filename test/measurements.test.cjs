const test = require('node:test');
const assert = require('node:assert/strict');
global.document = { readyState: 'loading', addEventListener() {} };
require('../src/lib/stats');
require('../src/lib/format');
require('../src/lib/geom');
require('../src/lib/sources');
require('../src/lib/measurements');
require('../src/lib/app');
const { stats: S, measurements: M, geom: G, app } = global.MP;
const names = { coinName: 'Bitcoin', indexName: 'Nasdaq Composite' };
function fixture(n = 120, flat = false) {
  const dates = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10));
  const a = dates.map((date, i) => ({ date, price: flat ? 100 : 100 * Math.exp(Math.sin(i) * .06 + i * .001) }));
  const b = dates.map((date, i) => ({ date, price: flat ? 100 : 100 * Math.exp(-Math.sin(i) * .02 + i * .0005) }));
  return app.analyticsFor(a, b, null, names);
}
test('takeaways distinguish negative, positive, weak and unavailable relationships', () => {
  assert.match(M.correlationText(-.85), /strong.*opposite/);
  assert.match(M.correlationText(.6), /moderate.*together/);
  assert.match(M.correlationText(-.1), /little linear/);
  assert.match(M.correlationText(NaN), /not enough/);
});
test('volatility compares values without implying gain or loss', () => {
  assert.match(M.volatilityText(.2, .5, names), /^Nasdaq Composite had more/);
  assert.match(M.volatilityText(.5, .2, names), /^Bitcoin had more/);
  assert.match(M.volatilityText(.2, .2, names), /same size/);
  assert.match(M.volatilityText(NaN, .2, names), /not enough/);
});
test('drawdown distinguishes a high, a decline and missing data', () => {
  assert.match(M.drawdownText({ now: 0, max: -.2 }), /at its previous high.*20.0%/);
  assert.match(M.drawdownText({ now: -.2, max: -.4 }), /20.0% below.*40.0%/);
  assert.match(M.drawdownText({ now: NaN, max: 0 }), /not enough/);
});
test('rendered periods match 90-day summary and actual rolling 30-day inputs', () => {
  const a = fixture();
  assert.equal(a.scatter.fit.n, 90);
  assert.equal(a.rollCorr[0].index, 29);
  const html = M.correlation(a, names, 320);
  assert.match(html, /90 trading days/);
  assert.match(html, /previous 30 shared trading days/);
  assert.match(html, /opposite directions/);
  assert.match(html, /Calculation details/);
  assert.match(M.correlation(fixture(40), names, 320), /39 trading days available \(90 requested\)/);
});
test('all panels tolerate flat histories and escape asset names', () => {
  const a = fixture(40, true), strange = { coinName: '<img src=x onerror=alert(1)>', indexName: 'A & B' };
  for (const kind of ['correlation', 'volatility', 'drawdown']) {
    const html = M[kind](a, strange, 288);
    assert.doesNotMatch(html, /NaN|Infinity|<img/);
    assert.match(html, /&lt;img/);
    assert.match(html, /aria-label=/);
  }
  assert.match(M.empty(true), /Loading/);
  assert.match(M.empty(false), /Not enough/);
});
test('drawdown charts share a domain; volatility has distinguishable lines on one domain', () => {
  const a = fixture(), seen = [], underwater = G.underwaterChart, step = G.stepChart;
  try {
    G.underwaterChart = opts => { seen.push(opts.yDomain); return underwater(opts); };
    M.drawdown(a, names, 360);
    assert.deepEqual(seen[0], seen[1]);
    assert.ok(seen[0][0] <= Math.min(a.coinDd.max, a.indexDd.max));
    G.stepChart = opts => {
      assert.equal(opts.series.length, 2);
      assert.equal(opts.yDomain[0], 0);
      assert.equal(opts.series[1].dash, '7 4');
      return step(opts);
    };
    assert.match(M.volatility(a, names, 360), /not a predicted yearly gain or loss/);
  } finally { G.underwaterChart = underwater; G.stepChart = step; }
});
test('readable geometry labels tiny moves, drops invalid pairs and handles no data', () => {
  const html = G.scatterFit({ xs: [-.001, 0, .001, NaN], ys: [.002, 0, -.002, 1], readable: true });
  assert.match(html, /0.1%/);
  assert.doesNotMatch(html, /NaN|Infinity/);
  assert.match(G.scatterFit({ xs: [NaN, 0, 1], ys: [1, NaN, 2], readable: true }), /awaiting returns/);
  assert.match(G.stepChart({ series: [], readable: true }), /awaiting series/);
  assert.match(G.underwaterChart({ values: [], readable: true }), /awaiting series/);
});
test('legacy geometry callers retain their size and visual defaults', () => {
  assert.match(G.stepChart({ series: [{ values: [0, 1, .5] }] }), /stroke-width="1.6"/);
  assert.match(G.scatterFit({ xs: [-1, 0, 1], ys: [-1, 0, 1] }), /fill-opacity="0.72"/);
  assert.doesNotMatch(G.underwaterChart({ values: [0, -.1, -.05] }), /chart-readable/);
});
