# Relay — Gap Audit vs. AutoRouter (full-coverage sweep)

Date: 2026-11-06 · Auditor pass after the owner caught the missing
difficulty axis and ordered a no-more-gaps sweep ("多检查几遍").
Method: the AutoRouter capability list below was extracted in full from
`docs/AUTOROUTER-REVERSE-REPORT.md` (the static reverse-engineering
report), then each item was checked against Relay's code (`src/`),
tests (`test/run-tests.mjs`, tests 1–23), config example, UI mock, and
the decision record (`docs/PLAN.md`, `docs/LEARNING-FROM-AUTOROUTER.md`,
M0/M1/CORE reports). Statuses:

- **implemented** — code (+ usually tests) exists; evidence cited.
- **planned** — explicitly scheduled in PLAN / LEARNINGS / a report's
  leftover list; not yet built.
- **rejected** — deliberately cut, with the reason on record (PLAN §1
  non-goals or LEARNINGS "Reject").
- **missing** — none of the above: never implemented, never scheduled,
  never rejected. These are the true gaps.

## Verdict up front

**True gaps: 6. None of them is a missing core capability.** The core
surface — config takeover with byte-exact restore, protocol
translation, routing priority/stickiness/pins/fail-closed, fallback
classification, dual honest ledgers, quota estimation with provenance,
feedback capture, version gating at install — is implemented and
test-covered (109 assertions). All 6 gaps are edge/experience class;
two of them should nevertheless be closed **before** the credentials
phase, because that phase puts real keys and real provider errors on
paths that are currently only mock-tested:

| # | Gap | Severity | Recommended slot |
|---|---|---|---|
| G1 | Redirect-refusal is true by construction but nowhere explicit or test-locked | edge (security hygiene) | **FIXED 2026-11-06** — comment at the HTTP layer + test 30 (see 修复与处置记录) |
| G2 | Error taxonomy has only 3 classes (quota / filtered / error); auth failures and invalid-request errors (e.g. context-length) fall into generic `error` and get retried across the whole chain | edge (cost/correctness) | **FIXED 2026-11-06** — `auth` / `invalid` classes + tests 31–33 (see 修复与处置记录) |
| G3 | Natural-language routing rules + policy editor input form | experience | **RECORDED 2026-11-06** — scheduled at the dashboard stage (M4): NL → structured draft → user confirmation (PLAN §4 + §4 dispositions) |
| G4 | Accessibility window-matching / Codex composer-UI model switching | edge | **RECORDED 2026-11-06** — explicitly rejected, reason in LEARNINGS (Reject) + PLAN §4 dispositions; do not build, do not re-flag |
| G5 | Local gateway endpoints have no local authentication (any local process can route / post feedback / burn quota) | edge (security hygiene) | **RECORDED 2026-11-06** — scheduled at the credentials phase: local token on management endpoints; forwarding-path decision taken there (PLAN §4 dispositions) |
| G6 | No redacted diagnostics export (metadata-only bundle for bug reports) | edge | **RECORDED 2026-11-06** — rejected for the self-use stage, revisit at productization / M5 (LEARNINGS Reject + PLAN §4 dispositions) |

Also flagged, not counted as gaps: the credentials-phase checklist in
CORE-REPORT §6 **omits the API balance query** that PLAN §3.3 promises
(planned work, dropped from a checklist — exactly the failure mode this
audit exists to catch; fix the checklist, no code needed), and the
install-time version gate's coverage limits (§4 below).
**Update 2026-11-06:** the checklist is fixed — the API balance query is
restored as CORE-REPORT §6 item 6 (see 修复与处置记录).

In-progress work (owner-directed, running in parallel during this
audit) is **not** counted as missing: the difficulty axis and the
Apple-style dashboard redesign. Their coverage at audit snapshot time
is assessed in §3.

---

## 1. Capability table

### 1.1 App form & lifecycle

