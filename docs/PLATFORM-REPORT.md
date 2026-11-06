# Relay Platform Wiring — ChatGPT (Codex) Real Quota Source

Date: 2026-11-06 · Environment: project VM (Linux), Node v24.22.1
Verdict: **PASSED** — 261/261 automated assertions green (the 236 from
M0–M4 untouched and still passing, 25 new), plus a live read-only smoke
against the owner's real Codex sign-in (numbers in §5; no credential
value was printed, logged, or written anywhere — the token lived only
in process memory for the duration of the fetch).

This is step 1 of the wiring phase per the owner's ordering
（平台 → Gemini → API): the ChatGPT platform's real quota now feeds the
router and the dashboard. Gemini and API-pool wiring are unchanged and
still ahead.

## 1. What was built

| File | Change |
|---|---|
| `src/quota.js` | New source `codex-usage`: official Codex usage endpoint behind a 60 s background-refreshed cache; injectable HTTP client + auth path + clock for tests; `mapCodexUsage` exported; service gains `refreshCodexUsage(force)` and `warmup()` |
| `src/config.js` | Upstream entries accept `quotaSource` (wins over the legacy `quota.source`); the quota block keeps its source-specific parameters |
| `src/gateway.js` | Calls `quotaService.warmup()` at startup (background, best-effort) so the first routed request / dashboard view already sees real numbers |
| `src/dashboard.js` | Quota entries carry `windows` + a plain-language `detail` line; the Codex card renders it as small text under the hint (four-block layout unchanged) |
| `relay.config.example.json` | The passthrough example declares `"quotaSource": "codex-usage"`; `$comment` documents that the credential comes from the local sign-in at fetch time, never from the file |
| `test/run-tests.mjs` | Tests 37–39 (25 new assertions) |

## 2. The source: endpoint, credential, mapping

- **Endpoint**: `GET https://chatgpt.com/backend-api/wham/usage`
  (`node:https`, zero new dependencies, 10 s timeout).
- **Credential**: `tokens.access_token` + `tokens.account_id` from the
  local Codex sign-in — `~/.codex/auth.json` by default, overridable
  with env `RELAY_CODEX_AUTH`. Sent as `Authorization: Bearer …` and
  `ChatGPT-Account-Id: …`. The file is read read-only; Relay never
  writes, refreshes, or logs it (token refresh remains the Codex CLI's
  own job, exactly as before).
- **Mapping**: `rate_limit.primary_window` (5 h) and
  `rate_limit.secondary_window` (week) each carry `used_percent` and
  `reset_at` (unix seconds). Each window maps to
  `{usedPercent, remainingPct = 100 − usedPercent (clamped 0..100),
  resetAt = ISO}`. The headline `remainingPct`/`resetsAt` come from the
  **tighter** window (a request dies when either window is spent); both
  windows ride along as `windows.{primary,secondary}`.
- **Source selection**: `upstream.quotaSource` when declared, else
  `quota.source` — existing mock/metering configs behave exactly as
  before.

## 3. Cache & degradation (the read API stays synchronous)

The router, ledger and dashboard all consume `getQuota()` inline, so
the fetch runs as a **background refresh behind a 60 s cache**
(stale-while-revalidate) instead of putting network latency — or a
network failure — on the request path:

- Fresh cache (< 60 s): served as-is, no request.
- Stale/absent: a refresh fires in the background (in-flight deduped);
  the last known value keeps serving meanwhile.
- Fetch failure (network error, non-200 incl. 401, malformed payload,
  missing/unreadable sign-in, missing token fields): the failure is
  **negatively cached** for the same 60 s (no retry storm), and
  `getQuota` degrades to the upstream's metering estimate when it
  configured a `windowTokens` budget — honestly labeled
  `metering-estimate` — otherwise `{remainingPct: null,
  source: 'unavailable'}`, which the router already treats as "unknown,
  keep routing". A quota outage can therefore never block a request.
- `warmup()` (gateway startup) pre-fetches when any enabled upstream
  declares `codex-usage`.

## 4. Dashboard behavior

