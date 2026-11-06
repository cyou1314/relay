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
 *
 * Core phase — routed mode: when a config file exists (RELAY_CONFIG or
 * <repo>/relay.config.json; see src/config.js), POST /v1/responses is
 * served by the routing engine instead of the single env upstream:
 *   - src/upstreams.js  registry of configured upstreams (kind/tier/price)
 *   - src/quota.js      quota sources (mock / metering-estimate / unavailable)
 *   - src/router.js     priority + stickiness + pins + sensitive fail-closed
 *   - src/difficulty.js task-difficulty classifier (second routing axis)
 * Every ATTEMPT is logged with requestId, chosen upstream, attempt number,
 * the decision reasonCode, a quota snapshot, the difficulty verdict
 * ({level, score} + signals on the line) and the model actually served
 * (servedModel — one specific model of the chosen upstream, picked by
 * capability; see src/router.js). Routed reasonCodes:
 *   initial          first attempt, automatic policy pick
 *   pinned           first attempt, a cwd rule pinned this upstream
 *   sticky_session   first attempt, this session chain already lives here
 *   fallback_quota   previous attempt failed on quota/429
 *   fallback_filtered previous attempt was refused by a safety filter
 *   fallback_auth    previous attempt's upstream rejected its credential
 *                    (401/403 — that upstream's key is dead; other
 *                    upstreams hold independent credentials)
 *   fallback_error   previous attempt failed otherwise (5xx/connect/timeout)
 *   invalid_request_stop  an upstream proved the REQUEST itself invalid
 *                    (400 + context_length_exceeded / invalid_request):
 *                    the fallback chain stopped immediately and the
 *                    upstream error was returned to the client as-is
 *   sensitive_block  sensitive project, no subscription upstream: refused
 *   difficulty_light_preserve  light task, subscription quota scarce:
 *                       a cheap API leads so quota survives for heavy work
 *   difficulty_upgrade  the chain's upstream has no model graded for
 *                       this task's level; the session moved up
 *   difficulty_underpowered  NO upstream has a model graded for this
 *                       level; the strongest available served anyway and
 *                       the downgrade is on the record, never silent
 *   client_abort / upstream_error as in legacy mode
 * With no config file the gateway behaves exactly as M1 (legacy mode).
 *
 * POST /v1/feedback {requestId, verdict:"up"|"down"} appends to the
 * feedback log (RELAY_FEEDBACK_FILE, default <repo>/logs/feedback.jsonl).
 * Record + count only (see src/ledger.js); no automatic tuning yet.
 */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig } = require('./config');
const { createRegistry, resolveTarget, classifyFailure, fallbackReasonCode } = require('./upstreams');
const { createQuotaService } = require('./quota');
const routerEngine = require('./router');
const difficultyEngine = require('./difficulty');

