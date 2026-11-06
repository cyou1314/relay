# Relay Difficulty Axis + Apple-style Dashboard Redesign

Date: 2026-11-06 · Environment: project VM (Linux), Node v24.22.1
Verdict: **PASSED** — 136/136 automated assertions green (the 109 from
M0/M1/core phases untouched and still passing; 27 new), run twice in a
row with identical results. Still zero real credentials: all upstreams
are mocks, all quota values fixtures.

Two deliveries in this phase:

1. **The difficulty axis.** AutoRouter picks models by task complexity
   as well as by quota; Relay's router only had the quota/price axis.
   Now every request is graded `light | standard | heavy` by a local
   heuristic classifier, every configured model carries a capability
   grade, and the router decides (upstream, model) pairs.
2. **The dashboard, redesigned Apple-style** (owner rejected the dark
   v1 mock): light, spacious, SF typography, one accent color.

---

## 1. The classifier (`src/difficulty.js`, v1 heuristics)

`classify(body, { chainDepth }) -> { level, score, signals }`. Pure
local computation, zero external calls. The verdict is explainable:
`signals` lists every signal that fired with its points, and the
gateway writes `{level, score, signals}` into every routing-log line.

| Signal | How measured | Points | Rationale |
|---|---|---|---|
| Input size | Estimated tokens of `input` + `instructions` (chars / 4) | ≥2k:+1, ≥8k:+2, ≥24k:+3, ≥64k:+4 (highest band only) | Context volume is the strongest single correlate of task weight; bands are log-spaced so size alone needs ~24k tokens to matter much |
| Tool count | `tools[]` length | ≥4: +1 (capped) | Agent tooling present = real work, but count alone is a weak signal (every coding agent sends tools) |
| Tool definition size | Serialized `tools` JSON length | ≥6000 chars: +1 | Large function schemas mean a serious agent harness, not a chat turn |
| Code / diff / structured payload | Fenced code block, `diff --git` / unified-diff hunks, or a ≥4000-char JSON payload in the input | +2 | Code and diffs are where weak models actually fail; a bare chat turn never fires this |
| Explicit `reasoning.effort` | `medium` / `high` / `xhigh` | +1 / +2 / +2 | The client's own difficulty claim — the cheapest signal to honor |
| Chain depth | `previous_response_id` chain length (gateway walks its response-parent map) | ≥3: +1, ≥8: +2 | Deep chains carry accumulated state; later turns are rarely trivial |

Level bands: score ≤ 1 → **light** · 2–4 → **standard** · ≥ 5 →
**heavy**. Calibration anchors: "say hello" scores 0 (light); a small
code fix scores 2 (standard); a 100 KB code payload scores 5 (heavy).
No single signal except a truly huge input can reach heavy alone —
heavy requires independent signals to agree. Known bias, stated
plainly: chars/4 *underestimates* CJK-dense input (denser per char), so
the classifier can under-rate a Chinese-heavy request, never inflate
one. v2 calibration (§5) is expected to fix exactly this kind of skew.

Capability grades live in config: each entry of an upstream's `models`
may be `{ "id": ..., "capability": "light|standard|heavy" }`; a bare
string still works and grades `standard` (backwards compatible), and a
pinned dispatch `model` takes its grade from `modelCapability`.
`relay.config.example.json` is graded end-to-end (e.g. codex-plan:
gpt-6-luna = standard, gpt-6-sol = heavy; deepseek-api: deepseek-lite
= light, deepseek-chat = standard).

## 2. Decision order (difficulty × existing rules)

The difficulty axis is layered ON the core-phase rules; no existing
semantic changed. First match wins the lead candidate; the rest of the
list is the fallback chain as before.

