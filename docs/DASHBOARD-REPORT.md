# Relay Dashboard — Live Wiring Report

Date: 2026-11-06 · Environment: project VM (Linux), Node v24.22.1
Verdict: **PASSED** — 236/236 automated assertions green (the 161 from
M0–M1 + core + difficulty + gap fixes untouched and still passing, 75
new). The approved design mock (`ui/dashboard-mock.html`: white/gray,
frosted glass, four plain-language blocks, no particles) is now served
by the gateway and bound to real data. No real credential was touched;
acceptance ran on mock upstreams + fixture logs, per the resequencing
decision.

## 1. What was built

| File | Change |
|---|---|
| `src/dashboard.js` (new, ~560 lines) | Status assembly + page. `createDashboard({config, registry, quotaService, logFile, feedbackFile, usdCny})` → `buildStatus()` / `handleStatus` / `handleHtml` |
| `src/gateway.js` | Mounts the dashboard: `GET /`, `GET /dashboard`, `GET /api/status` (works in routed AND legacy mode) |
| `src/ledger.js` | `summarize()` gained optional `fromTs`/`toTs` window (ISO strings) so the dashboard aggregates exactly today's slice with the same code the CLI uses — one aggregation implementation, two consumers |
| `src/config.js` | Optional per-upstream `label` (dashboard display name, e.g. `"Codex"`); falls back to a prettified id |
| `relay.config.example.json` | `label` added for the Codex / Gemini entries |
| `test/run-tests.mjs` | Tests 34–36 (75 new assertions) |

## 2. Endpoints

### `GET /api/status` (JSON)
Every field comes from a real source — nothing is fixture data:
- `quotas[]` — one entry per enabled **subscription** upstream, from
  `src/quota.js`: `{id, name, remainingPct, resetsAt, source, estimate,
  hint}`. `source` is stated verbatim (`mock` / `metering-estimate` /
  `unavailable`); `estimate` is `true` exactly when the source is
  `metering-estimate`, and the page renders the 估算 tag for it.
- `today` — `ledger.summarize()` over today's local-day slice of the
  routing log: `{served, subscriptionServed, cashUsd, cashCny}`.
- `recent[]` — the newest 10 `/v1/responses` log lines, newest first,
  each pre-translated server-side: `{time, model, badge, why, cost}`.
  No reason code and no token count ever reaches the page.
- `strategy` — one plain sentence generated from the live config and
  settings (the preserve threshold in the sentence is
  `settings.preservePct` read at runtime — change the setting and the
  sentence follows).
- `empty` — true when the log holds no `/v1/responses` line at all;
  the page then shows the friendly empty state (还没有记录，等你用
  Codex 干活后，这里会动起来。) instead of any numbers, and `today`
  reports honest zeros.
- `usdCnyRate` — the display rate in effect (see §4).

### `GET /` and `GET /dashboard` (HTML)
The mock's markup/CSS carried over item-for-item (white/gray wallpaper,
frosted-glass cards, rise-in, count-up numerals, growing quota bars,
reduced-motion and no-`backdrop-filter` fallbacks), with fixture values
replaced by live rendering: quota cards are built from `quotas[]` (one
per subscription upstream) plus the API spend card; the summary line,
recent list and strategy sentence all come from `/api/status`. The page
fetches once on load, then silently every **15 s** — refreshes update
numbers and bars in place and never replay the entrance animation or
the count-up. There is no particle layer (tests grep the served HTML
for `canvas`: zero).

## 3. Reason-code → plain-language mapping (server-side)

Successful (2xx) attempts explain the routing choice; failed attempts
explain the failure itself (a failed attempt's code says why it was
*tried*, not why it failed — the status carries that story).

| reasonCode | 页面人话 |
|---|---|
| initial（订阅） | 额度够，先用订阅的 |
| initial（便宜 API） | 订阅额度不够了，用了便宜的 |
| initial（贵 API） | 用了更强的付费模型 |
| pinned | 你给这个项目指定用的就是这家 |
| sticky_session | 接着前面的对话，还用这家 |
| fallback_quota | 前面那家额度用完了，自动换了这家 |
| fallback_filtered | 前面那家把内容拦下了，自动换了这家 |
| fallback_auth | 前面那家登录失效了，自动换了这家 |
| fallback_error | 刚才那家出故障了，自动换了一家 |
| difficulty_light_preserve | 任务简单，订阅额度又剩得不多，先用便宜的，把额度留给复杂任务 |
| difficulty_upgrade | 任务变复杂了，换了更强的 |
| difficulty_underpowered | 任务复杂，但没有更强的可用，先用这家顶上 |
| invalid_request_stop | 这次的内容太长了，哪家都处理不了 |
| sensitive_block | 这个项目被你标了机密，又没有订阅可用，按规矩拦下了 |
| client_abort | 你中途取消了这次 |
| upstream_error | 这家出故障了，没办成 |
| passthrough_default | 直接发给了官方服务 |
| translate_default | 直接发给了这家服务 |
| （未知码兜底） | 按规则自动选择 |
| 失败行 429 | 这家额度用完了，没办成 |
| 失败行 401/403 | 这家登录失效了，没办成 |
| 失败行 400 | 这次的内容不合要求，没办成 |
| 失败行 499 | 你中途取消了这次 |
| 失败行 其他 | 这家出故障了，没办成 |