const HOST = '127.0.0.1';
const PORT = Number(process.env.RELAY_PORT || 18923);
const MODE = process.env.RELAY_MODE || 'passthrough';
const UPSTREAM_BASE = (process.env.RELAY_UPSTREAM_BASE || 'http://127.0.0.1:18924/v1').replace(/\/+$/, '');
const UPSTREAM_API_KEY = process.env.RELAY_UPSTREAM_API_KEY || '';
const PASSTHROUGH_URL = process.env.RELAY_PASSTHROUGH_URL || 'https://chatgpt.com/backend-api/codex/responses';
const TIMEOUT_MS = Number(process.env.RELAY_UPSTREAM_TIMEOUT_MS || 120000);
const MODELS_OVERRIDE = (process.env.RELAY_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
const LOG_FILE = process.env.RELAY_LOG_FILE || path.join(__dirname, '..', 'logs', 'routing.jsonl');
const FEEDBACK_FILE = process.env.RELAY_FEEDBACK_FILE || path.join(__dirname, '..', 'logs', 'feedback.jsonl');

// Routed-mode assembly. A malformed config file is a hard startup error:
// silently falling back to legacy mode would route traffic somewhere the
// operator did not intend.
let CONFIG = null;
try { CONFIG = loadConfig(); } catch (err) {
  process.stderr.write(JSON.stringify({ event: 'config_error', message: err.message }) + '\n');
  process.exit(1);
}
const registry = CONFIG ? createRegistry(CONFIG) : null;
const quotaService = CONFIG ? createQuotaService({ config: CONFIG, registry, logFile: LOG_FILE }) : null;

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
// REDIRECT POLICY — deliberate, do not "fix".
// Every upstream request in this file is issued with raw node:http/https,
// which NEVER follows redirects, and Relay adds no redirect handling on
// top. This is intentional: these requests carry credentials (the
// caller's Authorization header in passthrough, an upstream's API key in
// translate/routed). If an upstream answers 3xx, the response is handed
// back to the client as-is (passthrough) or surfaced as an ordinary
// upstream failure (translate/routed) — it is NEVER automatically chased
// to the Location host. Following it would re-send the credential
// headers to a host the operator never configured: a credential
// exfiltration hole. If this file is ever refactored onto a
// redirect-following client (fetch defaults to following!), redirect
// handling MUST be disabled there. Locked in by test 30 (mock answers
// 302 -> gateway returns 302 untouched, redirect target never contacted).
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
    // Raw http/https: a 3xx is piped back to the client as-is and never
    // followed with the caller's Authorization attached — see the
    // REDIRECT POLICY note above upstreamAttempt. Do not add following.
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
// translate mode. The attempt functions serve one upstream target and
// RETURN an outcome instead of logging/sending errors themselves, so the
// routed engine can fall back; the legacy wrappers below reproduce the
// exact M0/M1 behavior (log lines + mapped error responses) on top.
//   outcome 'success'       response fully written to the client
//   outcome 'failure'       upstream answered >=400 pre-output; nothing
//                           written yet, caller may fall back or send
//                           `mapped` as the error response
//   outcome 'stream_broken' upstream SSE died mid-stream; a terminal
//                           response.failed was already written
//   outcome 'client_abort'  client went away mid-stream
// Transport exceptions (connect/timeout) are thrown, as before.
// ---------------------------------------------------------------------------
function chatCompletionsCallTo(baseUrl, apiKey, chatReq, accept) {
  const payload = Buffer.from(JSON.stringify(chatReq));
  const headers = { 'content-type': 'application/json', 'content-length': payload.length, accept };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return upstreamPostWithRetry(baseUrl + '/chat/completions', payload, headers);
}

function chatCompletionsCall(chatReq, accept) {
  return chatCompletionsCallTo(UPSTREAM_BASE, UPSTREAM_API_KEY, chatReq, accept);
}

function translateLogBase(body) {
  return { path: '/v1/responses', mode: 'translate', upstream: UPSTREAM_BASE, model: body.model || null, authPresent: false };
}

const ENV_TARGET = { baseUrl: UPSTREAM_BASE, apiKey: UPSTREAM_API_KEY, model: null };

async function attemptTranslateNonStream(res, body, target) {
  const chatReq = responsesToChat(body);
  if (target.model) chatReq.model = target.model;
  const upRes = await chatCompletionsCallTo(target.baseUrl, target.apiKey, chatReq, 'application/json');
  armBodyTimeout(upRes);
  const raw = await readBody(upRes);
  if (upRes.statusCode < 200 || upRes.statusCode >= 300) {
    const mapped = mapUpstreamErrorBody(upRes.statusCode, raw);
    return { outcome: 'failure', failureKind: classifyFailure({ status: upRes.statusCode, code: mapped.code, type: mapped.type, message: mapped.message }), status: upRes.statusCode, mapped };
  }
  const chat = JSON.parse(raw.toString('utf8'));
  const response = chatToResponse(chat, body.model);
  if (body.model) response.model = body.model; // the client sees the model it asked for
  sendJson(res, 200, response);
  return { outcome: 'success', status: 200, usage: response.usage, responseId: response.id };
}

async function attemptTranslateStream(res, body, target) {
  const chatReq = responsesToChat(body);
  if (target.model) chatReq.model = target.model;
  const upRes = await chatCompletionsCallTo(target.baseUrl, target.apiKey, chatReq, 'text/event-stream');
  armBodyTimeout(upRes);
  if (upRes.statusCode < 200 || upRes.statusCode >= 300) {
    const raw = await readBody(upRes);
    const mapped = mapUpstreamErrorBody(upRes.statusCode, raw);
    return { outcome: 'failure', failureKind: classifyFailure({ status: upRes.statusCode, code: mapped.code, type: mapped.type, message: mapped.message }), status: upRes.statusCode, mapped };
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
    if (!res.writableEnded) res.end();
    return { outcome: 'client_abort', status: 499 };
  }
  if (streamFailure) {
    // Terminate the Responses stream legally instead of hanging the client.
    const errObj = { message: `upstream stream interrupted: ${streamFailure.message}`, type: 'relay_upstream_error', param: null, code: streamFailure.code || 'upstream_stream_broken' };
    emit('response.failed', { response: baseResponse('failed', [], mapUsage(usage), errObj) });
    res.end();
    return { outcome: 'stream_broken', status: 502, usage: mapUsage(usage), errorCode: errObj.code };
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
  return { outcome: 'success', status: 200, usage: finalResponse.usage, responseId, finishReason };
}

/** Legacy translate path (no config): M0/M1 behavior on top of the attempts. */
async function handleTranslate(req, res, rawBody, startedAt) {
  let body;
  try { body = JSON.parse(rawBody.toString('utf8')); } catch { sendError(res, 400, 'invalid JSON body', 'relay_bad_request', 'invalid_json'); return; }
  const base = translateLogBase(body);
  try {
    const r = body.stream
      ? await attemptTranslateStream(res, body, ENV_TARGET)
      : await attemptTranslateNonStream(res, body, ENV_TARGET);
    if (r.outcome === 'success') {
      logRoute({ ...base, stream: Boolean(body.stream), status: 200, reasonCode: 'translate_default', usage: r.usage, ...(body.stream ? { finishReason: r.finishReason } : {}), ms: Date.now() - startedAt });
    } else if (r.outcome === 'failure') {
      logRoute({ ...base, stream: Boolean(body.stream), status: r.status, reasonCode: 'upstream_error', ms: Date.now() - startedAt });
      sendError(res, r.status, r.mapped.message, r.mapped.type, r.mapped.code);
    } else if (r.outcome === 'client_abort') {
      logRoute({ ...base, stream: true, status: 499, reasonCode: 'client_abort', ms: Date.now() - startedAt });
    } else if (r.outcome === 'stream_broken') {
      logRoute({ ...base, stream: true, status: 502, reasonCode: 'upstream_error', error: r.errorCode, ms: Date.now() - startedAt });
    }
  } catch (err) {
    const status = isTimeoutErr(err) ? 504 : 502;
    logRoute({ ...base, stream: Boolean(body && body.stream), status, reasonCode: 'upstream_error', error: err.code || err.message, ms: Date.now() - startedAt });
    if (!res.headersSent) sendError(res, status, isTimeoutErr(err) ? `translate upstream timeout after ${TIMEOUT_MS}ms` : `translate upstream error: ${err.message}`, isTimeoutErr(err) ? 'relay_upstream_timeout' : 'relay_upstream_error', err.code || null);
    else if (!res.writableEnded) res.end();
  }
}

// ---------------------------------------------------------------------------
// routed mode (config present): passthrough attempt + routing engine
// ---------------------------------------------------------------------------

/**
 * One passthrough attempt against a configured target URL. Unlike the
 * legacy handler it does NOT retry internally (the router's fallback
 * chain owns recovery) and it resolves an outcome: error statuses are
 * captured BEFORE any byte reaches the client so a fallback is still
 * possible; once a 2xx stream starts it is piped (tapped for the
 * response id + final usage) and can no longer fall back.
 */
function attemptPassthrough(req, res, rawBody, targetUrl) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (o) => { if (!settled) { settled = true; resolve(o); } };
    const target = new URL(targetUrl);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (['host', 'connection', 'content-length', 'transfer-encoding'].includes(k)) continue;
      headers[k] = v;
    }
    if (rawBody.length) headers['content-length'] = rawBody.length;
    const lib = target.protocol === 'http:' ? http : https;
    // Raw http/https, no redirect following (REDIRECT POLICY above
    // upstreamAttempt): a 3xx is returned to the client untouched.
    let up = null;
    let clientAborted = false;
    res.on('close', () => {
      if (!res.writableEnded && !settled) {
        clientAborted = true;
        if (up) up.destroy();
        done({ outcome: 'client_abort', status: 499 });
      }
    });
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
        if (upRes.statusCode >= 400) {
          readBody(upRes).then((raw) => {
            const mapped = mapUpstreamErrorBody(upRes.statusCode, raw);
            done({ outcome: 'failure', failureKind: classifyFailure({ status: upRes.statusCode, code: mapped.code, type: mapped.type, message: mapped.message }), status: upRes.statusCode, mapped });
          }).catch(() => done({ outcome: 'failure', failureKind: 'error', status: upRes.statusCode, mapped: { message: `upstream returned HTTP ${upRes.statusCode}`, type: 'relay_upstream_error', code: `upstream_${upRes.statusCode}` } }));
          return;
        }
        const outHeaders = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (['connection', 'transfer-encoding', 'content-length'].includes(k)) continue;
          outHeaders[k] = v;
        }
        res.writeHead(upRes.statusCode, outHeaders);
        // Tap the stream for the terminal response id + usage (stickiness
        // keys and the ledger need them; the bytes pass through untouched).
        let scan = '';
        let responseId = null;
        let usage = null;
        upRes.on('data', (c) => {
          scan = (scan + c.toString('utf8')).slice(-262144);
          if (!responseId) { const m = scan.match(/"id":"(resp_[^"]+)"/); if (m) responseId = m[1]; }
        });
        upRes.pipe(res);
        upRes.on('end', () => {
          for (const line of scan.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              const ev = JSON.parse(line.slice(5).trim());
              if (ev.type === 'response.completed' && ev.response) {
                if (ev.response.id) responseId = ev.response.id;
                if (ev.response.usage) usage = ev.response.usage;
              }
            } catch { /* partial tail line */ }
          }
          done({ outcome: 'success', status: upRes.statusCode, usage, responseId });
        });
        upRes.on('error', (err) => {
          if (!res.writableEnded) res.destroy();
          done({ outcome: 'stream_broken', status: 502, errorCode: err.code || 'upstream_stream_broken' });
        });
      },
    );
    up.on('error', (err) => {
      clearTimeout(timer);
      if (clientAborted || settled) return;
      const status = isTimeoutErr(err) ? 504 : 502;
      done({ outcome: 'failure', failureKind: 'error', status, mapped: { message: isTimeoutErr(err) ? `passthrough upstream timeout after ${TIMEOUT_MS}ms` : `passthrough upstream error: ${err.message}`, type: isTimeoutErr(err) ? 'relay_upstream_timeout' : 'relay_upstream_error', code: err.code || null } });
    });
    if (req.method === 'GET' || !rawBody.length) up.end();
    else up.end(rawBody);
  });
}

