# Relay Gemini Wiring — Cloud Code (OAuth) Adapter Foundation

Date: 2026-11-06 · Environment: project VM (Linux), Node v24.22.1
Verdict: **PASSED** — 297/297 automated assertions green (the 261 from
M0–platform untouched and still passing, 36 new). Every test ran
against a local mock of the Cloud Code backend or an injected fake
HTTP layer: **no real Google request was made, no real credential
file was read, and no token value appears in any log, test or this
report.** The one remaining step — the owner's in-browser
authorization — is deliberately not part of this phase (§6).

This is step 2 of the wiring phase per the owner's ordering
（平台 → Gemini → API): the Gemini pool now has its adapter,
credential layer and full mock acceptance. The API-key route is NOT
used here; it belongs to the later API phase.

## 1. Protocol research — what the Cloud Code backend actually is

The Gemini pool talks to the same backend the Gemini CLI and
Antigravity use: Google's **Cloud Code** API (`v1internal`), not the
public AI Studio API. Findings, graded by evidence:

### 1.1 Verified (public source code / official docs)

| # | Finding | Source |
|---|---|---|
| 1 | Endpoint `https://cloudcode-pa.googleapis.com`, version `v1internal`; method URL is `{endpoint}/{version}:{method}` (`:generateContent`, `:streamGenerateContent`, also `:loadCodeAssist`, `:onboardUser`, `:countTokens`, `:retrieveUserQuota`) | gemini-cli `packages/core/src/code_assist/server.ts` (`CODE_ASSIST_ENDPOINT`, `CODE_ASSIST_API_VERSION`, `getMethodUrl`) |
| 2 | Streaming = same URL with query param `alt=sse`; SSE framing is `data: <json>` lines with a blank line ending each event | server.ts `requestStreamingPost` (params `{alt:'sse'}`, line parser) |
| 3 | Request body is a **wrapper**: `{ model, project?, user_prompt_id, request: { contents, systemInstruction?, tools?, toolConfig?, safetySettings?, generationConfig?, session_id? } }`. The model sits OUTSIDE `request`; system instruction and tools sit INSIDE it | gemini-cli `packages/core/src/code_assist/converter.ts` (`CAGenerateContentRequest`, `VertexGenerateContentRequest`) |
| 4 | Reply is wrapped the same way: `{ response: { candidates, usageMetadata, modelVersion, promptFeedback }, traceId, consumedCredits?, remainingCredits? }`; clients unwrap `.response` | converter.ts (`CaGenerateContentResponse`, `fromGenerateContentResponse`) |
| 5 | Auth is an OAuth2 Bearer access token (google-auth-library client), scopes `cloud-platform` + `userinfo.email` + `userinfo.profile`; the OAuth client id is the Gemini CLI's public installed-app client | gemini-cli `packages/core/src/code_assist/oauth2.ts` (`OAUTH_CLIENT_ID`, `OAUTH_SCOPE`) |
| 6 | Credential file: `~/.gemini/oauth_creds.json` in google-auth-library `Credentials` JSON shape — `access_token`, `refresh_token`, `scope`, `token_type`, `expiry_date` (unix **milliseconds**) | oauth2.ts credential caching + the library's `Credentials` type; field list corroborated by OpenUsage's provider docs |
| 7 | Refresh = `POST https://oauth2.googleapis.com/token`, form grant `grant_type=refresh_token` with the file's refresh token; refreshed tokens are written back into the same file | google-auth-library standard exchange (what gemini-cli performs); endpoint corroborated by OpenUsage docs |
| 8 | `contents` roles are only `user` / `model`; a function result is a `functionResponse` part under role **`user`**; a call is a `functionCall` part (args as a JSON **object**) under role `model` | Google Cloud function-calling docs for the Gemini API + `@google/genai` behavior |
| 9 | The `project` in the wrapper is the **cloudaicompanionProject** produced by the `loadCodeAssist` / `onboardUser` step during sign-in | gemini-cli `packages/core/src/code_assist/types.ts` (`LoadCodeAssistResponse`, `OnboardUserResponse`) |
| 10 | Differences vs the public AI Studio `generateContent`: model in the URL path + API-key auth there, vs action-style URL + OAuth here; bare body there, vs the `{model, project, request}` wrapper here; identical `candidates`/`usageMetadata` core inside the wrapper | Google AI Studio / Gemini API docs vs rows 1–4 |

### 1.2 Unverified — to be settled at the in-person authorization

1. **Whether the refresh exchange requires the client secret.** The
   Gemini CLI embeds one and its source repeats Google's guidance
   that an installed-app secret is not treated as a secret; Relay
   nevertheless does not embed it. The creds layer sends
   `client_secret` only when env `RELAY_GEMINI_OAUTH_CLIENT_SECRET`
   is set (client id defaults to the public one, overridable via
   `RELAY_GEMINI_OAUTH_CLIENT_ID`). If the endpoint demands the
   secret, the in-person step sets the env — no code change.
