'use strict';
/**
 * Relay gateway — M0 spike.
 *
 * POST /v1/responses (OpenAI Responses API shape, Codex side) with two modes:
 *   RELAY_MODE=passthrough  forward the raw request to the Codex backend
 *                           (https://chatgpt.com/backend-api/codex/responses),
 *                           passing the caller's Authorization header through;
 *                           the SSE stream is piped back byte-for-byte.
 *   RELAY_MODE=translate    translate Responses -> Chat Completions, send to
 *                           RELAY_UPSTREAM_BASE (OpenAI-compatible), then
 *                           translate the reply (streaming or not) back to
 *                           Responses format.
 *
 * One JSON routing-log line per request goes to stderr and, if set,
 * RELAY_LOG_FILE. Authorization values are NEVER logged (only a boolean
 * "authPresent").
 */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const crypto = require('node:crypto');

const HOST = '127.0.0.1';
const PORT = Number(process.env.RELAY_PORT || 18923);
const MODE = process.env.RELAY_MODE || 'passthrough';
const UPSTREAM_BASE = (process.env.RELAY_UPSTREAM_BASE || 'http://127.0.0.1:18924/v1').replace(/\/+$/, '');
const UPSTREAM_API_KEY = process.env.RELAY_UPSTREAM_API_KEY || '';
const PASSTHROUGH_URL = process.env.RELAY_PASSTHROUGH_URL || 'https://chatgpt.com/backend-api/codex/responses';
const LOG_FILE = process.env.RELAY_LOG_FILE || '';

function logRoute(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  process.stderr.write(line + '\n');
  if (LOG_FILE) { try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* ignore */ } }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const rid = (p) => p + crypto.randomBytes(12).toString('hex');

// ---------------------------------------------------------------------------
// passthrough mode
// ---------------------------------------------------------------------------
function handlePassthrough(req, res, rawBody, startedAt) {
  const target = new URL(PASSTHROUGH_URL);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'connection', 'content-length', 'transfer-encoding'].includes(k)) continue;
    headers[k] = v;
  }
  headers['content-length'] = rawBody.length;
  const lib = target.protocol === 'http:' ? http : https;
  const up = lib.request(
    { method: 'POST', hostname: target.hostname, port: target.port || (target.protocol === 'http:' ? 80 : 443), path: target.pathname + target.search, headers },
    (upRes) => {
      const outHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (['connection', 'transfer-encoding', 'content-length'].includes(k)) continue;
        outHeaders[k] = v;
      }
      res.writeHead(upRes.statusCode, outHeaders);
      upRes.pipe(res);
      logRoute({ mode: 'passthrough', upstream: target.origin + target.pathname, status: upRes.statusCode, authPresent: Boolean(req.headers.authorization), ms: Date.now() - startedAt });
    },
  );
  up.on('error', (err) => {
    logRoute({ mode: 'passthrough', upstream: target.origin + target.pathname, status: 502, error: err.code || err.message, ms: Date.now() - startedAt });
    if (!res.headersSent) sendJson(res, 502, { error: { message: `passthrough upstream error: ${err.message}`, type: 'relay_upstream_error' } });
    else res.destroy();
  });
  up.end(rawBody);
}

// ---------------------------------------------------------------------------
// translation: Responses request -> Chat Completions request
// ---------------------------------------------------------------------------
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const p of content) {
    if (typeof p === 'string') parts.push(p);
    else if (p && (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text')) parts.push(p.text || '');
    // input_image / other parts: dropped in M0 (noted in M0-REPORT)
  }
  return parts.join('');
}

function responsesToChat(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: String(body.instructions) });
  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'function_call') {
        messages.push({
          role: 'assistant', content: null,
          tool_calls: [{ id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) } }],
        });
      } else if (item.type === 'function_call_output') {
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '') });
      } else if (item.type === 'reasoning') {
        // dropped: Chat Completions has no reasoning-item equivalent (M0 note)
      } else if (item.type === 'message' || item.role) {
        const role = item.role === 'developer' ? 'system' : (item.role || 'user');
        messages.push({ role, content: contentToText(item.content) });
      }
    }
  }
  const chat = { model: body.model, messages, stream: Boolean(body.stream) };
  if (Array.isArray(body.tools)) {
    const tools = body.tools.filter((t) => t && t.type === 'function' && t.name)
      .map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} }, ...(t.strict != null ? { strict: t.strict } : {}) } }));
    if (tools.length) chat.tools = tools;
  }
  if (typeof body.tool_choice === 'string') chat.tool_choice = body.tool_choice;
  else if (body.tool_choice && body.tool_choice.type === 'function' && body.tool_choice.name) chat.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
  if (body.temperature != null) chat.temperature = body.temperature;
  if (body.top_p != null) chat.top_p = body.top_p;
  if (body.max_output_tokens != null) chat.max_tokens = body.max_output_tokens;
  if (body.parallel_tool_calls != null) chat.parallel_tool_calls = body.parallel_tool_calls;
  if (chat.stream) chat.stream_options = { include_usage: true };
  return chat;
}

