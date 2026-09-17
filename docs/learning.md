# Learn by doing

For a first activity, open Multimeter and choose **Start experiment**. Returning learners can choose **Lessons → Price versus return** to resume.

Teaching a group? Use the [15-minute workshop guide and printable worksheet](workshop.html). It includes preparation, timed activities, discussion prompts, facilitator answers, and a place to record actual student observations.

Turn to **WATCH**, choose **Explore → Explore charts**, and open **Practice portfolio**. Add 1–5 supported US stocks, set positive starting weights totaling 100%, and run the simulation. **Use equal weights** divides the allocation for you. Choose 1 month, 3 months, or 1 year to inspect another period.

The model invests a hypothetical $10,000 at the first shared closing date, including fractional shares, and holds those quantities throughout the displayed period. It reports ending value, price return, annualized volatility and maximum drawdown. The actual date range and each holding’s latest available close appear with the result. Short histories and missing dates are identified. If any holding has no usable prices, the simulation stops instead of omitting it. Daily volatility is unavailable when the holdings have mismatched trading dates.

This is a price-history exercise, not a record of real holdings. There are no deposits, fees, taxes, dividend reinvestments, trades or rebalancing. Historical results do not predict future returns. Allocations stay in this browser; a message appears if saving is unavailable.

## Guided lessons

Choose **Lessons** in the Explore menu above the dial to open the activity library without changing your selected asset or resetting your active lesson. **Explain this** opens the concept behind your current measurement; **PROBE** answers questions about the available figures.

- **Price versus return:** Start experiment selects Apple, Microsoft, or NVIDIA with at least 253 available closing prices; you can change the company. Compare its 1-month and 1-year chart ranges, then answer what measures performance over a period.
- **Volatility versus drawdown:** inspect VOL and DD for the same stock, then distinguish variability from a decline below a peak.
- **Build a mix:** simulate two stocks, change their weights while keeping assets and dates fixed, then compare the historical measurements.

Each lesson has three steps and a question with explanatory feedback. The full guide remains in the drawer. The current task stays in the strip above the meter after you start or resume. **Show instrument above** takes you back to the screen. **Back to task** returns to the lesson. **Choose an asset** opens and focuses search; **Explore charts** opens the current reading’s details. **Exit lesson** keeps your progress; **Resume** continues it. **Restart lesson** clears that lesson’s progress. Lesson companies do not take up watch-list slots. A failed load offers **Retry**, **Choose another company**, and **Use an available example**. Your selection and observations remain unchanged until replacement history passes validation; choosing a different company then restarts only that lesson’s company-dependent steps. Volatility examples require usable shared history with Nasdaq or S&P 500. If no example is available, the lesson waits for retry instead of inventing data.

PROBE offers questions supported by the loaded measurements. Its explanations run locally.

Progress is saved locally and does not require an account or an AI service.

## Student testing tasks

1. Build a valid portfolio and reopen it after refreshing the page.
2. Complete the three lessons without help.
3. Explain price return, volatility and drawdown in your own words.
4. Use FEEDBACK to describe the first step that felt confusing.

## Developer verification

Run `node test/portfolio.test.cjs`, `node test/lessons.test.cjs` and `node test/probe.test.cjs`, then `./build.ps1 -ReleaseOnly`. Browser checks should cover a complete two-stock simulation, all chart ranges, missing prices, a full WATCH list, storage failure, lesson exit/resume/restart, the completed-lesson list, wrong answers, keyboard use and a narrow phone viewport.
