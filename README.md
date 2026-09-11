# Multimeter

A live bitcoin-vs-Nasdaq tracker with the statistics that make the comparison
mean something: correlation and beta across three windows, rolling realized
volatility for both legs, and a drawdown table with recovery times, plus a
Stock of the Week that a weekly job rewrites.

**Live:** https://jackmcmurry.github.io/multimeter/

Built by Jack McMurry with Claude Code.

## What's on it

The page is one handheld multimeter. The rotary dial picks a function, the
screen shows that one reading — a tall chart, the price beneath it, the
change and, for the coins, range tabs — and the DATA key (or a press
on the screen) opens a drawer beneath the meter with the charts and tables
behind the number. HOLD freezes the display. The COM jack lights while the
US market is open.

| Dial | Screen reads | Drawer holds |
|---|---|---|
| OFF | blank | Method, sources, and the not-advice line |
| BTC | spot price in USD, change over the chosen range | the range chart in the printed style |
| ETH | spot price in USD, change over the chosen range | BTC, ETH, ^IXIC, ^GSPC (and QQQ with a key) as rows |
| NASDAQ | ^IXIC level, day change | the same rows |
| S&P | ^GSPC level, day change | the same rows |
| STOCK | the stock of the week, day change | the pick in full: price, closes, 5d / 1m / market cap, runner-up |
| CRYPTO | the crypto of the week, change over the chosen range | the pick in full: price, 7-day sparkline, 7d / 24h / market cap |
| PROBE | a coin of your choosing, change over the chosen range | coin search (CoinGecko), the pick, its range chart |
| CORR | coin–index 90-session correlation, 30-session change | pair selector, return scatter, rolling correlation, coupling table with beta and R² |
| VOL | the coin's 30-session realized vol, annualized | pair selector, current vols and the rolling column chart |
| DD | the coin's distance below its running peak | pair selector, underwater curves and the episode table |

The statistics measure one coin against one index. The pair defaults to
bitcoin and the Nasdaq Composite; the selector at the top of those panels
offers BTC, ETH, the crypto of the week and the probe coin against the Nasdaq
or the S&P 500 (stored as `mm.stats`). Bitcoin's daily closes come from the
data job; any other coin's come from its one-year CoinGecko chart, which the
1Y range tab shares. CoinGecko stamps each daily point at 00:00 UTC, which is
the close of the day before, so the page dates them that way to line up with
FMP's bars. The probe coin itself is stored as `mm.probe`.

The keys under the screen are the ones a real meter has. **REL** zeroes the
reading where it stands, so the change line shows the move since the press.
**MIN/MAX** captures the lowest and highest reading while it is on. **ALERT**
sets a level on the current stop; when the reading crosses it the meter beeps
three times, flashes, buzzes a phone and posts a notification if allowed, and
the bell on the screen lists armed and fired alerts. Alerts are kept in this
browser (`localStorage`, key `mm.alerts`) and evaluated only while the page
is open. **HOLD** freezes the display; MIN/MAX keeps capturing underneath.

Routing is hash-based (`#corr`), so a stop is linkable and the back button
turns the dial. The old section hashes (`#home`, `#markets`, `#weekly`,
`#coupling`, `#beta`, `#volatility`, `#drawdown`, `#about`) and the tickers
`#ixic`, `#gspc`, `#qqq` still resolve.

The knob turns by dragging, by tapping a label, by tapping the knob itself
(one stop clockwise), by rolling the wheel over it, or with the arrow keys once it has focus. While dragging it follows the pointer and clicks at each detent.

## Install and share

The page is installable. On a phone, "Add to Home Screen" (or the install
prompt on Android Chrome) puts the yellow icon on the home screen and opens
the meter standalone. A small service worker (`docs/sw.js`, generated from
`src/sw.template.js`) precaches the shell and serves the page and the
`data/*.json` snapshots network-first with a cache fallback, so the meter
opens offline with the last figures it saw. It never touches CoinGecko,
Coinbase or the fonts. The cache name carries the build hash that
`build.ps1` prints, so a new build replaces the old cache on the next load.
Icons are rendered by `tools/icons.ps1` (System.Drawing) into `docs/icons`
and committed; rerun it only when the art changes.

