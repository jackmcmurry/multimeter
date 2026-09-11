/* ============================================================================
 * note.js: the daily reading: three plain sentences about the day's figures.
 *
 * Pure: the data job gathers the figures, this module turns them into a
 * request, checks whatever comes back, and supplies a fallback built only
 * from the numbers. The model is asked to DESCRIBE, never to predict or
 * advise; validate() enforces that mechanically, and anything that fails
 * it is replaced by the fallback rather than published. Runs in Node (the
 * data job) and in the browser test bundle; never in the published page.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var PROMPT_VERSION = 3;          /* 2: the house writing style; 3: the weekly movers */
  var MODEL = 'claude-opus-5';
  var MAX_TOKENS = 4096;           /* room for adaptive thinking at low effort */
  var RETRY_MS = 2 * 3600000;      /* a rejected reply is re-asked at most every 2h */
  var MAX_ATTEMPTS = 2;
  var MAX_WORDS = 90;

  /* Words a description of figures has no need for. Word-bounded and
   * case-insensitive; a trailing * matches any ending. */
  var BANNED = [
    'buy', 'buying', 'sell', 'selling', 'sold', 'hold', 'should', 'must', 'ought',
    'recommend*', 'advise*', 'bullish', 'bearish', 'will', 'expect*', 'forecast*', 'predict*',
    'target*', 'guarantee*', 'opportunit*', 'undervalued', 'overvalued', 'cheap', 'dip', 'moon', 'rally',
    /* the house style: filler and inflation */
    'crucial', 'delve*', 'enhanc*', 'foster*', 'garner*', 'highlight*', 'interplay', 'intricate', 'key',
    'landscape', 'meticulous*', 'pivotal', 'showcas*', 'tapestry', 'testament', 'underscor*', 'valuable',
    'vibrant', 'groundbreaking', 'renowned', 'diverse array', 'rich heritage', 'commitment to',
    'serves as', 'stands as', 'in summary', 'in conclusion', 'overall', 'notably', 'remarkabl*'
  ];
  var BANNED_RE = BANNED.map(function (w) {
    var stem = w.replace(/\*$/, '');
    return { word: stem, re: new RegExp('\\b' + stem + (w.slice(-1) === '*' ? '\\w*' : '') + '\\b', 'i') };
  });
  var CLOSING = 'This is a description of the figures, not advice.';

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(v) { return isNum(v) ? v : null; }

  /* 26081.7245 -> "26,081.72" (no Intl, so Node and every browser agree) */
  function group(v, dp) {
    var s = Math.abs(v).toFixed(dp === undefined ? 2 : dp).split('.');
    s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (v < 0 ? '-' : '') + s.join('.');
  }
  function signed(points, dp) { return (points >= 0 ? '+' : '') + points.toFixed(dp === undefined ? 2 : dp) + '%'; }
  function pctOf(fraction, dp) { return (fraction * 100).toFixed(dp === undefined ? 1 : dp) + '%'; }

  function windowAt(pair, w) {
    if (!pair || !Array.isArray(pair.coupling)) return null;
    for (var i = 0; i < pair.coupling.length; i++) if (pair.coupling[i].window === w) return pair.coupling[i];
    return null;
  }

  /* ---- when ---------------------------------------------------------------- */

  /* Once per completed session; a rejected reply earns one more try after
   * RETRY_MS. Without a key nothing is ever rejected, so nothing retries. */
  function due(prev, now, session, force) {
    if (force === 'all' || force === 'note') return true;
    if (!session) return false;
    if (!prev || prev.forSession !== session) return true;
    if (prev.invalidReason && (prev.attempts || 1) < MAX_ATTEMPTS) {
      var t = Date.parse(prev.generatedAt);
      return !isFinite(t) || now - t >= RETRY_MS;
    }
    return false;
  }

  /* ---- what ---------------------------------------------------------------- */

  /* A movers set from spotlight.json -> the highest and lowest move only. */
  function moversInput(m) {
    if (!m || !m.mover || typeof m.mover.symbol !== 'string') return null;
    function one(e) { return e && typeof e.symbol === 'string' ? { symbol: e.symbol, change: num(e.change) } : null; }
    return { mover: one(m.mover), loser: one(m.loser), scanned: num(m.scanned) };
  }

  /* st: { session, quotes (quotes.json), coins (coinsMarkets map), findings,
   * movers (spotlight.json's movers) } -> plain numbers, null where
   * unavailable. */
  function inputs(st) {
    st = st || {};
    var q = st.quotes || {}, c = st.coins || {}, f = st.findings;
    var mv = st.movers || (st.spotlight && st.spotlight.movers) || {};
    var ix = f && f.pairs ? f.pairs.ixic : null;
    var c90 = windowAt(ix, 90);
    var dd = (f && f.drawdowns) || {};
    function quote(x) { return x ? { price: num(x.price), changePct: num(x.changePct) } : null; }
    return {
      session: st.session || null,
      ixic: quote(q.ixic),
      spx: quote(q.spx),
      btc: quote(c.bitcoin),
      eth: quote(c.ethereum),
      coupling: c90 ? { corr90: num(c90.correlation), beta90: num(c90.beta) } : null,
      vol: ix && ix.vol ? { btc: num(ix.vol.coin), index: num(ix.vol.index) } : null,
      drawdown: dd.btc || dd.ixic ? { btc: dd.btc ? num(dd.btc.now) : null, index: dd.ixic ? num(dd.ixic.now) : null } : null,
      stocks: moversInput(mv.stocks),
      crypto: moversInput(mv.crypto)
    };
  }

  var SYSTEM = [
    'You write a short daily reading for a public market data page.',
    'Rules:',
    '1. Exactly three sentences of plain English, at most ' + MAX_WORDS + ' words in total.',
    '2. Describe only the figures you are given, and cite them as given, with the same rounding, units and time horizons.',
    '3. Do not predict, forecast, recommend or advise. Never use the words buy, sell, hold, should, must, will, expect, target, bullish or bearish.',
    '4. Add no facts, news, causes or context that are not in the figures.',
    '5. No headings, lists, markdown, emoji, quotation marks or em dashes.',
    '6. The last sentence must say that this is a description of the figures, not advice.',
    '7. Write short, direct, declarative sentences. Say what the figures are without saying how important they are. Use "is" rather than "serves as" or "represents". Do not end a sentence with an "-ing" phrase that comments on it. No filler words such as crucial, key, pivotal, notably or overall.',
    'Output the three sentences and nothing else.'
  ].join('\n');

  function buildRequest(inp) {
    inp = inp || {};
    var lines = ['Session: ' + (inp.session || 'unknown') + ' (US equity close).', 'Figures:'];
    function quoteLine(label, x, horizon, dollars) {
      if (!x || !isNum(x.price)) return;
      lines.push('- ' + label + ': ' + (dollars ? '$' : '') + group(x.price, 2) +
        (isNum(x.changePct) ? ', ' + signed(x.changePct) + ' ' + horizon : ''));
    }
    quoteLine('Nasdaq Composite', inp.ixic, 'on the day', false);
    quoteLine('S&P 500', inp.spx, 'on the day', false);
    quoteLine('Bitcoin', inp.btc, 'over 24 hours', true);
    quoteLine('Ether', inp.eth, 'over 24 hours', true);
    var cp = inp.coupling;
    if (cp && isNum(cp.corr90)) {
      lines.push('- Bitcoin vs Nasdaq, last 90 sessions: correlation ' + cp.corr90.toFixed(2) +
        (isNum(cp.beta90) ? ', beta ' + cp.beta90.toFixed(2) : ''));
    }
    if (inp.vol && isNum(inp.vol.btc) && isNum(inp.vol.index)) {
      lines.push('- 30-session realized volatility, annualized: bitcoin ' + pctOf(inp.vol.btc, 0) + ', Nasdaq ' + pctOf(inp.vol.index, 0));
    }
    if (inp.drawdown && isNum(inp.drawdown.btc) && isNum(inp.drawdown.index)) {
      lines.push('- Distance below the running peak: bitcoin ' + pctOf(-inp.drawdown.btc) + ', Nasdaq ' + pctOf(-inp.drawdown.index));
    }
    function moversLine(set, among, horizon) {
      if (!set || !set.mover || !isNum(set.mover.change)) return;
      var line = '- Highest ' + horizon + ' move ' + among + ': ' + set.mover.symbol + ', ' + signed(set.mover.change, 1);
      if (set.loser && isNum(set.loser.change)) line += '; lowest: ' + set.loser.symbol + ', ' + signed(set.loser.change, 1);
      lines.push(line);
    }
    var st = inp.stocks;
    moversLine(st, 'among ' + (st && isNum(st.scanned) ? st.scanned + ' ' : '') + 'Nasdaq-100 members', 'five-session');
    moversLine(inp.crypto, 'among 15 large coins other than bitcoin and ether', 'seven-day');
    lines.push('Write the reading.');
    return { system: SYSTEM, user: lines.join('\n') };
  }

  /* ---- what came back ------------------------------------------------------ */

  /* A Messages API response -> { text, model, stopReason, fellBack } or null
   * when the model declined or said nothing usable. */
  function parse(reply) {
    var p = reply;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { return null; } }
    if (!p || typeof p !== 'object' || !Array.isArray(p.content)) return null;
    if (p.stop_reason === 'refusal') return null;
    var text = p.content.filter(function (b) { return b && b.type === 'text' && typeof b.text === 'string'; })
      .map(function (b) { return b.text; }).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    var iterations = p.usage && Array.isArray(p.usage.iterations) ? p.usage.iterations : [];
    return {
      text: text,
      model: typeof p.model === 'string' ? p.model : null,
      stopReason: p.stop_reason || null,
      fellBack: iterations.some(function (it) { return it && it.type === 'fallback_message'; })
    };
  }

  function words(text) { return String(text).trim().split(/\s+/).filter(Boolean).length; }
  function sentences(text) {
    return String(text).trim().split(/[.!?](?:\s+|$)/).filter(function (s) { return s.trim(); }).length;
  }

  /* The rules, mechanically. Returns the first rule broken. */
  function validate(text) {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty' };
    if (/[<>*#`]|https?:/i.test(text)) return { ok: false, reason: 'markup or a link' };
    if (text.indexOf(String.fromCharCode(0x2014)) >= 0) return { ok: false, reason: 'an em dash' };
    var scan = text.replace(/\bnot (?:investment |financial )?advice\b/gi, '');
    for (var i = 0; i < BANNED_RE.length; i++) {
      if (BANNED_RE[i].re.test(scan)) return { ok: false, reason: 'banned word "' + BANNED_RE[i].word + '"' };
    }
    if (!/\bnot (?:investment |financial )?advice\b/i.test(text)) return { ok: false, reason: 'no not-advice line' };
    var n = sentences(text);
    if (n < 2 || n > 4) return { ok: false, reason: n + ' sentences' };
    var w = words(text);
    if (w > MAX_WORDS) return { ok: false, reason: w + ' words' };
    if (!/\d/.test(text)) return { ok: false, reason: 'no figure cited' };
    return { ok: true, reason: null };
  }

  /* ---- the fallback -------------------------------------------------------- */

  function fromInputs(inp) {
    var out = [];
    var ix = inp.ixic, sp = inp.spx, b = inp.btc;
    if (ix && isNum(ix.price)) {
      out.push('On the session of ' + inp.session + ' the Nasdaq Composite closed at ' + group(ix.price, 2) +
        (isNum(ix.changePct) ? ', ' + signed(ix.changePct) + ' on the day' : '') +
        (sp && isNum(sp.price) ? ', and the S&P 500 at ' + group(sp.price, 2) : '') + '.');
    }
    if (b && isNum(b.price)) {
      out.push('Bitcoin was at $' + group(b.price, 2) + (isNum(b.changePct) ? ', ' + signed(b.changePct) + ' over 24 hours' : '') + '.');
    }
    if (!out.length) out.push('Figures for the session of ' + (inp.session || 'this date') + ' were not available when this was written.');
    return out;
  }

  /* Always passes validate(): at most two sentences from the numbers, then
   * the closing line. */
  function fallback(findings, inp) {
    inp = inp || {};
    var pool = findings && MP.findings ? MP.findings.narrative(findings) : [];
    if (!pool.length) pool = fromInputs(inp);
    var out = [];
    for (var i = 0; i < pool.length && out.length < 2; i++) {
      var candidate = out.concat([pool[i], CLOSING]).join(' ');
      if (words(candidate) <= MAX_WORDS && validate(candidate).ok) out.push(pool[i]);
    }
    if (!out.length) out = fromInputs(inp).slice(0, 1);
    if (!validate(out.concat([CLOSING]).join(' ')).ok) out = ['Figures for the session of ' + (inp.session || 'this date') + ' are in the table below.'];
    return out.concat([CLOSING]).join(' ');
  }

  MP.note = {
    PROMPT_VERSION: PROMPT_VERSION,
    MODEL: MODEL,
    MAX_TOKENS: MAX_TOKENS,
    RETRY_MS: RETRY_MS,
    MAX_ATTEMPTS: MAX_ATTEMPTS,
    MAX_WORDS: MAX_WORDS,
    BANNED: BANNED,
    SYSTEM: SYSTEM,
    due: due,
    inputs: inputs,
    buildRequest: buildRequest,
    parse: parse,
    validate: validate,
    fallback: fallback
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
