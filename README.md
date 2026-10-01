# AI Usage Tracker

A quiet Windows notification-area monitor for the **included quota usage** of
OpenAI Codex, Claude Code, and Z.ai (GLM Coding Plan).

The headline numbers are **quota usage percentages**, not raw token counts:
Codex and Claude subscription allowances are weighted by model, context,
caching, reasoning, and tools, so raw tokens never map cleanly to a plan
percentage. Z.ai exposes token-oriented Coding Plan quotas; every provider is
normalized into clearly labelled windows (`5 hr` session, `Week`) without
claiming the percentages are directly comparable across providers.

```text
┌──────────────────────────────┐
│ AI USAGE                14:32│
│ CODEX                        │
│ 5 hr   ██████░░  72%     2h │
│ Week   ███░░░░░  34%     4d │
│ CLAUDE                    !  │
│ 5 hr   ████████  91%    38m │
│ Week   █████░░░  58%     2d │
│ Z.AI                         │
│ 5 hr   ██░░░░░░  24%     3h │
│ Week   █░░░░░░░  12%     5d │
└──────────────────────────────┘
```

Screenshots of the final UI (synthetic demo data) are in `screenshots/`
(`mini-100.png` at 100% scaling, `mini-150.png` at 150% scaling).

## Why a new implementation (not a UsageDeck fork)

`BUILD_PROMPT.md` names UsageDeck (Tauri/Rust, MIT) as the default
foundation. Inspection confirmed it is excellent, but this machine has no
Rust toolchain and no MSVC Build Tools, which a Tauri Windows build requires
(rustup + VS Build Tools is a multi-gigabyte install). Node.js 20 was
available, so the app is a fresh Electron implementation whose **provider
interface and normalization follow UsageDeck's model** and whose **Codex
app-server handshake follows agent-usage-widget's** proven approach. Both are
MIT-licensed and credited in `THIRD_PARTY_NOTICES.md`.

## Installation

Two ways to run:

**Packaged build (recommended)**

```text
dist\ai-usage-tracker-win32-x64\ai-usage-tracker.exe
```

(v1.0.2 - includes the settings-panel freeze fix, Windows Codex-CLI spawn
fix, and Z.ai credit-plan support; see FINAL_REPORT.md)

Double-click the exe. No installer, no admin rights, nothing is registered
anywhere. To "uninstall", delete the folder. (Requires the WebView2/Edge
runtime present on current Windows 10/11 - see Troubleshooting.)

**From source**

```bash
npm install
npm start          # runs from source
```

First launch shows the compact frameless 300x216 window (no title/menu
bars; the header line doubles as the drag region with a dropdown menu,
refresh, and hide buttons, plus a clock with a time-since-update counter).
It is resizable and remembers position and size; clicking the tray icon
shows/hides it; the tray menu and the header dropdown both offer Refresh,
Always-on-top, Launch-at-login, Settings, and Quit.

**Zoom-to-fit:** the whole UI scales so every enabled provider stays
visible. Enabling more providers squeezes them into the window; dragging
the window larger scales everything up (0.5x - 1.8x).

**Copy for agents:** the header button (between the clock and
refresh) copies a compact plain-text usage summary to the clipboard -
per-provider windows, percentages, reset times, and peak/off-peak state
where a provider has one - ready to paste into an agent prompt for routing
decisions.

Successful readings for every provider and profile are saved locally and restored
as stale after restarting. Copied summaries include reading age, local Claude
capture, paused accounts, and rate-limit retry times. The selected Claude account's
capture file is watched, so normal Claude Code usage updates its card within about
a second without refreshing other providers. Account switching reads only local data.
Provider endpoint settings stay isolated; poll timeouts cancel the underlying
HTTP request or CLI process before retrying.

**Peak/off-peak:** providers with a published peak schedule show a badge
on their card. Currently Z.ai (GLM Coding Plan): peak hours are Mon-Fri
14:00-18:00 Beijing time (UTC+8) and off-peak calls cost 50% of the base
credit cost; the badge shows which mode is active and when it flips. The
Claude usage API does not expose peak state, so no badge is shown there
rather than guessing.

## What each provider needs

Included-quota agents (auto-discovered, no key needed):

- **Codex** (OpenAI) - weekly usage via the Codex CLI app-server
- **Claude** (Anthropic) - 5-hour + weekly limits captured from Claude Code's status line
- **Z.ai** (GLM Coding Plan) - session + weekly quota from a key you store
  (key lives only in Windows Credential Manager)

