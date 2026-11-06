'use strict';
/**
 * Live dashboard (M4 wiring) — the approved design mock
 * (ui/dashboard-mock.html) bound to real data.
 *
 * Endpoints (mounted by src/gateway.js, read-only):
 *   GET /  and  GET /dashboard   the dashboard page (single self-contained
 *                                HTML document; white/gray + frosted glass,
 *                                four plain-language blocks, NO particles)
 *   GET /api/status              JSON assembled ONLY from real sources:
 *     quotas    src/quota.js per enabled subscription upstream, with the
 *               provenance stated verbatim in `source`; an estimated
 *               number (source 'metering-estimate') also carries
 *               estimate:true — the page shows the 估算 tag for it.
 *     today     src/ledger.js summarize() over today's slice of the
 *               routing log: served count, subscription-served count,
 *               API cash in USD.
 *     recent    the newest 10 /v1/responses log lines, each translated
 *               SERVER-SIDE into plain language (see REASON_WHY below):
 *               time, model, difficulty badge （简单/普通/复杂）, one
 *               human "why" sentence, and the cost （用额度 or ¥).
 *               Raw reason codes and token counts never reach the page.
 *     strategy  one plain sentence generated from the live settings
 *               (notably the preserve threshold), never hardcoded numbers.
 *
 * Money: the ledger's book currency is USD. The page displays ¥ like the
 * approved mock, converting with a configurable DISPLAY rate
 * (env RELAY_USD_CNY, default 7.2). The JSON carries both the USD
 * original and the converted value; the conversion is presentation
 * only and never feeds back into the books.
 */
const { summarize, readLines } = require('./ledger');
const { cashCostUsd } = require('./upstreams');

const DEFAULT_USD_CNY = 7.2;
const RECENT_LIMIT = 10;

