# Final report

## v1.4.0 - UI/UX pass

Eight quality-of-life tweaks found in a review pass: 1) spike '!' click now
shows a lightweight toast instead of a blocking window.alert; 2) refresh
button spins while a refresh is in flight; 3) the header age counter turns
amber once data is older than 2x the poll interval (provider failing or
machine slept); 4) 'Copy usage summary' added to the dropdown menu (shares
the exact code path with the header button); 5) friendly empty-state hint
when every provider is disabled instead of blank space; 6) hovering a usage
row shows used/remaining/reset detail; 7) restored the 'AI Usage' window
title for taskbar/alt-tab (dropped accidentally in the frameless edit);
8) powerMonitor resume/unlock-screen triggers an immediate refresh so data
is never stale after sleep. Note: an earlier multi-edit batch had silently
dropped two edits (toast + amber age) when a sibling edit failed - now
applied and covered. E2E selftest extended (menuCopyOk, toastPresent).
112/112 tests, lint clean, screenshots regenerated, live instance
swapped to v1.4.0.

## v1.3.2 - copy button double-click race fix

The copy button appeared dead after first use: the tick icon was restored
from a per-click `btnCopy.textContent` capture, so a second click inside
the 1.2s tick window captured the tick itself as the "original" icon and
the button froze on the tick forever (copies still landed, but with no
visible feedback change). Fix: capture the original glyph once at startup,
restore to that constant, and clearTimeout the previous restore timer on
each click. E2E selftest now replays the exact scenario - click, rapid
second click during the tick, then assert the icon restored AND the second
copy landed (copyOk / copyTwiceOk / copyRestored all true). 112/112 tests,
lint clean, live instance swapped to v1.3.2.

## v1.3.1 - hamburger fix + copy-for-agents button

1) Bug: the header hamburger menu did nothing on real clicks - .icon-btn
lacked -webkit-app-region: no-drag, so clicks started a window drag instead
(the E2E selftest's synthetic .click() bypasses hit-testing, which is why
it kept passing). While fixing it, an audit found the v1.1.1 app-quit /
window-hide IPC handlers had never landed in main.js (a failed multi-edit
batch was only partially reapplied), so header close and menu Quit were
silently no-ops - both are now implemented and the handlers registered.
2) New header button (between clock and refresh): copies a compact plain-
text usage summary (per-provider windows, percentages, reset times,
stale/unavailable markers) to the clipboard via an Electron clipboard IPC
channel; the button flashes a checkmark on success. Summary building lives
in the pure, unit-tested src/renderer/summary.js. The E2E selftest now
covers the full roundtrip (click -> clipboard contains the summary);
fixed a template-literal newline escaping bug found by that selftest.
112/112 tests (6 new), lint clean, screenshots regenerated, live instance
swapped to v1.3.1.

## v1.3.0 - more providers + zoom-to-fit

