'use strict';
/**
 * Mock Google Cloud Code upstream (kind 'gemini' tests).
 *
 * Speaks the v1internal shape Relay's Gemini adapter targets:
 *   POST /v1internal:generateContent
 *   POST /v1internal:streamGenerateContent?alt=sse
 *   body    { model, project?, user_prompt_id, request: { contents, ... } }
 *   reply   { response: { candidates, usageMetadata, modelVersion }, traceId }
 *   stream  SSE, one wrapped reply object per event
 *
 * Scripted behavior (driven by the request contents):
 *  - Authorization must be `Bearer <MOCK_GEMINI_TOKEN>` (default
 *    FAKE_GEMINI_ACCESS); anything else gets a Google-style 401
 *    {error:{code:401,message,status:'UNAUTHENTICATED'}}.
 *  - Any functionDeclaration present + conversation text containing
 *    "CALL_TOOL" -> one functionCall part for the first declared tool
 *    with args {"text":"hello-from-tool"}.
 *  - Text containing "GEMINI_FAIL_429" -> Google-style 429
 *    RESOURCE_EXHAUSTED.
 *  - Else -> text "Hello from gemini mock." (streamed in two events).
 * Usage is fixed: prompt 11 / candidates 6 / total 17.
 *
 * GET /__last returns {authorization, body} of the most recent POST so
 * tests can assert the wrapper shape, the contents conversion and the
 * credential header. GET /__hits counts POSTs per action.
 */
const http = require('node:http');

const PORT = Number(process.env.MOCK_GEMINI_PORT || 18967);
const TOKEN = process.env.MOCK_GEMINI_TOKEN || 'FAKE_GEMINI_ACCESS';
const TEXT = 'Hello from gemini mock.';
const USAGE = { promptTokenCount: 11, candidatesTokenCount: 6, totalTokenCount: 17 };

let last = null;
const hits = {};

function googleError(res, status, message, gStatus) {
  const s = JSON.stringify({ error: { code: status, message, status: gStatus } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

function allText(body) {
  const req = (body && body.request) || {};
  return (req.contents || [])
    .flatMap((c) => (c.parts || []).map((p) => (typeof p.text === 'string' ? p.text : '')))
    .join('\n');
}

function plan(body) {
  const text = allText(body);
  if (text.includes('GEMINI_FAIL_429')) return { kind: 'fail429' };
  const decls = ((body.request || {}).tools || []).flatMap((t) => t.functionDeclarations || []);
  if (text.includes('CALL_TOOL') && decls.length) return { kind: 'tool', name: decls[0].name };
  return { kind: 'text' };
}

function wrapped(parts, finishReason, withUsage) {
  const cand = { content: { role: 'model', parts } };
  if (finishReason) cand.finishReason = finishReason;
  const response = { candidates: [cand], modelVersion: 'gemini-mock-1' };
  if (withUsage) response.usageMetadata = USAGE;
  return { response, traceId: 'trace-mock-1' };
}

function handle(req, res, body, stream) {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    googleError(res, 401, 'Request had invalid authentication credentials. Expected OAuth 2 access token.', 'UNAUTHENTICATED');
    return;
  }
  const p = plan(body);
  if (p.kind === 'fail429') {
    googleError(res, 429, 'Resource has been exhausted (e.g. check quota).', 'RESOURCE_EXHAUSTED');
    return;
  }
  if (!stream) {
    const out = p.kind === 'tool'
      ? wrapped([{ functionCall: { name: p.name, args: { text: 'hello-from-tool' } } }], 'STOP', true)
      : wrapped([{ text: TEXT }], 'STOP', true);
    const s = JSON.stringify(out);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
    res.end(s);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const events = p.kind === 'tool'
    ? [wrapped([{ functionCall: { name: p.name, args: { text: 'hello-from-tool' } } }], null, false),
       wrapped([], 'STOP', true)]
    : [wrapped([{ text: 'Hello ' }], null, false),
       wrapped([{ text: 'from gemini mock.' }], null, false),
       wrapped([], 'STOP', true)];
  let i = 0;
  const tick = () => {
    if (i < events.length) { send(events[i++]); setTimeout(tick, 5); }
    else res.end();
  };
  tick();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
  if (req.method === 'GET' && url.pathname === '/__last') {
    const s = JSON.stringify(last || {});
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) }); res.end(s); return;
  }
  if (req.method === 'GET' && url.pathname === '/__hits') {
    const s = JSON.stringify(hits);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) }); res.end(s); return;
  }
  const isGenerate = req.method === 'POST' && url.pathname === '/v1internal:generateContent';
  const isStream = req.method === 'POST' && url.pathname === '/v1internal:streamGenerateContent';
  if (isGenerate || isStream) {
    const action = isStream ? 'streamGenerateContent' : 'generateContent';
    hits[action] = (hits[action] || 0) + 1;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { googleError(res, 400, 'Invalid JSON payload received.', 'INVALID_ARGUMENT'); return; }
      last = { authorization: req.headers.authorization || null, body };
      handle(req, res, body, isStream);
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"code":404,"message":"not found","status":"NOT_FOUND"}}');
});
server.listen(PORT, '127.0.0.1', () => process.stderr.write(JSON.stringify({ event: 'mock_gemini_listen', port: PORT }) + '\n'));