**SHARE**, in the drawer's header, draws the screen's reading — mode, chart,
price and change — as a 1200×630 picture and hands it to the system share
sheet where there is one, otherwise copies it to the clipboard, otherwise
downloads it.

## How it gets data

The page is static: one HTML file on GitHub Pages. Numbers reach it two ways.

**Crypto, live, from your browser.** CoinGecko's public API needs no key and
allows cross-origin requests, so the page polls it directly every 45 seconds
for bitcoin, ether and the crypto of the week in one call, and fetches the
BTC chart per range.

**Ticks, from Coinbase.** Coinbase Exchange's public WebSocket feed streams
BTC-USD, ETH-USD and, when Coinbase lists it, the week's crypto pick. While a
tick is under a minute old the screen shows LIVE and paints Coinbase's last
trade; when the feed is quiet or blocked the polled CoinGecko price takes
over. The two sources differ by a few dollars, which is why the price can
step when the lamp goes out. One subscription per product, so a coin Coinbase
does not carry fails alone. The drawer's rows always follow the poll.

**Everything else, from snapshot files.** Financial Modeling Prep and Alpha
Vantage require API keys, and a key in a public page is a leaked key. So a
scheduled GitHub Action (`.github/workflows/site.yml`) runs
`scripts/update-data.js` with the keys held as repository secrets, writes plain
JSON to `docs/data/`, commits it, and redeploys the site. The page reads those
files once a minute.

| Snapshot | Holds | Refreshed |
|---|---|---|
| `quotes.json` | ^IXIC, ^GSPC and the spotlight name (FMP), QQQ (Alpha Vantage) | every 15 min while the market is open, then once after the close |
| `history.json` | ^IXIC, ^GSPC and BTCUSD daily closes (FMP), QQQ daily closes (Alpha Vantage) | once per session, an hour after the close |
| `spotlight.json` | the stock of the week with its daily closes and multi-horizon change; the crypto of the week (CoinGecko scan) | Monday scans; stock detail once per session |

Each run of the job works out for itself what is due (`src/lib/pipeline.js`),
so a late or skipped cron tick heals on the next one. On the free plans it
uses about 90 of FMP's 250 daily calls, 10 of Alpha Vantage's 25, and one
keyless CoinGecko call a week.

The market-open dot is computed in the browser from NYSE hours and a holiday
table (`src/lib/session.js`), with no API call.

### Plan limits worth knowing

- **QQQ** is not available on FMP's free plan (`ACCESS DENIED`), which is why
  it comes from Alpha Vantage. Alpha Vantage is optional: without its key the
  QQQ row and the "vs QQQ" coupling rows simply don't appear.
- **^NDX** needs a paid FMP plan; QQQ stands in for it, and the page says so.
- **AVGO** is denied on FMP's free plan. The weekly scan counts it as skipped
  and never lets a denial win.

## Setup

1. **Secrets.** In the repository: Settings â†’ Secrets and variables â†’ Actions â†’
   New repository secret.
   - `FMP_API_KEY`: required. Free at financialmodelingprep.com.
   - `ALPHAVANTAGE_API_KEY`: optional, for QQQ. Free at alphavantage.co.
2. **Pages.** Settings â†’ Pages â†’ Build and deployment â†’ Source: **GitHub
   Actions**.
3. **First run.** Actions â†’ Site â†’ Run workflow (force: `all`). That fills
   every snapshot and deploys. After that the schedule takes over.

A run whose data step fails still deploys the site; the failure shows as a
warning or error in the run summary. Keys never appear in logs: every URL is
passed through `MP.pipeline.redact` before it is printed.