1) Three new API-key providers (off by default, enabled in Settings, keys
stored only in Windows Credential Manager via the generalized per-provider
IPC): OpenRouter (credit budget/prepaid balance via /api/v1/key +
/api/v1/credits), Grok/xAI (key validation against /v1/api-key with
defensive mapping of any credit/usage fields xAI may expose - their usage
API status is undocumented, so the card is honest when nothing is
available), and Gemini/AI Studio (key validation against the free models
metadata endpoint; Google exposes no usage/quota API for these keys, so the
card shows key health + documented free-tier limits). Gemini's key travels
in the x-goog-api-key header, never in a URL. 2+3) Zoom-to-fit: the whole
UI (#app) scales 0.5x-1.8x so every enabled provider stays visible -
enabling six providers squeezes them into 300x216 (~0.6x, no scroll), and
dragging the window larger scales everything up. Measurement uses a fixed
300px basis with auto height to avoid scale feedback loops (found and fixed
via a selftest diagnostic: fitDetail). Window-less providers now render
notes-only cards instead of '—' placeholder rows. Demo mode enables every
provider present in the fixture so screenshots can show any mix.
106/106 tests (18 new: adapter fixtures, scale math, registry, settings),
lint clean, E2E PASS (3-prov zoom 1.00, 6-prov zoom 0.60), screenshots
regenerated (mini-* and mini-six-*), live instance swapped to v1.3.0.

## v1.2.1 - living aura reverted

The v1.2.0 "Living Aura" effects (health-reactive glow, rotating gradient
border, breathing spike badge, fresh-data blink) were removed at the user's
request. Visuals and behavior are identical to v1.1.1 (frameless compact
panel). 88/88 tests, lint clean, E2E PASS, screenshots regenerated, live
instance swapped.

## v1.1.1 - frameless + update counter

User-requested: window is now frameless (native title bar and the default
File/Edit/View menu bar removed). The single header line doubles as the drag
region and carries: hamburger dropdown (Settings, Always on top, Launch at
sign-in, Refresh now, Quit), clock with time-since-update counter (`14:32 ·
3m`, tooltip shows exact update time), refresh button, and hide-to-tray
close button. The footer ("updated 17:25") was removed - its information
moved into the header counter. Settings overlay now sits below the header
so the drag region stays available. Default size 300x232 -> 300x216 outer
(frameless outer == content); v1.1.0's 300x232 saved size migrates. E2E
selftest extended to cover the dropdown path; 88/88 tests, lint clean,
screenshots regenerated.

## v1.1.0 - compact layout

User-requested densification: same information, much less chrome. Window
default 378x378 -> 300x232 (min 250x190); card paddings/gaps roughly
halved; provider header merged into a single 14px line; window rows on a
30px-label grid with 5px bars; settings restructured onto one consistent
row pattern (checkbox clusters, uniform control sizes, Done moved into the
settings header). Existing installs whose saved size equals the legacy
378x378 default migrate to the compact size once; user-chosen sizes are
kept. 88/88 tests (new: legacy-size migration), lint clean, E2E selftest
PASS, screenshots regenerated at 300x232.

## v1.0.2 fixes (settings freeze, Codex spawn, Z.ai credit plans)

**Settings-panel freeze** - `broadcast()` crashed on failing providers (no
`windows` array), suppressing all UI updates and rejecting `settings:patch`,
which wedged the Done button. Fixed via the crash-proof `snapshotView.js`
shaper (with regression tests), a never-rejecting settings IPC, a Done button
that always closes the panel, a first-poll/ready race fix, and coalesced
manual refreshes.

**Codex `spawn EINVAL` on Windows** - `codex` on PATH is an npm `.cmd` shim,
which Node refuses to spawn directly (CVE-2024-27980 hardening). The adapter
now parses the shim to its real target and spawns `node.exe codex.js
app-server` directly (with a `cmd.exe /c` fallback). Verified live: Codex
weekly window polls successfully.

**Z.ai credit plans** - live accounts now return `CREDIT_LIMIT` entries
instead of `TOKENS_LIMIT` (same unit codes; observed via sanitized
descriptor diagnostics, which UsageDeck has not caught up with). The adapter
accepts both; verified live: Z.ai 5h + weekly windows poll successfully.
Sanitized descriptors (type/unit only, no payload values) now explain
unrecognized responses in the card and log.

**Verification:** 87/87 unit tests, lint clean, E2E selftest PASS from source
and packaged exe; live poll confirmed all three providers (Claude 6%/78%,
Codex weekly 30%, Z.ai 79%/15%) and a real spike alert fired (`Zai 5h
increased 3% between 16:39 and 16:42`).

## v1.0.1 hotfix (settings panel freeze)

**Symptom:** clicking "Done" in Settings did not return to the tracker.

**Root cause:** `broadcast()` called `snap.windows.find(...)` on failing
providers, whose snapshots carry **no `windows` array** - a TypeError. In real
use the very first poll already included a failing provider (Z.ai before a
key is stored), so the exception (a) suppressed every snapshot update and
(b) rejected the `settings:patch` IPC, whose rejection left the Done button's
`await` unresolved and the panel stuck. Demo fixtures were all-OK, which is
why the original E2E screenshot/selftest passed.

**Fixes:**

1. Snapshot shaping extracted to pure `src/main/snapshotView.js` that
   tolerates every provider state (error, disabled, stale, missing fields);
   `broadcast()` wraps it with a fallback so it can never take the app down.
2. `settings:patch` never rejects anymore; failures are logged and current
   values returned.
3. Renderer: "Done" always hides the panel (save errors are shown + logged);
   render errors and unhandled rejections are reported to the main log via a
   `renderer-error` IPC channel.
4. Fresh-boot race: if the first poll broadcast happens before the page
   finished loading, the snapshot was lost - `did-finish-load` now re-polls
   immediately when no snapshot exists yet.
5. Scheduler: a manual refresh arriving mid-poll is now coalesced and run
   after the in-flight poll (previously dropped).
6. Demo loader tolerates fixtures without `windows` arrays (mixed ok/error
   fixtures); new `demo-mixed.json` fixture mirrors a real failing session.
7. Per-poll provider failures are now logged (code + message) to main.log.
8. New regression tests (`test/snapshotView.test.js`) cover every provider
   state through the exact production shaping path; E2E `--selftest` extended
   to mixed data and now exercises manual refresh, settings change, and Done.

**Verification:** 82/82 unit tests, lint clean, E2E selftest PASS against both
all-OK and mixed fixtures from source *and* from the packaged v1.0.1 exe.

---

## Foundation chosen

**New Electron implementation**, informed by inspection of all three
upstream projects (cloned to `.upstream/`, excluded from the artifact).

- **UsageDeck** (Tauri/Rust, MIT) was the preferred foundation per
  BUILD_PROMPT.md, but a Tauri Windows build requires the Rust toolchain plus
  MSVC Build Tools. This machine has neither (`cargo`, `cl.exe`, MSVS all
  absent; only .NET *runtimes*, no SDK). Installing a multi-gigabyte toolchain
  autonomously was judged out of proportion for a "small, lightweight" tray
  utility, so the concrete blocker is documented here and in the README, and
  UsageDeck's normalized provider model was followed instead of forked.
- **agent-usage-widget** (Electron, MIT) validated the Electron architecture
  and supplied the proven Codex `app-server` JSON-RPC handshake and the
  Claude OAuth usage-endpoint approach. Its plaintext `.env` key handling was
  deliberately **not** adopted: the Z.ai key goes to Windows Credential
  Manager only.
- **codex-usage-monitor** (Rust, MIT) was consulted as a reference for native
  tray behavior; nothing was copied.

All three licenses are preserved in `THIRD_PARTY_NOTICES.md`.

## Files created

- `package.json`, `eslint.config.js`, `.gitignore`, `LICENSE`,
  `THIRD_PARTY_NOTICES.md`, `README.md`, `FINAL_REPORT.md`
- `src/main/` - `main.js`, `preload.js`, `settings.js`, `scheduler.js`,
  `spikes.js`, `history.js`, `logger.js`, `credentials.js`, `credmgr.ps1`,
  `windowState.js`, `icon.js`, `demo.js`, `format.js`
- `src/main/providers/` - `model.js`, `index.js` (orchestrator), `codex.js`,
  `claude.js`, `zai.js`
- `src/renderer/` - `index.html`, `styles.css`, `renderer.js`
- `test/` - `providers.test.js`, `orchestrator.test.js`, `format.test.js`,
  `spikes.test.js`, `history-settings.test.js`, `infra.test.js`,
  `credentials.test.js`, `lint.test.js`; fixtures: `codex-ratelimits.json`,
  `claude-usage.json`, `zai-quota.json`, `demo-snapshot.json`
- `screenshots/mini-100.png`, `screenshots/mini-150.png` (demo data,
  captured via `webContents.capturePage`, no desktop content exposed)

## Commands run and results

| Command | Result |
|---|---|
| `npm install` | ok (electron 39.8.10, @electron/packager 18.x, eslint 9.x) |
| `node --test test/` | **74/74 pass** (includes an eslint gate test) |
| `npx eslint src test` | clean |
| `npm audit` | 3 high, all in `extract-zip`, a **dev-time-only** transitive dep of electron's installer/packager used to unpack the official Electron binary during install; it does not ship in the app and never runs at runtime. The app has **zero runtime npm dependencies**. No safe fix exists (`npm audit fix --force` installs a broken 0.0.0 placeholder). Accepted and documented. |
| `npm run package` | `dist/ai-usage-tracker-win32-x64/ai-usage-tracker.exe` (327 MB, standard Electron size) |
| Packaged exe smoke test | launched in demo mode, all processes verified running, terminated cleanly |
| `AITRACKER_DEMO=1 npx electron . --screenshot` | both screenshots captured; pixel-variance verified (2,300+ distinct colors, correct 378x378 base size) |

## Test coverage summary

- Response normalization for representative Codex (`rateLimitsByLimitId`,
  primary/secondary, epoch-second resets), Claude (`five_hour`, `seven_day`,
  `weekly_scoped` model limits), Z.ai (unit codes 3/4/5/6, session vs weekly,
  `TIME_LIMIT` web searches, no-plan envelope)
- Missing and additional quota windows (daily/monthly -> `other`, never
  guessed), malformed payloads, provider timeouts, non-retryable vs
  retryable error codes, one provider failing while others continue
- Reset countdown magnitudes; 12/24-hour clocks; DST spring-forward and
  fall-back rendering in `America/New_York` (repeated hour disambiguated by
  zone abbreviation)
- Percentage clamping and unknown (`null`) handling
- Spike detection: normal growth, absolute spike, just-under-threshold,
  delta normalization across double-interval gaps, relative spike with 24h
  median baseline, minimum-delta gate, usage-drop reset, resetsAt-change
  reset, long gap (> 3 intervals), stale/error recovery, zero/flat history,
  first sample, alert duration expiry, alert description text
- History stores only normalized fields (asserted); 48h prune; caps
- Settings: defaults, 1-minute interval floor, secret-shaped key refusal,
  secret-free persistence round-trip
- Redaction: bearer/basic, OpenAI-style keys, Z.ai key format, credential
  JSON fields, long blobs, `C:\Users\<name>` paths, logger file output
- Credential Manager bridge: secret travels via stdin only (asserted never
  in argv), base64 stdout decode, NOT_FOUND, error paths - all via a fake
  runner so the real store is never touched by tests
- Window state: defaults, clamping to work area, off-screen recovery,
  minimum sizes; scheduler: debounce, jittered cadence, stop cancellation,
  re-entrancy guard

## Artifact

`dist\ai-usage-tracker-win32-x64\ai-usage-tracker.exe` - runnable Windows
x64 folder build (no installer). Launch it directly; see README for details.

## Security posture

- Zero runtime npm dependencies; no analytics/telemetry/backend/update
  checks; no local listener; sandboxed renderer with context isolation and
  strict CSP; secrets only in Windows Credential Manager with confirmations;
  settings refuse secret-shaped keys; all logs redacted; no inference
  requests anywhere (Codex metadata RPC, Claude usage endpoint, Z.ai quota
  endpoint).

## Known limitations / unverified without credentials

Per BUILD_PROMPT.md, real credential files were **not** inspected and no
real API key operations were performed without user confirmation. The
following therefore remain verified only against upstream open-source
clients and synthetic fixtures:

1. **Codex**: live `account/rateLimits/read` response shape for the
   installed CLI version (schema taken from agent-usage-widget's current
   implementation; interface could change with CLI updates).
2. **Claude**: live `api.anthropic.com/api/oauth/usage` payload for this
   account (schema mirrored from agent-usage-widget/UsageDeck; token
   freshness rides on Claude Code keeping `~/.claude/.credentials.json`
   current - we never refresh it ourselves).
3. **Z.ai**: live quota response and whether the account's plan/region needs
   a different base URL than `https://api.z.ai` (configurable in Settings).
4. Real Windows Credential Manager round-trip: the PS bridge is unit-tested
   with a fake runner; the live P/Invoke path is exercised only when a user
   stores a key (with confirmation) in the running app.
5. The `!` spike badge was tested with deterministic fixtures; live-provider
   timing behavior may reveal tuning opportunities for the defaults.