| Capability | AutoRouter | Relay status | Evidence / source | Disposition |
|---|---|---|---|---|
| Menu-bar resident native app | SwiftUI menu-bar app, `LSUIElement` | planned | PLAN §2: launchd daemon + local web dashboard instead of a native app; M4 not built yet | Build at M4 as planned |
| Floating HUD window | Foglamp HUD beside the agent window | rejected | PLAN §1 non-goal ("No floating HUD in v1"); LEARNINGS keeps the *immediacy* via M4 dashboard live feed | — |
| Login-item / service autostart | ServiceManagement registration | planned | PLAN M4 (launchd autostart + crash restart); no supervisor exists yet | M4 |
| Crash self-recovery | (app + Sparkle-managed restarts) | planned | PLAN M4 launchd restart; gateway code has no crash supervisor or `uncaughtException` net today | M4 |
| Signed auto-update | Sparkle + EdDSA appcast, hourly | planned | LEARNINGS adopt row: "Productization fork only"; PLAN productization fork | Deferred by decision |

### 1.2 Config takeover & uninstall

| Capability | AutoRouter | Relay status | Evidence / source | Disposition |
|---|---|---|---|---|
| Managed marked blocks + pre-edit backup (Codex `config.toml`) | `# BEGIN/END AUTO MANAGED…`, `config-before-auto.toml` | implemented | `src/config-manager.js`; test 13 (byte-exact backup/restore); M1 real-chain sha256 proof | — |
| Claude Code config takeover (`~/.claude`) | `ANTHROPIC_BASE_URL`, virtual model, statusLine | rejected | PLAN §1 non-goal: no Claude support | — |
| Claude Desktop 3P gateway config | `inferenceGatewayBaseUrl` + credential helper | rejected | PLAN §1 non-goal | — |
| Original model/status preserved as comments for restore | `# Model before AutoRouter` etc. | implemented (stronger form) | Relay restores from a byte-exact backup file instead of comment archaeology (`config-manager.js`) | — |
| Dedicated uninstall/cleanup tool | Separate `AutoRouterCleanup` binary via LaunchAgent: strips every managed block, restores originals, deletes own data | planned (partial) | LEARNINGS adopt row schedules a `relay uninstall` path (M1/M4); today only `config-manager restore` exists — it restores `config.toml` but no `uninstall` command exists, and nothing removes `logs/`, `feedback.jsonl`, `relay.config.json`, or a future daemon | Deliver with M4 daemon; uninstall must also sweep Relay's own data files |
| Per-home targeting (`--codex-home` etc.) | Cleanup takes per-app home args | implemented | `config-manager.js --codex-home` | — |

### 1.3 Session identification & usage attribution

| Capability | AutoRouter | Relay status | Evidence / source | Disposition |
|---|---|---|---|---|
| Session marker via statusLine | statusLine prints `AutoRouter session: claude_code:<uuid>` | rejected | Claude-specific mechanism; LEARNINGS "Adapt" explicitly chooses a different route (next row) | — |
| Read the agent's own session index for per-session attribution | Reads Codex `session_index.jsonl` via app-server | planned | LEARNINGS "Adapt" decides this approach, but no milestone pins it and `grep session_index src/` is empty; current substitute is the `previous_response_id` chain map, openly labeled an approximation in CORE-REPORT §2 | Pin a milestone (credentials phase or M5); attribution precision only |
| Read local transcripts/usage for cost estimation | `CodexUsageCollector`; weekly usage apportioned across sessions as an estimate | implemented (better substitute) | `src/quota.js` `metering-estimate` meters actual gateway tokens instead of apportioning; official endpoint is planned (credentials phase) | — |
| AX window-tree traversal to bind windows ↔ sessions; operate Codex composer UI to switch models | Accessibility + ScreenCaptureKit; `CodexComposerControl` | **rejected → G4 (recorded 2026-11-06)** | Was absent from code and from every planning document; now explicitly rejected — Relay decides at the protocol layer, UI automation only widens the permission surface | Rejection recorded in LEARNINGS (Reject) + PLAN §4 dispositions |
| Terminal-specific support (Ghostty permission-free, Orca runtime) | Dedicated terminal handling | rejected | Exists only to serve the HUD/window binding, itself rejected (PLAN §1) | — |

### 1.4 Routing decisions

