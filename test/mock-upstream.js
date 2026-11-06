'use strict';
/**
 * Mock Chat Completions upstream for Relay M0 tests.
 *
 * Scripted behavior (driven by the request it receives):
 *  - If any message has role "tool"  -> final text: "After tool: <tool content>"
 *  - Else if the conversation text contains "CALL_TOOL"
 *      -> one tool call to the first declared tool (default run_echo)
 *         with arguments {"text":"hello-from-tool"}, finish_reason tool_calls.
 *  - Else -> plain text "Hello from mock upstream."
 * Supports stream and non-stream; usage is fixed (12/7) except tool turns (12/9).
 *
 * M1 failure markers (matched against the conversation text):
 *  - "FAIL_429"     -> HTTP 429 with an OpenAI-style error body
 *  - "FAIL_500"     -> HTTP 500 with an OpenAI-style error body
 *  - "FAIL_TIMEOUT" -> response delayed 3000ms (gateway timeout must fire first)
 *  - "FAIL_ONCE"    -> first request's socket is destroyed pre-response;
 *                      the retry (same marker) succeeds normally
 *  - "FAIL_DROP"    -> stream: one chunk is sent, then the socket is destroyed
 *                      mid-stream; non-stream: socket destroyed pre-response
 * Also serves GET /v1/models with two mock model ids.
 */
const http = require('node:http');

const PORT = Number(process.env.MOCK_PORT || 18924);
const TEXT = process.env.MOCK_TEXT || 'Hello from mock upstream.';
const TOOL_ARGS = JSON.stringify({ text: 'hello-from-tool' });
// Core-phase additions (all optional, defaults preserve M0/M1 behavior):
//   MOCK_USAGE_IN / MOCK_USAGE_OUT  fixed usage for every reply
//   MOCK_FAIL_STATUS (+ MOCK_FAIL_CODE / MOCK_FAIL_MESSAGE)
//                                   every chat request fails with this status
//   MOCK_MODEL_IDS                  comma list served by GET /v1/models
const USAGE_OVERRIDE = (process.env.MOCK_USAGE_IN != null || process.env.MOCK_USAGE_OUT != null)
  ? { prompt_tokens: Number(process.env.MOCK_USAGE_IN || 0), completion_tokens: Number(process.env.MOCK_USAGE_OUT || 0) }
  : null;
if (USAGE_OVERRIDE) USAGE_OVERRIDE.total_tokens = USAGE_OVERRIDE.prompt_tokens + USAGE_OVERRIDE.completion_tokens;
const FAIL_STATUS = process.env.MOCK_FAIL_STATUS ? Number(process.env.MOCK_FAIL_STATUS) : null;
const FAIL_CODE = process.env.MOCK_FAIL_CODE || 'mock_forced_failure';
const FAIL_MESSAGE = process.env.MOCK_FAIL_MESSAGE || 'mock forced failure';
const MODEL_IDS = (process.env.MOCK_MODEL_IDS || 'mock-model,mock-model-2').split(',').map((s) => s.trim()).filter(Boolean);

function plan(body) {
  const messages = body.messages || [];
  const toolMsg = messages.find((m) => m.role === 'tool');
  if (toolMsg) return { kind: 'text', text: `After tool: ${toolMsg.content}`, usage: USAGE_OVERRIDE || { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } };
  const allText = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  if (allText.includes('CALL_TOOL')) {
    const name = (body.tools && body.tools[0] && body.tools[0].function && body.tools[0].function.name) || 'run_echo';
    return { kind: 'tool', name, usage: USAGE_OVERRIDE || { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 } };
  }
  return { kind: 'text', text: TEXT, usage: USAGE_OVERRIDE || { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } };
}

function chunk(id, created, model, delta, finishReason) {
  return { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason || null }] };
}

const failOnceSeen = new Set();

