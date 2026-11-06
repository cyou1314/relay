# Learning from AutoRouter

Relay exists because we reverse-engineered AutoRouter 0.1.73 (see
`AUTOROUTER-REVERSE-REPORT.md`). It is a well-engineered product; this file
records what we deliberately adopt from it, what we adapt, and what we
deliberately reject — so the borrowing is a design decision, not an accident.

## Adopt (copy the technique)

| AutoRouter technique | Why it's good | Where it lands in Relay |
|---|---|---|
| Managed config blocks with markers (`# BEGIN/END AUTO MANAGED …`), pre-edit backups (`settings-before-auto`), "previous model/status" comments | Host-config edits become provably reversible; uninstall restores the user's original setup byte-for-byte | M1 config manager (already in PLAN §3.5) |
| Dedicated cleanup tool for uninstall (separate binary, restores every touched app) | Uninstall is a first-class feature, not an afterthought | M1/M4: `relay uninstall` path held to the same standard |
| Credential-helper pattern (agent asks a helper for a credential on demand, with a TTL, instead of keys written into config files) | Keys stay in one guarded place; configs only hold references | M2: API keys stay in the keychain; the gateway is the only reader |
| Routing reason codes + decision cache + local routing history | Every decision is explainable after the fact; caching keeps per-turn decisions consistent and cheap | M3: every routing log line carries a reason code; session decision cache |
| Per-turn feedback (👍/👎 on each routing pick) feeding future decisions | Routing quality compounds from real usage instead of static rules | M3/M4: one-click feedback in the dashboard, stored locally, tunes rules |
| Version-compatibility gating (refusing to touch configs of a too-old agent, with a clear message) | Prevents the worst failure class: corrupting a config format you don't understand | M1: Codex version check before any config write |
| Redirect-refusal on credential-carrying HTTP clients; RSA encryption + signed key manifests for credential exchange | Small, cheap defenses exactly where credentials move | M2: all OAuth-carrying clients refuse redirects; catalog integrity pinned |
| Real-time routing toast ("this turn → model X, because Y, cost Z") | Instant trust: the user sees the router work, not just its bill | M4 dashboard live feed (we skip the floating HUD window, not the immediacy) |
| Honest estimation labels (their docs spell out how weekly-meter estimates are split across sessions) | Estimates labeled as estimates, with the method stated | M2: Gemini quota always labeled "estimate" + method note |
| Demo fixtures for UI development (bundled fake traces) | UI can be built and reviewed without touching real data | M4: dashboard ships with fixture mode |
| Signed auto-updates (Sparkle + EdDSA appcast) | Update channel can't be silently hijacked | Productization fork only |

## Adapt (take the idea, fix the incentives)

- **Savings accounting.** AutoRouter prices every turn twice — actual pick
  vs. the app's flagship — which is a good accounting skeleton. But it also
  counts plan turns at API prices, inflating "savings" into a marketing
  number. Relay keeps the two-column method and reports *cash actually
  spent* and *quota actually burned* as separate, honest books.
- **Fail-closed privacy policy.** Their policy copy is genuinely good:
  restricted context may only reach approved private endpoints; if none is
  available, fail closed instead of falling back to a public model. Relay
  adopts this as a user-facing feature: mark a project "sensitive" and it
  can only route to subscription/local upstreams — never third-party APIs.
- **Session identification via the agent's own extension points** (their
  status-line session marker). The principle — ride the agent's official
  extensibility instead of fighting the app — is already Relay's entry
  strategy (Codex's native `model_provider`). For per-session usage
  attribution we read Codex's own session index rather than inventing a
  marker channel.

## Reject (deliberately not learning these)

- **Hosted credentials & cloud routing.** Their core architecture; Relay's
  reason to exist is the opposite (PLAN §1 non-goals).
- **Credits-first objective function.** A router that profits from one of
  the upstreams it routes to cannot be a neutral router.
- **Triple telemetry stack** (three analytics/crash vendors phoning home by
  default). Relay ships zero telemetry; logs are local files the user owns.
- **Breadth over depth** (many agents, enterprise surface, growth quests).
  Relay does one stack deeply.