| Capability | AutoRouter | Relay status | Evidence / source | Disposition |
|---|---|---|---|---|
| Route by task difficulty / type | Cloud routing brain classifies each turn | in progress (arranged) | `src/difficulty.js` + capability floor in `src/router.js` landed during this audit; see §3 for coverage gaps in the workstream itself | Finish the in-flight work |
| Server routing-decision API + local decision cache | `v1/routing-decisions`, `RoutingDecisionCache`, `v1/routing-sessions` | implemented (local form) | Decisions are computed locally per request (`router.js` pure function); session-level decision cache = `stickyChains` map in `gateway.js`; the cloud form is rejected with the cloud itself | — |
| Priority: expiring subscription quota first, then flagship, then paid tiers | Core routing policy | implemented | `router.orderAuto`; tests 14/15 (incl. the exhausted-subscription sinking bug found & fixed in CORE phase) | — |
| Session stickiness | Sessions pinned server-side | implemented | `stickyChains` keyed by `previous_response_id` / session headers; test 16 | — |
| Per-project pins | (rules system) | implemented | cwd-prefix rules; test 17 | — |
| Fail-closed privacy policy (restricted context → approved endpoints only, else refuse) | Built-in policy copy, private > savings | implemented | `router.decide` sensitive pool restriction; tests 18/23 (403, no upstream contacted) | — |
| Natural-language routing rules + policy editor | `RoutingRule` / `RoutingPolicyEditor`, task-type icon set | **scheduled → G3 (recorded 2026-11-06)** | Relay rules are structured `{cwdPrefix, upstream, sensitive}` only (`src/config.js`); the NL input form is now scheduled for the dashboard stage in PLAN M4: NL → structured draft → user confirmation before it takes effect | PLAN M4 + §4 dispositions |
| Model catalog distribution + user model overrides | Server `v1/model-catalog`, `v1/model-overrides` | implemented (local form) | Catalog = config-file registry (`src/upstreams.js`); user override = editing the config; routed `/v1/models` serves the union. Cloud distribution rejected with the cloud | — |
| Virtual model name ("select `auto-claude-route` to route") | Virtual model in the picker | implemented (equivalent) | Codex's provider block points at the gateway, so every model routes; `/v1/models` exposes real names — no virtual name needed | — |
| Per-turn feedback capture (👍/👎) | `v1/routing-feedback` per turn | implemented | `POST /v1/feedback` in `gateway.js`; counted in `src/ledger.js`; test 19 | — |
| Feedback actually improving future routing | Feedback feeds the routing brain | planned | LEARNINGS adopt row (M3/M4, "tunes rules"); CORE-REPORT §1 states "record + count only; no automatic tuning yet" | Schedule with/after M4 |
| Real-time routing visibility (this turn → model, reason, cost) | HUD toast per turn | planned | LEARNINGS adopt row lands it as the M4 dashboard live feed; the design mock already carries reason chips + 👍/👎 marks (CORE-REPORT §5). Note the form difference is deliberate: no in-Codex surface exists (that required the rejected HUD/AX route) | M4 |

### 1.5 Gateway & protocol

