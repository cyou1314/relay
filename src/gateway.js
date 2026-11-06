'use strict';
/**
 * Relay gateway — M1 (gateway core).
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
 * GET /v1/models            passthrough: forwarded to the Codex backend
 *                           (/models next to /responses, caller's headers
 *                           passed through). translate: RELAY_MODELS (comma
 *                           list) if set, else the upstream's own /models
 *                           list mapped to the OpenAI list shape.
 *
 * Resilience (M1):
 *   - Upstream 4xx/5xx are mapped to the Responses error shape
 *     ({error:{message,type,param,code}}) with the upstream status preserved.
 *   - Per-request upstream timeout (RELAY_UPSTREAM_TIMEOUT_MS, default
 *     120000). A timeout before any client output maps to 504.
 *   - At most ONE retry, only for failures that happen before the upstream
 *     sends response headers (connect/DNS/reset/timeout) and before any
 *     byte reaches the client. Never retried mid-stream.
 *   - If the upstream SSE stream breaks mid-flight, the gateway terminates
 *     the Responses stream with a response.failed event instead of hanging.
 *
 * Routing log: one JSON line per request to stderr AND to a JSONL file
 * (RELAY_LOG_FILE, default <repo>/logs/routing.jsonl). Fields: ts, path,
 * mode, upstream, model, status, ms, usage, reasonCode, authPresent.
 * reasonCode minimal set (M1):
 *   passthrough_default  request served by passthrough mode, no incident
 *   translate_default    request served by translate mode, no incident
 *   upstream_error       upstream returned >=400, timed out, broke the
 *                        stream, or was unreachable after the single retry
 *   client_abort         the client disconnected before completion
 * Authorization values are NEVER logged (only the boolean "authPresent").
 */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HOST = '127.0.0.1';
const PORT = Number(process.env.RELAY_PORT || 18923);
const MODE = process.env.RELAY_MODE || 'passthrough';
const UPSTREAM_BASE = (process.env.RELAY_UPSTREAM_BASE || 'http://127.0.0.1:18924/v1').replace(/\/+$/, '');
const UPSTREAM_API_KEY = process.env.RELAY_UPSTREAM_API_KEY || '';
const PASSTHROUGH_URL = process.env.RELAY_PASSTHROUGH_URL || 'https://chatgpt.com/backend-api/codex/responses';
const TIMEOUT_MS = Number(process.env.RELAY_UPSTREAM_TIMEOUT_MS || 120000);
const MODELS_OVERRIDE = (process.env.RELAY_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
const LOG_FILE = process.env.RELAY_LOG_FILE || path.join(__dirname, '..', 'logs', 'routing.jsonl');

let logDirReady = false;
function logRoute(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  process.stderr.write(line + '\n');
  try {
    if (!logDirReady) { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); logDirReady = true; }
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* logging must never break routing */ }
}

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** Responses-API-shaped error body. */
function sendError(res, status, message, type, code) {
  sendJson(res, status, { error: { message, type: type || 'relay_error', param: null, code: code || null } });
}

/** Map an upstream HTTP error (status + raw body) onto the Responses error shape, preserving the status. */
function mapUpstreamErrorBody(status, raw) {
  let message = `upstream returned HTTP ${status}`;
  let type = status === 429 ? 'rate_limit_error' : status >= 500 ? 'server_error' : 'invalid_request_error';
  let code = `upstream_${status}`;
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    const e = parsed && parsed.error;
    if (e && typeof e.message === 'string' && e.message) message = e.message;
    else if (parsed && typeof parsed.message === 'string' && parsed.message) message = parsed.message;
    if (e && typeof e.type === 'string' && e.type) type = e.type;
    if (e && (typeof e.code === 'string' || typeof e.code === 'number')) code = String(e.code);
  } catch { /* keep defaults */ }
  return { message, type, code };
}

const rid = (p) => p + crypto.randomBytes(12).toString('hex');
const isTimeoutErr = (err) => Boolean(err) && err.code === 'RELAY_TIMEOUT';

// ---------------------------------------------------------------------------
// low-level upstream POST with timeout; resolves with the response stream as
// soon as headers arrive. Rejects only for pre-header failures.
// ---------------------------------------------------------------------------
function upstreamAttempt(urlStr, payload, headers) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlStr);
    const lib = target.protocol === 'http:' ? http : https;
    const up = lib.request(
      { method: 'POST', hostname: target.hostname, port: target.port || (target.protocol === 'http:' ? 80 : 443), path: target.pathname + target.search, headers },
      (upRes) => { clearTimeout(timer); resolve(upRes); },
    );
    const timer = setTimeout(() => {
      const err = new Error(`upstream timeout after ${TIMEOUT_MS}ms`);
      err.code = 'RELAY_TIMEOUT';
      up.destroy(err);
    }, TIMEOUT_MS);
    up.on('error', (err) => { clearTimeout(timer); reject(err); });
    up.end(payload);
  });
}