| # | Step | Effect | reasonCode |
|---|---|---|---|
| 1 | Sensitive pool restriction | cwd rule `sensitive:true` restricts the pool to subscription tier; empty pool → 403, nothing contacted | `sensitive_block` |
| 2 | cwd pin | Pinned upstream leads regardless of difficulty; model = its cheapest adequate model (else its strongest) | `pinned` |
| 3 | Stickiness (chain's upstream has an adequate model) | Chain stays on its upstream — difficulty re-estimation does NOT move a session; model = cheapest adequate on that upstream | `sticky_session` |
| 3′ | Stickiness exception | Chain's upstream has NO model graded for this level (the heavy-turn case) → session moves to the auto winner | `difficulty_upgrade` |
| 4a | Auto, capability filter | Candidates are (upstream, model) pairs graded ≥ task level; per upstream the model is the cheapest adequate one; tier/quota order = core-phase `orderAuto` | `initial` |
| 4b | Auto, light + preserve | Light task AND every known subscription quota < `settings.preservePct` (default 30) but at least one above the exhaustion floor → API tiers lead, subscriptions become the fallback chain — scarce quota is preserved for heavier work | `difficulty_light_preserve` |
| 4c | Auto, underpowered | NO pair in the pool is graded for this level → strongest models serve anyway (never a refusal, never a silent swap) and the decision is flagged `underpowered:true` in the log | `difficulty_underpowered` |
| 5 | Fallback chain | Later attempts keep their failure-derived codes, unchanged | `fallback_quota` / `fallback_filtered` / `fallback_error` |

Notes on deliberate trade-offs:

- **Stickiness vs. difficulty:** mid-chain difficulty changes do not
  move a session (context continuity beats marginal model fit) — with
  exactly one exception, 3′: serving a heavy turn on an upstream that
  has nothing graded for it would be a silent quality cut, so the
  session upgrades and says so. The generalization is uniform (it also
  fires if a chain pinned to a light-only upstream turns standard),
  because the principle is "never silently under-serve", not "heavy is
  special".
- **Preserve vs. burn-first:** the founding principle is "burn expiring
  quota before cash". Preserve does not repeal it — it only applies to
  *light* tasks and only when subscription quota is *scarce but alive*
  (below 30%, above the exhaustion floor). At 0% there is nothing to
  preserve and the plain exhaustion order already leads with APIs
  (reason stays `initial`, test 15). With ample quota, light tasks burn
  subscription as before (test 28).
- **Precedence inside step 4:** if both 4b and 4c could fire (light
  task, nothing adequate — impossible in practice since every model is
  adequate for light) 4c would win; for upgrades (3′) combined with
  underpowered, `difficulty_underpowered` wins the lead reason because
  "nothing in the pool can do this properly" is the more important
  fact; the `underpowered` flag is on the log line either way.

Every routed log line now carries `difficulty: {level, score,
signals}` and `servedModel` (the specific model dispatched, which may
differ from the client's requested `model`).

## 3. Test evidence

Command: `cd ~/workspace/relay && npm test` → **136 passed, 0 failed**
(two consecutive full runs, identical).

```
tests 1–23  (M0/M1 + core corpus, unchanged semantics)    109 PASS
test 24: classifier — 2 typical requests per level,
         every verdict's signals explain its score         12 PASS
test 25: heavy skips light-only cheap API, lands on the
         heavy-capable premium; log shows difficulty
         heavy + servedModel premium-max                    4 PASS
test 26: heavy with NO adequate model — served by the
         strongest, reason difficulty_underpowered,
         underpowered flag on the log line                  4 PASS
test 27: light + quota 20% (< 30% preserve line, > floor)
         — cheap API leads, reason
         difficulty_light_preserve                          2 PASS
test 28: light + quota 80% — subscription still wins,
         reason initial                                     2 PASS
test 29: chain starts standard on cheap (subscription
         exhausted), follow-up turns heavy — session
         moves to the heavy-capable subscription,
         reason difficulty_upgrade, servedModel sub-max     3 PASS
                                            total         136 PASS
```

One harness fix worth recording: several routed-phase log assertions
read the log file the instant their fetch resolved, racing the
gateway's append (the attempt sends the response, then logs — a
pre-existing latent race that surfaced under this phase's extra
processes). The tests now settle the log file (bounded poll until its
size is stable) before asserting. Assertion semantics are unchanged;
two consecutive full-suite runs are green.

## 4. Dashboard redesign (`ui/dashboard-mock.html`)

Full visual rewrite to the Apple baseline the owner set; the
information architecture is preserved and extended, not reshuffled.

**Kept (same panels, same fixture story):** the three quota cards
(Codex 5-hour window, Codex weekly window, Gemini pool with its
`estimate` badge and `metering-estimate` source); the live routing
stream (time, project, model → upstream, reason, tokens, book,
👍/👎); the dual ledger side by side (cash book / quota book, totals
and per-upstream rows, the "money that actually left the wallet" /
"sunk-cost quota" captions); the rules list (sensitive, pin, default).

**Added (difficulty dimension):** a 难度 column in the routing stream
with three pill badges — 轻 (quiet gray), 标 (blue tint), 重 (orange
tint) — including rows exercising the three new reason codes
(`difficulty_light_preserve`, `difficulty_upgrade`,
`difficulty_underpowered`); a 当前策略 summary card under the header
that states the live policy in one breath (quota state vs. the 30%
preserve line, what light tasks do, what heavy tasks do), worded to
match the fixture state of the cards below it; a 难度轴 entry in the
rules list. The stream's model column now shows the *served* model per
row (deepseek-lite, gemini-3.1-pro, …), mirroring the new `servedModel`
log field.

**Changed (visual language, per the Apple direction):** background
`#f5f5f7`; cards pure white with 20 px radii and two-layer whisper
shadows; SF system font stack with Apple's size ladder (32 px page
title, 17 px section heads, 13–14 px body) and tabular numerals
throughout; single accent `#0071e3` (quota bars, strategy highlight);
status colors are the system green/orange/red at low saturation and
used only for the status dot, bar warnings and the estimate badge;
badges and reason chips are light-tint pills with dark text; table
separators are hairlines with a barely-there row hover. No gradients,
no glow, no dark surfaces anywhere. Copy switched to the owner's
language (Chinese labels, English product terms kept).

