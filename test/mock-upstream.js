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
 */
const http = require('node:http');

const PORT = Number(process.env.MOCK_PORT || 18924);
const TEXT = 'Hello from mock upstream.';
const TOOL_ARGS = JSON.stringify({ text: 'hello-from-tool' });

function plan(body) {
  const messages = body.messages || [];
  const toolMsg = messages.find((m) => m.role === 'tool');
  if (toolMsg) return { kind: 'text', text: `After tool: ${toolMsg.content}`, usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } };
  const allText = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  if (allText.includes('CALL_TOOL')) {
    const name = (body.tools && body.tools[0] && body.tools[0].function && body.tools[0].function.name) || 'run_echo';
    return { kind: 'tool', name, usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 } };
  }
  return { kind: 'text', text: TEXT, usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } };
}

function chunk(id, created, model, delta, finishReason) {
  return { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason || null }] };
}

function handleChat(req, res, body) {
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
