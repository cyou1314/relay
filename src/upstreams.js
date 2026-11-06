'use strict';
/**
 * Upstream registry + adapter classification helpers (core phase).
 *
 * The registry is the single view of the configured upstream pool. An
 * upstream adapter is deliberately thin: the gateway owns the two wire
 * protocols (passthrough forwarding and Responses<->Chat translation);
 * an upstream entry only supplies the dispatch parameters for one of
 * those protocols:
 *   kind 'passthrough' -> forward the raw Responses request to baseUrl
 *   kind 'chat'        -> translate to Chat Completions at baseUrl + '/chat/completions'
 *   kind 'gemini'      -> translate to Google's Cloud Code protocol
 *                         (src/gemini.js) with the OAuth credential from
 *                         src/gemini-creds.js; baseUrl optionally
 *                         overrides the v1internal API base
 *
 * resolveTarget(upstream) turns a registry entry into concrete dispatch
 * parameters, reading the API key from the environment variable NAMED by
 * the config (apiKeyEnv) — keys themselves never live in config files.
 */

function createRegistry(config) {
  const byId = new Map();
  for (const u of (config && config.upstreams) || []) byId.set(u.id, u);
  return {
    all: () => [...byId.values()],
    enabled: () => [...byId.values()].filter((u) => u.enabled),
    get: (id) => byId.get(id) || null,
    has: (id) => byId.has(id),
  };
}

/**
 * The upstream's full model list as [{id, capability}]: the declared
 * models[] entries plus the pinned dispatch `model` if it is not already
 * listed. An upstream with neither yields a single entry with id null
 * (pass the client's model through) graded 'standard'.
 */
function modelList(upstream) {
  const list = [];
  for (const m of (upstream && upstream.models) || []) {
    if (!list.some((x) => x.id === m.id)) list.push({ id: m.id, capability: m.capability || 'standard' });
  }
  if (upstream && upstream.model && !list.some((x) => x.id === upstream.model)) {
    list.push({ id: upstream.model, capability: upstream.modelCapability || 'standard' });
  }
  if (!list.length) list.push({ id: null, capability: 'standard' });
  return list;
}

function resolveTarget(upstream) {
  if (!upstream) return null;
  return {
    upstreamId: upstream.id,
    kind: upstream.kind,
    tier: upstream.tier,
    baseUrl: upstream.baseUrl,
    apiKey: upstream.apiKeyEnv ? (process.env[upstream.apiKeyEnv] || '') : '',
    model: upstream.model,
    project: upstream.project || null,
  };
}

/**
 * Body hints for the 'auth' class, matched against the error code, type
 * and message. Source: the common OpenAI-compatible error envelope
 * ({error:{code,type,message}}) as emitted by OpenAI and the compatible
 * providers Relay targets (DeepSeek et al.): a rejected credential
 * surfaces as code 'invalid_api_key' / type 'authentication_error' /
 * messages like "incorrect api key provided" or "unauthorized".
 */
const AUTH_BODY_HINTS = [
  'invalid_api_key', 'invalid api key', 'incorrect api key',
  'authentication_error', 'authentication error', 'invalid authentication',
  'unauthorized',
];

/**
 * Body hints for the 'invalid' class — the REQUEST is at fault, so no
 * other upstream can serve it either. Source: the same OpenAI-compatible
 * envelope: context overflow is code 'context_length_exceeded' with a
 * message citing the "maximum context length"; malformed requests carry
 * type 'invalid_request_error' / code 'invalid_request'. Matched against
 * code, type and message, and only in combination with HTTP 400 (the
 * status these providers use for request faults) — a bare keyword on
 * some other status must not stop the fallback chain.
 */
const INVALID_BODY_HINTS = [
  'context_length_exceeded', 'context length exceeded', 'maximum context length',
  'invalid_request', 'invalid request',
];

const hasHint = (hints, codeS, typeS, msgS) => hints.some((h) => codeS.includes(h) || typeS.includes(h) || msgS.includes(h));

/**
 * Classify a failed upstream attempt for the fallback chain:
 *   'quota'    HTTP 429, or an error body naming quota exhaustion
 *              (insufficient_quota / quota_exceeded / quota_exhausted).
 *              Another upstream's quota is independent: fall back.
 *   'filtered' the provider's safety/content filter refused the request
 *              (error code/type mentioning content_filter / safety, or a
 *              message saying the content was filtered/blocked by policy).
 *              Another provider's filter may accept it: fall back.
 *   'auth'     the upstream rejected OUR credential: HTTP 401/403, or a
 *              body naming an authentication failure (AUTH_BODY_HINTS).
 *              Other upstreams hold independent credentials, so falling
 *              back is legitimate — but the dead credential must be
 *              unmistakable in the log (reason fallback_auth) and the
 *              same upstream is never retried within the request (the
 *              chain visits each candidate at most once by construction).
 *   'invalid'  the request itself is invalid: HTTP 400 AND a body naming
 *              a request fault (INVALID_BODY_HINTS — context-length
 *              overflow, invalid_request, ...). No upstream can serve
 *              this request: the gateway STOPS the chain immediately and
 *              returns the upstream error as-is (reason
 *              invalid_request_stop in the routing log).
 *   'error'    everything else (5xx, connect failure, timeout, ...)
 *
 * Order matters: quota and filtered are checked first (existing
 * semantics — a 429 is always quota; a content_filter refusal often
 * arrives as a 400 whose type is 'invalid_request_error', and it MUST
 * stay 'filtered', not 'invalid').
 */
function classifyFailure({ status, code, type, message }) {
  const codeS = String(code || '').toLowerCase();
  const typeS = String(type || '').toLowerCase();
  const msgS = String(message || '').toLowerCase();
  if (status === 429 || codeS.includes('insufficient_quota') || codeS.includes('quota') || msgS.includes('quota exhausted') || msgS.includes('quota exceeded')) {
    return 'quota';
  }
  if (
    codeS.includes('content_filter') || codeS.includes('content-filter') || typeS.includes('content_filter') ||
    codeS.includes('safety') || msgS.includes('content filter') || msgS.includes('filtered by') ||
    msgS.includes('safety policy') || msgS.includes('blocked by policy')
  ) {
    return 'filtered';
  }
  if (status === 401 || status === 403 || hasHint(AUTH_BODY_HINTS, codeS, typeS, msgS)) {
    return 'auth';
  }
  if (status === 400 && hasHint(INVALID_BODY_HINTS, codeS, typeS, msgS)) {
    return 'invalid';
  }
  return 'error';
}

/** Reason code recorded for a fallback attempt, given the previous failure kind. */
function fallbackReasonCode(failureKind) {
  if (failureKind === 'quota') return 'fallback_quota';
  if (failureKind === 'filtered') return 'fallback_filtered';
  if (failureKind === 'auth') return 'fallback_auth';
  // 'invalid' never reaches this function: the gateway stops the chain
  // on it instead of choosing a next attempt (see gateway.js).
  return 'fallback_error';
}

/** Cash cost (USD) of one successful request under an upstream's price table. */
function cashCostUsd(upstream, usage) {
  if (!upstream || !usage) return 0;
  const inp = Number(usage.input_tokens || 0);
  const out = Number(usage.output_tokens || 0);
  return (inp / 1000) * (upstream.price.inputPer1k || 0) + (out / 1000) * (upstream.price.outputPer1k || 0);
}

module.exports = { createRegistry, resolveTarget, modelList, classifyFailure, fallbackReasonCode, cashCostUsd };
