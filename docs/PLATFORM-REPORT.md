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


## Mac 真机部署（2026-11-06，已完成）

按 `deploy/DEPLOY-MAC.md` 在用户 Mac（jay的MacBook Pro）执行完毕，证据链：

- Mac 本地克隆仓库，测试 **297/297** 通过（Node v26.13.0）。
- launchd `com.muse.relay` 已加载常驻（RunAtLoad + KeepAlive），`GET /api/status` 与 `/dashboard` 均 200。
- config-manager install 成功：真 `~/.codex/config.toml` 只新增首尾两个 Relay 托管段，备份 `~/.codex/config-before-relay.toml` 在位；status 显示 managed:true、provider:relay、baseUrl http://127.0.0.1:18923/v1。
- 真链：在 `~/relay` 下 `codex exec` 经 Relay 回复 `relay-mac-ok`（退出码 0），证明文件一致；路由日志对应行 mode:routed、upstream/chosen:`codex-plan`、status 200、quota.source:`codex-usage`（验收脚本曾误写字段名 provider/codex-subscription，以日志原样为准）。
- 桌面版 Codex 新对话已在 Relay 下正常工作（会话粘性 sticky_session）；旧对话打开时应用会提示「此聊天使用 openai，当前提供商是 relay」，点切换即可继续——属切换默认提供商后的预期行为，非故障。

遗留小问题（已立项）：桌面版 Codex 曾报一次模型列表刷新解码失败（`failed to decode models response`，body 307 bytes），疑似桌面版对 `/v1/models` 响应格式要求比 CLI 更严；对话功能不受影响，待专项核查后修复并补测试。

部署中确认的 Mac 环境事实（已同步修订 DEPLOY-MAC.md）：该机 Codex 桌面会话的 shell PATH 不含 `/Users/cyou/node/bin`，命令须带 PATH 前缀或绝对路径；`codex exec` 须在受信任目录（git 仓库）内运行，/tmp 会被信任检查拒绝。


### 模型列表解码问题：已修复（2026-11-06，待 Mac 更新后复验）

根因确认：桌面版 Codex（0.167）的模型管理器按 Codex 后端格式解析 `/v1/models`，期望 `{models:[ModelInfo]}`；Relay 此前只返回 OpenAI 的 `{object:"list", data:[…]}`，缺 `models` 字段，serde 在正文末尾报 missing field——与实测「column 307 = 307 bytes 正文末尾」吻合。对照源码为 openai/codex `rust-v0.167.0` 的 `codex-rs/protocol/src/openai_models.rs`：ModelInfo 的必填字段共 10 个（slug、display_name、supported_reasoning_levels、shell_type、visibility、supported_in_api、priority、support_verbosity、truncation_policy、experimental_supported_tools），其余均有默认值或为 Option。

修法：`/v1/models`（routed 与 translate 两种模式）同时返回 `data[]` 与 `models[]` 两套形状，`models[]` 每项带齐全部必填字段。新增 4 项测试锁定（总数 301/301）。Mac 侧待 `git pull` + 重启 launchd 后复验桌面报错消失。