/** 'codex-plan' -> 'Codex', 'gemini-pool' -> 'Gemini', else the raw id. */
function displayName(upstream) {
  if (!upstream) return '—';
  if (upstream.label) return upstream.label;
  const words = String(upstream.id).split('-').filter((w) => !['plan', 'pool', 'main'].includes(w));
  if (!words.length) return upstream.id;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * reasonCode -> plain-language "why" for a SERVED (2xx) attempt.
 * `initial` is tier-dependent and handled in humanWhy(); every other
 * routed code has a fixed sentence here. An unknown code falls back to
 * FALLBACK_WHY — the page must never print a raw code.
 */
const REASON_WHY = {
  pinned: '你给这个项目指定用的就是这家',
  sticky_session: '接着前面的对话，还用这家',
  fallback_quota: '前面那家额度用完了，自动换了这家',
  fallback_filtered: '前面那家把内容拦下了，自动换了这家',
  fallback_auth: '前面那家登录失效了，自动换了这家',
  fallback_error: '刚才那家出故障了，自动换了一家',
  difficulty_light_preserve: '任务简单，订阅额度又剩得不多，先用便宜的，把额度留给复杂任务',
  difficulty_upgrade: '任务变复杂了，换了更强的',
  difficulty_underpowered: '任务复杂，但没有更强的可用，先用这家顶上',
  invalid_request_stop: '这次的内容太长了，哪家都处理不了',
  sensitive_block: '这个项目被你标了机密，又没有订阅可用，按规矩拦下了',
  client_abort: '你中途取消了这次',
  upstream_error: '这家出故障了，没办成',
  passthrough_default: '直接发给了官方服务',
  translate_default: '直接发给了这家服务',
};
const FALLBACK_WHY = '按规则自动选择';

function initialWhy(tier) {
  if (tier === 'subscription') return '额度够，先用订阅的';
  if (tier === 'premium-api') return '用了更强的付费模型';
  return '订阅额度不够了，用了便宜的';
}

/**
 * The one human sentence for a log line. Served attempts explain the
 * routing choice (the reason code); failed attempts explain the failure
 * itself (a failed attempt's code says why it was TRIED, not why it
 * failed — the status/error carries that story).
 */
function humanWhy(entry, tier) {
  const status = entry.status || 0;
  const code = entry.reasonCode || '';
  if (code === 'sensitive_block') return REASON_WHY.sensitive_block;
  if (code === 'invalid_request_stop') return REASON_WHY.invalid_request_stop;
  if (status >= 200 && status < 300) {
    if (code === 'initial') return initialWhy(tier);
    return REASON_WHY[code] || FALLBACK_WHY;
  }
  if (code === 'client_abort' || status === 499) return '你中途取消了这次';
  if (status === 429 || /quota/i.test(String(entry.error || ''))) return '这家额度用完了，没办成';
  if (status === 401 || status === 403) return '这家登录失效了，没办成';
  if (status === 400) return '这次的内容不合要求，没办成';
  return '这家出故障了，没办成';
}

const BADGES = {
  light: { key: 'easy', text: '简单' },
  standard: { key: 'normal', text: '普通' },
  heavy: { key: 'hard', text: '复杂' },
};

function moneyText(cny) {
  if (!(cny > 0)) return '¥0';
  if (cny < 0.01) return '不到 ¥0.01';
  return '¥' + cny.toFixed(2);
}

const pad2 = (n) => String(n).padStart(2, '0');

function timeText(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--';
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function quotaHint(q) {
  if (!q || q.remainingPct == null) return '暂时不知道还剩多少';
  if (q.resetsAt) {
    const d = new Date(q.resetsAt);
    if (!Number.isNaN(d.getTime())) {
      const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      const now = new Date();
      if (d.toDateString() === now.toDateString()) return `今天 ${hm} 恢复满格`;
      if (d.toDateString() === new Date(now.getTime() + 86400000).toDateString()) return `明天 ${hm} 恢复满格`;
      return `${d.getMonth() + 1}月${d.getDate()}日 ${hm} 恢复满格`;
    }
  }
  return q.remainingPct >= 30 ? '够用，不用省着' : '剩得不多了，省着点用';
}

/** The strategy sentence, generated from the live config + settings. */
function strategyText(config) {
  if (!config) return '现在是直通模式：还没有开启自动选择，请求直接发给原来的服务。';
  const enabled = (config.upstreams || []).filter((u) => u.enabled !== false);
  const hasSub = enabled.some((u) => u.tier === 'subscription');
  const hasApi = enabled.some((u) => u.tier !== 'subscription');
  const preservePct = config.settings && Number.isFinite(config.settings.preservePct) ? config.settings.preservePct : 30;
  const parts = [];
  if (hasSub) parts.push('先用快要到期的订阅额度，尽量不花钱');
  if (hasSub && hasApi) parts.push(`订阅额度剩得不多时（低于 ${preservePct}%），简单任务会先用便宜的 API，把额度留给复杂任务`);
  parts.push('任务复杂的才用最强的模型');
  if (enabled.length > 1) parts.push('哪家出问题就自动换一家，你不用管');
  return parts.join('；') + '。';
}

function createDashboard({ config, registry, quotaService, logFile, feedbackFile, usdCny }) {
  const rate = Number.isFinite(usdCny) && usdCny > 0 ? usdCny : DEFAULT_USD_CNY;

  // Tier/cost resolution mirrors src/ledger.js exactly, so the recent
  // list and the books can never disagree: registry tier when the
  // upstream is configured, else the legacy mode-based inference.
  function tierOf(entry) {
    const up = registry ? registry.get(entry.upstream) : null;
    if (up) return up.tier;
    return entry.mode === 'passthrough' ? 'subscription' : 'cheap-api';
  }
  function upstreamOf(entry) {
    return registry ? registry.get(entry.upstream) : null;
  }

  function costFor(entry, tier) {
    const ok = entry.status >= 200 && entry.status < 300 && entry.usage;
    if (!ok) return { kind: 'none', text: '没花钱' };
    if (tier === 'subscription') return { kind: 'quota', text: '用额度' };
    const usd = cashCostUsd(upstreamOf(entry), entry.usage);
    const cny = usd * rate;
    return { kind: 'money', usd, cny, text: moneyText(cny) };
  }

  function recentItem(entry) {
    const tier = tierOf(entry);
    const level = entry.difficulty && entry.difficulty.level;
    return {
      time: timeText(entry.ts),
      ts: entry.ts || null,
      model: entry.servedModel || entry.model || (entry.upstream ? displayName(upstreamOf(entry)) : '—'),
      badge: BADGES[level] || null,
      why: humanWhy(entry, tier),
      cost: costFor(entry, tier),
    };
  }

  function buildStatus() {
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const todaySum = summarize({
      config, logFile, feedbackFile,
      fromTs: dayStart.toISOString(), toTs: dayEnd.toISOString(),
    });
    let subscriptionServed = 0;
    for (const b of Object.values(todaySum.quota.byUpstream)) subscriptionServed += b.requests;

    const quotas = [];
    if (registry && quotaService) {
      for (const u of registry.enabled()) {
        if (u.tier !== 'subscription') continue;
        const q = quotaService.getQuota(u.id);
        quotas.push({
          id: u.id,
          name: displayName(u),
          remainingPct: q.remainingPct,
          resetsAt: q.resetsAt || null,
          source: q.source,
          estimate: q.source === 'metering-estimate',
          hint: quotaHint(q),
        });
      }
    }

    const responseLines = readLines(logFile).filter((e) => e.path === '/v1/responses');
    const recent = responseLines.slice(-RECENT_LIMIT).reverse().map(recentItem);

    return {
      generatedAt: now.toISOString(),
      usdCnyRate: rate,
      empty: responseLines.length === 0,
      quotas,
      today: {
        date: dayStart.toISOString().slice(0, 10),
        served: todaySum.servedRequests,
        subscriptionServed,
        cashUsd: todaySum.cash.totalUsd,
        cashCny: todaySum.cash.totalUsd * rate,
      },
      recent,
      strategy: strategyText(config),
    };
  }

  function sendBody(res, status, contentType, body) {
    res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }
  function handleStatus(req, res) {
    sendBody(res, 200, 'application/json', JSON.stringify(buildStatus()));
  }
  function handleHtml(req, res) {
    sendBody(res, 200, 'text/html; charset=utf-8', PAGE_HTML);
  }

  return { buildStatus, handleStatus, handleHtml, recentItem };
}

// ---------------------------------------------------------------------------
// The page: the approved mock's markup/CSS with fixture values replaced
// by live rendering. Inline script contains no routing codes and no
// fixture numbers; all translation happens server-side above.
// ---------------------------------------------------------------------------
const PAGE_HTML = `<!doctype html>
<!-- Relay 仪表盘（正式版）：数字全部来自 /api/status 的真实记录，每 15 秒静默刷新。 -->
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Relay — 仪表盘</title>
<style>
  :root{
    --bg:#f4f4f6;
    --ink:#1d1d1f;
    --sub:#5f5f63;
    --faint:#76767c;
    --hair:rgba(0,0,0,.07);
    --blue:#0071e3;
    --green:#34c759;
    --track:rgba(120,120,128,.16);
    --glass:rgba(255,255,255,.55);
    --glass-line:rgba(255,255,255,.65);
    --shadow:0 2px 6px rgba(0,0,0,.04),0 14px 34px rgba(0,0,0,.06),inset 0 1px 0 rgba(255,255,255,.8);
    --shadow-hover:0 4px 10px rgba(0,0,0,.05),0 20px 44px rgba(0,0,0,.09),inset 0 1px 0 rgba(255,255,255,.8);
    --ease:cubic-bezier(0.22,1,0.36,1);
    --sans:-apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC','Helvetica Neue',Helvetica,Arial,sans-serif;
  }
  *{box-sizing:border-box}
  html{-webkit-font-smoothing:antialiased}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.7 var(--sans)}
  .wallpaper{position:fixed;inset:0;z-index:-1;pointer-events:none;
    background:
      radial-gradient(900px 620px at 18% 6%,  rgba(255,255,255,.95), rgba(255,255,255,0) 62%),
      radial-gradient(1000px 720px at 85% 90%, rgba(196,196,202,.34), rgba(196,196,202,0) 65%),
      radial-gradient(760px 560px at 78% 10%,  rgba(214,214,219,.28), rgba(214,214,219,0) 62%),
      radial-gradient(880px 640px at 8% 88%,   rgba(206,206,212,.26), rgba(206,206,212,0) 62%),
      linear-gradient(168deg, #fbfbfc 0%, #f4f4f6 46%, #eeeef0 100%)}
  .wrap{max-width:880px;margin:0 auto;padding:44px 28px 40px}
  header{display:flex;align-items:baseline;gap:14px;margin-bottom:30px}
  header h1{font-size:32px;line-height:1.1;font-weight:700;letter-spacing:-.02em;margin:0}
  header .sub{color:var(--sub);font-size:15px}
  header .live{margin-left:auto;font-size:12px;font-weight:600;color:var(--sub);background:rgba(255,255,255,.45);border:1px solid rgba(255,255,255,.6);
    -webkit-backdrop-filter:blur(10px) saturate(120%);backdrop-filter:blur(10px) saturate(120%);
    border-radius:999px;padding:3px 12px;white-space:nowrap}
  .statusline{display:flex;align-items:center;gap:8px;color:var(--sub);font-size:14px;margin:-18px 0 26px}
  .dot{position:relative;width:9px;height:9px;border-radius:50%;background:var(--green);flex:none}
  .dot::after{content:"";position:absolute;inset:0;border-radius:50%;background:rgba(52,199,89,.45);
    animation:pulse 2s ease-out infinite}
  @keyframes pulse{from{transform:scale(1);opacity:.55}to{transform:scale(2.3);opacity:0}}
  .glass{background:var(--glass);border:1px solid var(--glass-line);border-radius:20px;box-shadow:var(--shadow);
    -webkit-backdrop-filter:blur(22px) saturate(120%);backdrop-filter:blur(22px) saturate(120%)}
  @keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
  .rise{animation:rise .85s var(--ease) backwards;animation-delay:var(--d,0s)}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:20px;margin-bottom:20px}
  .card{padding:24px 26px;transition:transform .3s ease,box-shadow .3s ease}
  .card:hover{transform:translateY(-2px);box-shadow:var(--shadow-hover)}
  .card h3{margin:0 0 12px;font-size:15px;font-weight:600;color:var(--sub)}
  .big{font-size:42px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.05}
  .big .unit{font-size:22px;font-weight:600;color:var(--sub)}
  .bar{height:7px;background:var(--track);border-radius:4px;margin:16px 0 12px;overflow:hidden}
  .bar i{display:block;height:100%;width:0;background:var(--blue);border-radius:4px;
    animation:grow .9s var(--ease) .2s forwards;transition:width .6s var(--ease)}
  .bar i.still{animation:none;width:var(--w)}
  @keyframes grow{from{width:0}to{width:var(--w)}}
  .hint{color:var(--sub);font-size:14px;line-height:1.6}
  .tag{display:inline-block;border-radius:999px;padding:1px 10px;font-size:12px;font-weight:600;color:var(--sub);background:rgba(0,0,0,.05);border:1px solid rgba(255,255,255,.5);margin-left:8px;vertical-align:5px}
  .summary{padding:22px 26px;margin-bottom:20px}
  .summary p{margin:0;font-size:18px}
  .summary b{font-weight:700}
  section{padding:24px 26px;margin-bottom:20px}
  section h2{margin:0 0 8px;font-size:19px;font-weight:600;letter-spacing:-.01em}
  .item{display:flex;gap:16px;align-items:baseline;padding:13px 0;border-bottom:1px solid var(--hair)}
  .item:last-child{border-bottom:none;padding-bottom:2px}
  .item .time{color:var(--faint);font-size:14px;font-variant-numeric:tabular-nums;flex:none;width:52px}
  .item .main{flex:1;min-width:0}
  .item .model{font-weight:600;font-size:16px}
  .badge{display:inline-block;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:600;margin-left:8px;vertical-align:2px;border:1px solid rgba(255,255,255,.5)}
  .badge.easy{color:var(--sub);background:rgba(255,255,255,.5)}
  .badge.normal{color:#3a3a3c;background:rgba(0,0,0,.06)}
  .badge.hard{color:var(--ink);background:rgba(0,0,0,.11)}
  .item .why{color:var(--sub);font-size:14.5px;line-height:1.55}
  .item .cost{flex:none;font-weight:600;font-size:15px;font-variant-numeric:tabular-nums;white-space:nowrap}
  .item .cost.quota{color:var(--sub);font-weight:500}
  .empty{color:var(--sub);font-size:15.5px;padding:16px 0 10px;line-height:1.7}
  .strategy{color:var(--sub);font-size:15.5px;line-height:1.7;padding:2px 6px 0}
  .strategy b{color:var(--ink);font-weight:600}
  footer{color:var(--faint);font-size:13px;padding:10px 6px 0}
  @supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
    .glass{background:rgba(255,255,255,.92)}
    header .live{background:rgba(255,255,255,.92)}
    .badge.easy{background:rgba(245,245,247,.92)}
  }
  @media (prefers-reduced-motion: reduce){
    *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
    .bar i{width:var(--w)}
  }
</style>
</head>
<body>
<div class="wallpaper" aria-hidden="true"></div>
<div class="wrap">
  <header>
    <h1>Relay</h1>
    <span class="sub">我的模型管家</span>
    <span class="live">实时数据</span>
  </header>
  <div class="statusline"><span class="dot"></span><span id="statusText">正在运行，一切正常</span></div>

  <div class="cards" id="cards"></div>

  <div class="summary glass rise" style="--d:.30s">
    <p id="summaryText">正在读取你的记录…</p>
  </div>

  <section class="glass rise" style="--d:.38s">
    <h2>最近动态</h2>
    <div id="recentList"><div class="empty">正在读取…</div></div>
  </section>

  <div class="strategy" id="strategyText"></div>

  <footer>数字来自你自己的使用记录，每 15 秒自动更新一次。</footer>
</div>
<script>
(function(){
  var firstRender = true;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function money(cny){ if(!(cny > 0)) return '0'; if(cny < 0.01) return '0.01'; return cny.toFixed(2); }

  function quotaCard(q, idx, animate){
    var pct = (q.remainingPct == null) ? null : Math.round(q.remainingPct);
    var big = pct == null
      ? '<div class="big">—</div>'
      : '<div class="big"><span class="num" data-count="' + pct + '">0</span><span class="unit">%</span>' + (q.estimate ? '<span class="tag">估算</span>' : '') + '</div>';
    var bar = pct == null ? '' : '<div class="bar"><i class="' + (animate ? '' : 'still') + '" style="--w:' + pct + '%"></i></div>';
    var hintStyle = pct == null ? '' : (q.resetsAt ? '' : ' style="margin-top:16px"');
    return '<div class="card glass' + (animate ? ' rise' : '') + '" style="--d:' + (0.05 + idx * 0.08).toFixed(2) + 's">'
      + '<h3>' + esc(q.name) + ' 剩余额度</h3>' + big + bar
      + '<div class="hint"' + hintStyle + '>' + esc(q.hint) + '</div></div>';
  }
  function spendCard(d, idx, animate){
    var hint = d.today.subscriptionServed > 0
      ? '今天 ' + d.today.subscriptionServed + ' 次走订阅额度，没花钱'
      : '大部分时候用的是订阅额度，没花钱';
    return '<div class="card glass' + (animate ? ' rise' : '') + '" style="--d:' + (0.05 + idx * 0.08).toFixed(2) + 's">'
      + '<h3>API 今天已花费</h3>'
      + '<div class="big"><span class="unit">¥</span><span class="num" data-count="' + d.today.cashCny.toFixed(2) + '" data-dec="2">0.00</span></div>'
      + '<div class="hint" style="margin-top:16px">' + esc(hint) + '</div></div>';
  }
  function renderCards(d, animate){
    var html = '';
    d.quotas.forEach(function(q, i){ html += quotaCard(q, i, animate); });
    html += spendCard(d, d.quotas.length, animate);
    document.getElementById('cards').innerHTML = html;
    if (!animate || reduced) {
      document.querySelectorAll('.num[data-count]').forEach(function(el){
        var dec = parseInt(el.getAttribute('data-dec') || '0', 10);
        el.textContent = parseFloat(el.getAttribute('data-count')).toFixed(dec);
      });
    }
  }
  function renderSummary(d){
    var el = document.getElementById('summaryText');
    if (!d.today.served) { el.textContent = '今天还没用过，等你开始用 Codex 干活，这里会记下来。'; return; }
    var s = '今天一共用了 <b>' + d.today.served + ' 次</b>';
    if (d.today.subscriptionServed > 0) s += '，其中 ' + d.today.subscriptionServed + ' 次走订阅额度没花钱';
    s += '，API 一共花了 <b>¥' + money(d.today.cashCny) + '</b>。';
    el.innerHTML = s;
  }
  function renderRecent(d, animate){
    var box = document.getElementById('recentList');
    if (!d.recent.length) {
      box.innerHTML = '<div class="empty">还没有记录，等你用 Codex 干活后，这里会动起来。</div>';
      return;
    }
    box.innerHTML = d.recent.map(function(it, i){
      var badge = it.badge ? '<span class="badge ' + it.badge.key + '">' + esc(it.badge.text) + '</span>' : '';
      var costCls = it.cost.kind === 'quota' ? 'cost quota' : 'cost';
      return '<div class="item' + (animate ? ' rise' : '') + '" style="--d:' + (0.42 + i * 0.06).toFixed(2) + 's">'
        + '<span class="time">' + esc(it.time) + '</span>'
        + '<div class="main"><span class="model">' + esc(it.model) + '</span>' + badge
        + '<div class="why">' + esc(it.why) + '</div></div>'
        + '<span class="' + costCls + '">' + esc(it.cost.text) + '</span></div>';
    }).join('');
  }
  function countUp(){
    if (reduced) return;
    var ease = function(t){ return 1 - Math.pow(1 - t, 3); };
    document.querySelectorAll('.num[data-count]').forEach(function(el){
      var target = parseFloat(el.getAttribute('data-count'));
      var dec = parseInt(el.getAttribute('data-dec') || '0', 10);
      var dur = 900, start = null;
      el.textContent = (0).toFixed(dec);
      function frame(ts){
        if (!start) start = ts;
        var p = Math.min((ts - start) / dur, 1);
        el.textContent = (target * ease(p)).toFixed(dec);
        if (p < 1) requestAnimationFrame(frame);
      }
      setTimeout(function(){ requestAnimationFrame(frame); }, 200);
    });
  }
  function render(d){
    var animate = firstRender;
    renderCards(d, animate);
    renderSummary(d);
    renderRecent(d, animate);
    document.getElementById('strategyText').innerHTML = '<b>现在的做法：</b>' + esc(d.strategy);
    if (animate) countUp();
    firstRender = false;
  }
  function load(){
    fetch('/api/status').then(function(r){ return r.json(); }).then(render).catch(function(){
      document.getElementById('statusText').textContent = '暂时连不上，正在重试';
    });
  }
  load();
  setInterval(load, 15000);
})();
</script>
</body>
</html>
`;

module.exports = { createDashboard, humanWhy, REASON_WHY, FALLBACK_WHY, strategyText, displayName, DEFAULT_USD_CNY };