/** One idempotent retry, strictly for pre-header (connection-stage) failures. */
async function upstreamPostWithRetry(urlStr, payload, headers) {
  try {
    return await upstreamAttempt(urlStr, payload, headers);
  } catch (firstErr) {
    return await upstreamAttempt(urlStr, payload, headers); // second and final attempt
  }
}

function armBodyTimeout(upRes) {
  // After headers, a stalled body must not hang the gateway forever.
  upRes.setTimeout(TIMEOUT_MS, () => {
    const err = new Error(`upstream body timeout after ${TIMEOUT_MS}ms`);
    err.code = 'RELAY_TIMEOUT';
    upRes.destroy(err);
  });
}

// ---------------------------------------------------------------------------
// passthrough mode (POST /v1/responses and GET /v1/models)
// ---------------------------------------------------------------------------
function handlePassthrough(req, res, rawBody, startedAt, upstreamUrlStr, model) {
  let attempt = 0;
  let logged = false;
  let clientAborted = false;
  const targetLabel = (() => { const u = new URL(upstreamUrlStr); return u.origin + u.pathname; })();
  const logOnce = (fields) => {
    if (logged) return; logged = true;
    logRoute({ path: new URL(req.url, 'http://x').pathname, mode: 'passthrough', upstream: targetLabel, model: model || null, authPresent: Boolean(req.headers.authorization), ms: Date.now() - startedAt, ...fields });
  };
  res.on('close', () => {
    if (!res.writableEnded) { clientAborted = true; logOnce({ status: 499, reasonCode: 'client_abort' }); }
  });

  const tryOnce = () => {
    attempt++;
    const target = new URL(upstreamUrlStr);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (['host', 'connection', 'content-length', 'transfer-encoding'].includes(k)) continue;
      headers[k] = v;
    }
    if (rawBody.length) headers['content-length'] = rawBody.length;
    const lib = target.protocol === 'http:' ? http : https;
    let up;
    const timer = setTimeout(() => {
      const err = new Error(`upstream timeout after ${TIMEOUT_MS}ms`);
      err.code = 'RELAY_TIMEOUT';
      if (up) up.destroy(err);
    }, TIMEOUT_MS);
    up = lib.request(
      { method: req.method, hostname: target.hostname, port: target.port || (target.protocol === 'http:' ? 80 : 443), path: target.pathname + target.search, headers },
      (upRes) => {
        clearTimeout(timer);
        armBodyTimeout(upRes);
        const outHeaders = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (['connection', 'transfer-encoding', 'content-length'].includes(k)) continue;
          outHeaders[k] = v;
        }
        res.writeHead(upRes.statusCode, outHeaders);
        upRes.pipe(res);
        upRes.on('end', () => logOnce({ status: upRes.statusCode, reasonCode: upRes.statusCode >= 400 ? 'upstream_error' : 'passthrough_default' }));
        upRes.on('error', (err) => {
          logOnce({ status: isTimeoutErr(err) ? 504 : 502, reasonCode: 'upstream_error', error: err.code || err.message });
          if (!res.writableEnded) res.destroy();
        });
      },
    );
    up.on('error', (err) => {
      clearTimeout(timer);
      if (clientAborted) return;
      if (!res.headersSent && attempt < 2) { tryOnce(); return; } // pre-header failure: single retry
      if (!res.headersSent) {
        const status = isTimeoutErr(err) ? 504 : 502;
        logOnce({ status, reasonCode: 'upstream_error', error: err.code || err.message });
        sendError(res, status, isTimeoutErr(err) ? `passthrough upstream timeout after ${TIMEOUT_MS}ms` : `passthrough upstream error: ${err.message}`, isTimeoutErr(err) ? 'relay_upstream_timeout' : 'relay_upstream_error', err.code || null);
      } else {
        logOnce({ status: 502, reasonCode: 'upstream_error', error: err.code || err.message });
        res.destroy();
      }
    });
    if (req.method === 'GET' || !rawBody.length) up.end();
    else up.end(rawBody);
  };
  tryOnce();
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
function chatCompletionsCall(chatReq, accept) {
  const payload = Buffer.from(JSON.stringify(chatReq));
  const headers = { 'content-type': 'application/json', 'content-length': payload.length, accept };
  if (UPSTREAM_API_KEY) headers.authorization = `Bearer ${UPSTREAM_API_KEY}`;
  return upstreamPostWithRetry(UPSTREAM_BASE + '/chat/completions', payload, headers);
}

