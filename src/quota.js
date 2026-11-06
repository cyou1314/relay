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
 *     'codex-usage'        the official Codex usage endpoint (see below)
 *     'unavailable'        no source could answer; the router must (and
 *                          does) keep working in this case
 *
 * Which source serves an upstream: the upstream's `quotaSource` field
 * when set, else `quota.source` (config.js normalizes both).
 *
 * codex-usage — the first real source (credentials phase, platform step).
 * Codex's official usage endpoint:
 *   GET https://chatgpt.com/backend-api/wham/usage
 *   Authorization: Bearer <tokens.access_token>
 *   ChatGPT-Account-Id: <tokens.account_id>
 * with both values read from the local Codex sign-in
 * (~/.codex/auth.json, override with env RELAY_CODEX_AUTH). The reply's
 * rate_limit.primary_window (5 h) and rate_limit.secondary_window
 * (week) each carry used_percent + reset_at (unix seconds); Relay
 * reports the TIGHTER window as the headline number and keeps both
 * windows on the result (`windows`) for the dashboard.
 *
 * The read API of this module stays synchronous (router, ledger and
 * dashboard all consume it inline), so the network fetch runs as a
 * background refresh behind a 60 s cache (stale-while-revalidate): a
 * cold or failed fetch degrades to the metering estimate when the
 * upstream configured a window budget, else 'unavailable' — a quota
 * lookup can therefore never block or break a routed request. The
 * credential values live only in memory for the duration of one fetch:
 * never logged, never returned, never written anywhere.
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const os = require('node:os');

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_CACHE_MS = 60_000;
const CODEX_FETCH_TIMEOUT_MS = 10_000;

/** Default HTTP client for the usage endpoint (injectable for tests). */
function defaultCodexHttpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(CODEX_FETCH_TIMEOUT_MS, () => req.destroy(new Error('codex usage request timed out')));
    req.on('error', reject);
  });
}

/**
 * Map a wham/usage reply onto the quota shape. remainingPct is the
 * tighter of the two windows (a request dies when EITHER window is
 * spent); resetsAt follows the same window. Returns null when the
 * payload does not carry both windows with usable numbers.
 */
function mapCodexUsage(json) {
  const rl = json && typeof json === 'object' ? json.rate_limit : null;
  if (!rl) return null;
  const win = (w) => {
    if (!w || typeof w !== 'object') return null;
    const used = Number(w.used_percent);
    if (!Number.isFinite(used)) return null;
    const resetSec = Number(w.reset_at);
    return {
      usedPercent: used,
      remainingPct: Math.max(0, Math.min(100, 100 - used)),
      resetAt: Number.isFinite(resetSec) && resetSec > 0 ? new Date(resetSec * 1000).toISOString() : null,
    };
  };
  const primary = win(rl.primary_window);
  const secondary = win(rl.secondary_window);
  if (!primary || !secondary) return null;
  const tighter = primary.remainingPct <= secondary.remainingPct ? primary : secondary;
  return {
    remainingPct: tighter.remainingPct,
    resetsAt: tighter.resetAt,
    source: 'codex-usage',
    windows: { primary, secondary },
  };
}

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

function createQuotaService({ config, registry, logFile, repoRoot, codexHttpGet, codexAuthPath, nowFn }) {
  const root = repoRoot || path.join(__dirname, '..');
  const httpGet = typeof codexHttpGet === 'function' ? codexHttpGet : defaultCodexHttpGet;
  const now = typeof nowFn === 'function' ? nowFn : Date.now;
  const authPath = () => {
    if (codexAuthPath) return codexAuthPath;
    if (process.env.RELAY_CODEX_AUTH) return process.env.RELAY_CODEX_AUTH;
    return path.join(os.homedir(), '.codex', 'auth.json');
  };

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

  // ---- codex-usage: account-level fetch behind a 60 s cache --------
  // One sign-in serves every codex-usage upstream, so the cache is per
  // service, not per upstream. `at === 0` means "never fetched"; a
  // failed fetch also stamps `at`, so an outage is negatively cached
  // for the same 60 s instead of being retried on every routed request.
  const codexCache = { at: 0, result: null, inflight: null };

  async function refreshCodexUsage(force = false) {
    if (codexCache.inflight) return codexCache.inflight;
    if (!force && codexCache.at !== 0 && now() - codexCache.at < CODEX_CACHE_MS) {
      return codexCache.result; // fresh enough — the 60 s cache is the point
    }
    const p = (async () => {
      try {
        const auth = readJsonSafe(authPath());
        const tokens = auth && typeof auth === 'object' ? auth.tokens : null;
        const accessToken = tokens && typeof tokens.access_token === 'string' ? tokens.access_token : null;
        const accountId = tokens && typeof tokens.account_id === 'string' ? tokens.account_id : null;
        if (!accessToken || !accountId) return null;
        const resp = await httpGet(CODEX_USAGE_URL, {
          authorization: `Bearer ${accessToken}`,
          'chatgpt-account-id': accountId,
        });
        if (!resp || resp.status !== 200) return null;
        let parsed = null;
        try { parsed = JSON.parse(resp.body); } catch { return null; }
        return mapCodexUsage(parsed);
      } catch { return null; }
    })();
    codexCache.inflight = p;
    try {
      codexCache.result = await p;
      codexCache.at = now();
    } finally {
      codexCache.inflight = null;
    }
    return codexCache.result;
  }

  /** Degradation when codex-usage cannot answer: metering, else unavailable. */
  function codexFallback(upstream) {
    const m = meteringQuota(upstream);
    if (m.remainingPct != null) return m;
    return { remainingPct: null, resetsAt: null, source: 'unavailable' };
  }

  function codexUsageQuota(upstream) {
    const stale = codexCache.at === 0 || now() - codexCache.at >= CODEX_CACHE_MS;
    if (stale) refreshCodexUsage().catch(() => {}); // background; never awaited on the request path
    const r = codexCache.result;
    if (r) {
      return {
        remainingPct: r.remainingPct,
        resetsAt: r.resetsAt,
        source: 'codex-usage',
        windows: {
          primary: { ...r.windows.primary },
          secondary: { ...r.windows.secondary },
        },
      };
    }
    return codexFallback(upstream);
  }

  /** Kick a background fetch when any enabled upstream uses codex-usage. */
  function warmup() {
    try {
      if (!registry) return;
      const any = registry.enabled().some(
        (u) => (u.quotaSource || (u.quota && u.quota.source)) === 'codex-usage',
      );
      if (any) refreshCodexUsage().catch(() => {});
    } catch { /* warmup is best effort */ }
  }

  function getQuota(upstreamId) {
    const upstream = registry ? registry.get(upstreamId) : null;
    if (!upstream) return { remainingPct: null, resetsAt: null, source: 'unavailable' };
    const source = upstream.quotaSource || (upstream.quota && upstream.quota.source) || 'unavailable';
    try {
      if (source === 'mock') return mockQuota(upstream);
      if (source === 'metering') return meteringQuota(upstream);
      if (source === 'codex-usage') return codexUsageQuota(upstream);
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

  return { getQuota, snapshot, refreshCodexUsage, warmup };
}

module.exports = { createQuotaService, sumMeteredTokens, mapCodexUsage, CODEX_USAGE_URL, CODEX_CACHE_MS };
