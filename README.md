# AI Usage Tracker

A compact Windows tray app for **Codex, Claude Code, Z.ai, Grok, Gemini, and
OpenRouter**, with separate cards for additional Codex and Claude subscription
profiles. It shows quota percentages, credit budgets, or key health according to
what each provider exposes. Percentages across providers are not directly
comparable; missing numbers are never guessed.

Claude readings come from **local Claude Code status-line capture**, for every
Claude account at once. An optional, per-account **API top-up** (off by default)
can fill in an account whose capture has gone quiet; see
[Claude API top-up](#claude-api-top-up). The tracker never sends prompts, and
monitoring makes no model inference requests.

## Windows setup

1. Download the Windows x64 ZIP from a
   [published release](https://github.com/jdsteel61/ai-usage-tracker/releases),
   when available. The
   [Windows build workflow](https://github.com/jdsteel61/ai-usage-tracker/actions/workflows/windows-build.yml)
   also provides downloadable build artifacts after a successful run; GitHub
   requires sign-in to download Actions artifacts. Build automation prepares
   downloads but does not publish releases automatically.
2. Extract the **whole ZIP**, then run
   `ai-usage-tracker-win32-x64\ai-usage-tracker.exe`. Keep the executable beside
   its runtime files. No installer or administrator access is needed. Electron
   includes Chromium; WebView2 is not required.
3. Open **Menu > Settings**, enable the providers you use, and follow the
   requirements below. Launch at Windows sign-in is optional and off by default.

For Actions downloads, extract the `ai-usage-tracker-windows-x64` artifact first
to get the portable ZIP and checksum, then extract the portable ZIP in step 2.

Release assets use names such as `ai-usage-tracker-1.5.1-win32-x64.zip`, with a
matching `.zip.sha256` file. To check a downloaded ZIP in PowerShell, compare the
hash below with that file:

```powershell
Get-FileHash .\ai-usage-tracker-1.5.1-win32-x64.zip -Algorithm SHA256
```

A checksum detects a damaged or mismatched download; it is not code signing.
These builds are unsigned, so Windows may show an unknown-publisher warning.

Click the tray icon to show or hide the window. Closing the panel hides it;
**Quit** exits the app. Drag the header to move it or an edge to resize it. Cards
scale to fit. The header copy button copies a plain-text summary, including
reading freshness, for pasting elsewhere.

### Connect your providers

| Provider | Setup | What the tracker reads |
|---|---|---|
| Codex | Install the Codex CLI, sign in yourself, and make `codex` available on PATH. | Starts `codex app-server` and requests `account/rateLimits/read`. The CLI manages its authentication; the tracker does not read the Codex auth file. |
| Claude | Use Claude Code with status-line `rate_limits` support and Node.js on PATH. In Settings, choose **Enable capture** for each account you want to capture. Optionally tick **API top-up** for an account. | Reads the local usage file written by the status-line collector. Usage may appear only after a Claude Code response, and some sessions/accounts omit these fields. With API top-up on, it may also call `GET https://api.anthropic.com/api/oauth/usage` using that account's saved login (see below). |
| Z.ai | Add a GLM Coding Plan API key in Settings. | `GET https://api.z.ai/api/monitor/usage/quota/limit`; only Z.ai uses the configurable Z.ai base URL. |
| Grok | Enable it and add an xAI API key in Settings. | `GET https://api.x.ai/v1/api-key`; shows reported credit fields when available, otherwise key health and a note that usage data is unavailable. |
| Gemini | Enable it and add a Google AI Studio API key in Settings. | `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1`; validates the key. This adapter does not measure actual Gemini usage. |
| OpenRouter | Enable it and add an OpenRouter API key in Settings. | `GET https://openrouter.ai/api/v1/key`, plus `/api/v1/credits` when needed for prepaid balances. Credit budgets do not have a reset countdown. |

Codex, Claude, and Z.ai are enabled by default; the other providers are optional.
All four API keys are stored in Windows Credential Manager. Storing, testing,
and removing a key each require confirmation in the app. Enabled providers read
their stored keys for normal monitoring.

In Settings, use **Add profile** to choose another signed-in Codex home folder or
Claude Code config folder. Each gets its own card, saved reading, and history.
The provider checkbox controls all of that provider's profiles.

Every enabled Claude profile is watched at the same time through its own local
capture file. Each Claude card shows its reading source and age, such as
`local · live` or `api · 12 min ago`. To stop capturing an account, see
[Undo Claude capture](#undo-claude-capture).

### Claude API top-up

Local capture only updates while you use Claude Code with that account, so an
idle account's reading ages. **API top-up** is an opt-in checkbox per Claude
account (default off; enabling asks for confirmation). When on, the tracker asks
Claude's usage endpoint only if the newest reading it holds for that account is
missing or older than 25 minutes. A fresh local capture means zero API calls.

- It reads `<Claude config folder>/.credentials.json` **read-only** and sends
  the access token to `https://api.anthropic.com/api/oauth/usage`. It never
  writes or refreshes credentials, and the token is not stored by the tracker.
  The request is a usage-metadata query, not a prompt, so it uses no model quota.
  The file must be a plain file inside that folder: symlinks and reparse points
  are refused, as are tokens that are not plain printable ASCII.
- Your approval is tied to the resolved credentials location shown in the
  confirmation. If the folder later resolves somewhere else, the approval is
  cleared and you must approve again. The profile folder can be changed only by
  removing and re-adding the profile, never through the settings channel.
- That endpoint rate-limits very aggressively, so calls follow a strict budget:
  at least 10 minutes between calls per account, at most one call started per
  minute across all accounts, and on HTTP 429 a wait of the longest of: any
  cooldown still running, the escalation step (1, 2, then 4 hours), and the
  server's `Retry-After` when valid (up to 24 hours), plus a little jitter. A
  short `Retry-After` never shortens an existing wait, and the escalation eases
  only after several successes or a long quiet period, not after one success.
  A 401/403 marks the account **sign-in needed** and stops calls until you sign
  in again (its credentials file changes) or a new local capture arrives. When
  several accounts are waiting, the one with the oldest reading goes first and
  the next attempt is scheduled for when the budget allows.
- The budget survives restarts and is measured on a monotonic clock, so changing
  the system clock cannot end a wait early. A call is sent only after its
  record is saved. If the saved budget is damaged beyond recovery, or cannot be
  saved, API top-ups pause (the card says so) while local capture carries on.
- For each account, session and weekly independently take the newest observation
  from local capture or the API. A failed API call never replaces a good
  reading: the card keeps showing it as cached (not current) until a newer
  observation arrives, and its hover explains the cooldown or sign-in problem.
- When the API reports model-specific weekly limits (for example a per-model
  week), they appear in the card's reading-status hover and the copy-for-agents
  summary ("Fable week 0%"), never as extra bars. They come only from the API
  and are hidden once their reset passes or they are over 35 minutes old.

## Understand reading freshness

Each card has a small status dot and a text label. Hover the status to see the
source, reading age, and any error or retry detail.

| Label | Meaning |
|---|---|
| **Current** | A recent successful provider reading, or recent local Claude capture. It is a point-in-time observation. |
| **Cached** | The last successful reading is retained after a failed request, restart, or an age limit. Its age tells you how old the numbers are. |
| **Waiting** | There is no successful reading to show yet. Hover for the reason, such as missing capture, CLI, authentication, or API key. |

Claude readings become cached after 15 minutes without a new observation
(35 minutes for an API reading, because top-ups run after 25); network readings become cached after two configured polling intervals. Reset
countdowns reaching zero do not prove usage is zero: the card needs a new
reading. The header reports the last **panel update**, which can happen without
a successful provider reading. A provider in rate-limit cooldown shows cached
values, or waiting if it has none; hover for the next retry time.

Successful readings survive restarts. A provider failure does not blank other
cards. Background polling defaults to five minutes, with jitter, timeouts,
cancellation, and bounded retries. HTTP 429 responses pause that provider for
15, 30, 60, then up to 120 minutes; manual refresh respects the pause. Every Claude
capture file is also watched, so capture changes normally appear within about a
second. Claude's API top-up has its own budget, described above, rather than
the generic pause.

The `!` marker reports a detected usage jump; hover or click it for the interval
and increase. Thresholds are configurable. Published peak/off-peak timing is
shown for Z.ai. Missing windows use a dash with an explanation.

## What is read and stored

There is no telemetry, analytics, application backend, update checker, or
network listener. Network monitoring goes to the enabled providers listed
above; Codex's CLI makes its own authenticated metadata request. The renderer
uses sandboxing, context isolation, no Node integration, and a restrictive CSP.

| Location | Contents |
|---|---|
| `%APPDATA%\ai-usage-tracker\settings.json` | Display/polling settings, profile labels and folder paths, which Claude accounts have API top-up on (with the credentials location you approved), the ids already issued to profiles (so a removed profile's id is never reused), and window bounds. No API keys. An old active-Claude-profile value is ignored. |
| `%APPDATA%\ai-usage-tracker\readings.json` | Last successful normalized readings: provider/window identifiers, plan label, percentages, reset/observation times, and selected numeric quota fields. No raw responses or arbitrary error text. Older installs may also have `claude-readings.json`. |
| `%APPDATA%\ai-usage-tracker\claude-api-budget.json` (and `.bak`) | Claude API top-up rate budget: per-account timestamps, failure counters, and the credentials-file modification time seen at a sign-in rejection, with a one-step backup. No tokens or responses. Removing a profile deletes its entry, readings, and history. |
| `%APPDATA%\ai-usage-tracker\history.json` | Normalized session/weekly percentages, reset times, sample times, and success/error state. Pruned to 48 hours and capped in size. |
| `%APPDATA%\ai-usage-tracker\logs\main.log` | Diagnostics passed through a redaction filter for tokens, keys, credential fields, long blobs, and user profile paths; rotated around 512 KB. |
| Windows Credential Manager | API keys under `ai-usage-tracker:zai-api-key`, `ai-usage-tracker:grok-api-key`, `ai-usage-tracker:gemini-api-key`, and `ai-usage-tracker:openrouter-api-key`. |
| `<Claude config folder>\ai-usage-tracker\usage.json` | Only five-hour/seven-day percentages, reset times, and observation times captured from Claude Code. |
| `<Claude config folder>\ai-usage-tracker\` setup files | `original-statusline.json` backs up the previous status-line setting; `capture-state.json` records the installed wrapper and prior field presence; `forward.json` records its command and shell; `collector.cjs` and `claudeStatusline.js` run local capture. |

Claude capture reads and updates that profile's `settings.json` to wrap its
`statusLine` command. It preserves other settings and forwards the original
stdin and output to an existing status-line command. The collector receives
Claude Code's status-line JSON in memory but saves only the usage fields above;
it does not open transcripts or persist the full payload. Capture itself does
not read Claude's authentication file or use the network; only the opt-in API
top-up reads the saved login, as described above. Existing status-line commands continue to have
their own behavior.

### Undo Claude capture

In Settings, choose **Undo capture** for the relevant Claude profile.
Confirm the config folder shown in the dialog. This restores its backed-up
`statusLine` setting, or removes the field if it was
originally absent. Other Claude settings are preserved. If you have changed the
status-line setting since enabling capture, or the backup is missing or damaged,
the app refuses to overwrite it.

For manual recovery, quit the tracker and edit that profile's `settings.json`:
replace **only** `statusLine` with the JSON value in
`ai-usage-tracker\original-statusline.json`. If the backup is `null`, remove the
`statusLine` field unless `capture-state.json` records `hadStatusLine: true`;
in that case, restore the field to `null`. Keep the rest of `settings.json`
intact. Do not replace the
whole settings file with this backup. Start a new Claude Code session if an
existing session continues to use the old command.

Undo leaves the helper files and saved readings in place. Once the
status-line wrapper has been removed, you can delete that profile's
`ai-usage-tracker` subfolder to remove its capture data. Removing a profile from
the tracker, disabling Claude, or quitting the tracker does not undo capture.

### Remove the app and its data

1. Undo capture for every Claude profile where you enabled it.
2. Turn off **Launch at sign-in** and remove stored API keys in Settings if you
   want to remove those too.
3. **Quit** the app, then delete the extracted app folder.
4. Optionally delete `%APPDATA%\ai-usage-tracker` and the restored Claude
   profiles' `ai-usage-tracker` subfolders to erase local tracker data.

Deleting the app folder alone keeps settings, readings, keys, and Claude capture
for a later reinstall. If the app is already gone, remove its key entries in
Windows Credential Manager and use the manual capture recovery above.

## Build and run from source

Use Node.js 20+ and npm. From the repository folder:

```powershell
npm ci
npm test
npm run lint
npm start
npm run package         # fresh Windows x64 app folder
npm run package:release # app folder, portable ZIP, and SHA256 file
```

Fresh build output is placed under a unique `dist\releases\<version>-<suffix>`
folder; the build command prints its exact path. It does not overwrite the
running `dist-ui` build. The GitHub workflow performs tests and lint before
packaging and uploads artifacts for tag pushes (`v*`) or manual workflow runs.
Publishing a GitHub release is a separate action.

Demo mode uses synthetic fixtures and does not access accounts or the network:

```powershell
$env:AITRACKER_DEMO = '1'
npm start
# Optional: npm run screenshot
Remove-Item Env:AITRACKER_DEMO
```

The implementation is plain Electron/JavaScript: `src/main/providers/` contains
provider adapters; `claudeStatusline.js` handles capture setup and restoration;
`readingCache.js` and `history.js` persist normalized data; `snapshotView.js`
shapes freshness; `src/renderer/` contains the compact panel and Settings. Tests
use fixtures and injected transports rather than live accounts. Third-party
credits are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Troubleshooting and limits

- **Codex CLI not found:** confirm `codex --version` works in a normal terminal,
  then restart the tracker after changing PATH. Sign in using the CLI yourself.
- **Claude waiting:** enable capture for the correct config folder and use
  Claude Code normally, or turn on API top-up for that account. A card marked
  sign-in needed means the usage API rejected the saved login: sign in to Claude
  Code again. Missing subscription fields cannot be forced by
  refreshing the tracker. Project/managed status-line overrides, disabled hooks,
  or API-key billing can prevent a reading.
- **Cached values:** inspect the status hover for reading age, error, and retry
  time. Refresh cannot bypass a provider's rate-limit pause.
- **Key valid without percentages:** Gemini measures key health only; Grok
  usage depends on fields returned by xAI. Consult the provider's own dashboard.
- **Missing quota rows:** the compact panel renders session and weekly/credit
  rows. Additional normalized windows, such as Z.ai web-search limits, are not
  shown as separate rows.
- **Testing scope:** automated verification uses synthetic fixtures. Provider
  schemas and Claude Code status-line availability can change; live-account
  behavior must be checked separately with your authorization.
