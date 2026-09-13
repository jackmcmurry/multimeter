/* ============================================================================
 * api/history.js: one stock's daily closes, fetched on demand.
 *
 * The published snapshots cover the Nasdaq-100 only, because pre-fetching
 * every listed symbol would be thousands of calls a run. Anything outside
 * that list comes through here instead: the browser asks for a symbol, this
 * function asks Financial Modeling Prep with the key held in the environment,
 * and returns the same shape data/stocks/SYM.json has, so the page parses it
 * with the normaliser it already had.
 *
 * The key never reaches the browser. Responses are cached at the edge, so a
 * symbol several people look at costs one upstream call an hour.
 * ========================================================================== */

const FMP = 'https://financialmodelingprep.com/stable';
const SYMBOL_RE = /^[A-Za-z0-9]{1,6}(?:[.\-][A-Za-z0-9]{1,4})?$/;
const MAX_SESSIONS = 300;      /* the 1Y range tab, plus slack */
const LOOKBACK_DAYS = 500;

function send(res, status, body, cacheSeconds) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cacheSeconds
    ? 's-maxage=' + cacheSeconds + ', stale-while-revalidate=86400'
    : 'no-store');
  res.status(status).end(JSON.stringify(body));
}

function isoDay(d) { return d.toISOString().slice(0, 10); }

module.exports = async (req, res) => {
  const raw = (req.query && req.query.symbol) || '';
  const symbol = String(raw).toUpperCase();
  if (!SYMBOL_RE.test(symbol)) {
    return send(res, 400, { error: 'bad_symbol', message: 'Ask for one ticker, such as NVDA.' });
  }

  const key = process.env.FMP_API_KEY;
  if (!key) {
    return send(res, 503, { error: 'not_configured', message: 'Price history is not configured on this deployment.' });
  }

  const to = new Date();
  const from = new Date(to.getTime() - LOOKBACK_DAYS * 86400000);
  const url = FMP + '/historical-price-eod/light?symbol=' + encodeURIComponent(symbol) +
    '&from=' + isoDay(from) + '&to=' + isoDay(to) + '&apikey=' + encodeURIComponent(key);

  let upstream;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    upstream = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
  } catch (e) {
    return send(res, 504, { error: 'upstream_unreachable', message: 'The price source did not answer.' });
  }

  /* A plan that does not cover this symbol answers 402 or 403. That is not a
   * fault the reader can fix, so it is named rather than dressed up as an
   * empty chart. */
  if (upstream.status === 402 || upstream.status === 403) {
    return send(res, 200, { error: 'not_covered', symbol: symbol, closes: [],
      message: 'This plan does not cover ' + symbol + '.' }, 3600);
  }
  if (!upstream.ok) {
    return send(res, 502, { error: 'upstream_error', status: upstream.status, message: 'The price source refused that request.' });
  }

  let rows;
  try {
    rows = await upstream.json();
  } catch (e) {
    return send(res, 502, { error: 'bad_upstream_json', message: 'The price source sent something unreadable.' });
  }
  if (!Array.isArray(rows) || !rows.length) {
    return send(res, 200, { error: 'no_history', symbol: symbol, closes: [],
      message: 'No daily closes were returned for ' + symbol + '.' }, 900);
  }

  const closes = rows
    .map((r) => [r && r.date ? String(r.date).slice(0, 10) : null, Number(r && r.price)])
    .filter((c) => c[0] && isFinite(c[1]))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(-MAX_SESSIONS);

  if (!closes.length) {
    return send(res, 200, { error: 'no_history', symbol: symbol, closes: [], message: 'No usable closes for ' + symbol + '.' }, 900);
  }

  return send(res, 200, { symbol: symbol, name: symbol, closes: closes }, 3600);
};