| Capability | AutoRouter | Relay status | Evidence / source | Disposition |
|---|---|---|---|---|
| Responses-API inference forwarding | `v1/responses` via gateway | implemented | `gateway.js` passthrough / translate / routed; tests 1–23; two live Codex chains (M0/M1) | — |
| Anthropic Messages forwarding + `count_tokens` | `v1/messages` incl. `count_tokens` | rejected | No Claude entry point (PLAN §1); the Responses shape has no count_tokens need | — |
| Local loopback endpoint, optional hosted API | `127.0.0.1:8787` or `api.autorouter.com` | implemented / rejected | Gateway binds `127.0.0.1` only; hosted form rejected with the cloud (PLAN §1) | — |
| Local-model endpoint (Ollama) | Optional `localhost:11434` upstream | implemented (generic form) | Any `chat`-kind upstream's `baseUrl` may be a local OpenAI-compatible endpoint (config-driven; example config includes a `127.0.0.1` upstream). No Ollama-specific adapter, none needed | — |
| Streaming SSE protocol translation | (gateway core function) | implemented | Streaming state machine in `gateway.js`; tests 4/5/11 | — |
| Model list for the client's polling | Server catalog backing the picker | implemented | `/v1/models` in all three modes (M1: passthrough forward / translate map / routed union) | — |
| WebSocket transport handling | n/a in report (client-side preference) | implemented (avoidance) | `config-manager.js` writes `supports_websockets = false` (M0 pitfall #5) | — |

### 1.6 Errors & resilience

| Capability | AutoRouter | Relay status | Evidence / source | Disposition |
|---|---|---|---|---|
| Upstream error mapping (status preserved, client-shaped error body) | (gateway core function) | implemented | `mapUpstreamErrorBody`; tests 8/9/12 | — |
| Per-request timeout + bounded retry | (gateway core function) | implemented | `RELAY_UPSTREAM_TIMEOUT_MS`; single pre-header retry only; tests 10/12 | — |
| Mid-stream break → legal terminal event, no hang | (gateway core function) | implemented | `response.failed` termination; test 11; client-abort 499 also fired on the real chain (M1 §3) | — |
| Fallback chains by failure kind | Rerouting on failure is core behavior | implemented | `classifyFailure` → `fallback_quota / fallback_filtered / fallback_error`; tests 21/22 | — |
| Finer error taxonomy (auth failure, invalid request / context-length, …) | Not itemized in the report; Relay-side refinement of the row above | **fixed → G2 (2026-11-06)** | `classifyFailure` (`src/upstreams.js`) now has 5 classes: `auth` (401/403 or auth body hints → `fallback_auth`) and `invalid` (400 + request-fault hints → chain stops, `invalid_request_stop`, error passed through) join quota/filtered/error; tests 31–33 | Fixed — see 修复与处置记录 |
| Passthrough: tear down upstream when the client aborts | — | planned | Self-recorded debt, M1-REPORT §5 item 2, assigned to M5 | M5 |
| Non-idempotent POST retry risk | — | implemented (bounded + documented) | Retries are pre-header/pre-output only; risk noted in M1-REPORT §5 item 3 | — |

### 1.7 Credentials & security

| Capability | AutoRouter | Relay status | Evidence / source | Disposition |
|---|---|---|---|---|
| Hosted subscription OAuth (provider grants) | `v1/provider-grants`, WorkOS accounts, Sign in with ChatGPT | rejected | PLAN §1 non-goals: no hosted accounts, credentials never leave the machine | — |
| Subscription sharing | `v1/subscription-accounts/sharing` | rejected | PLAN §1 non-goal, explicit | — |
| Keychain credential storage | Keychain, AfterFirstUnlockThisDeviceOnly | planned | PLAN §3.4 (keys in OS keychain); today keys are referenced by env-var *name* and read at dispatch (`upstreams.resolveTarget`) — never in config files | Credentials phase (CORE §6.4) |
| Credential helper: on-demand fetch with TTL | apiKeyHelper / `inferenceCredentialHelper` with TTL + silent refresh | planned (form adapted) | LEARNINGS adopt row: "the gateway is the only reader" (M2). Current state = the on-demand half: the gateway reads the key fresh at each dispatch, holds no cached copy. The agent-side helper process has no object in Relay (Codex serves its own auth via `requires_openai_auth`); TTL-short-lived API credentials are not separately scheduled | Credentials phase; note the form difference when it lands |
| Redirect-refusal on credential-carrying clients | RedirectGuard across API clients | **fixed → G1 (2026-11-06)** | The property (raw `node:http` never follows redirects) is now stated in a REDIRECT POLICY comment at the gateway's HTTP layer and locked by test 30: mock 302 → gateway returns the 302 untouched and the redirect target's hit counter stays at zero | Fixed — see 修复与处置记录 |
| RSA-OAEP credential exchange + signed key-manifest verification | RSA-OAEP-SHA256 exchange, `SecKeyVerifySignature` on key lists | rejected (no object; recommend formalizing) | Relay has no credential *exchange* channel at all (nothing leaves the machine), so there is nothing to encrypt in transit; LEARNINGS' adopt row survives only as "catalog integrity pinned", and Relay's catalog is a local file — nothing is downloaded to pin. If a remote catalog/update channel ever appears, signature verification rides with the Sparkle item (§1.1) | Recommend amending LEARNINGS to record this as rejected-by-architecture |
| Local installation credential | `v1/installation-credential` | **scheduled → G5 (recorded 2026-11-06)** | Relay's gateway performs no local authentication at all today; now scheduled for the credentials phase: local token on management endpoints (`/v1/feedback`, future admin), with the forwarding-path (`/v1/responses`) token decision taken in that phase | PLAN §4 dispositions |
| Credential hygiene in logs | (their diagnostics claim no credentials) | implemented | Only `authPresent` boolean is ever logged; test 6 asserts no secret material in logs; M0/M1 repo+log scans clean | — |

### 1.8 Quota, ledger, billing

| Capability | AutoRouter | Relay status | Evidence / source | Disposition |
|---|---|---|---|---|
| Subscription usage query | `v1/subscription-usage`, `v1/chatgpt-plans` | planned | Official Codex usage endpoint is credentials-phase item #2 (CORE §6.2); mock + metering sources already implemented in `src/quota.js` | Credentials phase |
| API balance query where available | (PLAN §3.3 commits Relay to this) | planned — **checklist fixed 2026-11-06** | PLAN §2/§3.3 promise it; it had been dropped from CORE-REPORT §6's credentials-phase checklist and is now restored there as item 6 | Restored in CORE §6 (see 修复与处置记录) |
| Savings accounting (actual vs. flagship, priced twice) | Per-turn dual pricing; plan turns priced at API rates | implemented (honest form) | Dual ledger (`src/ledger.js`, test 20 reconciliation): cash book = money actually spent, quota book = quota actually burned. The marketing form (subscription turns at API prices) is rejected in LEARNINGS "Adapt" | — |
| Credits system / Stripe checkout / Pro tier | Credits $5–$10,000, Pro unlocks | rejected | LEARNINGS reject: credits-first objective function; PLAN non-goal: no credit reselling | — |
| Invite rewards / credits quests / trials | $20 invite, quests | rejected | LEARNINGS reject: breadth/growth surface | — |
| Enterprise (seats, shared credit, MDM managed config) | Enterprise tier, Managed Preferences | rejected | PLAN §1 non-goal: no teams/enterprise/MDM | — |
| Estimation honesty (estimates labeled, method stated) | Weekly-estimate method documented | implemented | Quota `source` is logged on every decision, carried into the ledger (`quotaSource`), and badged in the dashboard mock; method documented in `src/quota.js` header | — |

### 1.9 Telemetry & data

| Capability | AutoRouter | Relay status | Evidence / source | Disposition |
|---|---|---|---|---|
| Analytics/crash/HUD telemetry (3 vendors, on by default) | Datadog + PostHog + Foglamp | rejected | LEARNINGS reject, explicit; Relay ships zero telemetry, logs are local files | — |
| Local routing history | `~/.autorouter/routing-history/v1` | implemented | `logs/routing.jsonl` — append-only, full decision fields per attempt | — |
| Diagnostics export (metadata + demo events, no bodies/credentials) | In-app diagnostic report | **rejected → G6 (recorded 2026-11-06)** | Relay has only the raw JSONL logs; for the self-use stage those logs are the diagnostics — an export bundle is rejected for now and revisited at the productization fork / M5 | Rejection recorded in LEARNINGS (Reject) + PLAN §4 dispositions |

---

## 2. The six true gaps, in detail

**G1 — Redirect-refusal: true by accident, locked by nothing.**
Every upstream call in `gateway.js` goes through raw `node:http/https`,
which does not follow redirects: a 3xx from a Chat upstream is treated
as a failure and mapped, and in passthrough it is handed back to the
client rather than chased with the `Authorization` header attached. So
today, a credential cannot be 30x'd away. But LEARNINGS lists
redirect-refusal as an adopted M2 control, and nothing in code, tests,
or comments states or pins the property. The risk is a future refactor
(e.g. swapping in `fetch`, which *does* follow redirects and re-sends
headers cross-origin in some configurations) silently removing the
protection exactly when real API keys start flowing. *Disposition:
before the credentials phase* — add one test (mock answers 302 → assert
no follow, no key in the second request) and a comment at the HTTP
layer; ~zero ongoing cost.
**Status 2026-11-06: FIXED** — see 修复与处置记录 (test 30).

**G2 — Error taxonomy too coarse for real providers.**
`classifyFailure` distinguishes quota / filtered / error. With mock
upstreams that sufficed (tests 21/22). With real providers, two more
classes matter: **auth** (401/403 — the *key* is wrong; falling back
through every remaining upstream wastes turns and muddies the log, and
the operator needs an unmistakable signal) and **invalid** (e.g.
`context_length_exceeded`, malformed request — no upstream can serve
it; the chain should stop and surface the original error immediately).
Both currently land in `error` and burn the full fallback chain.
*Disposition: before the credentials phase* — extend `classifyFailure`
with `auth` (fall back at most once, log loudly) and `invalid` (no
fallback, preserve status/body), plus tests mirroring 21/22.
**Status 2026-11-06: FIXED** — see 修复与处置记录 (tests 31–33). One
refinement over the sketch above: an `auth` failure falls back to the
next candidate (each upstream's credential is independent, so the next
one may well work) rather than "at most once" globally; the dead
upstream itself is never retried within the request, and the fallback
is unmistakable in the log as `fallback_auth`.

**G3 — Natural-language routing rules.**
AutoRouter lets users write routing rules in natural language with a
policy editor. Relay's rules are structured cwd-prefix entries in a
JSON file; M4 adds a *structured* editor. The NL form is nowhere in
PLAN/LEARNINGS — a genuine input-form gap, experience-class only (the
underlying rule semantics — pin, sensitive — exist). *Disposition:*
either schedule it after the difficulty v2 judge model exists (the
same small-model call can compile NL → structured rules, with the
compiled form shown to the user before it takes effect), or reject it
explicitly. Do not build a regex "NL" parser.
**Status 2026-11-06: RECORDED** — scheduled in PLAN M4 in exactly the
first form above (NL → structured draft → user confirmation); see
修复与处置记录.

**G4 — Accessibility window binding / composer-UI control.**
AutoRouter traverses other apps' window trees to bind windows to
sessions and operates Codex's composer UI to switch models. Relay has
no trace of this — and almost certainly should not: Relay decides at
the protocol layer (the provider block + `/v1/models`), so UI
automation buys nothing, while costing the Accessibility/Screen
Recording permission surface the reverse report itself flags as risk.
The gap is documentary, not functional: it was never *decided*.
*Disposition: recommend explicit rejection*, recorded in LEARNINGS with
that reasoning, so a future sweep doesn't re-flag it.
**Status 2026-11-06: RECORDED** — rejected in LEARNINGS (Reject
section) and cross-referenced in PLAN §4 dispositions; see
修复与处置记录.

**G5 — Local gateway has no local authentication.**
The gateway listens on `127.0.0.1:18923` and accepts
`POST /v1/responses` and `POST /v1/feedback` from any local process: any
program on the machine can burn the user's quota/cash through Relay or
poison the feedback log. 
...[truncated 3885 chars]
---

## 修复与处置记录（2026-11-06）

Fix pass ordered by the owner after this audit landed ("不要再漏了").
G1/G2 are fixed in code; G3–G6 are recorded dispositions (documents
only, no features built). Statuses in the verdict table (§Verdict) and
the §1 capability tables above were updated in the same pass.

| # | Action | Evidence / landing spot |
|---|---|---|
| G1 | **Fixed.** Redirect policy is now explicit: a `REDIRECT POLICY` comment block at the gateway's shared HTTP layer (`src/gateway.js`, above `upstreamAttempt`) states that credential-carrying requests are never auto-followed to a new host — a 3xx is returned to the client as-is (passthrough) or surfaced as an ordinary failure (translate/routed) — with pointer comments at both passthrough dispatch sites, and a warning against future refactors onto redirect-following clients. | Test **30**: a mock upstream answers 302 + Location at a second mock instance; the gateway returns the 302 status and Location header untouched, the second instance's hit counter (`GET /__hits`) proves the target endpoint was **never contacted**, and the routing log records the 302 attempt cleanly (chosen upstream set, no error). |
| G2 | **Fixed.** `classifyFailure` (`src/upstreams.js`) gains two classes, both dual-condition (status + error-body keywords; the keyword lists `AUTH_BODY_HINTS` / `INVALID_BODY_HINTS` are constants commented as sourced from the common OpenAI-compatible error envelope): **`auth`** — HTTP 401/403 or an auth body hint (e.g. `invalid_api_key`, `authentication_error`): the upstream's credential is dead; the chain falls back (other upstreams' credentials are independent), the next attempt is logged `fallback_auth`, and the dead upstream is never retried within the request. **`invalid`** — HTTP 400 AND a request-fault hint (e.g. `context_length_exceeded`, `invalid_request`): the request itself cannot succeed anywhere, so the gateway (`handleRouted`) stops the chain immediately, returns the upstream error to the client as-is, and logs the attempt with reasonCode `invalid_request_stop` (willFallback false). Check order preserves prior semantics: quota and filtered are classified before auth/invalid, so a 400 `content_filter` refusal (whose type is `invalid_request_error`) stays `filtered`. | Test **31**: mock A returns 401 `invalid_api_key` → chain lands on B, log shows `fallback_auth`, A attempted exactly once. Test **32**: every candidate would return the same context-length error → the chain stops after ONE attempt, the client receives the upstream 400 with code/message intact, log shows `invalid_request_stop`. Test **33**: unit matrix for `classifyFailure` / `fallbackReasonCode` — both new classes, the dual condition (context keyword on a 500 stays `error`), and quota/filtered/error classification unchanged. |
| G3 | **Recorded — scheduled.** Natural-language rules land at the dashboard stage in the form: NL → structured rule draft (compiled by the difficulty-v2 judge-model call) → shown to the user → effective only after confirmation. No regex "NL" parser. | `docs/PLAN.md` M4 entry + "Gap-audit dispositions" subsection in PLAN §4. |
| G4 | **Recorded — rejected.** Accessibility window-matching / composer-UI model switching is explicitly rejected: Relay decides at the protocol layer (provider block + `/v1/models`), so UI automation buys nothing and only widens the Accessibility/Screen-Recording permission surface. | `docs/LEARNING-FROM-AUTOROUTER.md` Reject section (new bullet) + PLAN §4 dispositions cross-reference. Future sweeps must not re-flag. |
| G5 | **Recorded — scheduled.** Local endpoint authentication lands in the credentials phase: management-class endpoints (`POST /v1/feedback`, future admin/config) get a local token; whether the `/v1/responses` forwarding path also requires one (and its client-compatibility cost) is decided in that phase. | `docs/PLAN.md` §4 dispositions subsection. |
| G6 | **Recorded — rejected (self-use stage).** No redacted diagnostics export for now: at self-use stage the local JSONL logs are the diagnostics. Revisit at the productization fork / M5. | `docs/LEARNING-FROM-AUTOROUTER.md` Reject section (new bullet) + PLAN §4 dispositions cross-reference. |
| checklist | **Fixed.** The API balance query (PLAN §3.3) that CORE-REPORT §6 had dropped is restored as checklist item 6 (`source: 'api-balance'` for API-tier upstreams, consumption-only accounting as fallback). | `docs/CORE-REPORT.md` §6 item 6. |

