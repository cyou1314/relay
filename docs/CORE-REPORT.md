# Relay Core Phase — Registry, Router, Dual Ledger (mock-credential stage)

Date: 2026-11-06 · Environment: project VM (Linux), Node v24.22.1
Verdict: **PASSED** — 109/109 automated assertions green (the M0/M1 corpus of
71 is untouched and still passes), every routing rule in PLAN §3 exercised
against mock upstreams, the dual ledger reconciled line-by-line with the
routing log, and a fixture dashboard mock delivered for owner review.
Per the 2026-11-06 resequencing note, **no real credential, login or API
key was touched in this phase**; all upstreams and quota sources are mocks
or local metering.

## 1. What was built

| File | Lines | Role |
|---|---|---|
| `src/config.js` | ~110 | Config loader: `RELAY_CONFIG` or `<repo>/relay.config.json`; validation/normalization; absent file → legacy M1 behavior |
| `src/upstreams.js` | ~90 | Upstream registry, dispatch-target resolution (API key read from the env var NAMED in config), failure classification (quota/filtered/error), cash pricing |
| `src/quota.js` | ~105 | `getQuota(id) → {remainingPct, resetsAt, source}` with sources `mock` (fixture file, re-read per call), `metering-estimate` (tokens metered in the routing log vs. a window budget), `unavailable` |
| `src/router.js` | ~120 | Pure routing decisions: priority ordering, stickiness, pins, sensitive fail-closed |
| `src/ledger.js` | ~130 | Dual ledger aggregation + `node src/ledger.js summary` CLI |
| `src/gateway.js` | 562 → ~940 | Routed mode on top of refactored attempt functions; per-attempt logging; `POST /v1/feedback`; routed `/v1/models` |
| `relay.config.example.json` | — | Example registry: passthrough subscription, metering subscription, cheap + premium APIs (keys only as env-var names; placeholder hosts) |
| `test/mock-upstream.js` | +env knobs | `MOCK_TEXT / MOCK_USAGE_IN/OUT / MOCK_FAIL_STATUS+CODE+MESSAGE / MOCK_MODEL_IDS` — defaults identical to M0/M1 |
| `test/run-tests.mjs` | +tests 14–23 | 38 new assertions (see §3) |
| `ui/dashboard-mock.html` | ~200 | Static fixture dashboard design mock (§5) |

Still zero dependencies. The translate/passthrough wire code was refactored
into *attempt* functions that return outcomes (`success / failure /
stream_broken / client_abort`) instead of logging and responding on their
own; the legacy env-mode handlers are thin wrappers over them, which is
why the M0/M1 corpus passes byte-for-byte in behavior.

### Routed-mode request flow
1. Parse body; take a quota snapshot of all enabled upstreams.
2. `router.decide()` → ordered candidates (or a fail-closed block).
3. Attempts walk the candidates. Error statuses are captured **before any
   byte reaches the client**, so a fallback is still possible; once a 2xx
   stream starts it is piped (tapped for response id + usage) and cannot
   fall back — a mid-stream break terminates with the M1 `response.failed`
   semantics and is logged `upstream_error`.
4. Every attempt logs one JSONL line: `requestId, attempt, chosen,
   reasonCode, quota snapshot {remainingPct, source, resetsAt}, status,
   usage (success only), error code, willFallback`.
5. On success the chain is remembered: `previous_response_id → upstream`.

## 2. Routing rules — implementation vs. PLAN §3

| Rule (PLAN) | Implementation | Evidence |
|---|---|---|
| Priority: soonest-resetting ample subscription > subscription flagship > cheap API > premium API (§3.2) | `router.orderAuto`: subscriptions grouped ample → low → (exhausted sinks below all API tiers), ample sorted by `resetsAt` ascending; API tiers price-ascending | tests 14, 15 |
| Session stickiness (§3.1) | Chain keyed by `previous_response_id` (fallback: a stable `session-id`/`x-session-id` header); the remembered upstream leads the candidate list with reason `sticky_session`; failure is the only way off | test 16 |
| Per-directory pins beat policy (§3.2) | First matching `rules[].cwdPrefix` with `upstream` leads with reason `pinned`; remaining candidates stay as its fallback chain | test 17 |
| Sensitive projects fail closed (LEARNINGS adapt) | `sensitive:true` rule restricts the pool to `tier:"subscription"`; empty pool → HTTP 403, error code `sensitive_block`, log reasonCode `sensitive_block`, **no upstream is contacted**; with a subscription available it routes there and the log line carries `sensitive:true` | tests 18, 23 |
| Quota truth & estimation honesty (§3.3) | Every decision logs the quota snapshot incl. `source`; unknown quota (`unavailable`, `remainingPct:null`) is treated as available and never blocks routing | tests 14 (snapshot), all phases run with `unavailable` API quotas |
| Fallback chains (§3.1/§3.6) | Failure classification: 429 / `insufficient_quota` / quota wording → `fallback_quota`; content-filter / safety-policy refusal → `fallback_filtered`; anything else → `fallback_error`. Final failure surfaces the last upstream's mapped error with its status preserved | tests 21, 22 |
| Transparent failure (§3.6) | Failed attempts are logged with the same `requestId` and `willFallback` flag; nothing is silently swapped | test 21 (3 attempts, 1 request) |

**Stickiness approximation (stated plainly):** Responses chains are linked
by `previous_response_id`, but the gateway only learns a response's id
from the reply itself (JSON body or the tapped SSE `response.completed`
event). The chain map is in-memory: a gateway restart forgets chains and
the next request re-decides from policy — consistent with §3.1 defining
switches at session start. **cwd approximation:** Responses requests carry
no standard cwd field, so Relay checks `metadata.cwd`, then the
`x-relay-cwd` header, then `RELAY_DEFAULT_CWD`; no cwd → no rule matches.

