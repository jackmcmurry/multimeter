/* ============================================================================
 * probe-prompt.js: the model half of PROBE, and the guard around it.
 *
 * Pure, like note.js: it turns a ProbeContext and a question into a request,
 * reads what comes back, and checks it mechanically. Nothing here calls the
 * network, and none of it ever ships in the published page. The key lives in
 * the environment of whatever runs this.
 *
 * The guard matters more than the prompt. A system prompt is a request; the
 * validator is a rule. Anything the model returns that asserts a cause while
 * no external evidence was supplied, or cites a figure that was not in the
 * context, or recommends a trade, is rejected outright and the local evidence
 * engine answers instead. So the worst case is that PROBE sounds duller, not
 * that it says something untrue.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var PROMPT_VERSION = 1;
  var MODEL = 'claude-opus-5';
  var MAX_TOKENS = 4096;            /* room for adaptive thinking at low effort */
  var MAX_HEADLINE = 60;
  var MAX_SUMMARY = 320;
  var MAX_ITEMS = 4;

  /* Words that turn a description into a recommendation or a forecast. The
   * same idea as note.js, narrowed to what an investigation might reach for. */
  var BANNED = [
    'buy', 'sell', 'hold', 'should', 'must', 'recommend', 'advise', 'bullish', 'bearish',
    'will rise', 'will fall', 'will go', 'expect', 'forecast', 'predict', 'target price',
    'undervalued', 'overvalued', 'guaranteed', 'sure thing', 'opportunity'
  ];
  var BANNED_RE = BANNED.map(function (w) { return { word: w, re: new RegExp('\\b' + w.replace(/ /g, '\\s+') + '\\w*\\b', 'i') }; });

  /* Asserting a cause. Permitted only when external evidence was supplied,
   * and this instrument currently supplies none. */
  var CAUSE_RE = /\b(because of|caused by|due to|driven by|thanks to|as a result of|in response to|following the|after the announcement|on news)\b/i;

  var SYSTEM = [
    'You are the investigative subsystem of Multimeter, an educational financial instrument used by students aged roughly 13 to 18.',
    '',
    'You are given a JSON context of measurements the instrument has already taken, and one question from a student. Answer that question from the context and from nothing else.',
    '',
    'Rules:',
    '1. Answer first. The headline is a short verdict a reader understands in a second. The summary is one or two plain sentences.',
    '2. Use only figures present in the context. Quote them with the same rounding and units. Never introduce a number that is not there.',
    '3. Separate what is observed, what it could mean, and what cannot be told. Put each in its own field.',
    '4. If the context has no externalContext, you do not know why anything happened. Say so. Never name an earnings report, product, announcement, analyst, policy decision or person as a cause.',
    '5. Correlation is never evidence of causation. If a student assumes it is, say plainly that it is not, and say what evidence would be needed.',
    '6. Never recommend buying, selling or holding. Never predict a future price. If asked, say the instrument does not do that and point at something measurable instead.',
    '7. Write at about an eighth to tenth grade reading level. Explain a financial term the first time you use it. No analogies, no hype, no talking down.',
    '8. Be short. At most four items in any list. This has to fit on a small instrument display.',
    '9. Prefer actions that send the student back to the instrument rather than back to you.',
    '',
    'Return only JSON, with this shape:',
    '{"answer":{"headline":"","summary":""},"observations":[""],"interpretation":[""],"uncertainty":[""],"concepts":[""],"actions":[{"type":"OPEN_MODE|OPEN_LEARN|SET_COMPARISON","mode":"vol|corr|dd|btc|eth|nasdaq|spx|watch","concept":"volatility|correlation|drawdown|risk|returns|causation|index|marketcap|volume|diversification","label":""}],"followUps":[""]}',
    'Omit any field you have nothing truthful to put in.'
  ].join('\n');

  /* The context sent to the model: summarized measurements only. No raw
   * series, no watch list, no identifiers, nothing about the browser. */
  function requestContext(ctx) {
    if (!ctx) return null;
    function n(v, dp) { return typeof v === 'number' && isFinite(v) ? Number(v.toFixed(dp === undefined ? 4 : dp)) : null; }
    return {
      subject: { symbol: ctx.subject.symbol, name: ctx.subject.name, kind: ctx.subject.kind },
      comparison: ctx.comparison ? { symbol: ctx.comparison.symbol, name: ctx.comparison.name } : null,
      mode: ctx.mode,
      price: ctx.price ? { value: n(ctx.price.value, 2), currency: ctx.price.currency, basis: ctx.price.basis, source: ctx.price.source } : null,
      change: ctx.change ? { percent: n(ctx.change.percent, 2), period: ctx.change.period } : null,
      history: ctx.history ? { points: ctx.history.points, from: ctx.history.from, to: ctx.history.to } : null,
      move: ctx.move ? { percentOfRecentDays: n(ctx.move.percentile, 3), comparedWith: ctx.move.comparedWith, z: n(ctx.move.z, 2) } : null,
      volatility: ctx.volatility ? { annualized: n(ctx.volatility.value, 4), window: ctx.volatility.window } : null,
      comparisonVolatility: ctx.indexVolatility ? { annualized: n(ctx.indexVolatility.value, 4), window: ctx.indexVolatility.window } : null,
      drawdown: ctx.drawdown ? { now: n(ctx.drawdown.now, 4), worst: n(ctx.drawdown.worst, 4) } : null,
      episode: ctx.episode ? { depth: n(ctx.episode.depth, 4), peakDate: ctx.episode.peakDate, troughDate: ctx.episode.troughDate, recovered: !ctx.episode.ongoing } : null,
      correlation: ctx.correlation ? { value: n(ctx.correlation.value, 3), window: ctx.correlation.window, pairedSessions: ctx.correlation.pairedSessions } : null,
      externalContext: ctx.externalContext || null
    };
  }

  function buildRequest(ctx, question) {
    var packet = requestContext(ctx);
    var user = [
      'Context:',
      JSON.stringify(packet),
      '',
      'Student question: ' + String(question || '').slice(0, 200),
      '',
      'Answer it from the context. Return only the JSON object.'
    ].join('\n');
    return { system: SYSTEM, user: user, model: MODEL, maxTokens: MAX_TOKENS };
  }

  /* A Messages API reply -> the finding object, or null. */
  function parse(reply) {
    var p = reply;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { return null; } }
    if (!p || typeof p !== 'object' || !Array.isArray(p.content)) return null;
    if (p.stop_reason === 'refusal') return null;
    var text = p.content.filter(function (b) { return b && b.type === 'text' && typeof b.text === 'string'; })
      .map(function (b) { return b.text; }).join('').trim();
    if (!text) return null;
    var open = text.indexOf('{'), close = text.lastIndexOf('}');
    if (open < 0 || close <= open) return null;
    try { return JSON.parse(text.slice(open, close + 1)); } catch (e) { return null; }
  }

  function strings(v) {
    return Array.isArray(v) ? v.filter(function (s) { return typeof s === 'string' && s.trim(); }).slice(0, MAX_ITEMS) : [];
  }

  /* Every number the model may legitimately quote, as strings, drawn from the
   * context it was given. */
  function allowedFigures(ctx) {
    var packet = requestContext(ctx);
    var out = [];
    (function walk(v) {
      if (v === null || v === undefined) return;
      if (typeof v === 'number') { out.push(Math.abs(v)); return; }
      if (typeof v === 'object') { Object.keys(v).forEach(function (k) { walk(v[k]); }); }
    })(packet);
    return out;
  }

  /* Does every figure in the text correspond to one the context supplied?
   * Percentages are compared against both the fraction and the percent form,
   * with a tolerance, since the model is asked to round. */
  /* Instrument names carry digits: "S&P 500", "Nasdaq 100". Those are names,
   * not measurements, and must not be mistaken for figures the model made up. */
  function stripNames(text, ctx) {
    var out = String(text).replace(/S&P\s*500|Nasdaq[\s-]?(?:100|Composite)?|Dow(?:\s*Jones)?|MM-10/gi, ' ');
    [ctx && ctx.subject, ctx && ctx.comparison].forEach(function (p) {
      if (!p) return;
      [p.name, p.symbol].forEach(function (s) {
        if (typeof s === 'string' && s.length > 1) {
          out = out.split(s).join(' ');
        }
      });
    });
    return out;
  }

  function figuresSupported(text, ctx) {
    var allowed = allowedFigures(ctx);
    var found = stripNames(text, ctx).match(/-?\d+(?:\.\d+)?/g) || [];
    return found.every(function (raw) {
      var v = Math.abs(parseFloat(raw));
      if (!isFinite(v)) return true;
      if (v <= 12) return true;                 /* small counts, windows, scales */
      if (/^(19|20)\d\d$/.test(raw)) return true; /* a year from a date */
      return allowed.some(function (a) {
        return Math.abs(a - v) <= 0.51 || Math.abs(a * 100 - v) <= 0.51 || Math.abs(a - v / 100) <= 0.0051;
      });
    });
  }

  /* The rules, mechanically. Returns the first one broken. */
  function validate(finding, ctx) {
    if (!finding || typeof finding !== 'object') return { ok: false, reason: 'not an object' };
    var a = finding.answer;
    if (!a || typeof a.headline !== 'string' || !a.headline.trim()) return { ok: false, reason: 'no headline' };
    if (a.headline.length > MAX_HEADLINE) return { ok: false, reason: 'headline too long' };
    if (typeof a.summary !== 'string' || a.summary.length > MAX_SUMMARY) return { ok: false, reason: 'summary missing or too long' };

    var prose = [a.headline, a.summary].concat(strings(finding.observations), strings(finding.interpretation), strings(finding.uncertainty)).join(' ');
    for (var i = 0; i < BANNED_RE.length; i++) {
      if (BANNED_RE[i].re.test(prose)) return { ok: false, reason: 'banned word "' + BANNED_RE[i].word + '"' };
    }
    /* the rule the whole product rests on */
    if (!(ctx && ctx.externalContext) && CAUSE_RE.test(prose)) return { ok: false, reason: 'asserted a cause with no external evidence' };
    if (!figuresSupported(prose, ctx)) return { ok: false, reason: 'cited a figure not present in the context' };

    var concepts = strings(finding.concepts).filter(function (id) { return !!(MP.concepts && MP.concepts.get(id)); });
    var actions = MP.probe ? MP.probe.cleanActions(finding.actions) : [];
    return { ok: true, reason: null, concepts: concepts, actions: actions };
  }

  /* A validated reply, in the same shape the local engine returns. */
  function toFinding(raw, check, question) {
    return {
      version: MP.probe ? MP.probe.SCHEMA_VERSION : 1,
      status: 'answered',
      origin: 'claude',
      question: question || null,
      answer: { headline: raw.answer.headline.trim(), summary: (raw.answer.summary || '').trim() },
      observations: strings(raw.observations).map(function (t) { return { text: t, kind: 'calculated', source: 'Multimeter' }; }),
      interpretation: strings(raw.interpretation),
      uncertainty: strings(raw.uncertainty),
      concepts: check.concepts,
      actions: check.actions,
      followUps: strings(raw.followUps)
    };
  }

  MP.probePrompt = {
    PROMPT_VERSION: PROMPT_VERSION,
    MODEL: MODEL,
    MAX_TOKENS: MAX_TOKENS,
    SYSTEM: SYSTEM,
    BANNED: BANNED,
    requestContext: requestContext,
    stripNames: stripNames,
    buildRequest: buildRequest,
    parse: parse,
    validate: validate,
    figuresSupported: figuresSupported,
    toFinding: toFinding
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
