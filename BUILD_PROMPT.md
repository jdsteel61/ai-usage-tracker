# Build prompt for GLM-5.3

You are working in `C:\Users\jdste\coding projects\ai-usage-tracker` on a Windows PC. Build and verify a small Windows desktop application that monitors the user's included usage quotas across OpenAI Codex, Claude Code, and Z.ai.

Do not stop after producing a plan or mock-up. Inspect the relevant upstream projects, make a justified technical choice, implement the application, run its tests, build a runnable Windows artifact, and document how to launch it. Keep all project files inside this folder. Do not publish, deploy, push to a remote, enable Windows startup, or read/configure real credentials without asking the user first.

## Product goal

Create a quiet, lightweight usage monitor that:

- Runs in the Windows notification area and can launch automatically at Windows sign-in when the user explicitly enables that option.
- Opens as a compact, approximately 10 cm by 10 cm, always-on-top box. Treat `378 x 378` device-independent pixels as the initial size, while keeping it resizable and remembering its last position and size.
- Can be shown or hidden by clicking its tray icon.
- Shows exactly three provider cards by default: Codex, Claude, and Z.ai.
- Shows the five-hour/session quota and weekly quota for each provider when those windows are returned by the provider.
- Shows percentage used, a small progress bar, and the reset countdown/time for each available window.
- Uses `—` with a useful tooltip when a provider does not expose a particular window. Do not invent or estimate an unavailable account quota.
- Shows a conspicuous `!` beside a provider when a large usage spike is detected.
- Has a manual refresh control and a configurable background refresh interval, defaulting to five minutes.
- Uses plain, restrained visuals and remains readable at common Windows scaling settings.
- Starts with Windows only after the user turns this on in Settings. Do not silently add startup entries.

The UI should be conceptually similar to:

```text
┌──────────────────────────────┐
│ AI USAGE                14:32│
│                              │
│ CODEX                        │
│ 5 hr   ██████░░  72%     2h │
│ Week   ███░░░░░  34%     4d │
│                              │
│ CLAUDE                    !  │
│ 5 hr   ████████  91%    38m │
│ Week   █████░░░  58%     2d │
│                              │
│ Z.AI                         │
│ 5 hr   ██░░░░░░  24%     3h │
│ Week   █░░░░░░░  12%     5d │
└──────────────────────────────┘
```

## Important terminology

Call the headline values **quota usage**, not raw token usage. Codex and Claude subscription allowances are weighted by model, context, caching, reasoning, tools, and other factors. Raw token totals do not reliably map to a subscription percentage. Z.ai may expose token-oriented Coding Plan quotas, but normalize all providers into clearly labelled usage windows without claiming the percentages are directly comparable.

## Starting point and upstream research

Do not rebuild provider integrations blindly. First inspect these projects and their current licenses, recent activity, provider implementations, tests, and Windows behavior:

1. UsageDeck — `https://github.com/lamchun1110/UsageDeck`
   - MIT licensed.
   - Tauri/Rust desktop app with Codex, Claude Code, and Z.ai support.
   - Already has tray behavior, local history, credential-store integration, quota/reset displays, pacing, and Windows builds.
   - This is the default foundation unless inspection reveals a concrete blocker.

2. Agent Usage Widget — `https://github.com/chunnytechmate/agent-usage-widget`
   - Very close to the desired three-provider display.
   - Useful reference for a simple layout and spike detection.
   - Electron-based and less mature; do not adopt its plaintext `.env` approach for long-lived Z.ai credentials.

3. Codex Usage Monitor — `https://github.com/upstream-ray/codex-usage-monitor`
   - Native Windows/Rust reference for Codex and Claude quota collection and taskbar/tray behavior.

Prefer a narrow fork/customization of UsageDeck if doing so produces a maintainable, lightweight result. Preserve all required license and attribution notices. If you instead create a new implementation, explain the concrete reason in the README and reuse only code whose license permits it.

Before substantial work, check for and follow any `AGENTS.md` or `CLAUDE.md` files in this folder or inherited from the workspace. Inspect actual upstream files and current CLI behavior before asserting how an integration works. Provider interfaces can change.

## Provider behavior

### OpenAI Codex

- Prefer the installed, authenticated Codex CLI's app-server interface and its account/rate-limit method rather than reading secrets or making model requests.
- Existing implementations use `codex app-server` and `account/rateLimits/read`; verify the current method and response schema from the installed version or current official code/docs.
- Do not send an inference prompt to obtain usage.
- Clearly report when Codex is absent, signed out, API-key-only, or returns no subscription windows.
- Never write to the Codex credential file.

### Claude Code

- Prefer the authenticated account-usage mechanism used by Claude Code or a local `/usage` mechanism that does not invoke a model. Verify current behavior before implementation.
- Reuse the Claude Code login if safely possible; never modify its credential store.
- Avoid ordinary `claude -p` prompts or Messages API calls, because the monitor must not consume model usage merely to measure it.
- Support the provider's session/five-hour window, overall weekly window, and optional model-specific limits, but Mini mode should show only the session and overall weekly rows by default.
- Clearly report when the user is signed in using usage-based API billing and subscription windows do not apply.

### Z.ai