## 5. v2 outlook (not implemented)

Once the credentials phase lands, the cheapest adequate API model can
act as a *judge*: sample real requests, have the judge grade them, and
diff its verdicts against this heuristic classifier — that measures
the chars/4 skew (CJK!), the band edges, and which signals actually
predict failure. Until there is data, the thresholds above are honest
v1 guesses and every decision remains auditable from its logged
signals. Also expected in v2: per-model price-aware "cheapest adequate"
(the router currently picks the lowest *capability* adequate model per
upstream; cross-upstream cost is already handled by tier order), and a
capability floor for pins (today an explicit pin wins even when
underpowered — the owner's word beats the classifier, and the
`underpowered` flag still records it).

## 6. Self-check (pre-delivery audit)

Performed per the owner's completeness discipline: the §2 decision
table was walked line by line against the test suite, and the
dashboard was checked element by element against its architecture
list.

**Decision table ↔ tests:**

| §2 step | Covered by | Log assertion includes the reasonCode |
|---|---|---|
| 1 sensitive allowed / blocked | tests 18, 23 | `sensitive_block` ✅ (23); sensitive flag ✅ (18) |
| 2 pin | test 17 | `pinned` ✅ |
| 3 sticky | test 16 | `sticky_session` ✅ |
| 3′ upgrade | test 29 | `difficulty_upgrade` ✅ + servedModel |
| 4a auto + capability filter | tests 14, 15, 25, 28 | `initial` ✅; servedModel ✅ (25) |
| 4b light preserve | test 27 | `difficulty_light_preserve` ✅ + level |
| 4c underpowered | test 26 | `difficulty_underpowered` ✅ + `underpowered:true` |
| 5 fallback chain | tests 21, 22 | `fallback_quota` ✅, `fallback_error` ✅, `fallback_filtered` ✅ |
| classifier (all 3 levels ×2, explainable) | test 24 | score/signals shape ✅ |

Reason-code census: all ten routed reasonCodes (`initial`, `pinned`,
`sticky_session`, `difficulty_upgrade`, `difficulty_light_preserve`,
`difficulty_underpowered`, `fallback_quota`, `fallback_filtered`,
`fallback_error`, `sensitive_block`) appear in at least one log
assertion; `difficulty.level`/`score` and `servedModel` are asserted in
tests 25–29. No rule in §2 lacks a test; no new reasonCode lacks a log
assertion.

**Dashboard IA checklist:** quota cards ✅ (×3, incl. estimate badge) ·
live routing stream ✅ · dual ledger ✅ (both books) · rules list ✅ ·
difficulty badges ✅ (轻/标/重 column, three styles) · strategy summary
✅ (当前策略 card, state-consistent with the cards) · served model per
row ✅ · new reason codes visible in fixture rows ✅. Style negatives
verified by scan: no `linear-gradient`/`radial-gradient`, no dark-theme
colors from v1, no glow shadows; tag balance checked (section/table/
div/ul/script/style all matched).

**Leftovers:** none within this phase's scope. Carried forward from
CORE-REPORT §6 unchanged: the credentials-phase checklist (real
translate acceptance, official Codex quota source, Gemini adapter, key
custody, Mac gates) — and the §5 v2 items above join it.
