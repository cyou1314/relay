'use strict';
/**
 * Quota sources (core phase).
 *
 * getQuota(upstreamId) -> { remainingPct, resetsAt, source }
 *   remainingPct  0..100, or null when unknown
 *   resetsAt      ISO timestamp string, or null
 *   source        where the number came from — always stated honestly:
 *     'mock'               fixture values from the config / a fixture file
 *                          (tests and pre-credential development)
 *     'metering-estimate'  estimated from the tokens this gateway has
 *                          already metered in its routing log against a
 *                          configured window budget (PLAN §3.3: Gemini-style
 *                          metering where no official quota API exists)
 *     'unavailable'        no source could answer; the router must (and
 *                          does) keep working in this case
 *
 * Real sources (the Codex usage endpoint, provider balance APIs) plug in
 * here in the credentials phase; nothing in this file touches a network
 * or a credential.
 */
const fs = require('node:fs');
const path = require('node:path');

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function sumMeteredTokens(logFile, upstreamId) {
  if (!logFile || !fs.existsSync(logFile)) return 0;
  let total = 0;
  for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.upstream !== upstreamId) continue;
    if (!(e.status >= 200 && e.status < 300)) continue;
    if (e.usage && Number.isFinite(e.usage.total_tokens)) total += e.usage.total_tokens;
  }
  return total;
}

function createQuotaService({ config, registry, logFile, repoRoot }) {
  const root = repoRoot || path.join(__dirname, '..');

  function mockQuota(upstream) {
    const q = upstream.quota || {};
    // Inline values in the config win; otherwise read the fixture file.
    // The fixture file is re-read on EVERY call, so tests (and later a
    // real writer process) can move quota while the gateway runs.
    let entry = null;
    if (q.mockFile) {
      const file = path.isAbsolute(q.mockFile) ? q.mockFile : path.join(root, q.mockFile);
      const data = readJsonSafe(file);
      if (data && typeof data === 'object') entry = data[upstream.id] || null;
    }
    if (!entry && (q.remainingPct != null || q.resetsAt != null)) {
      entry = { remainingPct: q.remainingPct, resetsAt: q.resetsAt };
    }
    if (!entry) return { remainingPct: null, resetsAt: null, source: 'unavailable' };
    return {
      remainingPct: entry.remainingPct != null ? Number(entry.remainingPct) : null,
      resetsAt: entry.resetsAt || null,
      source: 'mock',
    };
  }

  function meteringQuota(upstream) {
    const q = upstream.quota || {};
    const windowTokens = Number(q.windowTokens || 0);
    if (!windowTokens) return { remainingPct: null, resetsAt: null, source: 'unavailable' };
    const used = sumMeteredTokens(logFile, upstream.id);
    const remainingPct = Math.max(0, Math.min(100, 100 * (1 - used / windowTokens)));
    return { remainingPct, resetsAt: q.resetsAt || null, source: 'metering-estimate', usedTokens: used, windowTokens };
  }

  function getQuota(upstreamId) {
    const upstream = registry ? registry.get(upstreamId) : null;
    if (!upstream) return { remainingPct: null, resetsAt: null, source: 'unavailable' };
    const source = (upstream.quota && upstream.quota.source) || 'unavailable';
    try {
      if (source === 'mock') return mockQuota(upstream);
      if (source === 'metering') return meteringQuota(upstream);
    } catch { /* fall through to unavailable — routing must not depend on quota */ }
    return { remainingPct: null, resetsAt: null, source: 'unavailable' };
  }

  /** Snapshot for every enabled upstream: { id: {remainingPct,resetsAt,source} } */
  function snapshot() {
    const out = {};
    if (!registry) return out;
    for (const u of registry.enabled()) out[u.id] = getQuota(u.id);
    return out;
  }

  return { getQuota, snapshot };
}

module.exports = { createQuotaService, sumMeteredTokens };