- Use the Coding Plan quota endpoint exposed for the user's account; current open-source implementations query `GET https://api.z.ai/api/monitor/usage/quota/limit`, but verify the current endpoint and schema.
- The Z.ai API key must be stored with Windows Credential Manager (or held in memory for the current process). Do not store it in source control, logs, JSON settings, or a plaintext `.env` file.
- Never print or log credential values or raw authenticated responses.
- Allow the user to configure the appropriate Z.ai region/domain if current plans require it.
- If the plan returns session, weekly, or web-search limits, normalize them by semantic type and display only session/five-hour and weekly in Mini mode.

All provider polling must be metadata/quota retrieval only. The finished application must not deliberately make paid model inference requests.

## Spike detection

Store a small local history containing only normalized percentages, reset timestamps, provider health, and sample timestamps. Do not store prompts, responses, repository paths, session contents, raw credentials, or complete raw provider payloads.

For each quota window, trigger a spike when either:

- usage rises by at least 8 percentage points within one normal polling interval; or
- usage rises by at least 3 points and the normalized rate is more than four times that window's rolling median rate from the previous 24 hours.

Requirements:

- Normalize deltas for the actual time between samples.
- Do not flag the first sample, a quota reset, a provider recovery from stale/cache/error state, or a gap longer than three normal polling intervals.
- Keep `!` visible for 30 minutes by default.
- Hovering or clicking it should explain the provider, window, change, and time range, for example: `Claude 5h increased 11% between 14:25 and 14:30`.
- Make absolute threshold, relative multiplier, and alert duration configurable in Settings.
- Add deterministic unit tests for normal growth, absolute spikes, relative spikes, resets, long gaps, stale recovery, and zero/flat history.

## Architecture and security requirements

- Keep provider adapters isolated behind one small normalized interface so one provider failing does not blank the others.
- Represent windows semantically (`session`, `weekly`, and optional provider-specific types), not by assuming the first result is always five-hour and the second weekly.
- Poll providers independently with timeouts, bounded retries, and modest jitter. Do not retry aggressively.
- Default to a five-minute interval. Manual refresh should be debounced.
- Cache the last successful result and visibly mark stale values with their age.
- Use Windows Credential Manager for any application-managed secret.
- Redact bearer tokens, cookies, API keys, authorization headers, raw credential objects, and sensitive paths from diagnostics.
- Bind no local network listener unless the inherited foundation makes it unavoidable; if one is needed, document and secure it.
- Do not add analytics, telemetry, advertising, or an application-operated backend.
- Update checks must be opt-in during development, and no external publishing is in scope.
- Use a single-instance guard so repeated launches reveal the existing window.
- Ensure clean exit from the tray menu and graceful cancellation of in-progress polls.

## Settings

Include a small Settings surface for:

- enabling/disabling each provider;
- refresh interval, with a safe minimum of one minute;
- used-versus-remaining percentage display;
- always-on-top;
- launch at login;
- light/dark/system theme;
- 12/24-hour reset-time display;
- spike thresholds and alert duration;
- adding, replacing, testing, and removing the Z.ai key through Windows Credential Manager.

Any action that reads, adds, changes, tests, or removes a real API key or credential requires a clear confirmation from the user first. Never ask the user to paste a secret into chat or a terminal command that would echo it.

## Testing and validation

Provide fixture-driven tests for all adapters so most tests run without real accounts. Fixtures must be synthetic and contain no copied secrets or personal data.

At minimum, verify:

- response normalization for representative Codex, Claude, and Z.ai payloads;
- missing or additional quota windows;
- malformed responses and provider timeouts;
- reset countdown formatting across local time and daylight-saving changes;
- percentage clamping and unknown values;
- spike detection cases listed above;
- settings persistence without secrets;
- logging redaction;
- one provider failing while the others continue to update;
- window size, tray show/hide, and startup-toggle logic where practical.

Run the project's formatter, linter, type checker, unit tests, security/audit checks available in the chosen stack, and a release build. Fix failures caused by this work. Do not hide failing tests or weaken assertions.

If real-account verification is needed, finish all synthetic/offline work first, then state exactly which provider and read-only operation needs authorization. Do not inspect existing credential files until the user confirms.

## Deliverables

Leave the folder with:

- complete source code;
- preserved upstream license/attribution if applicable;
- a concise `README.md` covering architecture, privacy, installation, development, and troubleshooting;
- automated tests and synthetic provider fixtures;
- a reproducible build command;
- a runnable Windows debug or release artifact, or a precise documented blocker if the environment lacks a required build dependency;
- screenshots of the final Mini mode at 100% and 150% Windows scaling if the available tooling can capture them without exposing unrelated desktop content;
- a short final report listing the foundation chosen, files changed, commands/tests run, artifact path, known limitations, and any provider behavior that remains unverified without credentials.

Do not publish releases, push code, install the application globally, enable launch at login, or alter provider credentials as part of this task.

## Definition of done

The task is complete only when the application builds and its automated tests pass; it can remain running in the tray; its compact window shows independent Codex, Claude, and Z.ai status; missing providers fail gracefully; spike logic is tested; no model-inference request is used for monitoring; secrets are excluded from settings/logs/source control; and a new user can understand how to run the artifact from the README.
