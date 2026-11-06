/**
 * Relay M0 automated tests: gateway (translate mode) + mock upstream.
 * Run: npm test
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const MOCK_PORT = 18941;
const GW_PORT = 18942;
const GW = `http://127.0.0.1:${GW_PORT}`;
const LOG_FILE = '/tmp/relay-m0-test.log';
const SECRET = 'DUMMY_SECRET_DO_NOT_LOG';
fs.rmSync(LOG_FILE, { force: true });

const children = [];
function start(args, env) {
  const child = spawn('node', args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  children.push(child);
  return child;
}
async function waitHealth(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`health check failed: ${url}`);
}

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function postResponses(body) {
  const r = await fetch(`${GW}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  });
  return r;
}
async function postResponsesJson(body) {
  const r = await postResponses(body);
  return { status: r.status, json: await r.json() };
}
async function postResponsesSse(body) {
  const r = await postResponses(body);
  const raw = await r.text();
  const events = [];
  for (const block of raw.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const data = line.slice(5).trim();
    if (data && data !== '[DONE]') events.push(JSON.parse(data));
  }
  return { status: r.status, events };
}

const TOOLS = [{ type: 'function', name: 'run_echo', description: 'echo text', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }];

try {
  start(['test/mock-upstream.js'], { MOCK_PORT: String(MOCK_PORT) });
  start(['src/gateway.js'], { RELAY_MODE: 'translate', RELAY_PORT: String(GW_PORT), RELAY_UPSTREAM_BASE: `http://127.0.0.1:${MOCK_PORT}/v1`, RELAY_LOG_FILE: LOG_FILE, RELAY_UPSTREAM_TIMEOUT_MS: '600' });
  await waitHealth(`http://127.0.0.1:${MOCK_PORT}/health`);
  await waitHealth(`${GW}/health`);
  console.log('gateway + mock upstream up');

  console.log('test 1: non-stream text');
  {
    const { status, json } = await postResponsesJson({ model: 'mock-model', input: 'say hello', stream: false });
    check('status 200', status === 200, `got ${status}`);
    check('object=response', json.object === 'response');
    check('status completed', json.status === 'completed');
    const msg = (json.output || []).find((o) => o.type === 'message');
    check('text exact', msg && msg.content[0].text === 'Hello from mock upstream.', JSON.stringify(json.output));
    check('usage mapped', json.usage && json.usage.input_tokens === 12 && json.usage.output_tokens === 7 && json.usage.total_tokens === 19, JSON.stringify(json.usage));
  }

  console.log('test 2: non-stream tool call');
  {
    const { status, json } = await postResponsesJson({ model: 'mock-model', input: 'CALL_TOOL please', tools: TOOLS, stream: false });
    check('status 200', status === 200);
    const fc = (json.output || []).find((o) => o.type === 'function_call');
    check('function_call item present', Boolean(fc), JSON.stringify(json.output));
    check('tool name', fc && fc.name === 'run_echo');
    check('call_id passthrough', fc && fc.call_id === 'call_mock_1');
    let argsOk = false; try { argsOk = JSON.parse(fc.arguments).text === 'hello-from-tool'; } catch {}
    check('arguments assembled', argsOk, fc && fc.arguments);
  }

  console.log('test 3: tool-result roundtrip (request translation)');
  {
    const input = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read the file' }] },
      { type: 'function_call', call_id: 'call_mock_1', name: 'run_echo', arguments: '{"text":"hi"}' },
      { type: 'function_call_output', call_id: 'call_mock_1', output: 'file-contents-xyz' },
    ];
    const { json } = await postResponsesJson({ model: 'mock-model', input, tools: TOOLS, stream: false });
    const msg = (json.output || []).find((o) => o.type === 'message');
    check('mock saw tool role and echoed output', msg && msg.content[0].text === 'After tool: file-contents-xyz', msg && msg.content[0].text);
  }

  console.log('test 4: streaming text event sequence');
  {
    const { status, events } = await postResponsesSse({ model: 'mock-model', input: 'say hello', stream: true });
    const types = events.map((e) => e.type);
    check('status 200', status === 200);
    check('first event response.created', types[0] === 'response.created', types.slice(0, 3).join(','));
    check('has output_text.delta', types.includes('response.output_text.delta'));
    check('has output_item.done', types.includes('response.output_item.done'));
    check('last event response.completed', types[types.length - 1] === 'response.completed', types.slice(-2).join(','));
    check('created < delta < completed order', types.indexOf('response.created') < types.indexOf('response.output_text.delta') && types.indexOf('response.output_text.delta') < types.lastIndexOf('response.completed'));
    const deltas = events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('');
    check('delta concat = full text', deltas === 'Hello from mock upstream.', deltas);
    const completed = events[events.length - 1].response;
    const msg = (completed.output || []).find((o) => o.type === 'message');
    check('completed output text', msg && msg.content[0].text === 'Hello from mock upstream.');
    check('completed usage mapped', completed.usage && completed.usage.total_tokens === 19, JSON.stringify(completed.usage));
    const seqs = events.map((e) => e.sequence_number);
    check('sequence numbers increasing', seqs.every((v, i) => i === 0 || v > seqs[i - 1]), seqs.join(','));
  }

  console.log('test 5: streaming tool call');
  {
    const { events } = await postResponsesSse({ model: 'mock-model', input: 'CALL_TOOL please', tools: TOOLS, stream: true });
    const types = events.map((e) => e.type);
    check('has function_call_arguments.delta', types.includes('response.function_call_arguments.delta'));
    check('has function_call_arguments.done', types.includes('response.function_call_arguments.done'));
    const argDeltas = events.filter((e) => e.type === 'response.function_call_arguments.delta').map((e) => e.delta).join('');
    check('argument deltas assemble', argDeltas === '{"text":"hello-from-tool"}', argDeltas);
    const completed = events[events.length - 1].response;
    const fc = (completed.output || []).find((o) => o.type === 'function_call');
    check('completed has function_call', Boolean(fc) && fc.name === 'run_echo' && fc.call_id === 'call_mock_1');
    check('completed arguments string', fc && fc.arguments === '{"text":"hello-from-tool"}', fc && fc.arguments);
  }

  console.log('test 6: routing log + secret hygiene');
  {
    await new Promise((r) => setTimeout(r, 200));
    const log = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
    const lines = log.trim().split('\n').filter(Boolean);
    check('log lines >= 5', lines.length >= 5, `got ${lines.length}`);
    let allJson = true; for (const l of lines) { try { JSON.parse(l); } catch { allJson = false; } }
    check('log lines are JSON', allJson);
    check('log has translate mode entries', lines.some((l) => l.includes('"mode":"translate"')));
    check('log contains NO authorization secret', !log.includes(SECRET) && !log.toLowerCase().includes('bearer'));
  }

  const readLogEntries = () => {
    const log = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
    return log.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  };

  console.log('test 7: GET /v1/models (translate mode, mapped from upstream)');
  {
    const r = await fetch(`${GW}/v1/models`);
    const json = await r.json();
    check('status 200', r.status === 200, `got ${r.status}`);
    check('object=list', json.object === 'list', JSON.stringify(json).slice(0, 120));
    const ids = (json.data || []).map((m) => m.id);
    check('contains mock-model', ids.includes('mock-model'), ids.join(','));
    check('contains mock-model-2', ids.includes('mock-model-2'), ids.join(','));
    check('entries have object=model', (json.data || []).every((m) => m.object === 'model'));
  }

  console.log('test 8: upstream 429 mapped to Responses error shape');
  {
    const { status, json } = await postResponsesJson({ model: 'mock-model', input: 'FAIL_429 please', stream: false });
    check('status preserved 429', status === 429, `got ${status}`);
    check('error object present', Boolean(json.error) && typeof json.error.message === 'string', JSON.stringify(json).slice(0, 160));
    check('upstream message carried', json.error && json.error.message.includes('rate limit'), json.error && json.error.message);
    check('upstream code carried', json.error && json.error.code === 'mock_rate_limit', json.error && json.error.code);
    await new Promise((r) => setTimeout(r, 150));
    const e429 = readLogEntries().find((e) => e.status === 429);
    check('log reasonCode upstream_error for 429', Boolean(e429) && e429.reasonCode === 'upstream_error', e429 && e429.reasonCode);
    check('log entry has model+upstream', Boolean(e429) && e429.model === 'mock-model' && typeof e429.upstream === 'string');
  }

  console.log('test 9: upstream 500 mapped to Responses error shape');
  {
    const { status, json } = await postResponsesJson({ model: 'mock-model', input: 'FAIL_500 please', stream: false });
    check('status preserved 500', status === 500, `got ${status}`);
    check('error object present', Boolean(json.error) && json.error.code === 'mock_internal', JSON.stringify(json).slice(0, 160));
  }

  console.log('test 10: upstream timeout -> 504, no hang');
  {
    const t0 = Date.now();
    const { status, json } = await postResponsesJson({ model: 'mock-model', input: 'FAIL_TIMEOUT please', stream: false });
    const elapsed = Date.now() - t0;
    check('status 504', status === 504, `got ${status}`);
    check('error type relay_upstream_timeout', Boolean(json.error) && json.error.type === 'relay_upstream_timeout', JSON.stringify(json).slice(0, 160));
    check('returned well before upstream delay', elapsed < 2600, `${elapsed}ms`);
  }

  console.log('test 11: upstream SSE drop mid-stream -> response.failed, no hang');
  {
    const r = await fetch(`${GW}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ model: 'mock-model', input: 'FAIL_DROP please', stream: true }),
      signal: AbortSignal.timeout(8000),
    });
    const raw = await r.text();
    const events = [];
    for (const block of raw.split('\n\n')) {
      const line = block.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data && data !== '[DONE]') events.push(JSON.parse(data));
    }
    const types = events.map((e) => e.type);
    check('status 200 (stream opened)', r.status === 200, `got ${r.status}`);
    check('stream terminated with response.failed', types[types.length - 1] === 'response.failed', types.join(','));
    check('no response.completed', !types.includes('response.completed'));
    const failed = events[events.length - 1];
    check('failed response carries error', Boolean(failed.response && failed.response.error && failed.response.status === 'failed'), JSON.stringify(failed).slice(0, 200));
  }

  console.log('test 12: pre-header connection failure retried once; hard drop -> 502');
  {
    const ok = await postResponsesJson({ model: 'mock-model', input: 'FAIL_ONCE please', stream: false });
    check('retry recovered with 200', ok.status === 200, `got ${ok.status}`);
    const msg = (ok.json.output || []).find((o) => o.type === 'message');
    check('retry returned normal text', msg && msg.content[0].text === 'Hello from mock upstream.', msg && msg.content[0].text);
    const drop = await postResponsesJson({ model: 'mock-model', input: 'FAIL_DROP please', stream: false });
    check('non-stream drop maps to 502', drop.status === 502, `got ${drop.status}`);
    check('502 has Responses error shape', Boolean(drop.json.error) && typeof drop.json.error.message === 'string', JSON.stringify(drop.json).slice(0, 160));
  }

  console.log('test 13: config manager install -> status -> restore (byte-exact)');
  {
    const CODEX_BIN = [process.env.RELAY_CODEX_BIN, path.join(os.homedir(), 'bin', 'codex'), '/opt/hatch-image/bin/codex'].find((p) => p && fs.existsSync(p)) || 'codex';
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fake-codex-'));
    const configPath = path.join(fakeHome, 'config.toml');
    const backupPath = path.join(fakeHome, 'config-before-relay.toml');
    const original = '# my codex config\nmodel = "gpt-6-luna"\nmodel_reasoning_effort = "low"\n\n[projects."/tmp"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(configPath, original);
    const originalBuf = Buffer.from(original);
    const cm = (args, extraEnv = {}) => spawnSync('node', ['src/config-manager.js', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, RELAY_CODEX_BIN: CODEX_BIN, ...extraEnv } });

    const refused = cm(['install', '--codex-home', fakeHome], { RELAY_CODEX_BIN: '/nonexistent/codex-bin' });
    check('version gate refuses when version unknown', refused.status !== 0, `exit ${refused.status}`);
    check('config untouched after refusal', fs.readFileSync(configPath).equals(originalBuf));
    check('no backup created after refusal', !fs.existsSync(backupPath));

    const inst = cm(['install', '--codex-home', fakeHome]);
    check('install exit 0', inst.status === 0, inst.stderr);
    const installed = fs.readFileSync(configPath, 'utf8');
    check('managed markers present', installed.includes('# BEGIN RELAY MANAGED') && installed.includes('# END RELAY MANAGED'));
    check('provider definition written', installed.includes('[model_providers.relay]') && installed.includes('wire_api = "responses"') && installed.includes('supports_websockets = false'));
    check('user top-level keys preserved', installed.includes('model = "gpt-6-luna"') && installed.includes('model_reasoning_effort = "low"'));
    check('user table preserved', installed.includes('[projects."/tmp"]') && installed.includes('trust_level = "trusted"'));
    check('backup is byte-exact original', fs.existsSync(backupPath) && fs.readFileSync(backupPath).equals(originalBuf));

    const inst2 = cm(['install', '--codex-home', fakeHome]);
    check('re-install exit 0 (idempotent)', inst2.status === 0, inst2.stderr);
    const installed2 = fs.readFileSync(configPath, 'utf8');
    check('selection block not duplicated', (installed2.match(/# BEGIN RELAY MANAGED \(provider selection/g) || []).length === 1);
    check('backup still original after re-install', fs.readFileSync(backupPath).equals(originalBuf));

    const st = cm(['status', '--codex-home', fakeHome]);
    let stJson = null; try { stJson = JSON.parse(st.stdout); } catch {}
    check('status reports managed relay', Boolean(stJson) && stJson.managed === true && stJson.provider === 'relay' && stJson.backupExists === true, st.stdout);

    const rst = cm(['restore', '--codex-home', fakeHome]);
    check('restore exit 0', rst.status === 0, rst.stderr);
    check('restored config byte-exact vs original', fs.readFileSync(configPath).equals(originalBuf));
    check('backup removed after restore', !fs.existsSync(backupPath));
    const st2 = cm(['status', '--codex-home', fakeHome]);
    let st2Json = null; try { st2Json = JSON.parse(st2.stdout); } catch {}
    check('status after restore: unmanaged', Boolean(st2Json) && st2Json.managed === false, st2.stdout);
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }

  // =======================================================================
  // Core phase: routed mode (config-driven registry + router + ledger).
  // Everything below runs against mock upstreams only — no real logins,
  // no real API keys. Each routing phase gets its own gateway port, its
  // own config file and its own routing log.
  // =======================================================================
  const SUB_PORT = 18961, CHEAP_PORT = 18962, PREM_PORT = 18963, BADQ_PORT = 18964, BAD5_PORT = 18965, FILT_PORT = 18966;
  const coreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-core-'));
  const quotaFile = path.join(coreDir, 'quota.json');
  const feedbackFile = path.join(coreDir, 'feedback.json');
  const setSubQuota = (pct) => fs.writeFileSync(quotaFile, JSON.stringify({ 'sub-main': { remainingPct: pct, resetsAt: '2026-11-06T12:00:00.000Z' } }));
  const PRICES = { cheap: { inputPer1k: 0.001, outputPer1k: 0.002 }, premium: { inputPer1k: 0.01, outputPer1k: 0.02 } };
  const subUp = (port) => ({ id: 'sub-main', kind: 'chat', tier: 'subscription', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'sub-model', models: ['sub-model'], quota: { source: 'mock', mockFile: quotaFile } });
  const cheapUp = (port) => ({ id: 'cheap-api', kind: 'chat', tier: 'cheap-api', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'cheap-model', models: ['cheap-model'], price: PRICES.cheap, quota: { source: 'unavailable' } });
  const premUp = (port) => ({ id: 'premium-api', kind: 'chat', tier: 'premium-api', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'premium-model', models: ['premium-model'], price: PRICES.premium, quota: { source: 'unavailable' } });
  const writeCfg = (name, upstreams, rules) => {
    const p = path.join(coreDir, name);
    fs.writeFileSync(p, JSON.stringify({ settings: { quotaFloorPct: 2, amplePct: 25 }, rules: rules || [], upstreams }, null, 1));
    return p;
  };
  start(['test/mock-upstream.js'], { MOCK_PORT: String(SUB_PORT), MOCK_TEXT: 'Hello from sub upstream.', MOCK_USAGE_IN: '10', MOCK_USAGE_OUT: '5', MOCK_MODEL_IDS: 'sub-model' });
  start(['test/mock-upstream.js'], { MOCK_PORT: String(CHEAP_PORT), MOCK_TEXT: 'Hello from cheap upstream.', MOCK_USAGE_IN: '20', MOCK_USAGE_OUT: '10', MOCK_MODEL_IDS: 'cheap-model' });
  start(['test/mock-upstream.js'], { MOCK_PORT: String(PREM_PORT), MOCK_TEXT: 'Hello from premium upstream.', MOCK_USAGE_IN: '30', MOCK_USAGE_OUT: '15', MOCK_MODEL_IDS: 'premium-model' });
  start(['test/mock-upstream.js'], { MOCK_PORT: String(BADQ_PORT), MOCK_FAIL_STATUS: '429', MOCK_FAIL_CODE: 'insufficient_quota', MOCK_FAIL_MESSAGE: 'plan quota exhausted', MOCK_MODEL_IDS: 'sub-model' });
  start(['test/mock-upstream.js'], { MOCK_PORT: String(BAD5_PORT), MOCK_FAIL_STATUS: '500', MOCK_FAIL_CODE: 'mock_internal', MOCK_MODEL_IDS: 'cheap-model' });
  start(['test/mock-upstream.js'], { MOCK_PORT: String(FILT_PORT), MOCK_FAIL_STATUS: '400', MOCK_FAIL_CODE: 'content_filter', MOCK_FAIL_MESSAGE: 'request blocked by safety policy filter', MOCK_MODEL_IDS: 'sub-model' });
  for (const p of [SUB_PORT, CHEAP_PORT, PREM_PORT, BADQ_PORT, BAD5_PORT, FILT_PORT]) await waitHealth(`http://127.0.0.1:${p}/health`);

  const startRouted = async (port, cfg, log) => {
    start(['src/gateway.js'], { RELAY_PORT: String(port), RELAY_CONFIG: cfg, RELAY_LOG_FILE: log, RELAY_FEEDBACK_FILE: feedbackFile });
    await waitHealth(`http://127.0.0.1:${port}/health`);
    return `http://127.0.0.1:${port}`;
  };
  const routedPost = async (base, body, headers = {}) => {
    const r = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  const textOf = (json) => { const m = (json.output || []).find((o) => o.type === 'message'); return m && m.content[0].text; };
  const entriesOf = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.path === '/v1/responses');
  const lastAttempt = (log) => { const es = entriesOf(log); return es[es.length - 1]; };

  // ---- Phase A: priority, stickiness, pin, sensitive-allowed, feedback --
  const logA = path.join(coreDir, 'routing-a.jsonl');
  const cfgA = writeCfg('config-a.json',
    [subUp(SUB_PORT), cheapUp(CHEAP_PORT), premUp(PREM_PORT)],
    [{ cwdPrefix: '/work/pinned-proj', upstream: 'premium-api' }, { cwdPrefix: '/work/secret-proj', sensitive: true }]);
  setSubQuota(80);
  const A = await startRouted(18951, cfgA, logA);

  console.log('test 14: routed priority — ample subscription quota wins');
  {
    const { status, json } = await routedPost(A, { model: 'mock-model', input: 'say hello', stream: false });
    check('status 200', status === 200, `got ${status}`);
    check('served by subscription upstream', textOf(json) === 'Hello from sub upstream.', textOf(json));
    const e = lastAttempt(logA);
    check('log chosen sub-main + reason initial', e && e.chosen === 'sub-main' && e.reasonCode === 'initial', JSON.stringify(e));
    check('log carries quota snapshot (mock 80%)', e && e.quota && e.quota.remainingPct === 80 && e.quota.source === 'mock', JSON.stringify(e && e.quota));
    const models = await (await fetch(`${A}/v1/models`)).json();
    const ids = (models.data || []).map((m) => m.id);
    check('routed /v1/models is the registry union', ids.includes('sub-model') && ids.includes('cheap-model') && ids.includes('premium-model'), ids.join(','));
  }

  console.log('test 15: routed priority — exhausted subscription quota falls to cheap API');
  {
    setSubQuota(0);
    const { json } = await routedPost(A, { model: 'mock-model', input: 'say hello', stream: false });
    check('served by cheap API', textOf(json) === 'Hello from cheap upstream.', textOf(json));
    const e = lastAttempt(logA);
    check('log chosen cheap-api + reason initial', e && e.chosen === 'cheap-api' && e.reasonCode === 'initial', JSON.stringify(e));
  }

  console.log('test 16: session stickiness — chain stays on subscription even after quota hits zero');
  {
    setSubQuota(80);
    const first = await routedPost(A, { model: 'mock-model', input: 'say hello', stream: false });
    check('first request on subscription', textOf(first.json) === 'Hello from sub upstream.', textOf(first.json));
    setSubQuota(0);
    const second = await routedPost(A, { model: 'mock-model', input: 'say hello again', previous_response_id: first.json.id, stream: false });
    check('chained request still on subscription', textOf(second.json) === 'Hello from sub upstream.', textOf(second.json));
    const e = lastAttempt(logA);
    check('log reason sticky_session', e && e.chosen === 'sub-main' && e.reasonCode === 'sticky_session', JSON.stringify(e));
  }

  console.log('test 17: cwd pin beats automatic policy');
  {
    setSubQuota(80);
    const { json } = await routedPost(A, { model: 'mock-model', input: 'say hello', stream: false }, { 'x-relay-cwd': '/work/pinned-proj/src' });
    check('served by pinned premium upstream', textOf(json) === 'Hello from premium upstream.', textOf(json));
    const e = lastAttempt(logA);
    check('log chosen premium-api + reason pinned', e && e.chosen === 'premium-api' && e.reasonCode === 'pinned', JSON.stringify(e));
  }

  console.log('test 18: sensitive project with a subscription available stays on subscription');
  {
    const { status, json } = await routedPost(A, { model: 'mock-model', input: 'say hello', stream: false }, { 'x-relay-cwd': '/work/secret-proj' });
    check('status 200', status === 200, `got ${status}`);
    check('served by subscription upstream', textOf(json) === 'Hello from sub upstream.', textOf(json));
    const e = lastAttempt(logA);
    check('log marks sensitive routing', e && e.chosen === 'sub-main' && e.sensitive === true, JSON.stringify(e));
  }

  console.log('test 19: feedback endpoint records verdicts, rejects junk');
  {
    const okPost = (body) => fetch(`${A}/v1/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const up = await okPost({ requestId: 'req-test-1', verdict: 'up' });
    check('feedback up accepted', up.status === 200, `got ${up.status}`);
    const down = await okPost({ requestId: 'req-test-2', verdict: 'down' });
    check('feedback down accepted', down.status === 200, `got ${down.status}`);
    const junk = await okPost({ requestId: 'req-test-3', verdict: 'meh' });
    check('invalid verdict rejected 400', junk.status === 400, `got ${junk.status}`);
    const lines = fs.readFileSync(feedbackFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    check('feedback file has exactly the 2 valid entries', lines.length === 2 && lines[0].verdict === 'up' && lines[1].verdict === 'down', JSON.stringify(lines));
  }

  console.log('test 20: dual ledger reconciles with the routing log line-by-line');
  {
    const run = spawnSync('node', ['src/ledger.js', 'summary', '--config', cfgA, '--log', logA, '--feedback', feedbackFile], { cwd: root, encoding: 'utf8' });
    check('ledger CLI exit 0', run.status === 0, run.stderr);
    const summary = JSON.parse(run.stdout);
    // Independent recomputation straight from the log + config prices.
    const cfg = JSON.parse(fs.readFileSync(cfgA, 'utf8'));
    const priceOf = {}; const tierOf = {};
    for (const u of cfg.upstreams) { priceOf[u.id] = u.price || { inputPer1k: 0, outputPer1k: 0 }; tierOf[u.id] = u.tier; }
    let expCash = 0, expQuotaTokens = 0, expServed = 0;
    for (const e of entriesOf(logA)) {
      if (!(e.status >= 200 && e.status < 300 && e.usage)) continue;
      expServed++;
      if (tierOf[e.upstream] === 'subscription') expQuotaTokens += e.usage.total_tokens;
      else expCash += (e.usage.input_tokens / 1000) * priceOf[e.upstream].inputPer1k + (e.usage.output_tokens / 1000) * priceOf[e.upstream].outputPer1k;
    }
    check('served requests reconcile', summary.servedRequests === expServed, `${summary.servedRequests} vs ${expServed}`);
    check('cash book reconciles to the cent-digit', Math.abs(summary.cash.totalUsd - expCash) < 1e-9, `${summary.cash.totalUsd} vs ${expCash}`);
    check('quota book tokens reconcile', summary.quota.byUpstream['sub-main'] && summary.quota.byUpstream['sub-main'].totalTokens === expQuotaTokens, JSON.stringify(summary.quota));
    check('books stay separate (cash has no subscription, quota has no API)', !('sub-main' in summary.cash.byUpstream) && !('cheap-api' in summary.quota.byUpstream) && !('premium-api' in summary.quota.byUpstream));
    check('feedback counted in summary', summary.feedback.up === 1 && summary.feedback.down === 1, JSON.stringify(summary.feedback));
  }

  // ---- Phase B: fallback chain quota -> error -> premium ----------------
  const logB = path.join(coreDir, 'routing-b.jsonl');
  const cfgB = writeCfg('config-b.json', [subUp(BADQ_PORT), cheapUp(BAD5_PORT), premUp(PREM_PORT)], []);
  const B = await startRouted(18952, cfgB, logB);
  console.log('test 21: fallback chain — 429 quota, then 500, lands on premium; every attempt logged');
  {
    const { status, json } = await routedPost(B, { model: 'mock-model', input: 'say hello', stream: false });
    check('status 200 via fallback', status === 200, `got ${status}`);
    check('landed on premium upstream', textOf(json) === 'Hello from premium upstream.', textOf(json));
    const es = entriesOf(logB);
    const reqId = es[es.length - 1].requestId;
    const attempts = es.filter((e) => e.requestId === reqId);
    check('three attempts, one requestId', attempts.length === 3, `got ${attempts.length}`);
    check('attempt 1: sub, initial, 429', attempts[0].chosen === 'sub-main' && attempts[0].reasonCode === 'initial' && attempts[0].status === 429, JSON.stringify(attempts[0]));
    check('attempt 2: cheap, fallback_quota, 500', attempts[1].chosen === 'cheap-api' && attempts[1].reasonCode === 'fallback_quota' && attempts[1].status === 500, JSON.stringify(attempts[1]));
    check('attempt 3: premium, fallback_error, 200', attempts[2].chosen === 'premium-api' && attempts[2].reasonCode === 'fallback_error' && attempts[2].status === 200, JSON.stringify(attempts[2]));
  }

  // ---- Phase B2: safety-filter fallback ---------------------------------
  const logB2 = path.join(coreDir, 'routing-b2.jsonl');
  const cfgB2 = writeCfg('config-b2.json', [subUp(FILT_PORT), cheapUp(CHEAP_PORT)], []);
  const B2 = await startRouted(18953, cfgB2, logB2);
  console.log('test 22: safety-filter refusal falls back with fallback_filtered');
  {
    const { status, json } = await routedPost(B2, { model: 'mock-model', input: 'say hello', stream: false });
    check('status 200 via fallback', status === 200, `got ${status}`);
    check('landed on cheap upstream', textOf(json) === 'Hello from cheap upstream.', textOf(json));
    const es = entriesOf(logB2);
    const attempts = es.filter((e) => e.requestId === es[es.length - 1].requestId);
    check('attempt 2 reason fallback_filtered', attempts.length === 2 && attempts[1].chosen === 'cheap-api' && attempts[1].reasonCode === 'fallback_filtered', JSON.stringify(attempts));
  }

  // ---- Phase C: sensitive fail-closed ------------------------------------
  const logC = path.join(coreDir, 'routing-c.jsonl');
  const cfgC = writeCfg('config-c.json', [cheapUp(CHEAP_PORT), premUp(PREM_PORT)], [{ cwdPrefix: '/work/secret-proj', sensitive: true }]);
  const C = await startRouted(18954, cfgC, logC);
  console.log('test 23: sensitive project with no subscription upstream fails closed');
  {
    const { status, json } = await routedPost(C, { model: 'mock-model', input: 'say hello', stream: false }, { 'x-relay-cwd': '/work/secret-proj' });
    check('refused with 403', status === 403, `got ${status}`);
    check('error code sensitive_block + fail-closed message', json.error && json.error.code === 'sensitive_block' && /fail-closed/i.test(json.error.message), JSON.stringify(json).slice(0, 200));
    const e = lastAttempt(logC);
    check('log reasonCode sensitive_block, nothing chosen', e && e.reasonCode === 'sensitive_block' && e.chosen === null, JSON.stringify(e));
    const okReq = await routedPost(C, { model: 'mock-model', input: 'say hello', stream: false }, { 'x-relay-cwd': '/work/public-proj' });
    check('non-sensitive cwd on same gateway still routes', okReq.status === 200 && textOf(okReq.json) === 'Hello from cheap upstream.', `got ${okReq.status}`);
  }
} catch (err) {
  failed++;
  console.log('FATAL', err && err.stack || err);
} finally {
  for (const c of children) c.kill('SIGTERM');
}
console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