2. **Whether `project` may be omitted** for the owner's account/tier,
   or whether loadCodeAssist/onboardUser must run first and the
   resulting project id pinned into the upstream's `project` config
   field (the field exists and is sent when set).
3. **Antigravity-specific envelope extras.** Third-party open-source
   proxies document Antigravity sending additional wrapper fields
   (`userAgent`, `requestId`) and, in some builds, alternate hosts
   (`antigravity.googleapis.com`, `codeassist-pa.clients6.google.com`).
   Relay implements the Gemini CLI shape against `cloudcode-pa`
   (row 1); if the owner's sign-in turns out to be AGY's, field-level
   deltas are verified then — the API base is a config/env override,
   so a host change needs no code change either.
4. **AGY's own credential storage.** A third-party observation puts
   Antigravity CLI's login at `~/.gemini/antigravity-cli/antigravity-oauth-token`
   with an unverified format. This phase implements the Gemini CLI
   file shape (row 6, verified). If authorization happens through
   `agy`, the file shape is measured first and, if different, gets a
   small adapter in the creds layer (its path is already
   env-configurable).
5. **Personal-account client eligibility.** A single third-party blog
   report (Oct 2026) claims Google stopped serving personal accounts
   through the Gemini CLI client (`UNSUPPORTED_CLIENT`) and routes
   individuals to Antigravity. Not confirmed against Google docs;
   the in-person step reveals which client the owner's account
   accepts, and the fallback order (Gemini CLI file first, AGY
   second) is already the plan in §6.
6. **Error-envelope granularity on the real backend** (exact
   `INVALID_ARGUMENT` texts, context-overflow wording). The adapter
   maps Google's `{error:{code,message,status}}` onto the OpenAI
   envelope and the existing classifier; verified against the mock's
   Google-style envelopes only.
7. **`retrieveUserQuota` availability.** Current gemini-cli types do
   expose a quota method (types.ts / server.ts), but per this phase's
   scope it is deliberately NOT wired: Gemini quota stays the
   metering estimate (§4). Candidate for a later phase if the owner's
   tier answers it.
8. **Streamed function-call arguments.** Gemini 3-era backends can
   stream functionCall args in fragments when asked
   (`streamFunctionCallArguments`); Relay's converter assumes whole
   `functionCall` parts per event (the established behavior). If the
   real backend fragments, the stream converter gains an assembly
   step — the Chat-side contract would not change.

## 2. What was built

| File | Change |
|---|---|
| `src/gemini-creds.js` | **New.** OAuth credential layer: reads the `oauth_creds.json`-shaped file (env `RELAY_GEMINI_CREDS`, default `~/.gemini/oauth_creds.json`), serves the access token while fresh (60 s skew), refreshes via the token endpoint when expired (injectable HTTP + clock), persists the refreshed token back into the file, caches in memory. Failures are coded errors (`gemini_creds_missing` / `gemini_creds_invalid` / `gemini_creds_expired` / `gemini_refresh_failed`). Token values never logged or returned |
| `src/gemini.js` | **New.** Protocol adapter + transport: Chat → wrapped Cloud Code request; wrapped reply → Chat completion; Gemini SSE → Chat SSE via a Transform; Google error envelope → OpenAI envelope; credential failure → synthetic 401. Thought parts are not surfaced as text; `thoughtsTokenCount` folds into completion tokens as `reasoning_tokens` |
| `src/gateway.js` | Translate dispatch branches on `target.kind === 'gemini'` (one dispatch point for both attempt functions); gemini upstreams may omit `baseUrl`; header docs updated |
| `src/config.js` | `kind: 'gemini'` accepted; upstream entries accept `project` |
| `src/upstreams.js` | `resolveTarget` carries `kind` dispatch info + `project` |
| `relay.config.example.json` | `gemini-pool` is now `kind: 'gemini'` (label Gemini, flash=light / pro=heavy capability grades, metering quota kept); `$comment` documents the credential-file route |
| `test/mock-gemini.js` | **New.** Local Cloud Code mock: v1internal actions, wrapper in/out, Google-style 401/429, `CALL_TOOL` scripting, `__last`/`__hits` introspection |
| `test/run-tests.mjs` | Tests 40–44 (36 new assertions) |

Conversion rules worth pinning down:

- **Requests**: system messages merge into one `systemInstruction`;
  assistant tool calls become `functionCall` parts (args string →
  object); tool results become `functionResponse` parts under role
  `user`, named by matching the Chat `tool_call_id` back to its call;
  consecutive same-role turns are merged (Gemini expects user/model
  alternation; parallel calls/results arrive as consecutive
  same-role Chat messages); `temperature` / `top_p` / `max_tokens`
  map to `generationConfig`; Chat tools map to one
  `functionDeclarations` tool.
