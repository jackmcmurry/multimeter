/* ============================================================================
 * probe.js: the investigative subsystem, without the model.
 *
 * PROBE answers questions that arise from what a student just measured. Most
 * of those questions are arithmetic, not judgement: "is that a lot", "is this
 * unusually volatile", "is minus thirty per cent bad", "how long did it take
 * to recover", "does correlation mean one caused the other". This module
 * answers every one of those from figures the page already holds, with no
 * network call and no model.
 *
 * That ordering is deliberate. The instrument must exhaust what it can prove
 * before it reaches for an opinion, so a model is never asked to restate a
 * calculation and can never quietly get one wrong. Claude is reserved for
 * questions the arithmetic genuinely cannot reach, and where nothing can
 * reach them, PROBE says so.
 *
 * Everything here is pure: it reads a context object, returns a finding, and
 * touches no DOM and no network. Advice and prediction are refused
 * mechanically here rather than by asking a model nicely, so that refusal
 * cannot be talked out of.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var SCHEMA_VERSION = 1;

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function pct(v, dp) { return (v * 100).toFixed(dp === undefined ? 1 : dp) + '%'; }

  /* ---- provenance ---------------------------------------------------------
   * Every statement PROBE makes carries how it is known. These four never mix:
   * a reading from a provider, a number this page computed, something from a
   * verified outside source, and an interpretation laid over them. */
  function observed(text, source, asOf) { return { text: text, kind: 'observed', source: source || null, asOf: asOf || null }; }
  function calculated(text, basis) { return { text: text, kind: 'calculated', source: 'Multimeter', basis: basis || null }; }

  /* ---- the allowed actions ------------------------------------------------
   * A finding may only ask the instrument to do one of these. Anything else,
   * whoever suggested it, is dropped. */
  var ACTION_TYPES = ['OPEN_MODE', 'OPEN_LEARN', 'SET_COMPARISON', 'OPEN_DATA', 'RETURN'];

  function openMode(stop, label) { return { type: 'OPEN_MODE', mode: stop, label: label }; }
  function openLearn(concept, label) { return { type: 'OPEN_LEARN', concept: concept, label: label || ('LEARN ' + concept.toUpperCase()) }; }

  /* An action is kept only when the instrument can actually perform it: the
   * stop exists, or the concept exists. Nothing is trusted by name. */
  function validAction(a) {
    if (!a || ACTION_TYPES.indexOf(a.type) < 0 || typeof a.label !== 'string' || !a.label) return false;
    if (a.type === 'OPEN_MODE') return !!(MP.router && MP.router.VIEWS.indexOf(a.mode) >= 0);
    if (a.type === 'OPEN_LEARN') return !!(MP.concepts && MP.concepts.get(a.concept));
    if (a.type === 'SET_COMPARISON') return a.index === 'ixic' || a.index === 'spx';
    return true;
  }

  function cleanActions(list) {
    return (list || []).filter(validAction).slice(0, 4);
  }

  /* ---- the context --------------------------------------------------------
   * Built from MarketContext, which already carries provenance and returns
   * null rather than guessing, plus the measurements the analytical stops
   * computed. Nothing here is invented and nothing is fetched. */
  function build(opts) {
    opts = opts || {};
    var stop = opts.stop || null;
    var ctx = MP.context && stop ? MP.context.build(stop) : null;
    var a = opts.analytics || null;
    var labels = opts.labels || {};
    var c90 = a && a.coupling ? (a.coupling[1] || a.coupling[0]) : null;

    return {
      version: SCHEMA_VERSION,
      builtAt: Date.now(),
      question: typeof opts.question === 'string' ? opts.question.slice(0, 200) : null,
      mode: stop,
      subject: {
        symbol: labels.coin || (ctx && ctx.instrument ? ctx.instrument.symbol : null),
        name: ctx && ctx.instrument ? ctx.instrument.name : null,
        kind: ctx && ctx.instrument ? ctx.instrument.kind : null
      },
      comparison: labels.indexName ? { symbol: labels.index, name: labels.indexName } : null,
      price: ctx ? ctx.price : null,
      change: ctx ? ctx.change : null,
      history: ctx ? ctx.history : null,
      move: ctx && ctx.statistics ? ctx.statistics.move : null,
      volatility: a && isNum(a.currentCoinVol) ? { value: a.currentCoinVol, window: 30, annualized: true } : null,
      indexVolatility: a && isNum(a.currentIndexVol) ? { value: a.currentIndexVol, window: 30, annualized: true } : null,
      drawdown: a && a.coinDd && isNum(a.coinDd.now) ? { now: a.coinDd.now, worst: a.coinDd.max } : null,
      episode: a && a.coinEpisodes && a.coinEpisodes.length ? a.coinEpisodes.slice().sort(function (p, q) { return p.depth - q.depth; })[0] : null,
      correlation: c90 && isNum(c90.correlation) ? { value: c90.correlation, window: c90.window, pairedSessions: c90.n } : null,
      concept: MP.concepts && stop ? MP.concepts.bindingFor(stop) : null,
      market: ctx ? ctx.market : null,
      sources: ctx ? ctx.sources : [],
      /* V1 has no verified event feed. This stays null so that nothing can
       * mistake an absence of news for an absence of cause. */
      externalContext: null
    };
  }

  /* ---- what a student is likely to ask next -------------------------------
   * Deterministic, from the mode and from what is actually measurable. A
   * question is offered only when PROBE could answer it. */
  function questionsFor(ctx) {
    if (!ctx) return [];
    var out = [];
    var sym = ctx.subject.symbol || 'this';
    if (ctx.mode === 'vol') {
      if (ctx.volatility) out.push('Is this unusually volatile?');
      if (ctx.volatility && ctx.indexVolatility) out.push('How does it compare with the market?');
      if (ctx.volatility) out.push('Has it always moved this much?');
    } else if (ctx.mode === 'corr') {
      if (ctx.correlation) out.push('Is this a strong relationship?');
      if (ctx.correlation) out.push('Does this mean one causes the other?');
      if (ctx.correlation) out.push('Have they always moved together?');
    } else if (ctx.mode === 'dd') {
      if (ctx.drawdown) out.push('Is this a large drawdown?');
      if (ctx.episode) out.push('How long has it been falling?');
      if (ctx.drawdown) out.push('How much would it take to recover?');
    } else {
      if (ctx.move) out.push('Is this a big move?');
      if (ctx.volatility) out.push('Does ' + sym + ' normally move this much?');
      if (ctx.volatility && ctx.indexVolatility) out.push('How does it compare with the market?');
    }

    /* Every question above needs a measurement to exist. Where the history
     * has not arrived, that left the panel with nothing to press, so the list
     * is topped up with questions this engine can always answer. The last one
     * needs no data at all, so there is never an empty PROBE. */
    var universal = [];
    if (ctx.move) universal.push('Is this a big move?');
    if (ctx.volatility) universal.push('How much does it usually move?');
    if (ctx.drawdown) universal.push('How far has it fallen from its peak?');
    universal.push('Does moving together prove one caused the other?');
    universal.forEach(function (q) {
      if (out.length < 3 && out.indexOf(q) < 0) out.push(q);
    });
    return out.slice(0, 3);
  }

  /* ---- reading a question -------------------------------------------------
   * Crude on purpose. The point is to route to an arithmetic answer where one
   * exists, and to recognise the two kinds of question this instrument
   * refuses, not to parse English properly. */
  var ADVICE_RE = /\b(should i|shall i|do i|worth buying|worth it|good buy|good investment|buy|sell|invest in)\b/i;
  var PREDICT_RE = /\b(will it|going to|tomorrow|next week|next month|next year|predict|forecast|future|moon|price target|what stock|which stock|guarantee)\b/i;
  /* "will ... double", "will ... go up": a prediction dressed as a question,
   * including the ones that arrive wrapped in an instruction to ignore these
   * rules. Refusing here, before any model, is what makes it stick. */
  var PREDICT_VERB_RE = /\bwill\b[^.?]{0,30}\b(double|triple|rise|fall|drop|crash|go up|go down|be worth|hit|outperform|skyrocket)\b/i;
  /* A question asking what caused a move, however it is phrased. */
  var CAUSE_Q_RE = /\bwhy\b|what happened|what caused|what made|what drove|what is behind|what's behind|whats behind|reason for|reason it/i;

  function topicOf(q, ctx) {
    var s = String(q || '').toLowerCase();
    /* "does one cause the other" is about the relationship. "Musk caused
     * bitcoin to rise" is a claim about an outside event, and belongs with
     * the questions this instrument cannot answer from price alone. */
    if (ctx.correlation && /caus|prove/.test(s) && /\bthey\b|\bboth\b|together|each other|correlat|relationship|one .*other/.test(s)) return 'causation';
    if (/strong|relationship|together|correlat/.test(s)) return 'correlation';
    if (/recover|how long|falling|drawdown|peak|fell|fall/.test(s)) return 'drawdown';
    if (/volatil|move this much|swing|jumpy|crazy|risky|risk/.test(s)) return 'volatility';
    if (/big move|a lot|unusual|normal|large/.test(s)) return 'move';
    if (/compare|versus|vs|than the market|s&p|nasdaq/.test(s)) return 'compare';
    return null;
  }

  function finding(status, headline, summary) {
    return {
      version: SCHEMA_VERSION,
      status: status,                 /* answered | insufficient | refused | unavailable */
      origin: 'local',
      answer: { headline: headline, summary: summary },
      observations: [],
      interpretation: [],
      uncertainty: [],
      concepts: [],
      actions: [],
      followUps: []
    };
  }

  /* ---- the refusals, done mechanically ------------------------------------
   * Advice and prediction are refused here, before any model sees the
   * question, so the refusal cannot be argued with or prompted around. */
  function refuseAdvice(ctx) {
    var f = finding('refused', 'THAT IS NOT WHAT THIS INSTRUMENT IS FOR',
      'Multimeter does not decide what anyone should buy or sell. It measures what has already happened, which is a different question and one you can actually check.');
    f.interpretation.push('What you can do is look at the things people examine before deciding: how much it moves, how far it has fallen before, and how it behaves next to the wider market.');
    f.concepts = ['risk'];
    f.actions = cleanActions([
      openMode('vol', 'SEE VOLATILITY'),
      openMode('dd', 'SEE DRAWDOWN'),
      openLearn('risk', 'LEARN RISK')
    ]);
    return f;
  }

  function refusePrediction(ctx) {
    var f = finding('refused', 'NOBODY CAN TELL YOU THAT',
      'Tomorrow’s price cannot be worked out from the history on this screen. If it could, the price today would already reflect it.');
    f.interpretation.push('What the history does support is a description of how this asset has behaved: how large its usual day is, and how far it has fallen in the past.');
    f.uncertainty.push('Every measurement here looks backwards. None of them carries forward as a promise.');
    f.concepts = ['volatility', 'risk'];
    f.actions = cleanActions([openMode('vol', 'SEE VOLATILITY'), openLearn('risk', 'LEARN RISK')]);
    return f;
  }

  /* ---- the evidence engine ------------------------------------------------ */

  function moveAnswer(ctx) {
    var m = ctx.move;
    if (!m || !isNum(m.percentile)) return null;
    var share = Math.round(m.percentile * 100);
    var band = MP.concepts ? MP.concepts.band('unusual', m.percentile) : null;
    var f = finding('answered', band ? band.label : (share >= 80 ? 'LARGER THAN USUAL' : 'AN ORDINARY DAY'),
      'That move was bigger than ' + share + '% of this asset’s last ' + m.comparedWith + ' daily moves.');
    f.observations.push(calculated('Latest move: ' + pct(m.return, 2) + '.', m.basis));
    if (isNum(m.z)) f.observations.push(calculated('About ' + Math.abs(m.z).toFixed(1) + ' standard deviations from an average day.', 'daily log returns'));
    f.interpretation.push(share >= 95
      ? 'A day like this is rare for this asset, though rare days happen in both directions.'
      : share >= 50
        ? 'This is on the larger side of normal for this asset.'
        : 'By this asset’s own standards, this is an ordinary day.');
    f.uncertainty.push('This says how big the move was against its own history. It says nothing about what caused it.');
    f.concepts = ['unusual', 'volatility'];
    f.actions = cleanActions([openMode('vol', 'SEE VOLATILITY'), openLearn('unusual', 'LEARN THIS')]);
    f.followUps = ['Does it normally move this much?', 'How far has it fallen before?'];
    return f;
  }

  function volatilityAnswer(ctx) {
    var v = ctx.volatility;
    if (!v) return null;
    var band = MP.concepts ? MP.concepts.band('volatility', v.value) : null;
    var sym = ctx.subject.symbol || 'This asset';
    var iv = ctx.indexVolatility;
    var f = finding('answered', band ? band.label : 'MEASURED', '');
    f.observations.push(calculated(sym + ' 30-day volatility: ' + pct(v.value, 1) + ', annualized.', 'standard deviation of daily log returns'));
    if (iv && ctx.comparison) {
      f.observations.push(calculated((ctx.comparison.name || 'the index') + ': ' + pct(iv.value, 1) + ', same method and window.', 'standard deviation of daily log returns'));
      var times = iv.value > 0 ? v.value / iv.value : NaN;
      f.answer.summary = sym + '’s returns have moved around ' + (v.value > iv.value ? 'more' : 'less') + ' than ' +
        (ctx.comparison.name || 'the market') + '’s' + (isNum(times) && times >= 1.2 ? ', about ' + times.toFixed(1) + ' times as much' : '') + '.';
      f.actions = cleanActions([openMode('vol', 'SEE VOLATILITY'), openLearn('volatility', 'LEARN VOLATILITY'), openMode('dd', 'SEE DRAWDOWN')]);
    } else {
      f.answer.summary = sym + '’s returns have varied by about ' + pct(v.value, 1) + ' a year on this measure.';
      f.uncertainty.push('There is no comparable index measurement loaded, so there is nothing to hold this against yet.');
      f.actions = cleanActions([openMode('vol', 'SEE VOLATILITY'), openLearn('volatility', 'LEARN VOLATILITY')]);
    }
    f.interpretation.push('Volatility measures the size of the swings, in both directions. It is not a direction and it is not a forecast.');
    f.concepts = ['volatility', 'risk'];
    f.followUps = ['Has it always moved this much?', 'How far has it fallen from its peak?'];
    return f;
  }

  function drawdownAnswer(ctx) {
    var d = ctx.drawdown;
    if (!d) return null;
    var band = MP.concepts ? MP.concepts.band('drawdown', d.now) : null;
    var sym = ctx.subject.symbol || 'This asset';
    var f = finding('answered', band ? band.label : 'MEASURED',
      sym + ' is ' + pct(d.now, 1) + ' below its own highest point.');
    f.observations.push(calculated('Currently ' + pct(d.now, 1) + ' below the running peak.', 'distance below the running peak'));
    if (isNum(d.worst)) f.observations.push(calculated('Worst fall in the loaded history: ' + pct(d.worst, 1) + '.', 'distance below the running peak'));
    if (ctx.episode) {
      var e = ctx.episode;
      f.observations.push(calculated('That fall began at a peak on ' + e.peakDate + ' and reached its low on ' + e.troughDate + '.', 'daily closes'));
      if (e.ongoing) f.uncertainty.push('It has not recovered to that peak within the history loaded here.');
    }
    if (isNum(d.now) && d.now < 0) {
      var need = 1 / (1 + d.now) - 1;
      f.interpretation.push('Getting back to the peak from here would take a rise of about ' + pct(need, 0) + ', because a fall and the recovery from it are not the same percentage.');
    }
    f.uncertainty.push('A drawdown says how far something fell, not why it fell or whether it will recover.');
    f.concepts = ['drawdown', 'risk'];
    f.actions = cleanActions([openMode('dd', 'SEE DRAWDOWN'), openLearn('drawdown', 'LEARN DRAWDOWN'), openMode('vol', 'SEE VOLATILITY')]);
    f.followUps = ['Did the whole market fall too?', 'How much does it normally move?'];
    return f;
  }

  function correlationAnswer(ctx) {
    var c = ctx.correlation;
    if (!c) return null;
    var band = MP.concepts ? MP.concepts.band('correlation', c.value) : null;
    var pair = (ctx.subject.symbol || 'this') + ' and ' + (ctx.comparison ? ctx.comparison.name : 'the index');
    var f = finding('answered', band ? band.label : 'MEASURED',
      c.value > 0.2 ? pair + ' have tended to rise and fall on the same days.'
        : c.value < -0.2 ? pair + ' have tended to move in opposite directions.'
          : 'The daily moves of ' + pair + ' have had little to do with each other.');
    f.observations.push(calculated('Correlation over ' + (c.window || 90) + ' sessions: ' + c.value.toFixed(2) +
      (isNum(c.pairedSessions) ? ', from ' + c.pairedSessions + ' days both traded' : '') + '.', 'daily log returns on shared sessions'));
    f.interpretation.push('Correlation runs from +1, moving in step, through 0, no relationship, to −1, moving opposite.');
    f.uncertainty.push('This describes the days they moved together. It does not show that either one moved the other.');
    f.concepts = ['correlation', 'causation'];
    f.actions = cleanActions([openMode('corr', 'SEE CORRELATION'), openLearn('correlation', 'LEARN CORRELATION'), openLearn('causation', 'WHY NOT CAUSE?')]);
    f.followUps = ['Does one cause the other?', 'Have they always moved together?'];
    return f;
  }

  /* The most important answer in the product, and it needs no model. */
  function causationAnswer(ctx) {
    var c = ctx.correlation;
    var f = finding('answered', 'NO. MOVING TOGETHER IS NOT CAUSING.',
      c ? 'A correlation of ' + c.value.toFixed(2) + ' says these two tended to move in similar directions. It does not say either one moved the other.'
        : 'Two things moving together does not show that one made the other move.');
    if (c) f.observations.push(calculated('Measured correlation: ' + c.value.toFixed(2) + ' over ' + (c.window || 90) + ' sessions.', 'daily log returns on shared sessions'));
    f.interpretation.push('Three explanations fit the same numbers equally well: one drives the other, something else drives both, or it happened by chance over a short window.');
    f.uncertainty.push('To argue that one caused the other you would need more than these two series: a reason it would work that way, and evidence it held up outside this window.');
    f.concepts = ['causation', 'correlation'];
    f.actions = cleanActions([openLearn('causation', 'LEARN THIS'), openMode('corr', 'SEE CORRELATION')]);
    f.followUps = ['What would better evidence look like?', 'Have they always moved together?'];
    return f;
  }

  /* A question about cause, where all we hold is price. */
  function noCauseAnswer(ctx) {
    var sym = ctx.subject.symbol || 'This asset';
    var f = finding('insufficient', 'WE CANNOT SAY WHY FROM THIS',
      'Multimeter holds prices and the measurements taken from them. It holds no news, filings or announcements, so it cannot tell you what caused a move.');
    if (ctx.change && isNum(ctx.change.percent)) {
      f.observations.push(observed(sym + ' moved ' + (ctx.change.percent >= 0 ? '+' : '') + ctx.change.percent.toFixed(2) + '% over ' + (ctx.change.period || 'the period shown') + '.',
        ctx.change.source, ctx.price ? ctx.price.asOf : null));
    }
    f.interpretation.push('What you can do is narrow it down. If similar assets moved the same way, the cause was probably broad. If this one moved alone, it was probably specific to it.');
    f.uncertainty.push('Price data shows what happened. On its own it never shows why.');
    f.uncertainty.push('If you have heard a reason given for this move, treat it as a claim to check rather than a fact, because nothing on this screen confirms it.');
    f.concepts = ['returns', 'correlation'];
    f.actions = cleanActions([openMode('corr', 'COMPARE WITH THE MARKET'), openMode('vol', 'SEE VOLATILITY')]);
    f.followUps = ['Did the whole market move too?', 'Is this a big move for it?'];
    return f;
  }

  /* ---- the entry point ----------------------------------------------------
   * Returns a finding, or null when nothing here can answer and the question
   * should be put to a model instead. */
  function answer(ctx, question) {
    if (!ctx) return null;
    var q = String(question || '');
    if (ADVICE_RE.test(q)) return refuseAdvice(ctx);
    if (PREDICT_RE.test(q) || PREDICT_VERB_RE.test(q)) return refusePrediction(ctx);

    var topic = topicOf(q, ctx);
    if (topic === 'causation') return causationAnswer(ctx);
    if (topic === 'correlation') return correlationAnswer(ctx) || null;
    if (topic === 'drawdown') return drawdownAnswer(ctx) || null;
    if (topic === 'volatility' || topic === 'compare') return volatilityAnswer(ctx) || null;
    if (topic === 'move') return moveAnswer(ctx) || null;

    /* "why did it fall", with only prices in hand */
    if (CAUSE_Q_RE.test(q)) return noCauseAnswer(ctx);

    /* a bare question on a measurement stop answers that measurement */
    if (ctx.mode === 'vol') return volatilityAnswer(ctx);
    if (ctx.mode === 'dd') return drawdownAnswer(ctx);
    if (ctx.mode === 'corr') return correlationAnswer(ctx);
    return moveAnswer(ctx);
  }

  /* Where a finding came from, for the INFO state. */
  function provenance(ctx) {
    var bits = [];
    if (ctx && ctx.sources && ctx.sources.length) bits.push('Market data: ' + ctx.sources.join(' and '));
    bits.push('Measurements: calculated by Multimeter');
    bits.push('Event context: none held');
    if (ctx && ctx.history && ctx.history.to) bits.push('Data through ' + ctx.history.to);
    return bits;
  }

  MP.probe = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    ACTION_TYPES: ACTION_TYPES,
    build: build,
    questionsFor: questionsFor,
    answer: answer,
    topicOf: topicOf,
    validAction: validAction,
    cleanActions: cleanActions,
    provenance: provenance
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