function translateLogBase(body) {
  return { path: '/v1/responses', mode: 'translate', upstream: UPSTREAM_BASE, model: body.model || null, authPresent: false };
}

async function handleTranslateNonStream(req, res, body, startedAt) {
  const chatReq = responsesToChat(body);
  const upRes = await chatCompletionsCall(chatReq, 'application/json');
  armBodyTimeout(upRes);
  const raw = await readBody(upRes);
  if (upRes.statusCode < 200 || upRes.statusCode >= 300) {
    const mapped = mapUpstreamErrorBody(upRes.statusCode, raw);
    logRoute({ ...translateLogBase(body), stream: false, status: upRes.statusCode, reasonCode: 'upstream_error', ms: Date.now() - startedAt });
    sendError(res, upRes.statusCode, mapped.message, mapped.type, mapped.code);
    return;
  }
  const chat = JSON.parse(raw.toString('utf8'));
  const response = chatToResponse(chat, body.model);
  logRoute({ ...translateLogBase(body), stream: false, status: 200, reasonCode: 'translate_default', usage: response.usage, ms: Date.now() - startedAt });
  sendJson(res, 200, response);
}

async function handleTranslateStream(req, res, body, startedAt) {
  const chatReq = responsesToChat(body);
  const upRes = await chatCompletionsCall(chatReq, 'text/event-stream');
  armBodyTimeout(upRes);
  if (upRes.statusCode < 200 || upRes.statusCode >= 300) {
    const raw = await readBody(upRes);
    const mapped = mapUpstreamErrorBody(upRes.statusCode, raw);
    logRoute({ ...translateLogBase(body), stream: true, status: upRes.statusCode, reasonCode: 'upstream_error', ms: Date.now() - startedAt });
    sendError(res, upRes.statusCode, mapped.message, mapped.type, mapped.code);
    return;
  }

  let clientAborted = false;
  res.on('close', () => {
    if (!res.writableEnded) { clientAborted = true; upRes.destroy(); }
  });

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const responseId = rid('resp_');
  const createdAt = Math.floor(Date.now() / 1000);
  let seq = 0;
  const baseResponse = (status, output, usage, error) => ({
    id: responseId, object: 'response', created_at: createdAt, status, model: body.model,
    output: output || [], ...(usage ? { usage } : {}), ...(error ? { error } : {}),
  });
  const emit = (type, fields) => {
    if (res.writableEnded || res.destroyed) return;
    const ev = { type, sequence_number: seq++, ...fields };
    res.write(`event: ${type}\ndata: ${JSON.stringify(ev)}\n\n`);
  };

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

  let streamFailure = null; // set when the upstream stream ends abnormally
  await new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const settle = () => { if (!settled) { settled = true; resolve(); } };
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
    upRes.on('end', settle);
    upRes.on('error', (err) => { streamFailure = err; settle(); });
    upRes.on('aborted', () => { streamFailure = streamFailure || new Error('upstream stream aborted'); settle(); });
    upRes.on('close', () => { if (!upRes.complete) { streamFailure = streamFailure || new Error('upstream stream closed prematurely'); } settle(); });
  });

  if (clientAborted) {
    logRoute({ ...translateLogBase(body), stream: true, status: 499, reasonCode: 'client_abort', ms: Date.now() - startedAt });
    if (!res.writableEnded) res.end();
    return;
  }
  if (streamFailure) {
    // Terminate the Responses stream legally instead of hanging the client.
    const errObj = { message: `upstream stream interrupted: ${streamFailure.message}`, type: 'relay_upstream_error', param: null, code: streamFailure.code || 'upstream_stream_broken' };
    emit('response.failed', { response: baseResponse('failed', [], mapUsage(usage), errObj) });
    res.end();
    logRoute({ ...translateLogBase(body), stream: true, status: 502, reasonCode: 'upstream_error', error: errObj.code, ms: Date.now() - startedAt });
    return;
  }

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
  logRoute({ ...translateLogBase(body), stream: true, status: 200, reasonCode: 'translate_default', finishReason, usage: finalResponse.usage, ms: Date.now() - startedAt });
}