// ---------------------------------------------------------------------------
// translation: Chat Completions reply -> Responses reply
// ---------------------------------------------------------------------------
function mapUsage(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  return {
    input_tokens: u.prompt_tokens || 0,
    output_tokens: u.completion_tokens || 0,
    total_tokens: u.total_tokens || ((u.prompt_tokens || 0) + (u.completion_tokens || 0)),
    input_tokens_details: { cached_tokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0 },
    output_tokens_details: { reasoning_tokens: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0 },
  };
}

function chatToResponse(chat, model) {
  const choice = (chat.choices && chat.choices[0]) || {};
  const msg = choice.message || {};
  const output = [];
  if (typeof msg.content === 'string' && msg.content.length) {
    output.push({ type: 'message', id: rid('msg_'), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: msg.content, annotations: [] }] });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      output.push({ type: 'function_call', id: rid('fc_'), call_id: tc.id || rid('call_'), name: tc.function.name, arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments || {}), status: 'completed' });
    }
  }
  if (!output.length) output.push({ type: 'message', id: rid('msg_'), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '', annotations: [] }] });
  return {
    id: chat.id ? chat.id.replace(/^chatcmpl/, 'resp') : rid('resp_'),
    object: 'response', created_at: chat.created || Math.floor(Date.now() / 1000),
    status: 'completed', model: chat.model || model, output, usage: mapUsage(chat.usage),
  };
}

// ---------------------------------------------------------------------------
// translate mode
// ---------------------------------------------------------------------------
function upstreamRequest(path, jsonBody, extraHeaders) {
  return new Promise((resolve, reject) => {
    const target = new URL(UPSTREAM_BASE + path);
    const payload = Buffer.from(JSON.stringify(jsonBody));
    const headers = { 'content-type': 'application/json', 'content-length': payload.length, ...(extraHeaders || {}) };
    if (UPSTREAM_API_KEY) headers.authorization = `Bearer ${UPSTREAM_API_KEY}`;
    const lib = target.protocol === 'http:' ? http : https;
    const up = lib.request(
      { method: 'POST', hostname: target.hostname, port: target.port || (target.protocol === 'http:' ? 80 : 443), path: target.pathname + target.search, headers },
      resolve,
    );
    up.on('error', reject);
    up.end(payload);
  });
}

async function handleTranslateNonStream(req, res, body, startedAt) {
  const chatReq = responsesToChat(body);
  const upRes = await upstreamRequest('/chat/completions', chatReq, { accept: 'application/json' });
  const raw = await readBody(upRes);
  if (upRes.statusCode < 200 || upRes.statusCode >= 300) {
    logRoute({ mode: 'translate', stream: false, model: body.model, upstream: UPSTREAM_BASE, status: upRes.statusCode, ms: Date.now() - startedAt });
    res.writeHead(upRes.statusCode, { 'content-type': 'application/json' });
    res.end(raw);
    return;
  }
  const chat = JSON.parse(raw.toString('utf8'));
  const response = chatToResponse(chat, body.model);
  logRoute({ mode: 'translate', stream: false, model: body.model, upstream: UPSTREAM_BASE, status: 200, usage: response.usage, ms: Date.now() - startedAt });
  sendJson(res, 200, response);
}

