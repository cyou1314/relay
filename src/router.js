'use strict';
/**
 * Routing engine — pure decision logic, no I/O.
 *
 * Two axes decide every request:
 *   quota/price axis (PLAN §3) — burn expiring subscription quota before
 *     cash; priority: soonest-resetting ample subscription > subscription
 *     > cheap APIs > premium APIs (price-ascending inside API tiers).
 *   difficulty axis (DIFFICULTY-REPORT.md) — the classifier grades the
 *     task light|standard|heavy; every upstream model carries a
 *     capability grade; a task is only offered to models graded at or
 *     above its level, and cheap-but-adequate wins for light work.
 *
 * Decision order (first match wins for the LEAD candidate; the rest of
 * the list is the fallback chain). DIFFICULTY-REPORT.md §2 has the same
 * table — keep the two in sync.
 *   1. sensitive pool restriction / fail-closed block (unchanged)
 *   2. cwd pin — an explicit user rule beats everything; model = the
 *      pinned upstream's cheapest adequate model (else its strongest)
 *   3. session stickiness — the chain's upstream keeps the session,
 *      UNLESS it has no model graded for this task's level (the
 *      difficulty_upgrade exception: a chain that turns heavy is moved
 *      to a capable upstream rather than silently under-served)
 *   4. automatic ordering over capability-adequate (upstream, model)
 *      pairs: orderAuto tier/quota ordering; per upstream the model is
 *      the cheapest adequate one (lowest capability at/above the floor)
 *        - light + every known subscription quota below
 *          settings.preservePct -> API tiers lead instead, preserving
 *          the scarce subscription quota for heavier work
 *          (reason difficulty_light_preserve)
 *        - NO adequate pair anywhere -> strongest models lead anyway
 *          and the decision is flagged underpowered; the gateway logs
 *          reason difficulty_underpowered. Never a silent downgrade.
 *
 * decide() returns candidates as {upstream, model, reason}. The gateway
 * walks them, assigning fallback_* reason codes to later attempts.
 */

const { LEVEL_RANK } = require('./difficulty');
const { modelList } = require('./upstreams');

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

/**
 * Light-task preserve ordering: API tiers first (cheapest adequate
 * first), subscriptions after (they are what is being preserved; they
 * remain in the list as the fallback chain).
 */
function orderPreserve(pool, quotas, settings) {
  const ordered = orderAuto(pool, quotas, settings);
  const apis = ordered.filter((u) => u.tier !== 'subscription');
  const subs = ordered.filter((u) => u.tier === 'subscription');
  return [...apis, ...subs];
}

/** Cheapest adequate model of an upstream for a level: lowest capability at/above the floor; null if none is adequate. */
function adequateModel(upstream, level) {
  const floor = LEVEL_RANK[level];
  const ok = modelList(upstream).filter((m) => LEVEL_RANK[m.capability] >= floor);
  if (!ok.length) return null;
  ok.sort((a, b) => LEVEL_RANK[a.capability] - LEVEL_RANK[b.capability]);
  return ok[0];
}

/** Strongest model of an upstream (highest capability; first listed wins ties). */
function strongestModel(upstream) {
  const list = modelList(upstream);
  let best = list[0];
  for (const m of list) if (LEVEL_RANK[m.capability] > LEVEL_RANK[best.capability]) best = m;
  return best;
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
 * @param {object} [input.difficulty]  {level, score, signals} from difficulty.js (default standard)
 * @returns {{candidates: Array<{upstream:object, model:string|null, reason:string|null}>,
 *            blocked: null|{reasonCode:string, message:string},
 *            sensitive: boolean, rule: object|null,
 *            difficulty: object, underpowered: boolean, preserved: boolean}}
 */
function decide({ registry, rules, settings, quotas, cwd, stickyUpstreamId, difficulty }) {
  const diff = difficulty && LEVEL_RANK[difficulty.level] != null
    ? difficulty
    : { level: 'standard', score: 0, signals: [] };
  const level = diff.level;
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
        difficulty: diff,
        underpowered: false,
        preserved: false,
      };
    }
  }

  // Capability view of the pool: which upstreams can serve this level at
  // all, and with which model.
  const adequate = new Map(); // upstreamId -> model entry
  for (const u of pool) {
    const m = adequateModel(u, level);
    if (m) adequate.set(u.id, m);
  }
  const anyAdequate = adequate.size > 0;
  const underpowered = !anyAdequate;
  const modelFor = (u) => (adequate.get(u.id) || strongestModel(u)).id;

  const pinnedId = rule && rule.upstream ? rule.upstream : null;
  let first = null;
  let firstReason = 'initial';
  let preserved = false;

  if (pinnedId && pool.some((u) => u.id === pinnedId)) {
    // (2) pin: explicit user rule leads regardless of difficulty.
    first = { upstream: pool.find((u) => u.id === pinnedId), reason: 'pinned' };
    first.model = modelFor(first.upstream);
  } else if (stickyUpstreamId && pool.some((u) => u.id === stickyUpstreamId)) {
    const stickyUp = pool.find((u) => u.id === stickyUpstreamId);
    if (adequate.has(stickyUp.id)) {
      // (3) stickiness beats difficulty re-estimation: same upstream,
      // cheapest adequate model on it.
      first = { upstream: stickyUp, reason: 'sticky_session', model: adequate.get(stickyUp.id).id };
    } else {
      // (3') the chain's upstream cannot grade for this level (the
      // heavy-turn case): move the session; the auto winner below is
      // labelled difficulty_upgrade so the switch is never silent.
      firstReason = 'difficulty_upgrade';
    }
  }

  // (4) automatic ordering for everything else.
  let restPool = pool.filter((u) => !first || u.id !== first.upstream.id);
  if (anyAdequate) restPool = restPool.filter((u) => adequate.has(u.id));
  let ordered;
  if (!first && level === 'light') {
    // Preserve check: every subscription in the pool whose quota is
    // KNOWN sits below preservePct, and at least one of them still has
    // something above the exhaustion floor left to preserve. (When all
    // subscriptions are already exhausted, the plain quota-first order
    // already leads with APIs and the reason stays 'initial' — there is
    // nothing left to preserve.) Unknown quota never triggers preserve
    // (cannot preserve what cannot be measured).
    const knownSubQuotas = pool
      .filter((u) => u.tier === 'subscription')
      .map((u) => quotas[u.id])
      .filter((q) => q && q.remainingPct != null);
    const hasApi = restPool.some((u) => u.tier !== 'subscription');
    const scarceButAlive = knownSubQuotas.length
      && knownSubQuotas.every((q) => q.remainingPct < settings.preservePct)
      && knownSubQuotas.some((q) => q.remainingPct > settings.quotaFloorPct);
    if (hasApi && scarceButAlive) {
      preserved = true;
      ordered = orderPreserve(restPool, quotas, settings);
    } else {
      ordered = orderAuto(restPool, quotas, settings);
    }
  } else {
    ordered = orderAuto(restPool, quotas, settings);
  }

  const candidates = [];
  if (first) candidates.push(first);
  for (const u of ordered) candidates.push({ upstream: u, model: modelFor(u), reason: null });
  if (!first && candidates.length) {
    candidates[0].reason = underpowered ? 'difficulty_underpowered' : preserved ? 'difficulty_light_preserve' : firstReason;
  }
  return { candidates, blocked: null, sensitive, rule, difficulty: diff, underpowered, preserved };
}

module.exports = { decide, orderAuto, orderPreserve, matchRule, adequateModel, strongestModel, TIER_RANK };
