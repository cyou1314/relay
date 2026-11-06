# Relay M0 — Protocol Spike Report

Date: 2026-11-06 · Environment: project VM (Linux), Node v24.22.1, codex-cli 0.162.1
Verdict: **M0 PASSED** — automated translation tests 30/30 green, and the real
chain Codex CLI → Relay gateway (passthrough) → ChatGPT Codex backend ran a
tool-using task end to end on the first attempt.

## What was built

| File | Lines | Role |
|---|---|---|
| `src/gateway.js` | 351 | Zero-dependency gateway on `127.0.0.1:18923` (env `RELAY_PORT`), `POST /v1/responses`, `GET /health` |
| `test/mock-upstream.js` | 88 | Scripted Chat Completions upstream (text / one tool call / streamed chunks) |
| `test/run-tests.mjs` | 161 | Automated tests (`npm test`): spawns gateway + mock, asserts both modes of the translation |
| `package.json` | — | `npm start` (gateway), `npm test`, `npm run mock` |

Gateway modes (env `RELAY_MODE`):

- **passthrough** — raw body forwarded to
  `https://chatgpt.com/backend-api/codex/responses` (override:
  `RELAY_PASSTHROUGH_URL`), caller's headers (incl. Authorization) passed
  through, response status/headers/SSE stream piped back byte-for-byte.
- **translate** — Responses request translated to Chat Completions
  (instructions→system, input items→messages incl. `function_call` /
  `function_call_output`, flat Responses tools→nested Chat tools,
  `max_output_tokens`→`max_tokens`, stream→`stream_options.include_usage`),
  sent to `RELAY_UPSTREAM_BASE`; the Chat reply is translated back:
  non-stream JSON rebuilt as a Responses object, and streamed chunks run
  through a state machine emitting Responses SSE events
  (`response.created` → `output_item.added` → `output_text.delta` /
  `function_call_arguments.delta` (arguments assembled across fragments) →
  `output_item.done` → `response.completed`, with usage mapped
  prompt/completion→input/output tokens).

Routing log: one JSON line per request (stderr + `RELAY_LOG_FILE` if set)
with mode/upstream/status/ms/usage. Authorization is logged only as
`authPresent: true|false` — never the value (asserted by test 6).

## Automated test evidence

Command: `cd ~/workspace/relay && npm test`

```
gateway + mock upstream up
test 1: non-stream text            5 PASS (status/object/completed/text exact/usage mapped)
test 2: non-stream tool call       5 PASS (function_call item, name, call_id passthrough, arguments assembled)
test 3: tool-result roundtrip      1 PASS (mock received role:"tool" message and its content round-tripped)
test 4: streaming text             10 PASS (created→delta→completed order, delta concat = full text, usage, sequence numbers)
test 5: streaming tool call        5 PASS (arguments deltas assemble to {"text":"hello-from-tool"}, completed output correct)
test 6: routing log + hygiene      4 PASS (>=5 JSON lines, mode recorded, NO authorization secret in log)
RESULT: 30 passed, 0 failed
```

## Real-chain evidence (passthrough, live Codex)

Setup (original `~/.codex` never modified — mtime/content verified after):

- Temp `CODEX_HOME=/tmp/relay-codex-home` with a *copy* of `auth.json`
  (0600, contents never printed) and a `config.toml` defining
  `model_provider = "relay"` → `[model_providers.relay] base_url =
  "http://127.0.0.1:18923/v1", wire_api = "responses",
  requires_openai_auth = true, supports_websockets = false`,
  model `gpt-6-luna`, reasoning effort `low` (temp config only).
- Gateway started with `RELAY_MODE=passthrough`.

Run (workdir `/tmp/relay-real-work`):

```
codex exec --skip-git-repo-check -s workspace-write \
  "Use the shell to run exactly: echo relay-m0-ok > proof.txt ; then read
   proof.txt and in your final reply output only the file contents." </dev/null
```

Result: **exit 0**. Codex executed `echo relay-m0-ok > proof.txt`, then
`cat proof.txt`, final reply `relay-m0-ok`; `proof.txt` on disk contains
`relay-m0-ok`. Tokens used: 22,950 (xhigh→low only in the temp config;
 the run itself was 3 model requests).

Gateway routing log for the run — 3 requests, all upstream 200:

```json
{"mode":"passthrough","upstream":"https://chatgpt.com/backend-api/codex/responses","status":200,"authPresent":true,"ms":1789}
{"mode":"passthrough","upstream":"https://chatgpt.com/backend-api/codex/responses","status":200,"authPresent":true,"ms":1458}
{"mode":"passthrough","upstream":"https://chatgpt.com/backend-api/codex/responses","status":200,"authPresent":true,"ms":2155}
```

Token hygiene re-checked afterwards: repository + both log files scanned
for JWT/Bearer material — clean. Gateway stopped, port closed.

## Protocol differences / pitfalls found

1. **Codex polls `GET /v1/models?client_version=0.162.1`** against the
   custom provider to refresh its model list. The gateway 404s it; Codex
   logs a non-fatal ERROR and continues with the configured model. M1 must
   implement `/v1/models` (passthrough or a synthesized list), otherwise
   the model picker and model metadata (context window etc.) will be stale
   in real use.
2. **Responses `input` is item-based, not message-based**: history arrives
   as `message` / `function_call` / `function_call_output` / `reasoning`
   items. Reasoning items have no Chat Completions equivalent and are
   dropped in translation (upstream models that need reasoning content
   round-tripped — e.g. some providers' tool-continuation rules — will
   need provider-specific handling in M2).
3. **Tool formats differ in nesting**: Responses tools are flat
   (`{type:"function", name, parameters}`); Chat Completions nests them
   under `function:{…}`. `tool_choice` differs the same way.
4. **Streaming event models differ fundamentally**: Chat streams anonymous
   deltas; Responses requires an item lifecycle (added/part/delta/done)
   with stable item ids, output indexes and sequence numbers, and usage
   only arrives in a trailing chunk when `stream_options.include_usage`
   is set. The gateway synthesizes all of it; the mock tests pin the
   required event order.
5. **`supports_websockets = false`** was set on the temp provider: newer
   Codex can prefer WebSocket transport for Responses; a plain HTTP
   gateway must opt out explicitly in the provider block.
6. Passthrough is genuinely transparent: Codex's own headers
   (session id, originator, account id) flow through untouched, which is
   why the ChatGPT backend accepted the requests exactly as if direct.

## Not yet proven (by design of M0)

- translate mode against a *real* Chat Completions upstream (only against
  the scripted mock). First real target for M1: Zro DeepSeek.
- Multi-tool parallel calls, image inputs, reasoning-effort mapping.
- Anything on the user's Mac (this spike ran on the VM with the VM's Codex
  login). Mac real-machine verification is an M1/M2 gate per plan.

## Recommendations for M1

1. Implement `GET /v1/models` (passthrough in passthrough mode; a mapped
   list in translate mode) — removes the only error seen in the real run.
2. Wire translate mode to one real upstream (DeepSeek via Zro) and re-run
   the same `proof.txt` task through it as the M1 acceptance test,
   including a tool call, before building the router.
3. Add error mapping (upstream 4xx/5xx → Responses error shape) and
   per-request timeouts; keep the state machine's event corpus as
   regression tests and extend it with parallel tool calls.
4. Keep zero-dependency: nothing so far needed a package.