async function handleTranslate(req, res, rawBody, startedAt) {
  let body;
  try { body = JSON.parse(rawBody.toString('utf8')); } catch { sendError(res, 400, 'invalid JSON body', 'relay_bad_request', 'invalid_json'); return; }
  try {
    if (body.stream) await handleTranslateStream(req, res, body, startedAt);
    else await handleTranslateNonStream(req, res, body, startedAt);
  } catch (err) {
    const status = isTimeoutErr(err) ? 504 : 502;
    logRoute({ ...translateLogBase(body), stream: Boolean(body && body.stream), status, reasonCode: 'upstream_error', error: err.code || err.message, ms: Date.now() - startedAt });
    if (!res.headersSent) sendError(res, status, isTimeoutErr(err) ? `translate upstream timeout after ${TIMEOUT_MS}ms` : `translate upstream error: ${err.message}`, isTimeoutErr(err) ? 'relay_upstream_timeout' : 'relay_upstream_error', err.code || null);
    else if (!res.writableEnded) res.end();
  }
}

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------
async function handleModels(req, res, url, startedAt) {
  if (MODE === 'passthrough') {
    const pt = new URL(PASSTHROUGH_URL);
    const modelsPath = pt.pathname.replace(/\/responses\/?$/, '/models');
    handlePassthrough(req, res, Buffer.alloc(0), startedAt, pt.origin + modelsPath + url.search, null);
    return;
  }
  // translate mode
  const logBase = { path: '/v1/models', mode: 'translate', upstream: UPSTREAM_BASE, model: null, authPresent: false };
  const sendList = (ids, reasonCode) => {
    logRoute({ ...logBase, status: 200, reasonCode, ms: Date.now() - startedAt });
    sendJson(res, 200, { object: 'list', data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'relay' })) });
  };
  if (MODELS_OVERRIDE.length) { sendList(MODELS_OVERRIDE, 'translate_default'); return; }
  try {
    const target = new URL(UPSTREAM_BASE + '/models');
    const headers = {};
    if (UPSTREAM_API_KEY) headers.authorization = `Bearer ${UPSTREAM_API_KEY}`;
    const upRes = await new Promise((resolve, reject) => {
      const lib = target.protocol === 'http:' ? http : https;
      const up = lib.request(
        { method: 'GET', hostname: target.hostname, port: target.port || (target.protocol === 'http:' ? 80 : 443), path: target.pathname + target.search, headers },
        (r) => { clearTimeout(timer); resolve(r); },
      );
      const timer = setTimeout(() => { const e = new Error(`upstream timeout after ${TIMEOUT_MS}ms`); e.code = 'RELAY_TIMEOUT'; up.destroy(e); }, TIMEOUT_MS);
      up.on('error', (err) => { clearTimeout(timer); reject(err); });
      up.end();
    });
    armBodyTimeout(upRes);
    const raw = await readBody(upRes);
    if (upRes.statusCode < 200 || upRes.statusCode >= 300) {
      const mapped = mapUpstreamErrorBody(upRes.statusCode, raw);
      logRoute({ ...logBase, status: upRes.statusCode, reasonCode: 'upstream_error', ms: Date.now() - startedAt });
      sendError(res, upRes.statusCode, mapped.message, mapped.type, mapped.code);
      return;
    }
    const parsed = JSON.parse(raw.toString('utf8'));
    const ids = (Array.isArray(parsed.data) ? parsed.data : []).map((m) => m && m.id).filter(Boolean);
    sendList(ids, 'translate_default');
  } catch (err) {
    const status = isTimeoutErr(err) ? 504 : 502;
    logRoute({ ...logBase, status, reasonCode: 'upstream_error', error: err.code || err.message, ms: Date.now() - startedAt });
    sendError(res, status, `models upstream error: ${err.message}`, isTimeoutErr(err) ? 'relay_upstream_timeout' : 'relay_upstream_error', err.code || null);
  }
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/health') { sendJson(res, 200, { ok: true, mode: MODE }); return; }
  if (req.method === 'GET' && url.pathname === '/v1/models') { await handleModels(req, res, url, startedAt); return; }
  if (req.method === 'POST' && url.pathname === '/v1/responses') {
    const rawBody = await readBody(req);
    if (MODE === 'passthrough') {
      let model = null;
      try { model = JSON.parse(rawBody.toString('utf8')).model || null; } catch { /* keep null */ }
      handlePassthrough(req, res, rawBody, startedAt, PASSTHROUGH_URL, model);
    } else await handleTranslate(req, res, rawBody, startedAt);
    return;
  }
  sendError(res, 404, 'not found', 'relay_not_found', 'not_found');
});
server.listen(PORT, HOST, () => logRoute({ event: 'listen', host: HOST, port: PORT, mode: MODE, logFile: LOG_FILE }));

module.exports = { responsesToChat, chatToResponse, mapUsage, mapUpstreamErrorBody };
