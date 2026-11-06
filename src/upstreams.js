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

function resolveTarget(upstream) {
  if (!upstream) return null;
  return {
    upstreamId: upstream.id,
    kind: upstream.kind,
    tier: upstream.tier,
    baseUrl: upstream.baseUrl,
    apiKey: upstream.apiKeyEnv ? (process.env[upstream.apiKeyEnv] || '') : '',
    model: upstream.model,
  };
}

/**
 * Classify a failed upstream attempt for the fallback chain:
 *   'quota'    HTTP 429, or an error body naming quota exhaustion
 *              (insufficient_quota / quota_exceeded / quota_exhausted)
 *   'filtered' the provider's safety/content filter refused the request
 *              (error code/type mentioning content_filter / safety, or a
 *              message saying the content was filtered/blocked by policy)
 *   'error'    everything else (5xx, connect failure, timeout, ...)
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
  return 'error';
}

/** Reason code recorded for a fallback attempt, given the previous failure kind. */
function fallbackReasonCode(failureKind) {
  if (failureKind === 'quota') return 'fallback_quota';
  if (failureKind === 'filtered') return 'fallback_filtered';
  return 'fallback_error';
}

/** Cash cost (USD) of one successful request under an upstream's price table. */
function cashCostUsd(upstream, usage) {
  if (!upstream || !usage) return 0;
  const inp = Number(usage.input_tokens || 0);
  const out = Number(usage.output_tokens || 0);
  return (inp / 1000) * (upstream.price.inputPer1k || 0) + (out / 1000) * (upstream.price.outputPer1k || 0);
}

module.exports = { createRegistry, resolveTarget, classifyFailure, fallbackReasonCode, cashCostUsd };