API-key providers (off by default; enable + store a key in Settings):

- **OpenRouter** - credit budget (or prepaid balance) from `api/v1/key` +
  `api/v1/credits`; metadata-only calls
- **Grok (xAI)** - validates the key against `api.x.ai/v1/api-key` and maps
  credit/usage fields if your account exposes them (xAI publishes no usage
  API; the card says so honestly when nothing is available)
- **Gemini (Google AI Studio)** - validates the key against the free
  `models` metadata endpoint and shows documented free-tier limits
  (Google exposes no usage/quota API for these keys)

All monitoring is metadata-only; the app never sends inference requests.

| Provider | Requirement | How it is read |
|---|---|---|
| Codex | Codex CLI installed and signed in (`codex` on PATH) | Spawns `codex app-server` and calls the metadata-only `account/rateLimits/read` method. The CLI handles its own credentials; we never read or write the Codex auth file. |
| Claude | Claude Code v2.1.251+ and Node.js on PATH | Reads a local cache written from Claude Code's documented status-line JSON. No credential reads, usage-endpoint requests, or model calls. Enable local capture in Settings for each profile. |
| Z.ai | GLM Coding Plan API key | You add the key in Settings; it is stored in **Windows Credential Manager** only. Polled via `GET https://api.z.ai/api/monitor/usage/quota/limit` (base URL configurable). |

Additional **Codex CLI** or **Claude Code** accounts can be added in **Settings → [provider] profiles → Add profile…**. Select a signed-in Codex home folder or Claude Code config folder (such as `.claude-work`). Each profile gets its own card and history. The normal provider checkbox controls all profiles of that provider. The front-page **Watching** selector chooses which Claude account's local usage is displayed actively; other cards retain their last reading and its age. Folder paths are stored in local settings; Codex authentication stays managed by the Codex CLI.

For Claude, click **Enable local capture** (or **Enable capture** for an additional profile). The installer wraps the current status-line command and preserves its output and options. The previous status-line setting is saved in `<config folder>/ai-usage-tracker/original-statusline.json`; restore that field in Claude's `settings.json` to undo setup. The collector needs `node` on PATH and writes only usage percentages, reset times, and observation times to `ai-usage-tracker/usage.json`. It never saves the full status-line payload. Usage fields may be absent until Claude Code receives its first response, or for some accounts/sessions. Missing fields retain previous readings; readings older than 15 minutes are marked stale and expired windows are excluded. The tracker reads these files on its normal refresh interval, including manual refresh.

Missing window? The card shows `—` with a tooltip explaining that the
provider does not expose that window. Signed out / no key / no plan states
are reported as text, never as invented numbers. API-key-style Codex plans
and usage-based Claude billing produce explicit notes.

## Features

- Three provider cards: session (5-hour) and weekly quota windows, percentage,
  progress bar, and reset countdown; tooltips show the exact reset clock time.
- Spike detection: `!` beside a provider when usage rises >= 8 points in one
  polling interval, or >= 3 points at more than 4x the window's 24-hour median
  rate (all configurable). Resets, provider recovery, long gaps, and first
  samples never trigger. The `!` explains itself on hover/click, e.g.
  `Claude 5h increased 11% between 14:25 and 14:30`, and clears after 30 min
  (configurable).
- Manual refresh (debounced) + background polling every 5 minutes (min 1) with
  modest jitter, per-provider timeouts and a single bounded retry. HTTP 429
  responses pause that provider for 15, 30, 60, then up to 120 minutes;
  manual refresh respects the pause.
- Failed providers keep their last good values, visibly marked
  `stale · 12m old`; one provider failing never blanks the others.
- Settings: enable/disable providers, interval, used-vs-remaining percent,
  always-on-top, launch at Windows sign-in (off by default - the app never
  adds startup entries silently), light/dark/system theme, 12/24-hour clocks,
  spike thresholds, Z.ai key management, window remembers position and size.
- Single-instance: a second launch just reveals the running window.

## Privacy & security

- **No telemetry, no analytics, no backend, no update checks.** The app talks
  only to enabled providers' metadata endpoints. Claude monitoring uses local files.
- The Z.ai key lives exclusively in Windows Credential Manager; storing,
  testing, or removing it always asks for confirmation first. It is never
  written to settings files, logs, source, or a `.env`.