**Bug found and fixed during this phase:** the first `orderAuto` sorted
exhausted subscriptions last *within* the subscription tier but still
concatenated the whole tier before the API tiers, so an exhausted
subscription kept winning (test 15 caught it: quota snapshot showed 0%
yet the subscription served). Fixed by sinking known-exhausted
subscriptions below every API tier while keeping them as last-resort
candidates.

## 3. Test evidence

Command: `cd ~/workspace/relay && npm test` → **109 passed, 0 failed**

```
tests 1–13  (M0/M1 corpus, unchanged)                71 PASS
test 14: ample quota → subscription, snapshot logged  5 PASS
test 15: quota at 0% → cheap API                      2 PASS
test 16: chain stays on subscription at 0% (sticky)   3 PASS
test 17: cwd pin → premium, reason pinned             2 PASS
test 18: sensitive + subscription available           3 PASS
test 19: feedback up/down recorded, junk → 400        4 PASS
test 20: dual ledger reconciles with the log          6 PASS
test 21: fallback 429(quota) → 500 → premium          6 PASS
test 22: filter refusal → fallback_filtered           3 PASS
test 23: sensitive, no subscription → 403 closed      4 PASS
                                            total     109 PASS
```

Rule-by-rule verdict: priority ✅ (ample and exhausted directions),
stickiness ✅, pin override ✅, sensitive allowed ✅, sensitive
fail-closed ✅ (plus a control request proving non-sensitive traffic on
the same gateway still routes), quota fallback ✅, error fallback ✅,
filter fallback ✅, per-attempt logging ✅.

## 4. Ledger reconciliation evidence

Test 20 recomputes both books **independently** from the phase-A routing
log and the config price table, then compares against
`node src/ledger.js summary` output: served-request count, cash total
(to <1e-9 USD), and quota-book tokens all equal; the books are disjoint
(subscription id absent from cash, API ids absent from quota); feedback
counts match the feedback file.

The phase-A dataset behind it (mock usage is fixed per instance, so the
figures are exact): 6 served requests — subscription 3 × (10 in / 5 out)
= **45 quota tokens**; cheap API 1 × (20/10) at $0.001/$0.002 per 1k =
**$0.00004**; premium 1 × (30/15) at $0.01/$0.02 per 1k = **$0.0006**;
**cash total $0.00064**. Feedback recorded in the same run: up 1, down 1
(the invalid verdict was rejected and not counted).

Quota-book entries also carry the current remaining-quota estimate and
its `source` when a quota source answers, so the dashboard never shows
an estimate without its provenance.

## 5. Dashboard design mock

`ui/dashboard-mock.html` — a single self-contained file (no external
assets), openable by double-click, rendering fixture data in the exact
panels the live dashboard (M4) will bind to ledger output + the routing
log:

- **Quota cards:** Codex 5-hour window and weekly window (official
  source), Gemini pool with an explicit `estimate` badge and
  `metering-estimate` source label.
- **Live routing stream:** time, project, model → upstream, reason-code
  chips (initial / sticky_session / pinned / fallback_quota /
  fallback_filtered / sensitive_block), tokens, and which book the turn
  landed in (quota vs. cash amount), plus 👍/👎 marks.
- **Dual ledger panels:** cash book and quota book side by side, with the
  "money that actually left the wallet" / "sunk-cost quota" captions.
- **Rules list:** sensitive and pin rules with badges, plus the default
  policy line.

Style: dark, restrained, dense, tabular numerals — no gradients, no
decoration. This is the owner's design-review artifact; live wiring is
M4 work and was deliberately not started.

## 6. Leftovers & the credentials-phase checklist

Deliberately not done here (by the resequencing decision), in the order
the final phase should take them:

1. **First real Chat upstream (translate acceptance debt from M1):** one
   real API key via secure entry (target: DeepSeek via Zro), run the
   proof task through `translate` against it; observe what Codex does
   with the thin `/v1/models` shape from a real provider.
2. **Real quota source for Codex:** implement the official usage
   endpoint as a `quota.js` source next to mock/metering (the interface
   already returns `{remainingPct, resetsAt, source}`; add
   `source:'codex-usage'`), reading the local Codex sign-in state only.
3. **Gemini pool adapter:** Antigravity OAuth as a `chat`-kind upstream
   variant (or a dedicated kind if its wire format demands it), with
   metering validated against the pool's real windows; API-key fallback
   path kept from the plan.
4. **API key custody:** keys enter via secure entry and live in the OS
   keychain; the gateway reads them through the `apiKeyEnv` indirection
   (or a keychain helper) — config files keep holding names, never keys.
5. **Mac real-machine gates:** `config-manager install` against the real
   `~/.codex`, launchd daemon (M4), the full-day no-broken-stream
   acceptance, and dashboard live wiring (M4) on top of the approved
   mock in §5.
6. **API balance query (PLAN §3.3):** where an API provider exposes a
   balance/credit endpoint, wire it as a quota source for API-tier
   upstreams (`source: 'api-balance'`) so the cash book gains a
   provider-side cross-check; consumption-only accounting stays the
   fallback where no such endpoint exists. *(This item was dropped from
   this checklist when the core phase closed and was restored by the
   2026-11-06 gap audit — see `docs/GAP-AUDIT.md`.)*

Known limitations carried forward: routed passthrough keeps no internal
retry (the fallback chain owns recovery); the sticky-chain map is
in-memory; metering-estimate accuracy is bounded by the configured
window size; mid-stream failures cannot fall back by construction.
