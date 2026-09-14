/* Practice portfolio math. Pure: USD closing prices, fixed fractional shares,
 * no rebalancing, cash flows, fees, taxes or dividend reinvestment. */
(function (root) {
  'use strict';
  var MP = root.MP = root.MP || {};
  var RANGES = { '1m': 30, '3m': 90, '1y': 365 };
  function validate(holdings) {
    if (!Array.isArray(holdings) || holdings.length < 1 || holdings.length > 5) throw new Error('Choose between 1 and 5 stocks.');
    var seen = {}, total = 0;
    holdings.forEach(function (h) {
      if (!h || typeof h.symbol !== 'string' || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(h.symbol)) throw new Error('Choose a supported US stock.');
      if (seen[h.symbol]) throw new Error('Each stock can appear only once.');
      seen[h.symbol] = true;
      if (typeof h.weight !== 'number' || !isFinite(h.weight) || h.weight <= 0 || h.weight > 100) throw new Error('Give every stock a weight above 0% and at most 100%.');
      total += h.weight;
    });
    if (Math.abs(total - 100) > 0.000001) throw new Error('Weights must total 100%. Your total is ' + Number(total.toFixed(2)) + '%.');
    return true;
  }
  function calculate(holdings, histories, range) {
    validate(holdings);
    if (!RANGES[range]) throw new Error('Choose a 1-month, 3-month or 1-year range.');
    var maps = [], freshness = [];
    holdings.forEach(function (h) {
      var series = histories[h.symbol];
      if (!Array.isArray(series) || !series.length) throw new Error('Price history is unavailable for ' + h.symbol + '. No holdings have been omitted.');
      var map = Object.create(null);
      series.forEach(function (p) {
        if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(p.date) || !isFinite(Date.parse(p.date)) || typeof p.price !== 'number' || !isFinite(p.price) || p.price <= 0 || map[p.date] !== undefined) {
          throw new Error('Invalid or duplicate closing prices for ' + h.symbol + '.');
        }
        map[p.date] = p.price;
      });
      var dates = Object.keys(map).sort();
      maps.push(map); freshness.push({ symbol: h.symbol, latest: dates[dates.length - 1] });
    });
    var common = Object.keys(maps[0]).sort().filter(function (d) { return maps.every(function (m) { return m[d] !== undefined; }); });
    if (common.length < 3) throw new Error('At least 3 common closing dates are needed to measure this portfolio.');
    var end = common[common.length - 1];
    var cutoff = new Date(Date.parse(end + 'T00:00:00Z') - RANGES[range] * 86400000).toISOString().slice(0, 10);
    var dates = common.filter(function (d) { return d >= cutoff; });
    if (dates.length < 3) throw new Error('Not enough shared history for this range. Try a longer range.');
    var start = dates[0];
    var allocation = holdings.map(function (h, i) { return {symbol:h.symbol, weight:h.weight, shares:10000 * h.weight / 100 / maps[i][start]}; });
    var series = dates.map(function (d) {
      return {date:d, price:allocation.reduce(function (sum, h, i) {return sum + h.shares * maps[i][d];}, 0)};
    });
    var peak = series[0].price, maxDrawdown = 0;
    series.forEach(function (p) { peak = Math.max(peak, p.price); maxDrawdown = Math.min(maxDrawdown, p.price / peak - 1); });
    var values = series.map(function (p) {return p.price;});
    var skipped = Object.keys(maps[0]).filter(function (d) {return d >= start && d <= end && dates.indexOf(d) < 0;}).length;
    // Missing sessions distort daily annualization; never call multi-day returns daily.
    var mismatch = maps.some(function (m) { return Object.keys(m).some(function (d) {return d >= start && d <= end && dates.indexOf(d) < 0;}); });
    return {series:series, allocation:allocation, start:start, end:end, freshness:freshness, sessions:dates.length,
      shortened:Date.parse(start) - Date.parse(cutoff) > 7 * 86400000,
      skipped:skipped, incompleteCalendar:mismatch,
      endingValue:values[values.length - 1], returnPct:(values[values.length - 1] / 10000 - 1) * 100,
      volatilityPct:mismatch ? null : MP.stats.annualizedVol(MP.stats.logReturns(values), 252) * 100,
      maxDrawdownPct:maxDrawdown * 100};
  }
  MP.portfolio = {validate:validate, calculate:calculate, RANGES:RANGES};
})(typeof globalThis !== 'undefined' ? globalThis : this);
