# Student-testing release

Testing version: **student-b2536a966587**. This identifier also appears in About the project and on the workshop worksheet. Record it with the session date; market snapshots can update independently.

## Implementation verification

- Build checks and 37 Node tests passed: period accuracy, chart edge cases, lesson validation, failures, cancellation, saved progress, portfolio and PROBE behavior.
- Fresh entry and saved-session reopening keep the task hidden until an explicit start/resume. Focused tests verify preserved observations, library access without activating a lesson, and exit without deleting progress. Explore actions and keyboard Escape/focus return were checked in the browser.
- Existing browser suite: 490 checks passed. Layout regression checks cover inactive, loading, active, completed, resumed, and long-task states while scrolled to the top and bottom (102 checks per tested layout passed).
- Manual browser checks: fresh entry, starter selection, keyboard navigation, About-to-activity link, library without reset, both comparison ranges, company changes, completion, returning activity, and persisted sound preference.
- Clean opening view, explicit lesson resume, Explore centered above OFF, persistent utility footer, complete-meter viewport fitting, and refreshed README screenshots verified at desktop and laptop sizes. Desktop, 360px and 390px layouts inspected. Narrow-layout reflow equivalent to 200% desktop zoom checked; native browser zoom was not available through the preview controls.
- Phone chart axis text measured at 14px; no document horizontal overflow. Workshop links and print rules inspected. A physical printed copy has not been checked.

- Full instrument bounds and Explore alignment checked at 1280×600, 1280×720, 1366×768, 360×800, and 390×844. The keys, dial, status and outer meter border clear the utility footer on entry.

## Student evidence still needed

Use the workshop reflection and understanding checks. Record independent explanations separately from coached answers, where help was needed, confusing controls, and whether the live activity loaded. Student testing and observed learning outcomes are still pending.