**Self-check (owner's completeness discipline), run at the end of this
pass:**

- `npm test` run twice in a row: **161 passed, 0 failed** both times —
  the pre-existing 136 assertions (tests 1–29) unregressed, plus 25 new
  (test 30 ×4, test 31 ×6, test 32 ×5, test 33 ×10).
- `grep` proves both new reasonCodes exist in code AND in test
  assertions: `fallback_auth` — `src/upstreams.js` (`fallbackReasonCode`)
  + gateway log lines asserted in tests 31/33; `invalid_request_stop` —
  `src/gateway.js` (`handleRouted` stop branch) + asserted in test 32.
- Two findings from this pass, recorded so they are not lost:
  1. Test 30's first run failed (gateway answered 200, not 302) because
     a **stray debug gateway from an earlier phase** (`RELAY_CONFIG=
     /tmp/dbg/cfg.json`, started 03:37) was still holding port 18959 and
     silently served the test's requests. The stray was identified by
     its `/proc` environ and killed; both full-suite runs above are
     post-kill. Lesson: `waitHealth` alone cannot prove the process
     answering is the one just spawned.
  2. This file's own stored copy was found **truncated mid-G5**: §2's
     G5 disposition, the G6 paragraph and §§3–4 are absent, with a
     literal `...[truncated 3885 chars]` marker baked into the file
     where the text should be. The G5/G6 dispositions are therefore
     recorded in full in PLAN §4 / LEARNINGS (above) and in this
     section, so nothing depends on the lost text; restoring the
     missing audit prose is a separate editorial task if the owner
     wants it.