- **Responses**: text parts join into the message content;
  `functionCall` parts become Chat tool calls with synthesized ids
  and args re-stringified; `finishReason` maps STOP→stop,
  MAX_TOKENS→length, SAFETY-family→content_filter; a blocked prompt
  (`promptFeedback.blockReason`, no candidates) also surfaces as
  content_filter.
- **Failure semantics**: a missing/expired/unrefreshable credential
  never reaches the network — the transport answers a synthetic 401
  (`authentication_error`) for that upstream only, the router logs
  the attempt and falls back with reason `fallback_auth`, exactly
  like a dead API key on any other upstream. A Google 429 maps to
  the quota class, a Google 401/403 to auth, by the existing
  classifier on the converted envelope.

## 3. Quota

Unchanged mechanism, verified end-to-end for the new kind: the
example `gemini-pool` declares `quota.source: 'metering'` with a
token window, so the dashboard card is driven by the routing log and
labeled **估算** (`source: 'metering-estimate'`, `estimate: true`)
— test 44 asserts the number moves with metered Gemini traffic
(68/170 tokens → 60%). No new quota source was built (see §1.2.7).

## 4. Test evidence

`npm test` → **297 passed, 0 failed** (run twice, stable). New:

```
test 40: gemini creds — read, refresh via fake HTTP, coded failures   10 PASS
   fresh token served with zero HTTP; expired token refreshed once
   against https://oauth2.googleapis.com/token (refresh_token grant,
   file's refresh token + client id asserted on the form body);
   refreshed token persisted back into the file (new expiry_date)
   and cached; missing file -> gemini_creds_missing; rejected
   refresh (invalid_grant) -> gemini_refresh_failed; expired with
   no refresh token -> gemini_creds_expired.
test 41: gemini non-stream                                            11 PASS
   end-to-end through a routed gateway + Cloud Code mock: text
   reply and usage (11/6/17) mapped; the mock asserts the OAuth
   Bearer came from the creds file, the wrapper shape (model
   outside request), contents conversion, functionDeclarations;
   the difficulty axis dispatched the light model for a light task.
test 41b: tool-result roundtrip                                        4 PASS
   function_call + function_call_output in Responses form come out
   as model functionCall part + user functionResponse part carrying
   the tool output under the call's name.
test 42: gemini streaming                                              4 PASS
   Gemini SSE -> Responses events: created..completed sequence,
   text deltas assemble to the full reply, usage lands (17).
test 43: creds missing -> fallback_auth                                5 PASS
   RELAY_GEMINI_CREDS pointing at an absent file: attempt 1 on
   gemini-pool is a 401 (reason initial), attempt 2 lands on the
   cheap API with reason fallback_auth; the pool is unaffected.
test 44: metering-estimate quota                                       2 PASS
```

Two port collisions with pre-existing test fixtures were found and
fixed during development (test infrastructure only; no product code
was affected).

## 5. Files & hygiene

No dependency was added (Node core only: `node:https`, streams).
Nothing under `~/.codex` was touched; no real credential file was
opened (the only credential-shaped files read are fixtures the tests
write themselves, with dummy values). `git` was not pushed, per
instructions.

## 6. In-person authorization — the checklist for the remaining step

Shortest form. The owner only touches the browser once.

**The owner does (at the Mac, ~2 minutes):**

1. Open the terminal when I say the word — I will already have put
   everything else in place.
2. Run the sign-in command I give you (official Gemini CLI login, or
   `agy` login if we go the Antigravity route — decided on the spot
   by which one your account accepts, cf. §1.2.5). A browser window
   opens.
3. In the browser: sign in with the Google account the Gemini pool
   should use, and approve the consent screen (scopes:
   cloud-platform + email/profile). Done — close the tab.

**I do (before/after, no owner action needed):**

1. Before: install the CLI on the Mac, prepare Relay's Mac config
   (`gemini-pool` as `kind: 'gemini'`, no `baseUrl`, 
   `RELAY_GEMINI_CREDS` pointing at the file the login will write).
2. After: confirm the credential file exists and carries
   `access_token` / `refresh_token` / `expiry_date` (field names
   only — values are never printed); if the login was AGY's, first
   measure its file location/format against §1.2.4.
3. If a real request answers that a project is required: obtain the
   cloudaicompanion project (the CLI's own onboarding produces it)
   and pin it as `project` on the upstream; if refresh demands the
   client secret, set `RELAY_GEMINI_OAUTH_CLIENT_SECRET` from the
   public gemini-cli source value (§1.2.1).
4. Acceptance: one real non-streaming + one real streaming request
   through Relay on the Mac; the dashboard Gemini card must show the
   估算 tag and move with usage; the routing log must show
   `gemini-pool` serving with no fallback. Any failure is diagnosed
   against the §1.2 list in order (client eligibility → project →
   secret → envelope deltas).

After the Gemini step: API pool keys (step 3 of the owner's order) —
each with its own report.