For a `codex-usage` upstream the card is real data end to end:
`source: 'codex-usage'`, `estimate: false` (no 估算 tag), headline =
tighter window, plus the small two-window line under the hint —
e.g. 「5 小时内还剩 26%，这周还剩 53%」. The four-block layout, the
plain-language rules and the no-raw-codes guarantee are unchanged.

## 5. Live smoke (real sign-in, read-only)

Two read-only usage queries were made (one direct, to record the HTTP
status; one through Relay's quota service). `~/.codex/auth.json` was
only read. Results (2026-11-06 ~14:03 CST):

| Window | Used | Remaining | Resets |
|---|---|---|---|
| Primary (5 h) | **74%** | **26%** | 2026-11-06 14:31:43 (Asia/Shanghai) |
| Secondary (week) | **47%** | **53%** | 2026-11-11 14:47:05 (Asia/Shanghai) |

- Direct call: HTTP **200**, `plan_type: plus`.
- Through the service: `getQuota('codex-plan')` →
  `source: 'codex-usage'`, `remainingPct: 26` (the tighter, primary
  window), `resetsAt` matching the primary reset — identical numbers
  via both paths.
- The token was valid (no 401): no CLI run was needed to renew it, and
  Relay did not touch the file either way.

## 6. Test evidence

`npm test` → **261 passed, 0 failed** (236 pre-existing + 25 new):

```
test 37: codex-usage — window mapping, credential headers, 60s cache   12 PASS
   pure mapper (tighter window leads either way, reset_at seconds->ISO,
   junk -> null); cold start degrades to unavailable with no invented
   number; injected fake HTTP asserts the official URL and the
   Authorization / ChatGPT-Account-Id headers taken from a fixture
   sign-in file; cache: repeated reads inside 60 s = 1 request, after
   61 s = 2nd request.
test 38: failure degradation                                            8 PASS
   HTTP 500 / 401 / missing sign-in file / sign-in without tokens all
   degrade to 'unavailable' (remainingPct null), failures negatively
   cached (1 request, no storm), no HTTP attempted when the file is
   missing; endpoint down + a metering window configured ->
   'metering-estimate' 90% (15/150 metered tokens).
test 39: dashboard integration                                          5 PASS
   buildStatus for a codex-usage upstream: source 'codex-usage',
   estimate false, headline 62%, both windows present, detail line
   exactly 「5 小时内还剩 62%，这周还剩 85%」 (fixture percentages).
```

All test HTTP is injected fakes and all test credentials are fixture
dummies; the only real-credential access in this phase is the §5
smoke.

## 7. Next steps — Mac deployment checklist (NOT executed here)

The VM wiring is done; making it the owner's daily driver is a Mac
deployment, in order:

1. **Copy the project to the Mac** (`~/workspace/relay` →
   the Mac's Relay home) and `npm test` there as a smoke gate.
2. **Install into the real Codex**: run the config manager against the
   Mac's `~/.codex` (it takes its backup first; restore stays
   byte-exact), with a routed config whose passthrough upstream
   declares `quotaSource: "codex-usage"` — the Mac's own
   `~/.codex/auth.json` (the owner's desktop sign-in) is then the
   credential the usage source reads.
3. **launchd autostart**: a LaunchAgent that starts
   `node src/gateway.js` at login with the routed config env
   (`RELAY_CONFIG`, log paths under the Relay home), restarts on
   crash, and binds 127.0.0.1 only — the gateway must never listen on
   a LAN interface.
4. **Dashboard acceptance on the Mac**: open `http://127.0.0.1:18923/`
   and verify the Codex card shows the real two windows (cross-check
   against the Codex app's own usage display once), the 估算 tag is
   absent for Codex, and today's counts move after real Codex work.
5. **Full-day gate** (the still-open M1/M2 item): one normal day of
   Codex use through Relay on the Mac — no stream breaks, quota card
   tracks the official numbers, restore path re-verified afterwards.

After the platform step: Gemini wiring (step 2 of the owner's order),
then API pool keys (step 3) — each with its own report.