// Session-chain stickiness. Approximation, stated plainly: the chain key
// is the request's previous_response_id (each successful response's id is
// remembered against the upstream that served it, so the next request in
// the chain resolves to the same upstream). Clients that send a stable
// session header (session-id / x-session-id) get the same treatment.
// There is no server-side session table to lean on — if the gateway
// restarts, chains re-decide from policy, which PLAN §3.1 tolerates
// (switching is defined at session start; a restart starts fresh).
const stickyChains = new Map();
// responseId -> the previous_response_id it was chained from. Lets the
// difficulty classifier see chain DEPTH (a difficulty signal) instead
// of just chain membership. Same in-memory lifetime as stickyChains.
const responseParent = new Map();
function chainKeyFor(req, body) {
  if (body && typeof body.previous_response_id === 'string' && body.previous_response_id) return 'prev:' + body.previous_response_id;
  const sid = req.headers['session-id'] || req.headers['x-session-id'] || req.headers.session_id;
  if (sid) return 'hdr:' + sid;
  return null;
}
function rememberChain(key, responseId, upstreamId) {
  if (stickyChains.size > 10000) stickyChains.clear();
  if (responseParent.size > 10000) responseParent.clear();
  if (key) stickyChains.set(key, upstreamId);
  if (responseId) {
    stickyChains.set('prev:' + responseId, upstreamId);
    if (key && key.startsWith('prev:')) responseParent.set(responseId, key.slice(5));
  }
}
/** Depth of the previous_response_id chain behind this request (0 = fresh chain). */
function chainDepthFor(body) {
  let depth = 0;
  let cur = body && typeof body.previous_response_id === 'string' ? body.previous_response_id : null;
  const seen = new Set();
  while (cur && !seen.has(cur) && depth < 64) {
    seen.add(cur);
    depth++;
    cur = responseParent.get(cur) || null;
  }
  return depth;
}

