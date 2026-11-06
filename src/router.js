'use strict';
/**
 * Routing engine (core phase) — pure decision logic, no I/O.
 *
 * Implements PLAN §3.1/§3.2:
 *   priority   soonest-resetting ample subscription quota > subscription
 *              flagship > cheap APIs > premium APIs (price-ascending
 *              inside the API tiers)
 *   stickiness a session chain (keyed by previous_response_id, see
 *              gateway) never changes upstream mid-chain, failure aside
 *   pins       a rule {cwdPrefix, upstream} beats automatic policy
 *   sensitive  a rule {cwdPrefix, sensitive:true} restricts the pool to
 *              tier 'subscription'; if none is available the request is
 *              refused (fail-closed) and NEVER falls to an API tier
 *   quota      a subscription whose known remainingPct is at/below the
 *              floor (settings.quotaFloorPct) sorts behind every API
 *              tier for the initial pick, but stays in the candidate
 *              list as a last resort; unknown quota (source
 *              'unavailable', remainingPct null) never blocks routing
 *
 * decide() returns an ordered candidate list. The gateway walks it,
 * assigning reason codes: the first attempt carries the decision reason
 * ('initial' | 'pinned' | 'sticky_session'); later attempts carry a
 * fallback_* code derived from the previous attempt's failure kind
 * (see upstreams.classifyFailure / fallbackReasonCode).
 */

const TIER_RANK = { subscription: 0, 'cheap-api': 1, 'premium-api': 2 };

function priceOf(u) {
  return (u.price.inputPer1k || 0) + (u.price.outputPer1k || 0);
}

function subscriptionGroup(u, quota, settings) {
  if (!quota || quota.remainingPct == null) return 0; // unknown quota: treated as available
  if (quota.remainingPct <= settings.quotaFloorPct) return 2; // exhausted
  if (quota.remainingPct < settings.amplePct) return 1; // low but usable
  return 0; // ample
}

function orderAuto(pool, quotas, settings) {
  const byTier = { subscription: [], 'cheap-api': [], 'premium-api': [] };
  for (const u of pool) (byTier[u.tier] || byTier['cheap-api']).push(u);
  byTier.subscription.sort((a, b) => {
    const ga = subscriptionGroup(a, quotas[a.id], settings);
    const gb = subscriptionGroup(b, quotas[b.id], settings);
    if (ga !== gb) return ga - gb;
    const ra = quotas[a.id] && quotas[a.id].resetsAt ? Date.parse(quotas[a.id].resetsAt) : Infinity;
    const rb = quotas[b.id] && quotas[b.id].resetsAt ? Date.parse(quotas[b.id].resetsAt) : Infinity;
    if (ra !== rb) return ra - rb; // soonest reset first: burn what expires first
    return priceOf(a) - priceOf(b) || a.id.localeCompare(b.id);
  });
  const byPrice = (a, b) => priceOf(a) - priceOf(b) || a.id.localeCompare(b.id);
  byTier['cheap-api'].sort(byPrice);
  byTier['premium-api'].sort(byPrice);
  // Known-exhausted subscriptions sink BELOW every API tier for the
  // initial pick (that is the whole point of quota-first routing), but
  // stay in the list as the last resort.
  const subsLive = byTier.subscription.filter((u) => subscriptionGroup(u, quotas[u.id], settings) < 2);
  const subsExhausted = byTier.subscription.filter((u) => subscriptionGroup(u, quotas[u.id], settings) >= 2);
  return [...subsLive, ...byTier['cheap-api'], ...byTier['premium-api'], ...subsExhausted];
}

function matchRule(rules, cwd) {
  if (!cwd) return null;
  return rules.find((r) => cwd.startsWith(r.cwdPrefix)) || null;
}

/**
 * @param {object} input
 * @param {object} input.registry  upstream registry (upstreams.js)
 * @param {Array}  input.rules     normalized rules from config
 * @param {object} input.settings  normalized settings from config
 * @param {object} input.quotas    snapshot {upstreamId: {remainingPct,resetsAt,source}}
 * @param {string|null} input.cwd  request working directory (best effort)
 * @param {string|null} input.stickyUpstreamId  upstream serving this session chain
 * @returns {{candidates: Array<{upstream:object, reason:string|null}>,
 *            blocked: null|{reasonCode:string, message:string},
 *            sensitive: boolean, rule: object|null}}
 */
function decide({ registry, rules, settings, quotas, cwd, stickyUpstreamId }) {
  const enabled = registry.enabled();
  const rule = matchRule(rules || [], cwd);
  const sensitive = Boolean(rule && rule.sensitive);
  let pool = enabled;
  if (sensitive) {
    pool = enabled.filter((u) => u.tier === 'subscription');
    if (!pool.length) {
      return {
        candidates: [],
        blocked: {
          reasonCode: 'sensitive_block',
          message: 'Relay fail-closed: this project is marked sensitive and no subscription-tier upstream is available; refusing to route to a pay-as-you-go API.',
        },
        sensitive,
        rule,
      };
    }
  }
  const pinnedId = rule && rule.upstream ? rule.upstream : null;
  let first = null;
  let firstReason = 'initial';
  if (pinnedId && pool.some((u) => u.id === pinnedId)) {
    first = pool.find((u) => u.id === pinnedId);
    firstReason = 'pinned';
  } else if (stickyUpstreamId && pool.some((u) => u.id === stickyUpstreamId)) {
    first = pool.find((u) => u.id === stickyUpstreamId);
    firstReason = 'sticky_session';
  }
  const rest = orderAuto(pool.filter((u) => !first || u.id !== first.id), quotas, settings);
  const candidates = [];
  if (first) candidates.push({ upstream: first, reason: firstReason });
  for (const u of rest) candidates.push({ upstream: u, reason: null });
  if (!first && candidates.length) candidates[0].reason = 'initial';
  return { candidates, blocked: null, sensitive, rule };
}

module.exports = { decide, orderAuto, matchRule, TIER_RANK };
