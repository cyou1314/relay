'use strict';
/**
 * Relay configuration loader (core phase).
 *
 * Two operating shapes:
 *   routed  — a JSON config file exists (env RELAY_CONFIG, or
 *             <repo>/relay.config.json). It declares the upstream registry,
 *             routing rules and settings; see relay.config.example.json.
 *   legacy  — no config file: the gateway falls back to the M0/M1 env-driven
 *             single-upstream behavior (RELAY_MODE / RELAY_UPSTREAM_BASE /
 *             RELAY_PASSTHROUGH_URL). All M0/M1 tests run in this shape.
 *
 * Config values are validated minimally and normalized here so the rest of
 * the code can trust the shape. API keys are NEVER read from the config
 * file: an upstream may name an environment variable (`apiKeyEnv`) whose
 * value the gateway reads at dispatch time.
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'relay.config.json');

const TIERS = ['subscription', 'cheap-api', 'premium-api'];
const KINDS = ['passthrough', 'chat'];

function configPath() {
  return process.env.RELAY_CONFIG || DEFAULT_CONFIG_PATH;
}

function normalizeUpstream(raw, idx) {
  if (!raw || typeof raw !== 'object') throw new Error(`upstreams[${idx}] must be an object`);
  if (!raw.id || typeof raw.id !== 'string') throw new Error(`upstreams[${idx}].id is required`);
  const kind = raw.kind || 'chat';
  if (!KINDS.includes(kind)) throw new Error(`upstream ${raw.id}: kind must be one of ${KINDS.join('/')}`);
  const tier = raw.tier || 'cheap-api';
  if (!TIERS.includes(tier)) throw new Error(`upstream ${raw.id}: tier must be one of ${TIERS.join('/')}`);
  const price = raw.price || {};
  return {
    id: raw.id,
    kind,
    tier,
    // chat kind: base URL of an OpenAI-compatible /v1 root.
    // passthrough kind: full URL of the Responses endpoint to forward to.
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.replace(/\/+$/, '') : null,
    apiKeyEnv: typeof raw.apiKeyEnv === 'string' ? raw.apiKeyEnv : null,
    // Model to send upstream; null = pass the client's requested model through.
    model: typeof raw.model === 'string' ? raw.model : null,
    models: Array.isArray(raw.models) ? raw.models.filter((m) => typeof m === 'string') : [],
    price: {
      inputPer1k: Number(price.inputPer1k || 0),
      outputPer1k: Number(price.outputPer1k || 0),
    },
    quota: raw.quota && typeof raw.quota === 'object' ? raw.quota : { source: 'unavailable' },
    enabled: raw.enabled !== false,
  };
}

function normalizeRule(raw, idx) {
  if (!raw || typeof raw !== 'object' || typeof raw.cwdPrefix !== 'string') {
    throw new Error(`rules[${idx}] requires a cwdPrefix string`);
  }
  return {
    cwdPrefix: raw.cwdPrefix,
    upstream: typeof raw.upstream === 'string' ? raw.upstream : null,
    sensitive: raw.sensitive === true,
  };
}

/** Returns the normalized config, or null when no config file exists (legacy mode). */
function loadConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) return null;
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  const upstreams = (Array.isArray(parsed.upstreams) ? parsed.upstreams : []).map(normalizeUpstream);
  const ids = new Set();
  for (const u of upstreams) {
    if (ids.has(u.id)) throw new Error(`duplicate upstream id: ${u.id}`);
    ids.add(u.id);
  }
  const settings = {
    // remainingPct at/below this = quota exhausted for initial routing.
    quotaFloorPct: Number((parsed.settings || {}).quotaFloorPct ?? 2),
    // remainingPct at/above this counts as "ample" subscription quota.
    amplePct: Number((parsed.settings || {}).amplePct ?? 25),
    ...(parsed.settings || {}),
  };
  settings.quotaFloorPct = Number(settings.quotaFloorPct);
  settings.amplePct = Number(settings.amplePct);
  return {
    path: p,
    upstreams,
    rules: (Array.isArray(parsed.rules) ? parsed.rules : []).map(normalizeRule),
    settings,
  };
}

module.exports = { loadConfig, configPath, normalizeUpstream, TIERS, KINDS };
