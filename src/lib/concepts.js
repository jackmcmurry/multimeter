/* ============================================================================
 * concepts.js: the short explanations behind the figures.
 *
 * One entry per idea the meter puts on screen. Each says what the idea is in
 * a sentence, then how this page measures it, so a student reads the
 * definition next to the number it describes rather than in a textbook.
 * Pure data and one lookup: the panels decide where to show it.
 * ========================================================================== */
(function (root) {
  'use strict';
  var MP = (root.MP = root.MP || {});

  var CONCEPTS = {
    volatility: {
      term: 'Volatility',
      what: 'How much an asset’s daily returns move around. Higher volatility means larger and less predictable swings, in both directions.',
      here: 'Measured over the last 30 sessions as the standard deviation of daily log returns, then annualized by the square root of 252.'
    },
    correlation: {
      term: 'Correlation',
      what: 'Whether two assets tend to move together. It runs from +1, moving in step, through 0, no relationship, to -1, moving opposite.',
      here: 'Computed on daily log returns over sessions both assets actually traded, so a weekend gap counts the same for each.'
    },
    beta: {
      term: 'Beta',
      what: 'How far one asset tends to move when another moves by one percent. A beta of 1.5 means it has historically moved about half again as much.',
      here: 'The slope of the line through the return scatter, with the index on the horizontal axis.'
    },
    r2: {
      term: 'R squared',
      what: 'The share of one asset’s movement that the other explains. A high beta with a low R squared is a loose relationship, not a tight one.',
      here: 'The square of the correlation over the same window.'
    },
    drawdown: {
      term: 'Drawdown',
      what: 'How far an asset sits below its own highest point so far. It answers what a buyer at the peak would still be down.',
      here: 'Measured on each asset’s own daily closes, against its running peak.'
    },
    change: {
      term: 'Percent change',
      what: 'The move from one price to another, as a share of where it started. It is what makes moves in a 300 dollar stock and a 70,000 dollar coin comparable.',
      here: 'Taken between the two prices named on the screen, over the period shown beside them.'
    },
    unusual: {
      term: 'How unusual a move is',
      what: 'A move only means something next to the asset’s own habits. The same one percent is ordinary for one asset and rare for another.',
      here: 'This session’s return is compared with the last 252 daily returns: how many standard deviations out it sits, and what share of recent days it beats.'
    },
    marketcap: {
      term: 'Market capitalisation',
      what: 'The total value of what is outstanding: price times the number of units in circulation. It says how large a thing is, not how good.',
      here: 'Reported by CoinGecko for coins and by the quote for stocks.'
    },
    returns: {
      term: 'Returns',
      what: 'The change from one close to the next, which is what statistics are computed on rather than the prices themselves.',
      here: 'Log returns throughout, so that gains and losses add up symmetrically over time.'
    }
  };

  var ORDER = ['change', 'unusual', 'volatility', 'correlation', 'beta', 'r2', 'drawdown', 'returns', 'marketcap'];

  function get(id) {
    return CONCEPTS[id] ? Object.assign({ id: id }, CONCEPTS[id]) : null;
  }

  function list() {
    return ORDER.map(get);
  }

  MP.concepts = { get: get, list: list, IDS: ORDER };
})(typeof globalThis !== 'undefined' ? globalThis : this);