- Claude credentials are never read or written. Codex credentials are never
  touched at all - the CLI handles its own auth.
- Local history stores only normalized percentages, reset timestamps, provider
  state, and sample times - no prompts, responses, paths, or raw payloads.
- All diagnostics pass a redaction filter (bearer tokens, API keys, credential
  fields, long blobs, user profile paths). Logs live under
  `%APPDATA%\ai-usage-tracker\logs\`.
- No network listener is opened. The renderer is sandboxed with context
  isolation, no node integration, and a strict CSP.
- No paid model inference request is ever made for monitoring.

## Architecture

```text
src/main/
  main.js            Electron lifecycle: tray, window, IPC, screenshots
  preload.js         context-bridged renderer API (tiny surface)
  providers/
    model.js         normalized window model (session/weekly/other) + clamps
    codex.js         Codex CLI app-server JSON-RPC adapter
    claude.js        Claude Code local status-line usage adapter
    zai.js           Z.ai Coding Plan quota adapter
    index.js         orchestrator: isolated polls, timeout, 1 retry,
                     cache merge with stale marking
  settings.js        secret-free JSON settings (rejects secret-shaped keys)
  credentials.js     Windows Credential Manager bridge (stdin/stdout only)
  credmgr.ps1        P/Invoke CredRead/CredWrite/CredDelete helper
  scheduler.js       jittered interval loop, debounced manual refresh,
                     generation-based cancellation
  spikes.js          spike rules (absolute + relative), alert bookkeeping
  history.js         normalized sample store (48h, capped)
  format.js          countdown / clock / age formatting (DST-correct via Intl)
  logger.js          redacting logger
  windowState.js     bounds persistence + work-area clamping
  icon.js            programmatic tray gauge PNG
src/renderer/        plain HTML/CSS/JS panel + settings overlay
test/                74 unit/fixture tests (node:test) + synthetic fixtures
```

## Development

```bash
npm install
npm test        # unit + fixture tests + lint gate (74 tests)
npm run lint    # eslint only
npm audit       # dependency audit
npm start       # run from source
npm run package # build dist\ai-usage-tracker-win32-x64\ai-usage-tracker.exe
```

Demo mode (synthetic fixtures, no accounts, no network):

```bash
AITRACKER_DEMO=1 npx electron .            # bash
set AITRACKER_DEMO=1 && npx electron .     # cmd
```

Screenshot mode (demo data, captures `screenshots/mini-100.png` and
`mini-150.png`, then exits):

```bash
AITRACKER_DEMO=1 npx electron . --screenshot
```

## Troubleshooting

- **Codex card says "Codex CLI not found"** - ensure `codex --version` works
  in a normal terminal (the CLI must be on PATH). Signed-out CLI shows a
  sign-in message; run `codex login` yourself, we never touch its auth.
- **Claude card says "Enable local capture" / "NO_DATA"** - enable capture for
  that profile in Settings, then use Claude Code normally and refresh the tracker.
  Subscription fields are provided after a response and can be absent. Check
  Claude Code's `/usage` display if fields remain missing. API-key billing does
  not provide subscription usage percentages. A project or managed status-line
  override, `disableAllHooks`, or `allowManagedHooksOnly` can prevent capture.
- **Z.ai card says "No Z.ai API key stored"** - add the key in Settings
  (it goes to Windows Credential Manager). "Key rejected (401/403)" means the
  key is wrong or lacks a Coding Plan; `npm`-style proxies are not used.
- **All cards stale** - check network; the app keeps showing cached values
  with their age until a poll succeeds.
- **Window opens off-screen** - bounds are clamped to the current work area;
  delete `%APPDATA%\ai-usage-tracker\settings.json` to reset everything.
- **Exe won't start on a stripped-down Windows** - Electron needs the
  WebView2/Edge runtime, present by default on current Windows 10/11.

## Known limitations

- Percentages across providers are not comparable (different weighting).
- Claude model-specific weekly limits are normalized but shown only in notes;
  Mini mode renders session + weekly rows by design.
- Z.ai web-search limits are tracked but not rendered as a row.
- The packaged exe uses Electron's default icon (a custom .ico is a
  packaging nicety, not functional).
- Real-account behavior of all three endpoints was verified against
  published open-source clients and synthetic fixtures; it was not exercised
  against live accounts in this environment (see FINAL_REPORT.md).
