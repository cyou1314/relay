# Relay M1 — Gateway Core Report

Date: 2026-11-06 · Environment: project VM (Linux), Node v24.22.1, codex-cli 0.162.1
Verdict: **M1 PASSED (with two explicitly unproven items, see §4)** — automated
tests 71/71 green (the original 30 M0 assertions all still pass), config
install/restore proven byte-exact twice (test fixture + real-chain temp
home), and the real chain Codex CLI → Relay (passthrough) ran the proof task
end to end with the provider installed by the config manager — and Codex's
`/v1/models` polling no longer 404s (upstream 200 twice).

## 1. What was built

| File | Lines | Change |
|---|---|---|
| `src/gateway.js` | 562 | + `GET /v1/models`, error mapping, timeouts, single pre-header retry, mid-stream failure termination, reason-coded file routing log |
| `src/config-manager.js` | 216 | NEW — `install` / `restore` / `status` CLI for the Codex provider block, with a Codex version gate |
| `test/mock-upstream.js` | 139 | + scripted failure markers (FAIL_429 / FAIL_500 / FAIL_TIMEOUT / FAIL_ONCE / FAIL_DROP) and `GET /v1/models` |
| `test/run-tests.mjs` | 289 | + tests 7–13 (41 new assertions) |

Still zero dependencies.

### GET /v1/models — approach taken
- **passthrough mode: forward.** The gateway derives `/models` from the
  passthrough `/responses` URL, forwards the request with the caller's
  headers (incl. Authorization) and the original query string
  (`?client_version=…`), and pipes the reply back. Evidence: real-chain log
  shows two `GET /v1/models` polls answered **200** by the real Codex
  backend (ms 3574 / 4101). This is the exact-format path — the backend's
  own rich model metadata reaches Codex untouched.
- **translate mode: synthesize/map.** If env `RELAY_MODELS` (comma list) is
  set it is served verbatim; otherwise the gateway fetches the upstream's
  own `GET /models` and maps the ids into the OpenAI list shape
  (`{object:"list", data:[{id, object:"model", created, owned_by:"relay"}]}`).
  Caveat: the OpenAI list shape is thinner than Codex's native model
  metadata (context windows etc.); passthrough is exact, translate is
  best-effort until M2 wires a real upstream and we can observe what Codex
  actually consumes.

### Error mapping & resilience
- Upstream 4xx/5xx → Responses error shape
  `{error:{message,type,param,code}}`, **status preserved**, upstream
  message/type/code carried through when the upstream sent an OpenAI-style
  error body (verified for 429 and 500 against the mock).
- Per-request upstream timeout, env `RELAY_UPSTREAM_TIMEOUT_MS`
  (default 120000), covering both the wait for headers and a stalled body.
  Timeout before any client output → **504** `relay_upstream_timeout`.
- At most **one retry**, only for failures before upstream response headers
  arrive (connect/DNS/reset/pre-header timeout) and before any byte reaches
  the client. Verified: mock destroys the first connection pre-response,
  the retry succeeds (test 12). Never retried mid-stream.
- Upstream SSE breaking mid-stream → the gateway emits a terminal
  **`response.failed`** event (status `failed`, error code
  `upstream_stream_broken`) and closes the stream — no hanging connection
  (test 11). Non-stream connection failure after the retry → mapped 502.
- Client disconnects are detected and logged (`client_abort`, status 499) —
  and this fired once on the *real* chain (§3), so it is not theoretical.

### Routing log (structured, on disk)
Default path is now `<repo>/logs/routing.jsonl` (env `RELAY_LOG_FILE`
overrides; directory auto-created; `logs/` is gitignored). Every line
carries `ts, path, mode, upstream, model, status, ms, usage, reasonCode,
authPresent`. Minimal reasonCode set, defined in the gateway header:
`passthrough_default`, `translate_default`, `upstream_error`,
`client_abort`. Authorization is still logged only as `authPresent`
boolean — test 6 (M0) still guards this, and the log assertions were
extended to check `reasonCode` on the 429 entry.

### Config manager
`node src/config-manager.js install|restore|status --codex-home <dir>
[--port N] [--codex-bin <path>]`

- **Version gate (install only):** runs `codex --version`; if the binary
  cannot be executed or no semver parses, or the version is < 0.100.0,
  install **refuses and modifies nothing** (negative-tested: config
  untouched, no backup created).
- **Managed blocks:** two marked blocks, because TOML has no "return to
  root table": the one-line `model_provider = "relay"` selection is
  inserted at the top of the file (top-level context), and
  `[model_providers.relay]` is appended at the end (a new table header is
  valid anywhere). Both are wrapped in `# BEGIN RELAY MANAGED …` /
  `# END RELAY MANAGED …`.
- **Backup:** original bytes copied once to `config-before-relay.toml`
  (+ `.meta.json` sidecar recording whether config.toml existed); an
  existing backup is never overwritten. Re-install is idempotent (blocks
  are stripped and rewritten, never duplicated).
- **Conflicts refuse:** a pre-existing top-level `model_provider` or an
  unmanaged `[model_providers.relay]` table makes install refuse with an
  explanation instead of guessing.