/**
 * Working directory for rule matching, best effort: Responses requests
 * do not standardize a cwd field, so Relay checks (in order) a
 * metadata.cwd in the body, the x-relay-cwd header (set by wrappers /
 * tests), and RELAY_DEFAULT_CWD. No cwd simply means no rule matches.
 */
function cwdFor(req, body) {
  if (body && body.metadata && typeof body.metadata.cwd === 'string') return body.metadata.cwd;
  if (req.headers['x-relay-cwd']) return String(req.headers['x-relay-cwd']);
  return process.env.RELAY_DEFAULT_CWD || null;
}

async function handleRouted(req, res, rawBody, startedAt) {
  const requestId = rid('req_');
  let body = null;
  try { body = JSON.parse(rawBody.toString('utf8')); } catch { /* handled below */ }
  const quotas = quotaService.snapshot();
  const chainKey = body ? chainKeyFor(req, body) : null;
  const stickyId = chainKey ? (stickyChains.get(chainKey) || null) : null;
  const cwd = cwdFor(req, body);
  // Difficulty axis: classify before deciding; the verdict (level/score
  // on every attempt line, signals included for explainability) rides
  // along into the routing log.
  const difficulty = body
    ? difficultyEngine.classify(body, { chainDepth: chainDepthFor(body) })
    : { level: 'standard', score: 0, signals: [] };
  const logAttempt = (fields) => logRoute({
    requestId, path: '/v1/responses', mode: 'routed', upstream: null, model: body ? (body.model || null) : null,
    cwd: cwd || null, authPresent: Boolean(req.headers.authorization), ms: Date.now() - startedAt,
    difficulty: { level: difficulty.level, score: difficulty.score, signals: difficulty.signals },
    servedModel: null, ...fields,
  });

  if (!body) {
    logAttempt({ chosen: null, attempt: 0, status: 400, reasonCode: 'initial', error: 'invalid_json' });
    sendError(res, 400, 'invalid JSON body', 'relay_bad_request', 'invalid_json');
    return;
  }

  const decision = routerEngine.decide({
    registry, rules: CONFIG.rules, settings: CONFIG.settings,
    quotas, cwd, stickyUpstreamId: stickyId, difficulty,
  });

  if (decision.blocked) {
    logAttempt({ chosen: null, attempt: 0, status: 403, reasonCode: decision.blocked.reasonCode, quota: null });
    sendError(res, 403, decision.blocked.message, 'relay_sensitive_block', 'sensitive_block');
    return;
  }
  if (!decision.candidates.length) {
    logAttempt({ chosen: null, attempt: 0, status: 503, reasonCode: 'initial', error: 'no_upstreams' });
    sendError(res, 503, 'Relay: no upstreams are configured/enabled.', 'relay_no_upstream', 'no_upstreams');
    return;
  }

  let lastFailureKind = null;
  let lastMapped = null;
  let lastStatus = 502;
  for (let i = 0; i < decision.candidates.length; i++) {
    const { upstream, reason, model: chosenModel } = decision.candidates[i];
    const reasonCode = i === 0 ? (reason || 'initial') : fallbackReasonCode(lastFailureKind);
    const q = quotas[upstream.id] || { remainingPct: null, source: 'unavailable' };
    const quotaSnap = { remainingPct: q.remainingPct, source: q.source, ...(q.resetsAt ? { resetsAt: q.resetsAt } : {}) };
    const target = resolveTarget(upstream);
    // The router picked one specific model of this upstream (by
    // capability); it overrides the upstream's pinned dispatch model.
    if (chosenModel) target.model = chosenModel;
    const servedModel = chosenModel || target.model || (body && body.model) || null;
    let r;
    if (!target.baseUrl) {
      r = { outcome: 'failure', failureKind: 'error', status: 502, mapped: { message: `upstream ${upstream.id} has no baseUrl configured`, type: 'relay_config_error', code: 'missing_base_url' } };
    } else if (upstream.kind === 'passthrough') {
      r = await attemptPassthrough(req, res, rawBody, target.baseUrl);
    } else {
      try {
        r = body.stream
          ? await attemptTranslateStream(res, body, target)
          : await attemptTranslateNonStream(res, body, target);
      } catch (err) {
        const status = isTimeoutErr(err) ? 504 : 502;
        r = { outcome: 'failure', failureKind: 'error', status, mapped: { message: isTimeoutErr(err) ? `upstream timeout after ${TIMEOUT_MS}ms` : `upstream error: ${err.message}`, type: isTimeoutErr(err) ? 'relay_upstream_timeout' : 'relay_upstream_error', code: err.code || null } };
      }
    }

    if (r.outcome === 'success') {
      logAttempt({ chosen: upstream.id, upstream: upstream.id, attempt: i + 1, status: r.status || 200, reasonCode, quota: quotaSnap, usage: r.usage || null, servedModel, ...(decision.sensitive ? { sensitive: true } : {}), ...(decision.underpowered ? { underpowered: true } : {}) });
      rememberChain(chainKey, r.responseId, upstream.id);
      return;
    }
    if (r.outcome === 'client_abort') {
      logAttempt({ chosen: upstream.id, upstream: upstream.id, attempt: i + 1, status: 499, reasonCode: 'client_abort', quota: quotaSnap, servedModel });
      if (!res.writableEnded && !res.headersSent) res.end();
      return;
    }
    if (r.outcome === 'stream_broken') {
      // Bytes already reached the client: no fallback is possible.
      logAttempt({ chosen: upstream.id, upstream: upstream.id, attempt: i + 1, status: 502, reasonCode: 'upstream_error', quota: quotaSnap, error: r.errorCode || 'upstream_stream_broken', servedModel });
      return;
    }
    lastFailureKind = r.failureKind || 'error';
    lastMapped = r.mapped || null;
    lastStatus = r.status || 502;
    // 'invalid' = the request itself is at fault (context-length
    // overflow, malformed request): no other upstream can serve it, so
    // the chain STOPS here instead of burning every remaining candidate,
    // and the upstream's error is returned to the client as-is below.
    // The stop is the salient fact of this attempt, so it owns the
    // log line's reasonCode.
    const stopForInvalid = lastFailureKind === 'invalid';
    logAttempt({ chosen: upstream.id, upstream: upstream.id, attempt: i + 1, status: lastStatus, reasonCode: stopForInvalid ? 'invalid_request_stop' : reasonCode, quota: quotaSnap, error: lastMapped ? lastMapped.code : null, willFallback: !stopForInvalid && i < decision.candidates.length - 1, servedModel });
    if (stopForInvalid) break;
  }
  if (!res.headersSent) {
    sendError(res, lastStatus, lastMapped ? lastMapped.message : 'all upstreams failed', lastMapped ? lastMapped.type : 'relay_upstream_error', lastMapped ? lastMapped.code : null);
  }
}

