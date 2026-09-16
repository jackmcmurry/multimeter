# Student-testing release

Testing version: **student-c21af0194798**. This identifier also appears in About the project and on the workshop worksheet. Record it with the session date; market snapshots can update independently.

## Implementation verification

- Build checks and 37 Node tests passed: period accuracy, chart edge cases, lesson validation, failures, cancellation, saved progress, portfolio and PROBE behavior.
- Fresh entry and saved-session reopening keep the task hidden until an explicit start/resume. Focused tests verify preserved observations, library access without activating a lesson, and exit without deleting progress. Explore actions and keyboard Escape/focus return were checked in the browser.
- Existing browser suite: 490 checks passed. Layout regression checks cover inactive, loading, active, completed, resumed, and long-task states while scrolled to the top and bottom (112 desktop checks; phone and narrow-layout checks passed).
- Manual browser checks: fresh entry, starter selection, keyboard navigation, About-to-activity link, library without reset, both comparison ranges, company changes, completion, returning activity, and persisted sound preference.
- Clean opening view, explicit lesson resume, compact Explore menu, persistent utility footer, readable meter sizing, and refreshed README screenshots verified at desktop and laptop sizes. Desktop, 360px and 390px layouts inspected. Narrow-layout reflow equivalent to 200% desktop zoom checked; native browser zoom was not available through the preview controls.
- Phone chart axis text measured at 14px; no document horizontal overflow. Workshop links and print rules inspected. A physical printed copy has not been checked.

## Student evidence still needed

Use the workshop reflection and understanding checks. Record independent explanations separately from coached answers, where help was needed, confusing controls, and whether the live activity loaded. Student testing and observed learning outcomes are still pending.
