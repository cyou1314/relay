/**
 * Relay M0 automated tests: gateway (translate mode) + mock upstream.
 * Run: npm test
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
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
  start(['src/gateway.js'], { RELAY_MODE: 'translate', RELAY_PORT: String(GW_PORT), RELAY_UPSTREAM_BASE: `http://127.0.0.1:${MOCK_PORT}/v1`, RELAY_LOG_FILE: LOG_FILE });
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
} catch (err) {
  failed++;
  console.log('FATAL', err && err.stack || err);
} finally {
  for (const c of children) c.kill('SIGTERM');
}
console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
