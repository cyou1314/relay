# Relay — Plan (local-first, Codex + Gemini + APIs)

Status: planning draft, not started. Companion research:
`docs/AUTOROUTER-REVERSE-REPORT.md` (static analysis of a comparable
commercial product, AutoRouter 0.1.73).

## 1. Goal / non-goals

**Goal.** A model router that runs entirely on the user's Mac. Requests from
Codex hit a local gateway first; the gateway routes per request by
*quota → capability → price*: burn expiring subscription quota first
(ChatGPT plan, Gemini/Antigravity quota), fall back to pay-as-you-go APIs
(DeepSeek via OpenAI-compatible endpoints, etc.) only on overflow or
mismatch. No manual model/provider switching; subscription quota stops
going to waste; API spend is capped and accounted.

**Non-goals (deliberate cuts vs. the commercial reference product).**

- No Claude support (no Claude Code takeover, no Claude Desktop, no
  Anthropic subscription hosting).
- No cloud: credentials never leave the machine; no hosted accounts, no
  credit reselling, no subscription sharing.
- No closed agents as entry points (e.g. Antigravity's own agent loop);
  Gemini is a model pool, not an entry point, in v1.
- No teams/enterprise/MDM. No floating HUD in v1 (a local web dashboard
  instead).

## 2. Architecture (all local)

```
Codex (desktop / CLI)
  │  config.toml: model_provider → local gateway (native extension point)
  ▼
Local gateway (Node.js + TypeScript, launchd daemon, user's Mac)
  ├─ Protocol layer: OpenAI Responses API in;
  │    ⇄ Chat Completions / Gemini translation (incl. streaming SSE, tools)
  ├─ Router: rules + quota state + price table + session stickiness
  │    + failure fallback chains
  ├─ Upstream adapters:
  │    A. ChatGPT plan (Codex OAuth from local sign-in state)
  │    B. Gemini pool (Antigravity OAuth; API-key fallback)
  │    C. Generic OpenAI-compatible APIs (config-only to add)
  ├─ Quota ledger: official Codex usage endpoint + gateway's own metering
  │    + API balances where queryable
  └─ Storage: local SQLite (routing log / usage / savings). Nothing leaves.
Local dashboard (served by the gateway): quota, routing history,
spend/savings, rule editing.
```

Stack rationale: Node/TS matches the Codex/Gemini tooling ecosystem; daemon
hosting follows the launchd pattern already proven locally; the listen port
is chosen after checking the machine for conflicts.

## 3. Design decisions (fixed up front)

1. **Session stickiness.** Never switch models mid-session (context and
   prompt-cache coherence); switching happens at session start or on
   upstream failure (429 / quota exhausted / safety-filter block).
2. **Priority.** Soonest-resetting ample subscription quota > subscription
   flagship > cheap API > premium API. Per-directory user pins override.
3. **Quota truth.** Codex: official usage endpoint (5 h + weekly windows).
   Gemini: gateway metering estimate where no stable official quota API
   exists, labeled as an estimate. APIs: balance query where available,
   otherwise consumption-only accounting.
4. **Credential boundary.** OAuth tokens are read from existing local
   sign-in state (Codex `auth.json`, Antigravity credential store) and
   refreshed locally. API keys in the OS keychain. No credential is ever
   logged or committed.
5. **Reversible install.** `~/.codex/config.toml` is edited in a marked
   managed block with a pre-edit backup and one-command restore.
6. **Transparent failure.** Every fallback is logged and surfaced (original
   upstream, failure reason, landed upstream). No silent model swaps.

## 4. Milestones

> **Resequencing note (2026-11-06, project owner decision).** Build the
> whole product first; real logins/APIs last. Concretely: the router core
> (adapter abstraction, routing engine, accounting, dashboard) is built and
> accepted entirely against mock upstreams and mock quota sources. Real
> credential integrations — API keys, Gemini OAuth, the ChatGPT quota
> endpoint — move to a final phase (M5-Credentials) after the product
> stands. The passthrough upstream is exempt: it rides Codex's own existing
> sign-in and needs no new login.

### M0 — Protocol spike (0.5–1 d)
Minimal gateway: Codex → gateway → one OpenAI-compatible API upstream,
Responses ⇄ Chat Completions translation (text + tool calls + streaming).
**Accept:** a multi-step Codex task with tool calls passes end to end;
disabling the gateway returns Codex to its original provider losslessly.
This is the project's biggest technical unknown; if it fails, stop here.

### M1 — Gateway core (2–3 d)
Full protocol layer (SSE streaming translation, error mapping,
timeouts/retries), config manager (managed block write/backup/restore),
structured routing log (SQLite).
**Accept:** a full day of daily use with no broken streams; install/restore
leaves a clean `config.toml` diff.

### M2 — Full upstream pool (2–4 d)
Adapter A: ChatGPT plan via local OAuth + official usage quota.
Adapter B: Gemini pool via Antigravity OAuth (with an API-key downgrade
path reserved if OAuth proves unstable). Adapter C: config-driven generic
APIs.
**Accept:** all three upstreams serve real Codex tasks; dashboard shows
Codex dual-window quota and Gemini estimated quota. *First usable version.*

### M3 — Router v1 (2–3 d)
Priority rules (§3.2), session stickiness, fallback chains (429 / quota /
safety-filter), per-directory pins, price table and "would-have-spent vs.
spent" savings math.
**Accept:** exhausting one tier moves the next new session down a tier,
logged with reasons; a Gemini filter block reroutes and completes the task.

### M4 — Dashboard & daemon (1–2 d)
Local web dashboard (quota, routing history, spend/savings, rule editor),
launchd autostart + crash restart.
**Accept:** gateway survives a reboot and Codex notices nothing; dashboard
reconciles with the routing log.

### M5 — Hardening (ongoing)
Codex version-compat checks (config format drift), Gemini OAuth path
health + downgrade notices, long-task stability. Later candidates:
small-model classifier routing (v2), other agents as entry points, HUD.

### Productization fork (after M4, separate decision)
Only after the personal version is proven: naming/branding, signing &
notarization, auto-update, and whether a public distribution keeps the
pure-local shape. This decision blocks nothing in M0–M5.

## 5. Risks

| Risk | Note | Mitigation |
|---|---|---|
| Protocol translation | Responses tool calls / reasoning items vs. Chat Completions & Gemini formats; streaming is the fragile part | M0 spike first; a translation test corpus |
| ChatGPT plan backend is unofficial | The Codex backend endpoint is not a public API; working precedents exist but it can change | Adapter isolation; degrade to "Codex native direct, gateway routes the rest" |
| Gemini OAuth path instability | Unofficial channel; known account-eligibility and probabilistic safety-filter issues | API-key fallback + filter-triggered rerouting; quota labeled as estimate |
| Subscription terms | Personal-quota self-use through a local gateway is a different shape from hosted credential sharing, but remains the user's own risk call | Local-only, single-user, no sharing by design |
| Codex config drift | Codex updates may change `config.toml` | Minimal managed block + version check + restore safety net |
| Duplicating existing switchers | Manual multi-provider switching already exists elsewhere | Relay's only claimed delta: automatic, quota-aware selection; M3 acceptance tests exactly that |
