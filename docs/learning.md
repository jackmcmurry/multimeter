# Learn by doing

Open **WATCH**, then **INFO**, and choose **Practice portfolio**. Add 1–5 supported US stocks, set positive starting weights totaling 100%, and run the simulation. **Use equal weights** divides the allocation for you. Choose 1 month, 3 months, or 1 year to inspect another period.

The model invests a hypothetical $10,000 at the first shared closing date, including fractional shares, and holds those quantities throughout the displayed period. It reports ending value, price return, annualized volatility and maximum drawdown. The actual date range and each holding’s latest available close appear with the result. Short histories and missing dates are identified. If any holding has no usable prices, the simulation stops instead of omitting it. Daily volatility is unavailable when the holdings have mismatched trading dates.

This is a price-history exercise, not a record of real holdings. There are no deposits, fees, taxes, dividend reinvestments, trades or rebalancing. Historical results do not predict future returns. Allocations stay in this browser; a message appears if saving is unavailable.

## Guided lessons

Choose **Start learning** in the welcome screen or in the learning bar. The bar sits above the instrument in desktop browsers and below it on phones and in the installed app. Returning students can choose **Continue learning**; after all three lessons are complete, **Review lessons** opens the lesson list. You can also open **LEARN → INFO → Guided lessons**. The existing explanation of your selected measurement stays available.

- **Price versus return:** choose a stock, compare its 1-month and 1-year chart ranges, then answer what measures performance over a period.
- **Volatility versus drawdown:** inspect VOL and DD for the same stock, then distinguish variability from a decline below a peak.
- **Build a mix:** simulate two stocks, change their weights while keeping assets and dates fixed, then compare the historical measurements.

Each lesson has three steps and a question with explanatory feedback. A bar at the bottom of the screen keeps the current step visible; **Show task** returns to the full instructions. **Show instrument above** takes you back to the screen. **Exit lesson** keeps your progress; **Resume** continues it. **Restart lesson** clears that lesson’s progress. Progress is saved locally and does not require an account or an AI service.

PROBE offers questions supported by the loaded measurements, plus an explanation of why correlation does not establish cause. Unsupported custom questions offer supported alternatives. These explanations run locally.

## Student testing tasks

1. Build a valid portfolio and reopen it after refreshing the page.
2. Complete the three lessons without help.
3. Explain price return, volatility and drawdown in your own words.
4. Use FEEDBACK to describe the first step that felt confusing.

## Developer verification

Run `node test/portfolio.test.cjs`, `node test/lessons.test.cjs` and `node test/probe.test.cjs`, then `./build.ps1 -ReleaseOnly`. Browser checks should cover a complete two-stock simulation, all chart ranges, missing prices, a full WATCH list, storage failure, lesson exit/resume/restart, the completed-lesson list, wrong answers, keyboard use and a narrow phone viewport.
