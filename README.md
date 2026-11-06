# Relay

A local-first model router for AI coding agents.

Relay sits between your coding agent and your model providers. Every request
goes to a gateway running **on your own machine first**, and the gateway picks
the upstream per request: burn the subscription quota that expires anyway
(ChatGPT plan via Codex, Gemini via Antigravity), and only spend pay-as-you-go
API money (DeepSeek and other OpenAI-compatible APIs) when the subscriptions
run out or don't fit the task.

## Why

- Subscription quotas (5-hour and weekly windows) are sunk cost — unused quota
  is wasted money. API calls are marginal cost. A router should spend sunk
  cost first.
- Switching models/providers by hand inside each agent is friction, and every
  agent has a different config format.
- Your credentials should never be hosted on someone else's server to do this.

## Principles

1. **Local-first.** The gateway, the routing decisions, the logs and the
   credentials all stay on your machine. Nothing is uploaded.
2. **Credentials never leave the device.** OAuth tokens are read from the
   agent's existing local sign-in state and refreshed locally. API keys live
   in the OS keychain.
3. **Quota-first routing.** Resetting subscription quota > subscription
   flagship models > cheap APIs > premium APIs. User rules (e.g. pinning a
   model per project) beat automatic policy.
4. **Session stickiness.** A session never changes models mid-flight (context
   and prompt-cache coherence), except when an upstream fails — and every
   fallback is logged and shown, never silent.
5. **Reversible install.** The only host config Relay touches (Codex
   `config.toml`) is edited in a marked managed block, backed up first, and
   restored cleanly on uninstall.

## Scope

- **Entry point (v1):** Codex (desktop + CLI), via its native custom
  `model_provider` support pointing at the local gateway
  (OpenAI Responses API in, Chat Completions / Gemini protocols out).
- **Upstream pool (v1):**
  - ChatGPT plan (Codex OAuth, local sign-in state)
  - Gemini pool (Antigravity OAuth; API-key fallback)
  - Generic OpenAI-compatible APIs (config-only to add: base URL + key +
    price table)
- **Not in scope:** Claude/Claude Code integration, cloud hosting of any
  kind, credential sharing, team/enterprise features.

## Status

Planning. The design and milestone plan live in
[docs/PLAN.md](docs/PLAN.md) (M0–M5; a working version lands at the end of
M2). Background research: a static reverse-engineering report of a comparable
commercial product is archived in
[docs/AUTOROUTER-REVERSE-REPORT.md](docs/AUTOROUTER-REVERSE-REPORT.md).

## Roadmap (summary)

| Milestone | What | Done when |
|---|---|---|
| M0 | Protocol spike: Codex → gateway → one API upstream | A multi-step Codex task with tool calls passes end to end |
| M1 | Gateway core: streaming translation, config manager, routing log | A full day of daily use without a broken stream; install/restore diff-clean |
| M2 | Full pool: ChatGPT plan + Gemini + generic APIs, quota ledger | All three upstreams serve real tasks; quota visible |
| M3 | Router v1: priority rules, stickiness, fallback chains, savings math | Exhausted quota auto-falls to the next tier, logged |
| M4 | Local dashboard + launchd daemon | Survives reboot; dashboard reconciles with logs |
| M5 | Hardening | Ongoing |