- **Restore:** writes the backup back (or removes config.toml if it did
  not exist at install time) and deletes backup + sidecar.

## 2. Automated test evidence

Command: `cd ~/workspace/relay && npm test` → **71 passed, 0 failed**

```
tests 1–6  (M0 corpus, unchanged)                 30 PASS
test 7:  GET /v1/models mapped from upstream       5 PASS (200, list shape, both mock ids)
test 8:  upstream 429 -> Responses error           6 PASS (status kept, msg/code carried, log reasonCode=upstream_error)
test 9:  upstream 500 -> Responses error           2 PASS (status kept, code carried)
test 10: upstream timeout -> 504                   3 PASS (type relay_upstream_timeout, returned in ~1.2s vs 3s upstream delay)
test 11: SSE drop mid-stream -> response.failed    4 PASS (failed is terminal, no completed, error attached, no hang)
test 12: pre-header failure retried once           4 PASS (drop-once recovers 200; hard drop -> mapped 502)
test 13: config manager                            17 PASS (version-gate refusal ×3, install, markers,
                                                         user content preserved, backup byte-exact,
                                                         idempotent re-install, status, restore byte-exact,
                                                         backup removed, status unmanaged)
```

## 3. Real-chain evidence (passthrough, live Codex)

Setup — no hand-written config this time:

- Temp `CODEX_HOME=/tmp/relay-m1-home`, `auth.json` copied (0600, contents
  never printed), initial `config.toml` = two user lines
  (`model = "gpt-6-luna"`, `model_reasoning_effort = "low"`, sha256
  `3a133655…92d2`).
- `config-manager install` → version gate read Codex **0.162.1**, backup
  created, both managed blocks written (selection block on top, provider
  table at the end); `status` reports `managed: true, provider: "relay"`.
- Gateway: `RELAY_MODE=passthrough`, log at `/tmp/relay-m1-gateway.log`.
- Same task as M0: `codex exec --skip-git-repo-check -s workspace-write
  "echo relay-m1-ok > proof.txt; read it back; reply with only its
  contents"` in `/tmp/relay-m1-work`.

Result: **exit 0**, `proof.txt` contains `relay-m1-ok`, final reply
`relay-m1-ok`, 22,850 tokens used.

Gateway routing log for the run:

```
/v1/models    status 200  passthrough_default        ms 3574
/v1/models    status 200  passthrough_default        ms 4101
/v1/responses status 499  client_abort  gpt-6-luna   ms 2946
/v1/responses status 200  passthrough_default  gpt-6-luna  ms 2746
/v1/responses status 200  passthrough_default  gpt-6-luna  ms 1445
```

Notes: `/v1/models` is now served (200, twice — Codex polls it more than
once per session). One `/v1/responses` request was **aborted by Codex
itself** (499/client_abort, before the two successful task requests);
Codex evidently cancels a preliminary request — harmless here, and it
proves the abort logging works against the real client.

Afterwards: `config-manager restore` on the temp home → config.toml sha256
back to `3a133655…92d2`, **byte-identical to the pre-install file**. The
real `~/.codex/config.toml` sha256 was recorded before and after the whole
exercise — **unchanged** (it was never touched). Log + repo scan for JWT /
Bearer material: clean. Gateway stopped, port closed.

## 4. PLAN M1 acceptance, item by item

| PLAN M1 item | Status | Evidence |
|---|---|---|
| SSE streaming translation (full protocol layer) | ✅ Proven (M0 corpus + M1 failure paths) | tests 4, 5, 11 |
| Error mapping | ✅ Proven | tests 8, 9, 12; mapping table in §1 |
| Timeouts / retries | ✅ Proven | tests 10, 12 |
| Config manager: managed block write / backup / restore | ✅ Proven | test 13; real-chain install + restore |
| Structured routing log | ✅ Proven — **as JSONL, not SQLite** | tests 6, 8; §1. Deliberate deviation: zero-dependency JSONL continues the M0 format and is greppable/append-only; SQLite can be layered on in M4 when the dashboard needs queries, without changing the line schema |
| Accept: install/restore leaves a clean `config.toml` diff | ✅ Proven byte-exact | sha256 equality in test 13 and in the real-chain temp home |
| Accept: a full day of daily use without a broken stream | ⏳ **Not yet provable** | Requires daily use on the user's Mac (M1/M2 real-machine gate per plan); VM evidence covers protocol correctness, not a day of load |
| (from M0 recommendations) translate mode vs a *real* Chat upstream | ⏳ **Still open** | Needs one real API key (first target: DeepSeek via Zro) via secure entry; scheduled as the first M2 step |

## 5. Leftovers / known limitations

1. Translate-mode `/v1/models` returns the thin OpenAI list shape; Codex's
   native metadata (context window, reasoning levels) is richer. Unknown
   until M2 whether Codex cares when the provider is a translated API.
2. Passthrough mode does not proactively tear down the upstream request
   when the client aborts mid-pipe (it logs `client_abort`; the upstream
   stream ends on its own or via the body timeout). Worth tightening in M5.
3. Retries apply to POST /v1/responses as a whole-request unit: a
   pre-header failure means the upstream sent nothing, but a non-id
...[truncated 2705 chars]