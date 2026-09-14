/* ============================================================================
 * api/history.js: one stock's daily closes, fetched on demand.
 *
 * The published snapshots cover the Nasdaq-100 and a short list of majors,
 * because pre-fetching every listed symbol would be thousands of calls a run.
 * Anything outside that list comes through here instead: the browser asks for
 * a symbol, this function asks upstream, and returns the same shape
 * data/stocks/SYM.json has, so the page parses it with the normaliser it
 * already had.
 *
 * Two sources, in order:
 *   1. Financial Modeling Prep, when FMP_API_KEY is set. A plan that does not
 *      cover a symbol answers 402, which is no longer fatal.
 *   2. Yahoo's chart endpoint, which needs no key at all.
 * So the endpoint works on a deployment with no secrets configured, and gets
 * better when a good key is present. Both normalisers live in
 * src/lib/sources.js, so this function and the scheduled job read every
 * payload the same way.
 *
 * The key never reaches the browser. Responses are cached at the edge, so a
 * symbol several people look at costs one upstream call an hour.
 * ========================================================================== */

require('../src/lib/sources.js');
const SRC = globalThis.MP.sources;

const FMP = 'https://financialmodelingprep.com/stable';
const SYMBOL_RE = /^[A-Za-z0-9]{1,6}(?:[.\-][A-Za-z0-9]{1,4})?$/;
const MAX_SESSIONS = 300;      /* the 1Y range tab, plus slack */
const LOOKBACK_DAYS = 500;
const TIMEOUT_MS = 10000;
/* Yahoo refuses a request that does not name a browser. */
const UA = 'Mozilla/5.0 (compatible; multimeter/1.0; +https://multimtr.com)';

function send(res, status, body, cacheSeconds) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cacheSeconds
    ? 's-maxage=' + cacheSeconds + ', stale-while-revalidate=86400'
    : 'no-store');
  res.status(status).end(JSON.stringify(body));
}

function isoDay(d) { return d.toISOString().slice(0, 10); }

function ask(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return fetch(url, { signal: controller.signal, headers: headers || {} })
    .finally(() => clearTimeout(timer));
}

function pairs(series) {
  return series.map((p) => [p.date, p.price]);
}

/* { closes, name } on success, { denied: true } when the plan refuses the
 * symbol, { error } otherwise. Nothing here throws: a failure is a fall to
 * the next source, not the end of the request. */
async function fromFmp(symbol, key) {
  const to = new Date();
  const from = new Date(to.getTime() - LOOKBACK_DAYS * 86400000);
  const url = FMP + '/historical-price-eod/light?symbol=' + encodeURIComponent(symbol) +
    '&from=' + isoDay(from) + '&to=' + isoDay(to) + '&apikey=' + encodeURIComponent(key);

  let r;
  try { r = await ask(url); } catch (e) { return { error: 'did not answer' }; }
  if (r.status === 402 || r.status === 403) return { denied: true };
  if (!r.ok) return { error: 'HTTP ' + r.status };

  let rows;
  try { rows = await r.json(); } catch (e) { return { error: 'unreadable JSON' }; }
  const series = SRC.normalizeEodLight(rows);
  return series ? { closes: pairs(series), name: symbol } : { error: 'no closes returned' };
}

async function fromYahoo(symbol) {
  const url = SRC.yahooChartUrl(symbol, '2y');
  if (!url) return { error: 'not a ticker it accepts' };

  let r;
  try { r = await ask(url, { 'user-agent': UA, accept: 'application/json' }); }
  catch (e) { return { error: 'did not answer' }; }
  if (r.status === 404) return { error: 'no such symbol' };
  if (!r.ok) return { error: 'HTTP ' + r.status };

  let payload;
  try { payload = await r.json(); } catch (e) { return { error: 'unreadable JSON' }; }
  const series = SRC.normalizeYahooChart(payload);
  return series
    ? { closes: pairs(series), name: SRC.yahooName(payload) || symbol }
    : { error: 'no closes returned' };
}

module.exports = async (req, res) => {
  const raw = (req.query && req.query.symbol) || '';
  const symbol = String(raw).toUpperCase();
  if (!SYMBOL_RE.test(symbol)) {
    return send(res, 400, { error: 'bad_symbol', message: 'Ask for one ticker, such as NVDA.' });
  }

  /* Why each source declined, so a blank chart can say what went wrong
   * instead of leaving the reader to guess. */
  const tried = [];
  let got = null;

  const key = process.env.FMP_API_KEY;
  if (key) {
    const fmp = await fromFmp(symbol, key);
    if (fmp.closes) got = fmp;
    else tried.push('the licensed source ' + (fmp.denied ? 'does not cover ' + symbol : fmp.error));
  }

  if (!got) {
    const yahoo = await fromYahoo(symbol);
    if (yahoo.closes) got = yahoo;
    else tried.push('the public source ' + yahoo.error);
  }

  if (!got) {
    return send(res, 200, {
      error: 'no_history', symbol: symbol, closes: [],
      message: 'No daily closes for ' + symbol + ': ' + tried.join(', ') + '.'
    }, 900);
  }

  return send(res, 200, {
    symbol: symbol,
    name: got.name || symbol,
    closes: got.closes.slice(-MAX_SESSIONS)
  }, 3600);
};