## Local development

There is no Node on the development machine, so the build is PowerShell and the
tests run in a browser.

```powershell
.\build.ps1                          # docs/index.html + dist/multimeter.debug.html
.\tools\serve.ps1                    # serves dist/ at http://127.0.0.1:8787/
```

Then, in the debug page's console:

```js
MP.test.run()                        // statistics, spotlight rule, router
MP.dataTest.run()                    // session clock and every payload normalizer
await MP.dataTest.runPipeline()      // the data job against canned payloads
MP.app.stop(); MP.debug.renderSynthetic(7, 365)  // seeded walk through the real render path
var stop = MP.debug.cycle(1200); stop()          // tour every dial stop, then halt the tour
```

The pipeline suite replays a full Monday: pre-market first run, quiet runs,
the hourly QQQ throttle, the final read after the close, the history grace, a
late daily bar, a missing key, FMP down, and an Alpha Vantage rate limit.

The build refuses to ship if an inject marker survives, if debug or data-job
code leaks into the published page, if the page contains an `apikey=`
parameter, or if any `var(--token)` does not resolve against `styles.css`.

## Repository layout

```
.github/workflows/site.yml   schedule + deploy
scripts/update-data.js       data job entry point (Node 20, I/O only)
src/
  index.template.html        page shell with two @inject markers
  styles.css                 the meter body, display, dial and drawer; single theme, Space Grotesk + JetBrains Mono via Google Fonts
  lib/
    stats.js                 statistics (pure)
    format.js                display formatting
    geom.js                  SVG chart kit
    sources.js               endpoints + payload normalizers
    session.js               NYSE session clock
    store.js                 guarded localStorage (alerts, probe, statistics pair)
    router.js                hash routing between dial stops
    funcs.js                 REL and MIN/MAX
    alerts.js                alert levels and their evaluation
    meter.js                 the dial, the knob, the keys, and the screen paint
    live.js                  Coinbase WebSocket ticks
    share.js                 the share card
    spotlight.js             stock- and crypto-of-the-week rules and panels
    app.js                   state, polling, analytics, render
    pipeline.js              the data job's decisions (debug bundle + Node)
    debug.js                 synthetic-data render (debug bundle only)
test/
  stats.test.js
  data.test.js
tools/serve.ps1              loopback server for local checks
tools/icons.ps1              renders docs/icons/*.png from the icon art
docs/                        what GitHub Pages serves
  index.html                 built page (commit after .\build.ps1)
  sw.js                      service worker, stamped by the build
  manifest.webmanifest       web app manifest (copied from src/)
  icons/                     app icons
  data/*.json                snapshots (written by the Action)
```

## Method

- **Pairing.** Correlation and beta intersect the two series on dates each
  instrument actually traded *before* taking returns. Bitcoin trades weekends
  and the index does not, so without this step BTC's Monday return spans one
  day while the index's spans three.
- **Returns.** Log returns throughout: `r = ln(p_t / p_{t-1})`.
- **Beta.** `cov(btc, ixic) / var(ixic)`, BTC regressed on the index. It is
  the slope drawn through the return scatter, so chart and table agree.
- **Volatility.** Sample standard deviation of the 30-session window,
  annualized by âˆš252.
- **Drawdown.** Computed on each instrument's own history. An episode opens
  when price falls below the running peak and closes when it regains it.
- **RÂ² alongside beta.** A high beta with a low RÂ² is a loose relationship.

## Maintenance

- **Holidays.** `src/lib/session.js` lists NYSE holidays through 2027. Add the
  next year's each December, then rebuild.
- **Code changes.** Edit `src/`, run `.\build.ps1`, commit `docs/index.html`
  with the source. Pushing to `main` redeploys.

## Not financial advice

Market data for reference only. Nothing produced by this project is investment
advice, a recommendation, or a solicitation to trade. Figures are as reported by
the upstream sources and may be delayed, revised, or wrong.
