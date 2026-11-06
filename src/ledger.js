'use strict';
/**
 * Dual ledger (core phase) — LEARNING-FROM-AUTOROUTER "adapt" item.
 *
 * AutoRouter's savings math prices everything at API rates, blending
 * subscription turns into a marketing number. Relay keeps two honest,
 * separate books aggregated from the routing log:
 *
 *   cash book   pay-as-you-go API upstreams only: requests, tokens and
 *               the actual USD spent, priced with the config price table
 *               (input/output per 1k tokens). This is money that left
 *               the wallet.
 *   quota book  subscription upstreams only: requests and tokens burned
 *               against plan quota (sunk cost, $0 cash), plus the current
 *               remaining-quota estimate per upstream when a quota
 *               source can answer.
 *
 * A log line counts as a *served* request when it is a /v1/responses
 * line with a 2xx status and a usage object — i.e. the successful
 * attempt of a request. Failed attempts (no usage) are counted
 * separately under attemptsFailed and never enter either book, so the
 * books reconcile line-by-line with the log.
 *
 * CLI: node src/ledger.js summary [--config p] [--log p] [--feedback p]
 * (env RELAY_CONFIG / RELAY_LOG_FILE / RELAY_FEEDBACK_FILE as fallbacks.)
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRegistry, cashCostUsd } = require('./upstreams');
const { createQuotaService } = require('./quota');

function readLines(file) {
  if (!file || !fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip torn lines */ }
  }
  return out;
}

function emptyBucket() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function summarize({ config, logFile, feedbackFile }) {
  const registry = config ? createRegistry(config) : null;
  const quotaService = config ? createQuotaService({ config, registry, logFile }) : null;
  const lines = readLines(logFile);

  const cash = { totalUsd: 0, byUpstream: {} };
  const quota = { byUpstream: {} };
  let served = 0;
  let attemptsFailed = 0;

  for (const e of lines) {
    if (e.path !== '/v1/responses') continue;
    const ok = e.status >= 200 && e.status < 300 && e.usage;
    if (!ok) { if (e.status) attemptsFailed++; continue; }
    served++;
    const key = e.upstream || 'unknown';
    const upstream = registry ? registry.get(key) : null;
    // Lines whose upstream is not a registry id are legacy (M0/M1) lines:
    // passthrough lines belong to the quota book, translate lines to the
    // cash book with an unknown (zero) price — labeled, never hidden.
    const tier = upstream ? upstream.tier : (e.mode === 'passthrough' ? 'subscription' : 'cheap-api');
    const bucket = tier === 'subscription' ? quota : cash;
    const b = bucket.byUpstream[key] || (bucket.byUpstream[key] = { ...emptyBucket(), ...(tier === 'subscription' ? {} : { usd: 0 }) });
    b.requests++;
    b.inputTokens += Number(e.usage.input_tokens || 0);
    b.outputTokens += Number(e.usage.output_tokens || 0);
    b.totalTokens += Number(e.usage.total_tokens || 0);
    if (tier !== 'subscription') {
      const usd = upstream ? cashCostUsd(upstream, e.usage) : 0;
      b.usd += usd;
      cash.totalUsd += usd;
      if (!upstream) b.priceKnown = false;
    }
  }

  if (quotaService) {
    for (const [id, b] of Object.entries(quota.byUpstream)) {
      const q = quotaService.getQuota(id);
      b.remainingPct = q.remainingPct;
      b.quotaSource = q.source;
      if (q.resetsAt) b.resetsAt = q.resetsAt;
    }
  }

  const feedback = { up: 0, down: 0 };
  for (const e of readLines(feedbackFile)) {
    if (e.verdict === 'up') feedback.up++;
    else if (e.verdict === 'down') feedback.down++;
  }

  return { servedRequests: served, attemptsFailed, cash, quota, feedback };
}

function main(argv) {
  const args = { command: argv[0] };
  for (let i = 1; i < argv.length; i += 2) {
    if (argv[i] && argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
  }
  if (args.command !== 'summary') {
    process.stderr.write('usage: node src/ledger.js summary [--config p] [--log p] [--feedback p]\n');
    process.exit(2);
  }
  const { loadConfig } = require('./config');
  let config = null;
  if (args.config) {
    const prev = process.env.RELAY_CONFIG;
    process.env.RELAY_CONFIG = args.config;
    try { config = loadConfig(); } finally { if (prev == null) delete process.env.RELAY_CONFIG; else process.env.RELAY_CONFIG = prev; }
  } else {
    try { config = loadConfig(); } catch { config = null; }
  }
  const logFile = args.log || process.env.RELAY_LOG_FILE || path.join(__dirname, '..', 'logs', 'routing.jsonl');
  const feedbackFile = args.feedback || process.env.RELAY_FEEDBACK_FILE || path.join(path.dirname(logFile), 'feedback.jsonl');
  const summary = summarize({ config, logFile, feedbackFile });
  process.stdout.write(JSON.stringify({ logFile, feedbackFile, ...summary }, null, 2) + '\n');
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { summarize, readLines };