async function handleTranslateStream(req, res, body, startedAt) {
  const chatReq = responsesToChat(body);
  const upRes = await upstreamRequest('/chat/completions', chatReq, { accept: 'text/event-stream' });
  if (upRes.statusCode < 200 || upRes.statusCode >= 300) {
    const raw = await readBody(upRes);
    logRoute({ mode: 'translate', stream: true, model: body.model, upstream: UPSTREAM_BASE, status: upRes.statusCode, ms: Date.now() - startedAt });
    res.writeHead(upRes.statusCode, { 'content-type': 'application/json' });
    res.end(raw);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const responseId = rid('resp_');
  const createdAt = Math.floor(Date.now() / 1000);
  let seq = 0;
  const baseResponse = (status, output, usage) => ({
    id: responseId, object: 'response', created_at: createdAt, status, model: body.model,
    output: output || [], ...(usage ? { usage } : {}),
  });
  const emit = (type, fields) => { const ev = { type, sequence_number: seq++, ...fields }; res.write(`event: ${type}\ndata: ${JSON.stringify(ev)}\n\n`); };

  emit('response.created', { response: baseResponse('in_progress', []) });
  emit('response.in_progress', { response: baseResponse('in_progress', []) });

  // Streaming state machine over chat chunks.
  let nextOutputIndex = 0;
  let textItem = null; // {id, outputIndex, text}
  const toolItems = new Map(); // chat tool index -> {id, outputIndex, callId, name, args}
  let usage = null;
  let finishReason = null;

  const closeTextItem = () => {
    if (!textItem) return;
    const part = { type: 'output_text', text: textItem.text, annotations: [] };
    emit('response.output_text.done', { item_id: textItem.id, output_index: textItem.outputIndex, content_index: 0, text: textItem.text });
    emit('response.content_part.done', { item_id: textItem.id, output_index: textItem.outputIndex, content_index: 0, part });
    emit('response.output_item.done', { output_index: textItem.outputIndex, item: { type: 'message', id: textItem.id, role: 'assistant', status: 'completed', content: [part] } });
    textItem = null;
  };
  const closeToolItem = (t) => {
    emit('response.function_call_arguments.done', { item_id: t.id, output_index: t.outputIndex, arguments: t.args });
    emit('response.output_item.done', { output_index: t.outputIndex, item: { type: 'function_call', id: t.id, call_id: t.callId, name: t.name, arguments: t.args, status: 'completed' } });
  };

  const onDelta = (delta) => {
    if (typeof delta.content === 'string' && delta.content.length) {
      if (!textItem) {
        textItem = { id: rid('msg_'), outputIndex: nextOutputIndex++, text: '' };
        emit('response.output_item.added', { output_index: textItem.outputIndex, item: { type: 'message', id: textItem.id, role: 'assistant', status: 'in_progress', content: [] } });
        emit('response.content_part.added', { item_id: textItem.id, output_index: textItem.outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      }
      textItem.text += delta.content;
      emit('response.output_text.delta', { item_id: textItem.id, output_index: textItem.outputIndex, content_index: 0, delta: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index || 0;
        if (!toolItems.has(idx)) {
          closeTextItem();
          const t = { id: rid('fc_'), outputIndex: nextOutputIndex++, callId: tc.id || rid('call_'), name: (tc.function && tc.function.name) || '', args: '' };
          toolItems.set(idx, t);
          emit('response.output_item.added', { output_index: t.outputIndex, item: { type: 'function_call', id: t.id, call_id: t.callId, name: t.name, arguments: '', status: 'in_progress' } });
        }
        const t = toolItems.get(idx);
        if (tc.id) t.callId = tc.id;
        if (tc.function && tc.function.name) t.name = tc.function.name;
        const argDelta = tc.function && typeof tc.function.arguments === 'string' ? tc.function.arguments : '';
        if (argDelta) { t.args += argDelta; emit('response.function_call_arguments.delta', { item_id: t.id, output_index: t.outputIndex, delta: argDelta }); }
      }
    }
  };

  await new Promise((resolve) => {
    let buf = '';
    upRes.setEncoding('utf8');
    upRes.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunkJson; try { chunkJson = JSON.parse(data); } catch { continue; }
        if (chunkJson.usage) usage = chunkJson.usage;
        const choice = (chunkJson.choices && chunkJson.choices[0]) || null;
        if (choice) {
          if (choice.delta) onDelta(choice.delta);
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      }
    });
    upRes.on('end', resolve);
    upRes.on('error', resolve);
  });

  // Finalize output items in output_index order.
  const completedByIndex = new Map();
  if (textItem) completedByIndex.set(textItem.outputIndex, { type: 'message', id: textItem.id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: textItem.text, annotations: [] }] });
  closeTextItem();
  const toolsSorted = [...toolItems.values()].sort((a, b) => a.outputIndex - b.outputIndex);
  for (const t of toolsSorted) {
    closeToolItem(t);
    completedByIndex.set(t.outputIndex, { type: 'function_call', id: t.id, call_id: t.callId, name: t.name, arguments: t.args, status: 'completed' });
  }
  const finalOutput = [...completedByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  const finalResponse = baseResponse('completed', finalOutput, mapUsage(usage));
  emit('response.completed', { response: finalResponse });
  res.end();
  logRoute({ mode: 'translate', stream: true, model: body.model, upstream: UPSTREAM_BASE, status: 200, finishReason, usage: finalResponse.usage, ms: Date.now() - startedAt });
}

async function handleTranslate(req, res, rawBody, startedAt) {
  let body;
  try { body = JSON.parse(rawBody.toString('utf8')); } catch { sendJson(res, 400, { error: { message: 'invalid JSON body', type: 'relay_bad_request' } }); return; }
  try {
    if (body.stream) await handleTranslateStream(req, res, body, startedAt);
    else await handleTranslateNonStream(req, res, body, startedAt);
  } catch (err) {
    logRoute({ mode: 'translate', stream: Boolean(body && body.stream), status: 502, error: err.code || err.message, ms: Date.now() - startedAt });
    if (!res.headersSent) sendJson(res, 502, { error: { message: `translate upstream error: ${err.message}`, type: 'relay_upstream_error' } });
    else res.end();
  }
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/health') { sendJson(res, 200, { ok: true, mode: MODE }); return; }
  if (req.method === 'POST' && url.pathname === '/v1/responses') {
    const rawBody = await readBody(req);
    if (MODE === 'passthrough') handlePassthrough(req, res, rawBody, startedAt);
    else await handleTranslate(req, res, rawBody, startedAt);
    return;
  }
  sendJson(res, 404, { error: { message: 'not found', type: 'relay_not_found' } });
});
server.listen(PORT, HOST, () => logRoute({ event: 'listen', host: HOST, port: PORT, mode: MODE }));
