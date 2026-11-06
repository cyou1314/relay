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
  // The gateway sends the response inside the attempt and appends the
  // attempt's log line immediately after; a test that reads the file the
  // instant its fetch resolves can win that race. Settle = poll until the
  // file size is stable across two checks (bounded), then read.
  const settleLog = async (log, timeoutMs = 2000) => {
    const t0 = Date.now();
    let prev = -1;
    while (Date.now() - t0 < timeoutMs) {
      const size = fs.existsSync(log) ? fs.statSync(log).size : 0;
      if (size > 0 && size === prev) return;
      prev = size;
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const lastAttemptWait = async (log) => { await settleLog(log); return lastAttempt(log); };

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
    const e = await lastAttemptWait(logA);
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
    const e = await lastAttemptWait(logA);
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
    const e = await lastAttemptWait(logA);
    check('log reason sticky_session', e && e.chosen === 'sub-main' && e.reasonCode === 'sticky_session', JSON.stringify(e));
  }

  console.log('test 17: cwd pin beats automatic policy');
  {
    setSubQuota(80);
    const { json } = await routedPost(A, { model: 'mock-model', input: 'say hello', stream: false }, { 'x-relay-cwd': '/work/pinned-proj/src' });
    check('served by pinned premium upstream', textOf(json) === 'Hello from premium upstream.', textOf(json));
    const e = await lastAttemptWait(logA);
    check('log chosen premium-api + reason pinned', e && e.chosen === 'premium-api' && e.reasonCode === 'pinned', JSON.stringify(e));
  }

  console.log('test 18: sensitive project with a subscription available stays on subscription');
  {
    const { status, json } = await routedPost(A, { model: 'mock-model', input: 'say hello', stream: false }, { 'x-relay-cwd': '/work/secret-proj' });
    check('status 200', status === 200, `got ${status}`);
    check('served by subscription upstream', textOf(json) === 'Hello from sub upstream.', textOf(json));
    const e = await lastAttemptWait(logA);
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
    await settleLog(logB);
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
    await settleLog(logB2);
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
    const e = await lastAttemptWait(logC);
    check('log reasonCode sensitive_block, nothing chosen', e && e.reasonCode === 'sensitive_block' && e.chosen === null, JSON.stringify(e));
    const okReq = await routedPost(C, { model: 'mock-model', input: 'say hello', stream: false }, { 'x-relay-cwd': '/work/public-proj' });
    check('non-sensitive cwd on same gateway still routes', okReq.status === 200 && textOf(okReq.json) === 'Hello from cheap upstream.', `got ${okReq.status}`);
  }

  // =======================================================================
  // Difficulty axis: heuristic classifier + capability-graded routing.
  // Same mock upstreams; configs now grade each model light|standard|heavy.
  // =======================================================================
  const gSub = (port, models) => ({ id: 'sub-main', kind: 'chat', tier: 'subscription', baseUrl: `http://127.0.0.1:${port}/v1`, models, quota: { source: 'mock', mockFile: quotaFile } });
  const gCheap = (port, models) => ({ id: 'cheap-api', kind: 'chat', tier: 'cheap-api', baseUrl: `http://127.0.0.1:${port}/v1`, models, price: PRICES.cheap, quota: { source: 'unavailable' } });
  const gPrem = (port, models) => ({ id: 'premium-api', kind: 'chat', tier: 'premium-api', baseUrl: `http://127.0.0.1:${port}/v1`, models, price: PRICES.premium, quota: { source: 'unavailable' } });
  const HEAVY_INPUT = '```\n' + 'x'.repeat(100000) + '\n```'; // ~25k est tokens + code signal -> heavy

  console.log('test 24: difficulty classifier — two typical requests per level, all explainable');
  {
    const diffMod = await import('file://' + path.join(root, 'src/difficulty.js'));
    const classify = diffMod.default.classify;
    const fiveTools = Array.from({ length: 5 }, (_, i) => ({ type: 'function', name: 'tool_' + i, description: 'd', parameters: { type: 'object', properties: {} } }));
    const cases = [
      ['light: bare chat turn', { input: 'say hello' }, 'light'],
      ['light: short translation ask', { input: 'translate to French: good morning, how are you?' }, 'light'],
      ['standard: small code fix', { input: 'fix this:\n```js\nlet a = 1\n```' }, 'standard'],
      ['standard: medium context + tools', { input: 'y'.repeat(12000), tools: fiveTools }, 'standard'],
      ['heavy: huge code payload', { input: HEAVY_INPUT }, 'heavy'],
      ['heavy: high effort + long input + deep chain', { input: 'z'.repeat(40000), reasoning: { effort: 'high' } }, 'heavy'],
    ];
    for (const [name, body, want] of cases) {
      const opts = name.includes('deep chain') ? { chainDepth: 4 } : {};
      const got = classify(body, opts);
      check(name, got.level === want, `got ${got.level} score=${got.score} signals=${got.signals.join(',')}`);
      check(name + ' — signals explain the score', got.signals.every((s) => /:\+\d+$/.test(s)) && (got.score === 0 || got.signals.length > 0), got.signals.join(','));
    }
  }

  console.log('test 25: heavy task is NOT dropped on a weak cheap API when an adequate model exists');
  {
    const logD1 = path.join(coreDir, 'routing-d1.jsonl');
    const cfgD1 = writeCfg('config-d1.json', [
      gSub(SUB_PORT, [{ id: 'sub-model', capability: 'standard' }]),
      gCheap(CHEAP_PORT, [{ id: 'cheap-lite', capability: 'light' }]),
      gPrem(PREM_PORT, [{ id: 'premium-max', capability: 'heavy' }]),
    ], []);
    setSubQuota(80);
    const D1 = await startRouted(18955, cfgD1, logD1);
    const { status, json } = await routedPost(D1, { model: 'mock-model', input: HEAVY_INPUT, stream: false });
    check('status 200', status === 200, `got ${status}`);
    check('served by the heavy-capable premium upstream', textOf(json) === 'Hello from premium upstream.', textOf(json));
    const e = await lastAttemptWait(logD1);
    check('log: chosen premium-api, reason initial', e && e.chosen === 'premium-api' && e.reasonCode === 'initial', JSON.stringify(e));
    check('log: difficulty heavy + servedModel premium-max', e && e.difficulty && e.difficulty.level === 'heavy' && e.servedModel === 'premium-max', JSON.stringify(e && { d: e.difficulty, m: e.servedModel }));
  }

  console.log('test 26: heavy task with NO adequate model anywhere — served anyway, downgrade on the record');
  {
    const logD2 = path.join(coreDir, 'routing-d2.jsonl');
    const cfgD2 = writeCfg('config-d2.json', [
      gSub(SUB_PORT, [{ id: 'sub-model', capability: 'standard' }]),
      gCheap(CHEAP_PORT, [{ id: 'cheap-lite', capability: 'light' }]),
    ], []);
    setSubQuota(80);
    const D2 = await startRouted(18956, cfgD2, logD2);
    const { status, json } = await routedPost(D2, { model: 'mock-model', input: HEAVY_INPUT, stream: false });
    check('status 200 (not refused)', status === 200, `got ${status}`);
    check('served by the strongest available (subscription)', textOf(json) === 'Hello from sub upstream.', textOf(json));
    const e = await lastAttemptWait(logD2);
    check('log: reasonCode difficulty_underpowered + underpowered flag', e && e.reasonCode === 'difficulty_underpowered' && e.underpowered === true, JSON.stringify(e));
    check('log: servedModel is the strongest model (sub-model)', e && e.servedModel === 'sub-model', JSON.stringify(e));
  }

  console.log('test 27: light task + scarce subscription quota — cheap API leads to preserve quota');
  {
    const logD3 = path.join(coreDir, 'routing-d3.jsonl');
    const cfgD3 = writeCfg('config-d3.json', [subUp(SUB_PORT), cheapUp(CHEAP_PORT), premUp(PREM_PORT)], []);
    const D3 = await startRouted(18957, cfgD3, logD3);
    setSubQuota(20); // below preservePct (30), above the exhaustion floor (2)
    const { json } = await routedPost(D3, { model: 'mock-model', input: 'say hello', stream: false });
    check('served by cheap API', textOf(json) === 'Hello from cheap upstream.', textOf(json));
    const e = await lastAttemptWait(logD3);
    check('log: reason difficulty_light_preserve, difficulty light', e && e.chosen === 'cheap-api' && e.reasonCode === 'difficulty_light_preserve' && e.difficulty.level === 'light', JSON.stringify(e));

    console.log('test 28: light task + ample subscription quota — quota-first still wins');
    setSubQuota(80);
    const r2 = await routedPost(D3, { model: 'mock-model', input: 'say hello again', stream: false });
    check('served by subscription', textOf(r2.json) === 'Hello from sub upstream.', textOf(r2.json));
    const e2 = await lastAttemptWait(logD3);
    check('log: chosen sub-main, reason initial, difficulty light', e2 && e2.chosen === 'sub-main' && e2.reasonCode === 'initial' && e2.difficulty.level === 'light', JSON.stringify(e2));
  }

  console.log('test 29: sticky chain turns heavy beyond its upstream — session upgrades, on the record');
  {
    const logD4 = path.join(coreDir, 'routing-d4.jsonl');
    const cfgD4 = writeCfg('config-d4.json', [
      gSub(SUB_PORT, [{ id: 'sub-max', capability: 'heavy' }]),
      gCheap(CHEAP_PORT, [{ id: 'cheap-std', capability: 'standard' }]),
    ], []);
    setSubQuota(0); // subscription exhausted: a standard task lands on cheap
    const D4 = await startRouted(18958, cfgD4, logD4);
    const first = await routedPost(D4, { model: 'mock-model', input: 'fix this:\n```js\nlet a = 1\n```', stream: false });
    check('first (standard) request served by cheap', textOf(first.json) === 'Hello from cheap upstream.', textOf(first.json));
    setSubQuota(80);
    const second = await routedPost(D4, { model: 'mock-model', input: HEAVY_INPUT, previous_response_id: first.json.id, stream: false });
    check('heavy follow-up moved OFF the incapable sticky upstream', textOf(second.json) === 'Hello from sub upstream.', textOf(second.json));
    const e = await lastAttemptWait(logD4);
    check('log: chosen sub-main, reason difficulty_upgrade, servedModel sub-max', e && e.chosen === 'sub-main' && e.reasonCode === 'difficulty_upgrade' && e.servedModel === 'sub-max', JSON.stringify(e));
  }

  // =======================================================================
  // Gap-audit fixes (GAP-AUDIT.md): G1 redirect refusal locked by test,
  // G2 error taxonomy extended with auth / invalid classes.
  // =======================================================================
  const REDIR_SRC_PORT = 18967, REDIR_TGT_PORT = 18968, AUTH_PORT = 18969, INV_A_PORT = 18970, INV_B_PORT = 18971;
  start(['test/mock-upstream.js'], { MOCK_PORT: String(REDIR_SRC_PORT), MOCK_REDIRECT_LOCATION: `http://127.0.0.1:${REDIR_TGT_PORT}/redirect-target`, MOCK_MODEL_IDS: 'mock-model' });
  start(['test/mock-upstream.js'], { MOCK_PORT: String(REDIR_TGT_PORT), MOCK_MODEL_IDS: 'mock-model' });
  start(['test/mock-upstream.js'], { MOCK_PORT: String(AUTH_PORT), MOCK_FAIL_STATUS: '401', MOCK_FAIL_CODE: 'invalid_api_key', MOCK_FAIL_MESSAGE: 'invalid api key provided', MOCK_MODEL_IDS: 'sub-model' });
  start(['test/mock-upstream.js'], { MOCK_PORT: String(INV_A_PORT), MOCK_FAIL_STATUS: '400', MOCK_FAIL_CODE: 'context_length_exceeded', MOCK_FAIL_MESSAGE: "This model's maximum context length is 128000 tokens, but the request has too many tokens.", MOCK_MODEL_IDS: 'sub-model' });
  start(['test/mock-upstream.js'], { MOCK_PORT: String(INV_B_PORT), MOCK_FAIL_STATUS: '400', MOCK_FAIL_CODE: 'context_length_exceeded', MOCK_FAIL_MESSAGE: "This model's maximum context length is 128000 tokens, but the request has too many tokens.", MOCK_MODEL_IDS: 'cheap-model' });
  for (const p of [REDIR_SRC_PORT, REDIR_TGT_PORT, AUTH_PORT, INV_A_PORT, INV_B_PORT]) await waitHealth(`http://127.0.0.1:${p}/health`);

  console.log('test 30 (G1): upstream 302 is returned untouched — never followed with credentials attached');
  {
    const logG1 = path.join(coreDir, 'routing-g1.jsonl');
    const cfgG1 = writeCfg('config-g1.json',
      [{ id: 'redir-pt', kind: 'passthrough', tier: 'subscription', baseUrl: `http://127.0.0.1:${REDIR_SRC_PORT}/v1/responses`, models: ['mock-model'], quota: { source: 'unavailable' } }], []);
    const G1GW = await startRouted(18959, cfgG1, logG1);
    const r = await fetch(`${G1GW}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ model: 'mock-model', input: 'say hello', stream: false }),
      redirect: 'manual', // the TEST client must not follow either; we assert what the gateway did
    });
    await r.text();
    check('gateway returns the 302 status untouched', r.status === 302, `got ${r.status}`);
    check('Location header preserved verbatim', r.headers.get('location') === `http://127.0.0.1:${REDIR_TGT_PORT}/redirect-target`, r.headers.get('location'));
    const targetHits = await (await fetch(`http://127.0.0.1:${REDIR_TGT_PORT}/__hits`)).json();
    check('redirect target endpoint NEVER contacted (hit counter proves it)', !targetHits['/redirect-target'], JSON.stringify(targetHits));
    const e = await lastAttemptWait(logG1);
    check('log: 302 attempt recorded cleanly, no error anomaly', Boolean(e) && e.chosen === 'redir-pt' && e.status === 302 && !e.error, JSON.stringify(e));
  }

  console.log('test 31 (G2): upstream 401 (dead credential) falls back once, logged as fallback_auth');
  {
    const logG2a = path.join(coreDir, 'routing-g2a.jsonl');
    const cfgG2a = writeCfg('config-g2a.json', [subUp(AUTH_PORT), cheapUp(CHEAP_PORT)], []);
    setSubQuota(80);
    const G2A = await startRouted(18960, cfgG2a, logG2a);
    const { status, json } = await routedPost(G2A, { model: 'mock-model', input: 'say hello', stream: false });
    check('status 200 via fallback', status === 200, `got ${status}`);
    check('landed on the independent-credential cheap upstream', textOf(json) === 'Hello from cheap upstream.', textOf(json));
    await settleLog(logG2a);
    const es = entriesOf(logG2a);
    const attempts = es.filter((e) => e.requestId === es[es.length - 1].requestId);
    check('exactly two attempts', attempts.length === 2, `got ${attempts.length}`);
    check('attempt 1: sub-main, 401', attempts[0].chosen === 'sub-main' && attempts[0].status === 401, JSON.stringify(attempts[0]));
    check('attempt 2: cheap-api, reasonCode fallback_auth, 200', attempts[1].chosen === 'cheap-api' && attempts[1].reasonCode === 'fallback_auth' && attempts[1].status === 200, JSON.stringify(attempts[1]));
    check('dead-credential upstream attempted exactly once (no same-upstream retry)', attempts.filter((a) => a.chosen === 'sub-main').length === 1);
  }

  console.log('test 32 (G2): context-length error stops the chain at the first upstream, error passed through');
  {
    const logG2b = path.join(coreDir, 'routing-g2b.jsonl');
    const cfgG2b = writeCfg('config-g2b.json', [subUp(INV_A_PORT), cheapUp(INV_B_PORT), premUp(PREM_PORT)], []);
    setSubQuota(80);
    const G2B = await startRouted(18972, cfgG2b, logG2b);
    const { status, json } = await routedPost(G2B, { model: 'mock-model', input: 'say hello', stream: false });
    check('client gets the upstream 400', status === 400, `got ${status}`);
    check('upstream error code passed through (context_length_exceeded)', Boolean(json.error) && json.error.code === 'context_length_exceeded', JSON.stringify(json).slice(0, 200));
    check('upstream error message passed through', Boolean(json.error) && json.error.message.includes('maximum context length'), json.error && json.error.message);
    await settleLog(logG2b);
    const es = entriesOf(logG2b);
    const attempts = es.filter((e) => e.requestId === es[es.length - 1].requestId);
    check('chain stopped after ONE attempt (cheap/premium never tried)', attempts.length === 1 && attempts[0].chosen === 'sub-main', `got ${attempts.length}: ${attempts.map((a) => a.chosen).join(',')}`);
    check('log reasonCode invalid_request_stop, willFallback false', attempts[0].reasonCode === 'invalid_request_stop' && attempts[0].willFallback === false, JSON.stringify(attempts[0]));
  }

  console.log('test 33 (G2): classifyFailure unit matrix — new classes + old classes unchanged');
  {
    const up = await import('file://' + path.join(root, 'src/upstreams.js'));
    const cf = up.default.classifyFailure;
    const frc = up.default.fallbackReasonCode;
    check('401 + invalid_api_key -> auth', cf({ status: 401, code: 'invalid_api_key', type: 'authentication_error', message: 'invalid api key provided' }) === 'auth');
    check('403 -> auth', cf({ status: 403, code: 'forbidden', type: '', message: 'Forbidden' }) === 'auth');
    check('auth body hint alone (400) -> auth', cf({ status: 400, code: 'invalid_api_key', type: 'authentication_error', message: 'bad key' }) === 'auth');
    check('400 + context_length_exceeded -> invalid', cf({ status: 400, code: 'context_length_exceeded', type: 'invalid_request_error', message: 'maximum context length is 128000 tokens' }) === 'invalid');
    check('400 + invalid_request -> invalid', cf({ status: 400, code: 'invalid_request', type: 'invalid_request_error', message: 'malformed request' }) === 'invalid');
    check('context keyword WITHOUT 400 does not stop the chain (500 -> error)', cf({ status: 500, code: 'context_length_exceeded', type: 'server_error', message: 'maximum context length' }) === 'error');
    check('429 + insufficient_quota -> quota (unchanged)', cf({ status: 429, code: 'insufficient_quota', type: 'rate_limit_error', message: 'plan quota exhausted' }) === 'quota');
    check('400 + content_filter -> filtered, NOT invalid (precedence unchanged)', cf({ status: 400, code: 'content_filter', type: 'invalid_request_error', message: 'request blocked by safety policy filter' }) === 'filtered');
    check('500 plain -> error (unchanged)', cf({ status: 500, code: 'mock_internal', type: 'server_error', message: 'mock internal error' }) === 'error');
    check('fallbackReasonCode: auth -> fallback_auth, old kinds unchanged', frc('auth') === 'fallback_auth' && frc('quota') === 'fallback_quota' && frc('filtered') === 'fallback_filtered' && frc('error') === 'fallback_error');
  }

  // =======================================================================
  // Dashboard (M4 wiring): GET / + /dashboard serve the approved design
  // bound to real data; GET /api/status assembles quotas (quota.js),
  // today's ledger slice and the newest log lines — with every reason
  // code translated to plain language server-side.
  // =======================================================================
  console.log('test 34: dashboard endpoints — status numbers reconcile with live traffic');
  {
    const dashQuota = path.join(coreDir, 'quota-dash.json');
    fs.writeFileSync(dashQuota, JSON.stringify({ 'sub-main': { remainingPct: 62, resetsAt: '2026-11-06T14:24:00.000Z' } }));
    const subDash = { ...subUp(SUB_PORT), quota: { source: 'mock', mockFile: dashQuota }, label: 'Codex' };
    const gemUp = { id: 'gem-meter', kind: 'chat', tier: 'subscription', baseUrl: `http://127.0.0.1:${SUB_PORT}/v1`, model: 'gem-model', models: ['gem-model'], label: 'Gemini', quota: { source: 'metering', windowTokens: 150 } };
    const logE = path.join(coreDir, 'routing-e.jsonl');
    const cfgE = writeCfg('config-e.json', [subDash, gemUp, cheapUp(CHEAP_PORT)],
      [{ cwdPrefix: '/work/gem-proj', upstream: 'gem-meter' }, { cwdPrefix: '/work/cheap-proj', upstream: 'cheap-api' }]);
    start(['src/gateway.js'], { RELAY_PORT: '18973', RELAY_CONFIG: cfgE, RELAY_LOG_FILE: logE, RELAY_FEEDBACK_FILE: feedbackFile, RELAY_USD_CNY: '7' });
    await waitHealth('http://127.0.0.1:18973/health');
    const E = 'http://127.0.0.1:18973';
    await routedPost(E, { model: 'mock-model', input: 'say hello', stream: false });
    await routedPost(E, { model: 'mock-model', input: 'say hello', stream: false }, { 'x-relay-cwd': '/work/gem-proj' });
    await routedPost(E, { model: 'mock-model', input: 'say hello', stream: false }, { 'x-relay-cwd': '/work/cheap-proj' });
    const stResp = await fetch(`${E}/api/status`);
    check('status endpoint 200 + JSON', stResp.status === 200 && (stResp.headers.get('content-type') || '').includes('application/json'), `got ${stResp.status}`);
    const st = await stResp.json();
    check('not empty after traffic', st.empty === false);
    check('quota card 1: mock source, 62%, not an estimate', st.quotas.length === 2 && st.quotas[0].id === 'sub-main' && st.quotas[0].remainingPct === 62 && st.quotas[0].source === 'mock' && st.quotas[0].estimate === false && st.quotas[0].name === 'Codex', JSON.stringify(st.quotas));
    check('quota card 2: metering 15/150 used -> 90%, flagged estimate', st.quotas[1].id === 'gem-meter' && st.quotas[1].remainingPct === 90 && st.quotas[1].source === 'metering-estimate' && st.quotas[1].estimate === true, JSON.stringify(st.quotas[1]));
    check('today: 3 served, 2 on subscription', st.today.served === 3 && st.today.subscriptionServed === 2, JSON.stringify(st.today));
    check('today: cash reconciles (one cheap request = $0.00004)', Math.abs(st.today.cashUsd - 0.00004) < 1e-12, String(st.today.cashUsd));
    check('today: CNY is display conversion at the configured rate 7', st.usdCnyRate === 7 && Math.abs(st.today.cashCny - 0.00028) < 1e-12, JSON.stringify(st.today));
    check('recent: 3 items, newest first is the cheap pin', st.recent.length === 3 && st.recent[0].model === 'cheap-model' && st.recent[0].cost.kind === 'money' && Math.abs(st.recent[0].cost.usd - 0.00004) < 1e-12, JSON.stringify(st.recent[0]));
    check('recent: pin reason in plain words', st.recent[0].why === '你给这个项目指定用的就是这家', st.recent[0].why);
    check('recent: difficulty badge in plain words (light -> 简单)', st.recent[0].badge && st.recent[0].badge.text === '简单' && st.recent[0].badge.key === 'easy', JSON.stringify(st.recent[0].badge));
    check('recent: subscription items cost 用额度 + initial reason in plain words', st.recent[2].cost.kind === 'quota' && st.recent[2].cost.text === '用额度' && st.recent[2].why === '额度够，先用订阅的', JSON.stringify(st.recent[2]));
    check('recent: no raw reason codes anywhere in the payload', !/fallback_|sticky_session|difficulty_|reasonCode/.test(JSON.stringify(st.recent)), JSON.stringify(st.recent).slice(0, 200));
    check('strategy sentence uses the live preserve threshold (30%)', st.strategy.includes('低于 30%') && st.strategy.includes('先用快要到期的订阅额度'), st.strategy);

    const htmlResp = await fetch(`${E}/dashboard`);
    const html = await htmlResp.text();
    check('GET /dashboard 200 text/html', htmlResp.status === 200 && (htmlResp.headers.get('content-type') || '').includes('text/html'), `got ${htmlResp.status}`);
    check('page has the four blocks', html.includes('最近动态') && html.includes('剩余额度') && html.includes('现在的做法') && html.includes('API 今天已花费'), '');
    check('page fetches /api/status and refreshes every 15s', html.includes('/api/status') && html.includes('15000'), '');
    check('page carries the friendly empty-state sentence', html.includes('还没有记录'), '');
    check('page has NO particle layer (no canvas anywhere)', !/canvas/i.test(html), '');
    check('page has no fixture numbers or design-mock label', !html.includes('data-count="62"') && !html.includes('1.32') && !html.includes('设计稿'), '');
    check('page contains no raw reason codes', !html.includes('reasonCode') && !/fallback_|sticky_session/.test(html), '');
    const rootHtml = await (await fetch(`${E}/`)).text();
    check('GET / serves the same dashboard', rootHtml.includes('最近动态') && rootHtml.includes('/api/status'), '');
  }

  console.log('test 35: /api/status builder — fixture log reconciles; every reason code has a human sentence');
  {
    const dashMod = await import('file://' + path.join(root, 'src/dashboard.js'));
    const upMod = await import('file://' + path.join(root, 'src/upstreams.js'));
    const quotaMod = await import('file://' + path.join(root, 'src/quota.js'));
    const { createDashboard, humanWhy, REASON_WHY, FALLBACK_WHY } = dashMod.default;
    const fxQuota = path.join(coreDir, 'quota-fx.json');
    fs.writeFileSync(fxQuota, JSON.stringify({ 'sub-main': { remainingPct: 62, resetsAt: '2026-11-06T14:24:00.000Z' } }));
    const fxUp = (id, tier, price, quota, label) => ({ id, kind: 'chat', tier, baseUrl: 'http://127.0.0.1:1/v1', model: id + '-model', models: [{ id: id + '-model', capability: 'standard' }], price, quota, enabled: true, ...(label ? { label } : {}) });
    const fxConfig = {
      settings: { quotaFloorPct: 2, amplePct: 25, preservePct: 30 }, rules: [],
      upstreams: [
        { ...fxUp('sub-main', 'subscription', { inputPer1k: 0, outputPer1k: 0 }, { source: 'mock', mockFile: fxQuota }, 'Codex'), model: 'sub-model', models: [{ id: 'sub-model', capability: 'standard' }] },
        { ...fxUp('cheap-api', 'cheap-api', PRICES.cheap, { source: 'unavailable' }), model: 'cheap-model', models: [{ id: 'cheap-model', capability: 'standard' }] },
        { ...fxUp('premium-api', 'premium-api', PRICES.premium, { source: 'unavailable' }), model: 'premium-model', models: [{ id: 'premium-model', capability: 'heavy' }] },
      ],
    };
    const fxLog = path.join(coreDir, 'routing-fx.jsonl');
    const U = (i, o) => ({ input_tokens: i, output_tokens: o, total_tokens: i + o });
    const fxLine = (mins, f) => JSON.stringify({ ts: new Date(Date.now() - mins * 60000).toISOString(), path: '/v1/responses', mode: 'routed', attempt: 1, difficulty: { level: 'standard', score: 1, signals: [] }, ...f });
    const fxLines = [
      fxLine(12, { upstream: 'sub-main', chosen: 'sub-main', status: 200, reasonCode: 'initial', usage: U(10, 5), servedModel: 'sub-model' }),
      fxLine(11, { upstream: 'premium-api', chosen: 'premium-api', status: 200, reasonCode: 'pinned', usage: U(30, 15), servedModel: 'premium-model' }),
      fxLine(10, { upstream: 'sub-main', chosen: 'sub-main', status: 200, reasonCode: 'sticky_session', usage: U(10, 5), servedModel: 'sub-model', difficulty: { level: 'light', score: 0, signals: [] } }),
      fxLine(9, { upstream: 'cheap-api', chosen: 'cheap-api', status: 200, reasonCode: 'fallback_quota', usage: U(20, 10), servedModel: 'cheap-model' }),
      fxLine(8, { upstream: 'cheap-api', chosen: 'cheap-api', status: 200, reasonCode: 'fallback_filtered', usage: U(20, 10), servedModel: 'cheap-model', difficulty: { level: 'heavy', score: 5, signals: [] } }),
      fxLine(7, { upstream: 'cheap-api', chosen: 'cheap-api', status: 200, reasonCode: 'fallback_auth', usage: U(20, 10), servedModel: 'cheap-model' }),
      fxLine(6, { upstream: 'premium-api', chosen: 'premium-api', status: 200, reasonCode: 'fallback_error', usage: U(30, 15), servedModel: 'premium-model' }),
      fxLine(5, { upstream: 'cheap-api', chosen: 'cheap-api', status: 200, reasonCode: 'difficulty_light_preserve', usage: U(20, 10), servedModel: 'cheap-model', difficulty: { level: 'light', score: 0, signals: [] } }),
      fxLine(4, { upstream: 'sub-main', chosen: 'sub-main', status: 200, reasonCode: 'difficulty_upgrade', usage: U(10, 5), servedModel: 'sub-model', difficulty: { level: 'heavy', score: 5, signals: [] } }),
      fxLine(3, { upstream: 'sub-main', chosen: 'sub-main', status: 200, reasonCode: 'difficulty_underpowered', usage: U(10, 5), servedModel: 'sub-model', difficulty: { level: 'heavy', score: 5, signals: [] } }),
      fxLine(2, { upstream: null, chosen: null, status: 403, reasonCode: 'sensitive_block', servedModel: null }),
      fxLine(1, { upstream: 'sub-main', chosen: 'sub-main', status: 400, reasonCode: 'invalid_request_stop', error: 'context_length_exceeded', servedModel: 'sub-model' }),
    ];
    fs.writeFileSync(fxLog, fxLines.join('\n') + '\n');
    const fxRegistry = upMod.default.createRegistry(fxConfig);
    const fxQuotaSvc = quotaMod.default.createQuotaService({ config: fxConfig, registry: fxRegistry, logFile: fxLog });
    const fxDash = createDashboard({ config: fxConfig, registry: fxRegistry, quotaService: fxQuotaSvc, logFile: fxLog, feedbackFile: path.join(coreDir, 'feedback-fx.jsonl') });
    const fx = fxDash.buildStatus();
    // Independent recomputation from the fixture lines + price table.
    let expServed = 0, expSub = 0, expCash = 0;
    const priceMap = { 'cheap-api': PRICES.cheap, 'premium-api': PRICES.premium };
    const tierMap = { 'sub-main': 'subscription', 'cheap-api': 'cheap-api', 'premium-api': 'premium-api' };
    for (const l of fxLines) {
      const e = JSON.parse(l);
      if (!(e.status >= 200 && e.status < 300 && e.usage)) continue;
      expServed++;
      if (tierMap[e.upstream] === 'subscription') expSub++;
      else expCash += (e.usage.input_tokens / 1000) * priceMap[e.upstream].inputPer1k + (e.usage.output_tokens / 1000) * priceMap[e.upstream].outputPer1k;
    }
    check('fixture: today served/subscription counts reconcile', fx.today.served === expServed && fx.today.subscriptionServed === expSub && expServed === 10 && expSub === 4, JSON.stringify(fx.today));
    check('fixture: today cash reconciles to <1e-9', Math.abs(fx.today.cashUsd - expCash) < 1e-9 && Math.abs(expCash - 0.00136) < 1e-12, `${fx.today.cashUsd} vs ${expCash}`);
    check('fixture: default CNY rate 7.2 applied to display value only', fx.usdCnyRate === 7.2 && Math.abs(fx.today.cashCny - expCash * 7.2) < 1e-9, JSON.stringify(fx.today));
    check('fixture: quota card from mock source with label name', fx.quotas.length === 1 && fx.quotas[0].remainingPct === 62 && fx.quotas[0].source === 'mock' && fx.quotas[0].estimate === false && fx.quotas[0].name === 'Codex', JSON.stringify(fx.quotas));
    check('fixture: not empty', fx.empty === false);
    const whyAt = (i) => fx.recent[i] && fx.recent[i].why;
    check('fixture: recent capped at 10, newest first', fx.recent.length === 10 && fx.recent[0].model === 'sub-model', `got ${fx.recent.length}`);
    check('recent why: invalid_request_stop', whyAt(0) === '这次的内容太长了，哪家都处理不了' && fx.recent[0].cost.kind === 'none', whyAt(0));
    check('recent why: sensitive_block', whyAt(1) === '这个项目被你标了机密，又没有订阅可用，按规矩拦下了', whyAt(1));
    check('recent why: difficulty_underpowered + 复杂 badge', whyAt(2) === '任务复杂，但没有更强的可用，先用这家顶上' && fx.recent[2].badge.text === '复杂', whyAt(2));
    check('recent why: difficulty_upgrade', whyAt(3) === '任务变复杂了，换了更强的', whyAt(3));
    check('recent why: difficulty_light_preserve + 简单 badge', whyAt(4) === '任务简单，订阅额度又剩得不多，先用便宜的，把额度留给复杂任务' && fx.recent[4].badge.text === '简单', whyAt(4));
    check('recent why: fallback_error + money cost', whyAt(5) === '刚才那家出故障了，自动换了一家' && fx.recent[5].cost.kind === 'money', whyAt(5));
    check('recent why: fallback_auth', whyAt(6) === '前面那家登录失效了，自动换了这家', whyAt(6));
    check('recent why: fallback_filtered', whyAt(7) === '前面那家把内容拦下了，自动换了这家', whyAt(7));
    check('recent why: fallback_quota', whyAt(8) === '前面那家额度用完了，自动换了这家', whyAt(8));
    check('recent why: sticky_session + quota cost', whyAt(9) === '接着前面的对话，还用这家' && fx.recent[9].cost.text === '用额度', whyAt(9));

    // Coverage sweep: EVERY routed reason code must own a plain
    // sentence (traverse-and-assert, so a future code cannot slip
    // through untranslated); unknown codes degrade to the generic one.
    const EXPECTED_CODES = ['initial', 'pinned', 'sticky_session', 'fallback_quota', 'fallback_filtered', 'fallback_auth', 'fallback_error', 'invalid_request_stop', 'sensitive_block', 'difficulty_light_preserve', 'difficulty_upgrade', 'difficulty_underpowered', 'client_abort', 'upstream_error', 'passthrough_default', 'translate_default'];
    for (const code of EXPECTED_CODES) {
      const why = humanWhy({ status: 200, reasonCode: code }, 'subscription');
      check(`humanWhy covers ${code}`, typeof why === 'string' && why.length > 0 && why !== code && why !== FALLBACK_WHY, String(why));
      if (code !== 'initial') check(`REASON_WHY owns ${code}`, Object.prototype.hasOwnProperty.call(REASON_WHY, code), '');
    }
    check('humanWhy: unknown code falls back to the generic sentence', humanWhy({ status: 200, reasonCode: 'some_future_code' }, 'subscription') === FALLBACK_WHY);
    check('humanWhy: initial is tier-aware', humanWhy({ status: 200, reasonCode: 'initial' }, 'subscription') !== humanWhy({ status: 200, reasonCode: 'initial' }, 'cheap-api'));
    check('humanWhy: failed attempts explain the failure (429/401/500)', humanWhy({ status: 429, reasonCode: 'initial' }, 'subscription') === '这家额度用完了，没办成' && humanWhy({ status: 401, reasonCode: 'initial' }, 'cheap-api') === '这家登录失效了，没办成' && humanWhy({ status: 500, reasonCode: 'initial' }, 'cheap-api') === '这家出故障了，没办成');
  }

  console.log('test 36: dashboard empty state — fresh log, friendly zeros, no fake numbers');
  {
    const logF = path.join(coreDir, 'routing-f.jsonl'); // never created
    const cfgF = writeCfg('config-f.json', [subUp(SUB_PORT), cheapUp(CHEAP_PORT)], []);
    const F = await startRouted(18974, cfgF, logF);
    const st = await (await fetch(`${F}/api/status`)).json();
    check('empty flag true with no log file', st.empty === true, JSON.stringify(st).slice(0, 160));
    check('recent is an empty list', Array.isArray(st.recent) && st.recent.length === 0);
    check('today is honest zeros', st.today.served === 0 && st.today.subscriptionServed === 0 && st.today.cashUsd === 0 && st.today.cashCny === 0, JSON.stringify(st.today));
    const html = await (await fetch(`${F}/dashboard`)).text();
    check('page still carries the friendly empty-state sentence', html.includes('还没有记录，等你用 Codex 干活后'), '');
  }
} catch (err) {
  failed++;
  console.log('FATAL', err && err.stack || err);
} finally {
  for (const c of children) c.kill('SIGTERM');
}
console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