function sendUpstreamError(res, status, message, type, code) {
  const s = JSON.stringify({ error: { message, type, param: null, code } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

function handleChat(req, res, body) {
  // --- core-phase forced failure (whole instance), checked first ---
  if (FAIL_STATUS) {
    const type = FAIL_STATUS === 429 ? 'rate_limit_error' : FAIL_STATUS >= 500 ? 'server_error' : 'invalid_request_error';
    sendUpstreamError(res, FAIL_STATUS, FAIL_MESSAGE, type, FAIL_CODE);
    return;
  }
  // --- M1 scripted failure modes, checked before the normal plan ---
  const allText = (body.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  if (allText.includes('FAIL_429')) { sendUpstreamError(res, 429, 'mock rate limit exceeded', 'rate_limit_error', 'mock_rate_limit'); return; }
  if (allText.includes('FAIL_500')) { sendUpstreamError(res, 500, 'mock internal error', 'server_error', 'mock_internal'); return; }
  if (allText.includes('FAIL_TIMEOUT')) { setTimeout(() => { if (!res.destroyed) handleChatNormal(req, res, body); }, 3000); return; }
  if (allText.includes('FAIL_ONCE')) {
    if (!failOnceSeen.has('FAIL_ONCE')) { failOnceSeen.add('FAIL_ONCE'); req.socket.destroy(); return; }
    handleChatNormal(req, res, body); return;
  }
  if (allText.includes('FAIL_DROP')) {
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const id = 'chatcmpl-mock1'; const created = 1700000000; const model = body.model || 'mock-model';
      res.write(`data: ${JSON.stringify(chunk(id, created, model, { role: 'assistant', content: 'partial-' }))}\n\n`);
      setTimeout(() => req.socket.destroy(), 30);
    } else {
      req.socket.destroy();
    }
    return;
  }
  handleChatNormal(req, res, body);
}

function handleChatNormal(req, res, body) {
  const p = plan(body);
  const id = 'chatcmpl-mock1';
  const created = 1700000000;
  const model = body.model || 'mock-model';
  if (!body.stream) {
    const message = p.kind === 'tool'
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_mock_1', type: 'function', function: { name: p.name, arguments: TOOL_ARGS } }] }
      : { role: 'assistant', content: p.text };
    const out = { id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: p.kind === 'tool' ? 'tool_calls' : 'stop' }], usage: p.usage };
    const s = JSON.stringify(out);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
    res.end(s);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const pieces = [];
  if (p.kind === 'tool') {
    pieces.push(chunk(id, created, model, { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: p.name, arguments: '' } }] }));
    pieces.push(chunk(id, created, model, { tool_calls: [{ index: 0, function: { arguments: TOOL_ARGS.slice(0, 12) } }] }));
    pieces.push(chunk(id, created, model, { tool_calls: [{ index: 0, function: { arguments: TOOL_ARGS.slice(12) } }] }));
    pieces.push(chunk(id, created, model, {}, 'tool_calls'));
  } else {
    pieces.push(chunk(id, created, model, { role: 'assistant', content: '' }));
    const words = p.text.split(' ');
    words.forEach((w, i) => pieces.push(chunk(id, created, model, { content: (i ? ' ' : '') + w })));
    pieces.push(chunk(id, created, model, {}, 'stop'));
  }
  if (body.stream_options && body.stream_options.include_usage) {
    pieces.push({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: p.usage });
  }
  let i = 0;
  const tick = () => {
    if (i < pieces.length) { send(pieces[i++]); setTimeout(tick, 5); }
    else { res.write('data: [DONE]\n\n'); res.end(); }
  };
  tick();
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
  if (req.method === 'GET' && req.url === '/v1/models') {
    const s = JSON.stringify({ object: 'list', data: MODEL_IDS.map((id) => ({ id, object: 'model', created: 1700000000, owned_by: 'mock' })) });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
    res.end(s);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400); res.end('{}'); return; }
      handleChat(req, res, body);
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}');
});
server.listen(PORT, '127.0.0.1', () => process.stderr.write(JSON.stringify({ event: 'mock_listen', port: PORT }) + '\n'));
