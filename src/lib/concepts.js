/* ============================================================================
 * concepts.js: the financial ideas the instrument can teach, as data.
 *
 * The audience is a student who has never invested, never taken economics and
 * never taken statistics. So each concept is written in three layers, and the
 * panels show one layer at a time:
 *
 *   beginner   one sentence, plain English, no jargon          (what is this)
 *   read       how to judge the number in front of you         (what it means)
 *   advanced   why it matters, the usual mistake, the maths    (on request)
 *
 * Nothing here is a lesson. A concept is bound to a measurement by
 * bindingFor(stop), so LEARN always explains the number already on the
 * screen rather than a chapter the reader chose.
 *
 * explorations are the curiosity engine: two or three questions a student
 * would actually ask next, each carrying where to go to answer it. They are
 * questions, not topics, because a question is what makes someone press.
 *
 * The bands turn a figure into a word: 57% becomes HIGH, 0.64 becomes
 * MODERATE POSITIVE. They are conventions this instrument adopts so a figure
 * has somewhere to stand, not facts about markets, and the panels say so.
 *
 * Reading level: around eighth to tenth grade. Precise plain English, no
 * talking down, no pizza analogies.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  /* A band: the word, and a tone the styles colour by. 'plain' takes the
   * screen's own ink, so only genuinely high or low readings take a colour. */
  function band(label, tone) { return { label: label, tone: tone || 'plain' }; }

  var CONCEPTS = {
    price: {
      name: 'Price',
      tier: 'core',
      beginner: 'What one share or one coin costs right now.',
      read: 'A price only means something next to the same asset’s own past. Comparing one asset’s price with another’s tells you nothing.',
      why: 'Price is where buyers and sellers last agreed. It is the number everything else on this instrument is built from, and on its own it is the least informative of them.',
      misconception: 'A high price does not mean expensive and a low price does not mean cheap. A $500 share is not a bigger company than a $50 one.',
      advanced: 'Coins are priced continuously across many exchanges, so this is a volume-weighted average rather than one trade. Index levels are not prices at all: nothing trades at that number.',
      visual: null,
      related: ['returns', 'marketcap'],
      explorations: [
        { q: 'How much has it moved?', concept: 'returns' },
        { q: 'How big is this company?', concept: 'marketcap' }
      ],
      bands: null
    },

    returns: {
      name: 'Return',
      tier: 'core',
      beginner: 'How much an investment gained or lost over a period, as a percent.',
      read: 'A percent has no size on its own. The same 2% is an ordinary day for one asset and a rare one for another, which is why this instrument compares every move with that asset’s own history.',
      why: 'Percent is what makes a $300 stock and a $70,000 coin comparable. Without it you cannot say which of two things moved more.',
      misconception: 'A large percent is not a large amount of money, and a small one does not mean nothing happened.',
      advanced: 'The statistics here use log returns, so that gains and losses add up symmetrically over time. A +10% followed by a −10% does not return you to where you started.',
      visual: 'return',
      related: ['price', 'volatility', 'unusual'],
      explorations: [
        { q: 'Is that a lot for this asset?', concept: 'unusual' },
        { q: 'How much does it usually move?', stop: 'vol' }
      ],
      bands: null
    },

    unusual: {
      name: 'How unusual a move is',
      tier: 'core',
      beginner: 'Where the latest move sits among that asset’s own recent moves.',
      read: 'The percent says how many recent days this move is bigger than. Anything past about 95% is a genuinely rare day.',
      why: 'This is the difference between reading a number and judging one. Without it, every percentage looks equally important.',
      misconception: 'A rare move is not a signal. Rare days happen, and they happen in both directions.',
      advanced: 'This session’s return is compared with the last 252 daily returns: how many standard deviations from an average day it sits, and the share of recent days it is larger than.',
      visual: null,
      related: ['returns', 'volatility'],
      explorations: [
        { q: 'Does it always move this much?', stop: 'vol' },
        { q: 'What was its worst fall?', stop: 'dd' }
      ],
      bands: function (v) {
        if (!isNum(v)) return null;
        if (v < 0.5) return band('ORDINARY');
        if (v < 0.8) return band('NOTABLE');
        if (v < 0.95) return band('LARGE', 'warn');
        return band('RARE', 'warn');
      }
    },

    volatility: {
      name: 'Volatility',
      tier: 'core',
      beginner: 'How much an investment’s returns move around.',
      read: 'Higher means bigger and less predictable swings, in both directions. Volatility is not direction: a violent rise and a violent fall read the same.',
      why: 'It tells you how rough the ride has been. Two investments can end the year in the same place and put you through completely different journeys.',
      misconception: 'High volatility does not mean something is falling, and low volatility does not mean it is safe.',
      advanced: 'The standard deviation of the last 30 days of daily returns, then scaled to a year by multiplying by the square root of 252, the number of trading days in a year.',
      visual: 'swings',
      compare: 'index',
      related: ['risk', 'returns', 'drawdown'],
      explorations: [
        { q: 'Is that high compared with the market?', action: 'compare' },
        { q: 'Does more volatile mean more risky?', concept: 'risk' },
        { q: 'How far has it fallen before?', stop: 'dd' }
      ],
      bands: function (v) {
        if (!isNum(v)) return null;
        if (v < 0.15) return band('LOW', 'calm');
        if (v < 0.35) return band('MODERATE');
        if (v < 0.60) return band('HIGH', 'warn');
        return band('VERY HIGH', 'warn');
      }
    },

    drawdown: {
      name: 'Drawdown',
      tier: 'core',
      beginner: 'How far an investment has fallen from its highest point.',
      read: 'It is always zero or negative, and it is measured against that asset’s own peak. Getting back from a 50% fall takes a 100% gain.',
      why: 'It answers the question a return cannot: what someone who bought at the worst moment would still be down, and how long they would have waited.',
      misconception: 'Being far below a peak does not make something cheap, and sitting at a peak does not make it expensive.',
      advanced: 'Measured on daily closes against the running peak. The chart marks the peak the fall began from and the lowest point since.',
      visual: 'peak',
      compare: 'index',
      related: ['risk', 'volatility'],
      explorations: [
        { q: 'Did the whole market fall too?', action: 'compare' },
        { q: 'How much does it normally swing?', stop: 'vol' }
      ],
      bands: function (v) {
        if (!isNum(v)) return null;
        if (v > -0.05) return band('AT OR NEAR ITS PEAK', 'calm');
        if (v > -0.20) return band('SHALLOW');
        if (v > -0.40) return band('DEEP', 'warn');
        return band('SEVERE', 'warn');
      }
    },

    correlation: {
      name: 'Correlation',
      tier: 'core',
      beginner: 'Whether two investments tend to move on the same days.',
      read: 'It runs from +1, moving in step, through 0, no relationship, to −1, moving opposite. It describes the days they moved together, not how far each one moved.',
      why: 'Owning two things that move together is closer to owning one thing twice. Correlation is how you tell them apart.',
      misconception: 'Correlation does not prove that one asset caused the other to move.',
      advanced: 'Daily returns over the sessions both instruments actually traded, so a weekend gap counts the same for each. Bitcoin trades weekends and the index does not.',
      visual: 'scale',
      related: ['causation', 'diversification', 'beta'],
      explorations: [
        { q: 'Does one cause the other?', concept: 'causation' },
        { q: 'Why would anyone care?', concept: 'diversification' },
        { q: 'Do they always move together?', stop: 'corr' }
      ],
      bands: function (v) {
        if (!isNum(v)) return null;
        var a = Math.abs(v);
        if (a < 0.2) return band('LITTLE RELATIONSHIP');
        var strength = a < 0.4 ? 'WEAK' : a < 0.7 ? 'MODERATE' : 'STRONG';
        return band(strength + (v < 0 ? ' NEGATIVE' : ' POSITIVE'));
      }
    },

    causation: {
      name: 'Correlation and cause',
      tier: 'core',
      beginner: 'Two things moving together does not mean one made the other move.',
      read: 'Three explanations fit the same numbers equally well: one drives the other, something else drives both, or it happened by chance over a short window. The correlation alone cannot tell you which.',
      why: 'It is the most common mistake people make when reading markets, and it is the difference between a measurement and an explanation.',
      misconception: 'A strong correlation is not stronger evidence of cause. It is only a stronger pattern.',
      advanced: 'To argue cause you need more than the two series: a mechanism that explains it, evidence it held before and after, and a check that a third thing is not driving both. This instrument measures; it does not explain.',
      visual: null,
      related: ['correlation'],
      explorations: [
        { q: 'See the relationship again', stop: 'corr' },
        { q: 'What does correlation measure?', concept: 'correlation' }
      ],
      bands: null
    },

    index: {
      name: 'Index',
      tier: 'core',
      beginner: 'One number that tracks a whole group of companies at once.',
      read: 'An index is the usual stand-in for "the market". It gives you something to hold a single company up against.',
      why: 'Without a yardstick, one company’s 3% means nothing. Against an index that fell 1% on the same day, it means a great deal.',
      misconception: 'You cannot buy an index. It is a measurement, not a share, though funds exist that try to track one.',
      advanced: 'The S&P 500 tracks 500 large US companies, weighted by size. The Nasdaq Composite tracks about 3,000 listed companies and is heavily influenced by technology.',
      visual: null,
      related: ['diversification', 'correlation'],
      explorations: [
        { q: 'How does this compare with it?', action: 'compare' },
        { q: 'Look at the S&P 500', stop: 'spx' }
      ],
      bands: null
    },

    marketcap: {
      name: 'Market value',
      tier: 'core',
      beginner: 'What the market says an entire company is worth: price times the number of shares.',
      read: 'This is how you compare the size of two companies, which share prices alone cannot do.',
      why: 'It says how large a thing is, not how good, how cheap, or how fast it grows.',
      misconception: 'It is not money invested and not money anyone could take out. It is the last price applied to every share at once.',
      advanced: 'Reported by the data source. For coins it uses the units in circulation, which is not always the total that will ever exist.',
      visual: null,
      related: ['price', 'volume'],
      explorations: [
        { q: 'What does the price itself tell me?', concept: 'price' },
        { q: 'How much is traded?', concept: 'volume' }
      ],
      bands: function (v) {
        if (!isNum(v) || v <= 0) return null;
        if (v < 2e9) return band('SMALL');
        if (v < 10e9) return band('MID');
        if (v < 200e9) return band('LARGE');
        return band('MEGA');
      }
    },

    volume: {
      name: 'Volume',
      tier: 'core',
      beginner: 'How much of something was bought and sold over a period.',
      read: 'Volume only means something next to its own recent level. A number on its own says nothing, which is why this instrument shows it beside the asset rather than ranking it.',
      why: 'Price says where buyers and sellers agreed. Volume says how many of them were involved in agreeing.',
      misconception: 'High volume does not confirm a price move or make it more likely to continue. It records participation, not agreement.',
      advanced: 'Reported over 24 hours for coins and over the session for indexes. Crypto volume is measured across exchanges and is not directly comparable with a stock exchange’s.',
      visual: null,
      related: ['price', 'marketcap'],
      explorations: [
        { q: 'What is the company worth?', concept: 'marketcap' },
        { q: 'How much did the price move?', concept: 'returns' }
      ],
      bands: null
    },

    risk: {
      name: 'Risk',
      tier: 'core',
      beginner: 'The chance that an investment does something other than what you expected.',
      read: 'Volatility and drawdown are two ways of measuring it. Neither is the whole picture, and no number on this instrument captures all of it.',
      why: 'Every measurement here is a partial answer to one question: how wrong could this go, and how would it feel on the way.',
      misconception: 'Risk is not the same as volatility. A calm investment can still lose everything, and a jumpy one can end up fine.',
      advanced: 'The measures here are backward looking. They describe what already happened, and nothing guarantees the next year resembles the last.',
      visual: null,
      related: ['volatility', 'drawdown', 'diversification'],
      explorations: [
        { q: 'How much does this move around?', stop: 'vol' },
        { q: 'How far has it fallen before?', stop: 'dd' },
        { q: 'Does owning more than one thing help?', concept: 'diversification' }
      ],
      bands: null
    },

    diversification: {
      name: 'Diversification',
      tier: 'core',
      beginner: 'Owning several different things so one bad outcome does not decide everything.',
      read: 'It only works when the things do not move together. That is exactly what correlation measures, which is why the two ideas belong side by side.',
      why: 'It is the one thing in finance that reduces risk without requiring you to predict anything.',
      misconception: 'Owning twenty things that all move together is not diversified. The number of holdings is not the point; how they move is.',
      advanced: 'An index is diversification packaged as one number, which is part of why a single company is usually more volatile than the index containing it.',
      visual: null,
      related: ['correlation', 'risk', 'index'],
      explorations: [
        { q: 'Do these two move together?', stop: 'corr' },
        { q: 'What is an index?', concept: 'index' }
      ],
      bands: null
    },

    beta: {
      name: 'Beta',
      tier: 'advanced',
      beginner: 'How far one investment tends to move when the market moves one percent.',
      read: 'A beta of 1.5 means it has historically moved about half again as much as the index. Beta without R squared is half a picture.',
      why: 'Correlation says whether two things move together. Beta says by how much, which is what decides the size of the swing you actually feel.',
      misconception: 'Beta is not a forecast and it is not risk. It is the slope of a line drawn through the past.',
      advanced: 'The slope of the line through the return scatter, with the index on the horizontal axis.',
      visual: null,
      related: ['correlation', 'r2', 'volatility'],
      explorations: [
        { q: 'How tight is the relationship?', concept: 'r2' },
        { q: 'See the correlation', stop: 'corr' }
      ],
      bands: function (v) {
        if (!isNum(v)) return null;
        if (v < 0.5) return band('MUCH LESS THAN THE MARKET');
        if (v < 0.9) return band('LESS THAN THE MARKET');
        if (v <= 1.1) return band('ABOUT THE MARKET');
        if (v <= 2) return band('MORE THAN THE MARKET');
        return band('MUCH MORE THAN THE MARKET', 'warn');
      }
    },

    r2: {
      name: 'R squared',
      tier: 'advanced',
      beginner: 'How much of one investment’s movement the other one explains.',
      read: 'It runs from 0 to 1. A high beta with a low R squared is a loose relationship, not a tight one.',
      why: 'It is the check on beta. It tells you how much of the story that line actually accounts for.',
      misconception: 'A low R squared does not mean the two are unrelated. It means most of what moved this asset came from somewhere else.',
      advanced: 'The square of the correlation over the same window.',
      visual: null,
      related: ['beta', 'correlation'],
      explorations: [
        { q: 'See the correlation', stop: 'corr' },
        { q: 'What does beta add?', concept: 'beta' }
      ],
      bands: function (v) {
        if (!isNum(v)) return null;
        if (v < 0.2) return band('LOOSE');
        if (v < 0.5) return band('PARTIAL');
        return band('TIGHT');
      }
    }
  };

  /* Older call sites, and the percent-change figure on the price stops, ask
   * for 'change'. It is the same idea as a return. */
  var ALIASES = { change: 'returns', 'return': 'returns', percentchange: 'returns', marketvalue: 'marketcap' };

  var ORDER = [
    'price', 'returns', 'unusual', 'volatility', 'drawdown', 'correlation', 'causation',
    'index', 'marketcap', 'volume', 'risk', 'diversification', 'beta', 'r2'
  ];

  /* Which concept a stop's headline figure is an instance of. This is what
   * makes LEARN contextual: it explains the number on the screen, not a
   * chapter the reader chose. */
  var BINDINGS = {
    btc: 'returns',
    eth: 'returns',
    nasdaq: 'index',
    spx: 'index',
    probe: 'returns',
    mover: 'returns',
    loser: 'returns',
    watch: 'returns',
    corr: 'correlation',
    vol: 'volatility',
    dd: 'drawdown',
    subject: 'returns',
    investigate: 'returns',
    learn: 'returns',
    off: 'returns'
  };

  function resolve(id) {
    var key = ALIASES[id] || id;
    return CONCEPTS[key] ? key : null;
  }

  function get(id) {
    var key = resolve(id);
    if (!key) return null;
    var c = CONCEPTS[key];
    return {
      id: key,
      name: c.name,
      tier: c.tier,
      beginner: c.beginner,
      read: c.read,
      why: c.why,
      misconception: c.misconception,
      advanced: c.advanced,
      visual: c.visual,
      compare: c.compare || null,
      related: (c.related || []).slice(),
      explorations: (c.explorations || []).slice(),
      banded: !!c.bands
    };
  }

  /* The word for a figure, or null when the concept has no band or the
   * figure is missing. Pure, so the thresholds can be held to account. */
  function bandOf(id, value) {
    var key = resolve(id);
    var c = key ? CONCEPTS[key] : null;
    return c && c.bands ? c.bands(value) : null;
  }

  function bindingFor(stop) {
    return BINDINGS[stop] || null;
  }

  function list() {
    return ORDER.map(get);
  }

  MP.concepts = {
    IDS: ORDER,
    BINDINGS: BINDINGS,
    get: get,
    list: list,
    band: bandOf,
    bindingFor: bindingFor
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