// ---------------------------------------------------------------------------
// POST /v1/feedback — record + count only (counting lives in ledger.js)
// ---------------------------------------------------------------------------
async function handleFeedback(req, res, rawBody) {
  let body;
  try { body = JSON.parse(rawBody.toString('utf8')); } catch { sendError(res, 400, 'invalid JSON body', 'relay_bad_request', 'invalid_json'); return; }
  if (!body || typeof body.requestId !== 'string' || !body.requestId || !['up', 'down'].includes(body.verdict)) {
    sendError(res, 400, 'feedback requires {requestId: string, verdict: "up" | "down"}', 'relay_bad_request', 'invalid_feedback');
    return;
  }
  const entry = { ts: new Date().toISOString(), requestId: body.requestId, verdict: body.verdict };
  try {
    fs.mkdirSync(path.dirname(FEEDBACK_FILE), { recursive: true });
    fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    sendError(res, 500, `could not record feedback: ${err.message}`, 'relay_internal_error', 'feedback_write_failed');
    return;
  }
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------
async function handleModels(req, res, url, startedAt) {
  if (CONFIG) {
    // Routed mode: the model list is the union of the enabled upstreams'
    // declared models (falling back to their pinned `model` values).
    const ids = [];
    for (const u of registry.enabled()) {
      for (const m of [...u.models.map((x) => x.id), ...(u.model ? [u.model] : [])]) if (!ids.includes(m)) ids.push(m);
    }
    logRoute({ path: '/v1/models', mode: 'routed', upstream: null, model: null, authPresent: Boolean(req.headers.authorization), status: 200, reasonCode: 'initial', ms: Date.now() - startedAt });
    sendJson(res, 200, { object: 'list', data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'relay' })) });
    return;
  }
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
  if (req.method === 'GET' && url.pathname === '/health') { sendJson(res, 200, { ok: true, mode: CONFIG ? 'routed' : MODE, routed: Boolean(CONFIG), upstreams: CONFIG ? registry.enabled().length : null }); return; }
  if (req.method === 'GET' && url.pathname === '/v1/models') { await handleModels(req, res, url, startedAt); return; }
  if (req.method === 'POST' && url.pathname === '/v1/feedback') {
    const rawBody = await readBody(req);
    await handleFeedback(req, res, rawBody);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/responses') {
    const rawBody = await readBody(req);
    if (CONFIG) { await handleRouted(req, res, rawBody, startedAt); return; }
    if (MODE === 'passthrough') {
      let model = null;
      try { model = JSON.parse(rawBody.toString('utf8')).model || null; } catch { /* keep null */ }
      handlePassthrough(req, res, rawBody, startedAt, PASSTHROUGH_URL, model);
    } else await handleTranslate(req, res, rawBody, startedAt);
    return;
  }
  sendError(res, 404, 'not found', 'relay_not_found', 'not_found');
});
server.listen(PORT, HOST, () => logRoute({ event: 'listen', host: HOST, port: PORT, mode: CONFIG ? 'routed' : MODE, logFile: LOG_FILE }));

module.exports = { responsesToChat, chatToResponse, mapUsage, mapUpstreamErrorBody, classifyFailure };