难度徽章：light → 简单，standard → 普通，heavy → 复杂。
花费列：订阅成功行 = 「用额度」；API 成功行 = ¥ 金额（小于 ¥0.01 显示
「不到 ¥0.01」）；失败行 = 「没花钱」。

Coverage is enforced by test 35's sweep: it traverses the full list of
16 known codes, asserts each owns a distinct plain sentence (and that
`REASON_WHY` owns every code except the tier-dependent `initial`), and
asserts an unknown code degrades to the generic sentence — a future
reason code cannot slip onto the page untranslated without a red test.

## 4. Money display (USD book, ¥ page)

The ledger's book currency stays **USD** — aggregation, prices and
reconciliation are all USD, unchanged. The dashboard converts for
display only: `cashCny = cashUsd × rate`, rate from env
`RELAY_USD_CNY` (default **7.2**), exposed in the JSON as `usdCnyRate`,
and both values are carried side by side (`cashUsd` untouched). Test 34
runs the gateway with `RELAY_USD_CNY=7` and asserts the converted value
($0.00004 → ¥0.00028), proving the rate is configuration, not a
constant; test 35 asserts the default 7.2.

## 5. Acceptance evidence

`npm test` → **236 passed, 0 failed** (161 pre-existing + 75 new):

```
test 34: dashboard endpoints — status numbers reconcile with live traffic   26 PASS
   live routed gateway (mock quota 62% + metering window 150) driven by
   3 real requests (subscription initial / Gemini pinned / cheap pinned):
   quotas[0] = 62% source 'mock' estimate:false;
   quotas[1] = 90% (15 of 150 tokens metered) source 'metering-estimate'
   estimate:true; today = 3 served / 2 subscription / $0.00004 cash;
   recent whys, badges and costs asserted per item; HTML asserted for
   the four blocks, /api/status + 15000 refresh, empty-state sentence,
   and the ABSENCE of canvas / fixture numbers / raw codes.
test 35: status builder vs. a hand-written 12-line fixture log          45 PASS
   today independently recomputed from the lines (10 served, 4
   subscription, $0.00136 cash) and matched to <1e-9; recent capped at
   10 with the per-code 人话 asserted for
   invalid_request_stop / sensitive_block / underpowered / upgrade /
   preserve / fallback_error / fallback_auth / fallback_filtered /
   fallback_quota / sticky_session; 16-code translation sweep (§3).
test 36: empty state — no log file at all                                 4 PASS
   empty:true, recent [], today all zeros, page still carries the
   friendly empty-state sentence.
```

Real `curl` excerpt (demo gateway on :18980, fixture log of 3 lines:
1 subscription initial + 2 cheap-API lines at $0.001/$0.002 per 1k with
usage 20/10 — expected cash 2 × $0.00004 = $0.00008):

```json
{
  "usdCnyRate": 7.2,
  "empty": false,
  "quotas": [
    { "id": "sub-main", "name": "Codex", "remainingPct": 62,
      "resetsAt": "2026-11-06T14:24:00.000Z", "source": "mock",
      "estimate": false, "hint": "今天 14:24 恢复满格" }
  ],
  "today": { "date": "2026-11-06", "served": 3, "subscriptionServed": 1,
             "cashUsd": 8e-05, "cashCny": 0.000576 },
  "recent": [
    { "time": "05:53", "model": "cheap-model",
      "badge": { "key": "hard", "text": "复杂" },
      "why": "前面那家额度用完了，自动换了这家",
      "cost": { "kind": "money", "usd": 4e-05, "cny": 0.000288, "text": "不到 ¥0.01" } },
    { "time": "05:50", "model": "cheap-model",
      "badge": { "key": "easy", "text": "简单" },
      "why": "任务简单，订阅额度又剩得不多，先用便宜的，把额度留给复杂任务",
      "cost": { "kind": "money", "usd": 4e-05, "cny": 0.000288, "text": "不到 ¥0.01" } }
  ]
}
```
Cash reconciles exactly ($0.00008 = 2 × $0.00004; ¥ = ×7.2 display
conversion), and `GET /dashboard` / `GET /` both returned
`200 text/html; charset=utf-8` against the same gateway.

## 6. Leftovers

- **Real quota sources (credentials phase, unchanged from
  CORE-REPORT §6):** the cards already render whatever `quota.js`
  answers — when the credentials phase adds the Codex usage endpoint
  (`source: 'codex-usage'`) and provider balance APIs
  (`source: 'api-balance'`), the `mock` fixtures disappear and
  `metering-estimate` remains only where no official source exists.
  The dashboard needs no change for that swap: provenance and the
  estimate flag are already first-class in the JSON and the page.
- **Rest of M4:** launchd autostart / crash restart and the Mac
  real-machine gate are still open (they belong to the Mac deployment,
  not this VM wiring). The G3 natural-language rule editor remains
  scheduled in M4 as recorded in PLAN's gap-audit dispositions — the
  dashboard's four blocks intentionally have no rule editor yet, per
  the owner's 简洁 requirement.
- **Known approximation:** "today" is the gateway host's local day;
  recent times are host-local HH:MM. Both become the Mac's local time
  in deployment, which is the owner's.
