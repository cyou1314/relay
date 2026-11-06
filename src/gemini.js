'use strict';
/**
 * Gemini upstream adapter (wiring phase, Gemini step) — upstream
 * kind 'gemini'.
 *
 * Wire protocol: Google's Cloud Code backend, the one the Gemini CLI
 * and Antigravity share (verified against the public gemini-cli
 * source; full citations + confidence notes in docs/GEMINI-REPORT.md):
 *   POST https://cloudcode-pa.googleapis.com/v1internal:generateContent
 *   POST https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
 *   Authorization: Bearer <OAuth access token>   (src/gemini-creds.js)
 *   body    { model, project?, user_prompt_id,
 *             request: { contents, systemInstruction?, tools?,
 *                        generationConfig?, session_id? } }
 *   reply   { response: { candidates, usageMetadata, modelVersion },
 *             traceId, ... } — the public AI Studio generateContent
 *           shape WITHOUT the wrapper is the main difference; the
 *           model sits OUTSIDE `request`, and streaming is SSE with
 *           one wrapped response object per event.
 *
 * Integration shape: the gateway's translate machinery (Responses <->
 * Chat translation, streaming state machine, error mapping, fallback
 * classification) is reused unchanged. This module sits exactly where
 * an OpenAI-compatible HTTP call sits for kind 'chat': it accepts the
 * gateway's Chat Completions request and returns a response object
 * with the same surface the attempt functions consume (statusCode,
 * setTimeout, a readable stream of Chat-shaped JSON / Chat SSE). All
 * Gemini specifics — the wrapper, contents conversion, usageMetadata,
 * Google error envelopes — are translated at this boundary:
 *   - non-stream: the Gemini JSON reply becomes one Chat completion.
 *   - stream: a Transform converts Gemini SSE events into Chat SSE
 *     chunks (text deltas, tool-call deltas, a finish chunk, and a
 *     trailing usage chunk when the backend reports usageMetadata).
 *   - errors: Google's {error:{code,message,status}} envelope becomes
 *     the OpenAI envelope, so mapUpstreamErrorBody + classifyFailure
 *     behave exactly as for any other upstream (429 -> quota,
 *     401/403 -> auth, safety finishes -> filtered downstream).
 *   - credential failure (missing/expired/unrefreshable, from
 *     src/gemini-creds.js) becomes a synthetic 401 with an
 *     authentication_error body: the router's fallback_auth semantics
 *     take over and the request is served by the next upstream.
 *
 * Thought parts (parts with thought:true) are reasoning traces: they
 * are NOT surfaced as answer text; their tokens still count through
 * usageMetadata.thoughtsTokenCount (folded into completion tokens and
 * reported as reasoning_tokens, like OpenAI reasoning models).
 */
const { PassThrough, Transform } = require('node:stream');
const crypto = require('node:crypto');

const DEFAULT_API_BASE = 'https://cloudcode-pa.googleapis.com/v1internal';

function apiBaseFor(target) {
  const raw = (target && target.baseUrl) || process.env.RELAY_GEMINI_API_BASE || DEFAULT_API_BASE;
  return String(raw).replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Chat Completions request -> Cloud Code (wrapped Gemini) request
// ---------------------------------------------------------------------------

/** Tool-call arguments (a JSON string in Chat) -> Gemini's args object. */
function argsToObject(argsStr) {
  if (argsStr && typeof argsStr === 'object') return argsStr;
  try {
    const v = JSON.parse(String(argsStr || ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { text: String(argsStr || '') };
  }
}

/** A Chat tool message's content -> Gemini functionResponse.response (must be an object). */
function toolOutputToResponse(content) {
  if (content && typeof content === 'object' && !Array.isArray(content)) return content;
  try {
    const v = JSON.parse(String(content || ''));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    return { output: v };
  } catch {
    return { output: typeof content === 'string' ? content : JSON.stringify(content ?? '') };
  }
}

function chatToGeminiBody(chatReq, { model, project } = {}) {
  const systemTexts = [];
  const contents = [];
  const callNameById = new Map(); // Chat tool_call id -> function name (for tool results)
  for (const m of (chatReq && chatReq.messages) || []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system') {
      if (typeof m.content === 'string' && m.content) systemTexts.push(m.content);
      continue;
    }
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: typeof m.content === 'string' ? m.content : '' }] });
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      if (typeof m.content === 'string' && m.content) parts.push({ text: m.content });
      for (const tc of m.tool_calls || []) {
        if (!tc || !tc.function) continue;
        if (tc.id) callNameById.set(tc.id, tc.function.name);
        parts.push({ functionCall: { name: tc.function.name, args: argsToObject(tc.function.arguments) } });
      }
      if (parts.length) contents.push({ role: 'model', parts });
      continue;
    }
    if (m.role === 'tool') {
      // Gemini carries function results as functionResponse parts
      // under role 'user' (its contents only alternate user/model).
      const name = callNameById.get(m.tool_call_id) || 'unknown_tool';
      contents.push({ role: 'user', parts: [{ functionResponse: { name, response: toolOutputToResponse(m.content) } }] });
      continue;
    }
  }
  // Merge consecutive same-role turns: Gemini expects user/model
  // alternation (parallel tool calls and parallel tool results arrive
  // as several same-role Chat messages in a row).
  const merged = [];
  for (const c of contents) {
    const last = merged[merged.length - 1];
    if (last && last.role === c.role) last.parts.push(...c.parts);
    else merged.push({ role: c.role, parts: [...c.parts] });
  }
  const inner = { contents: merged };
  if (systemTexts.length) inner.systemInstruction = { parts: systemTexts.map((t) => ({ text: t })) };
  const gc = {};
  if (chatReq.temperature != null) gc.temperature = chatReq.temperature;
  if (chatReq.top_p != null) gc.topP = chatReq.top_p;
  if (chatReq.max_tokens != null) gc.maxOutputTokens = chatReq.max_tokens;
  if (Object.keys(gc).length) inner.generationConfig = gc;
  if (Array.isArray(chatReq.tools) && chatReq.tools.length) {
    inner.tools = [{
      functionDeclarations: chatReq.tools
        .filter((t) => t && t.type === 'function' && t.function && t.function.name)
        .map((t) => ({
          name: t.function.name,
          description: t.function.description || '',
          parameters: t.function.parameters || { type: 'object', properties: {} },
        })),
    }];
  }
  const body = { model: model || (chatReq && chatReq.model) || null, request: inner };
  if (project) body.project = project;
  body.user_prompt_id = crypto.randomUUID();
  return body;
}

// ---------------------------------------------------------------------------
// Cloud Code (wrapped Gemini) reply -> Chat Completions shape
// ---------------------------------------------------------------------------

function mapFinishReason(fr) {
  switch (fr) {
    case 'STOP': return 'stop';
    case 'MAX_TOKENS': return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
    case 'SPII': return 'content_filter';
    default: return fr ? 'stop' : null;
  }
}

function usageFromGemini(u) {
  if (!u || typeof u !== 'object') return null;
  const prompt = Number(u.promptTokenCount || 0);
  const candidates = Number(u.candidatesTokenCount || 0);
  const thoughts = Number(u.thoughtsTokenCount || 0);
  const completion = candidates + thoughts;
  const total = Number(u.totalTokenCount || 0) || (prompt + completion);
  if (!prompt && !completion && !total) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    prompt_tokens_details: { cached_tokens: Number(u.cachedContentTokenCount || 0) },
    completion_tokens_details: { reasoning_tokens: thoughts },
  };
}

/** Parts of one candidate -> { texts: [...], calls: [{name, args}] } (thought parts skipped). */
function partsToTextAndCalls(parts) {
  const texts = [];
  const calls = [];
  for (const p of parts || []) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.text === 'string' && p.text && !p.thought) texts.push(p.text);
    else if (p.functionCall && typeof p.functionCall.name === 'string') {
      calls.push({ name: p.functionCall.name, args: p.functionCall.args || {} });
    }
  }
  return { texts, calls };
}

function geminiToChatCompletion(caRes, model) {
  const res = (caRes && typeof caRes === 'object' ? (caRes.response || caRes) : {}) || {};
  const cand = (Array.isArray(res.candidates) && res.candidates[0]) || null;
  const { texts, calls } = partsToTextAndCalls(cand && cand.content && cand.content.parts);
  const message = { role: 'assistant', content: texts.length ? texts.join('') : (calls.length ? null : '') };
  if (calls.length) {
    message.tool_calls = calls.map((c) => ({
      id: 'call_' + crypto.randomBytes(8).toString('hex'),
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    }));
  }
  let finish = cand ? mapFinishReason(cand.finishReason) : null;
  if (!finish && res.promptFeedback && res.promptFeedback.blockReason) finish = 'content_filter';
  if (calls.length && (finish === 'stop' || !finish)) finish = 'tool_calls';
  const out = {
    id: 'chatcmpl-' + crypto.randomBytes(12).toString('hex'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: res.modelVersion || model || null,
    choices: [{ index: 0, message, finish_reason: finish || 'stop' }],
  };
  const usage = usageFromGemini(res.usageMetadata);
  if (usage) out.usage = usage;
  return out;
}

/**
 * Transform stream: Gemini SSE (one wrapped response JSON per event)
 * in, Chat Completions SSE chunks out. Mirrors the public backend's
 * own framing (lines starting 'data:', blank line ends an event), so
 * both '\n' and '\r\n' framings parse.
 */
function createGeminiStreamTransform(model) {
  const chatId = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);
  let buf = '';
  let dataLines = [];
  let toolCount = 0;
  let sawToolCall = false;
  let usage = null;
  let finalFinish = null;

  const chunk = (delta, finishReason, withUsage) => {
    const c = { id: chatId, object: 'chat.completion.chunk', created, model: model || null, choices: [{ index: 0, delta, finish_reason: finishReason || null }] };
    if (withUsage && usage) { c.choices = []; c.usage = usage; }
    return `data: ${JSON.stringify(c)}\n\n`;
  };

  function convertEvent(jsonText, push) {
    let evt;
    try { evt = JSON.parse(jsonText); } catch { return; }
    const res = (evt && typeof evt === 'object' ? (evt.response || evt) : null);
    if (!res) return;
    if (res.usageMetadata) usage = usageFromGemini(res.usageMetadata) || usage;
    const cand = (Array.isArray(res.candidates) && res.candidates[0]) || null;
    if (cand) {
      const { texts, calls } = partsToTextAndCalls(cand.content && cand.content.parts);
      const delta = {};
      if (texts.length) delta.content = texts.join('');
      if (calls.length) {
        sawToolCall = true;
        delta.tool_calls = calls.map((c) => ({
          index: toolCount++,
          id: 'call_' + crypto.randomBytes(8).toString('hex'),
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        }));
      }
      if (delta.content || delta.tool_calls) push(chunk(delta, null, false));
      if (cand.finishReason) finalFinish = mapFinishReason(cand.finishReason);
    }
    if (res.promptFeedback && res.promptFeedback.blockReason && !finalFinish) finalFinish = 'content_filter';
  }

  const transform = new Transform({
    decodeStrings: false,
    transform(data, _enc, cb) {
      buf += typeof data === 'string' ? data : data.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) { dataLines.push(line.slice(5).trim()); continue; }
        if (line === '' && dataLines.length) {
          convertEvent(dataLines.join('\n'), (s) => transform.push(s));
          dataLines = [];
        }
        // other lines (comments, event:, id:) are ignored, like the
        // reference client's parser does.
      }
      cb();
    },
    flush(cb) {
      if (dataLines.length) {
        convertEvent(dataLines.join('\n'), (s) => transform.push(s));
        dataLines = [];
      }
      let finish = finalFinish || 'stop';
      if (sawToolCall && finish === 'stop') finish = 'tool_calls';
      transform.push(chunk({}, finish, false));
      if (usage) transform.push(chunk(null, null, true));
      cb();
    },
  });
  return transform;
}

// ---------------------------------------------------------------------------
// Transport: the Chat-call surface the gateway's attempt functions use
// ---------------------------------------------------------------------------

function openAiErrorBody(message, type, code) {
  return Buffer.from(JSON.stringify({ error: { message, type, param: null, code } }));
}

/** Google error envelope -> OpenAI envelope (status preserved by the caller). */
function googleErrorToOpenAiBody(status, raw) {
  let message = `gemini upstream returned HTTP ${status}`;
  let type = status === 429 ? 'rate_limit_error' : status >= 500 ? 'server_error' : 'invalid_request_error';
  let code = `gemini_${status}`;
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    const e = parsed && parsed.error;
    if (e && typeof e.message === 'string' && e.message) message = e.message;
    if (e && typeof e.status === 'string' && e.status) {
      code = e.status.toLowerCase();
      if (e.status === 'UNAUTHENTICATED' || e.status === 'PERMISSION_DENIED') type = 'authentication_error';
      else if (e.status === 'RESOURCE_EXHAUSTED') type = 'rate_limit_error';
      else if (e.status === 'INVALID_ARGUMENT') type = 'invalid_request_error';
    }
  } catch { /* keep defaults */ }
  return openAiErrorBody(message, type, code);
}

/** A buffered synthetic response with the surface the attempt layer consumes. */
function syntheticResponse(statusCode, bodyBuf) {
  const s = new PassThrough();
  s.statusCode = statusCode;
  s.headers = { 'content-type': 'application/json' };
  s.complete = true;
  s.setTimeout = () => s;
  process.nextTick(() => { if (!s.destroyed) s.end(bodyBuf); });
  return s;
}

/** A streaming synthetic response wrapping the converted Chat SSE. */
function syntheticStreamResponse(source, model) {
  const converter = createGeminiStreamTransform(model);
  const out = new PassThrough();
  out.statusCode = 200;
  out.headers = { 'content-type': 'text/event-stream' };
  out.complete = false;
  // The attempt layer arms its body timeout through setTimeout(ms, cb)
  // (armBodyTimeout in gateway.js); on a synthetic stream that must be
  // real, not a no-op — a stalled Gemini body times out exactly like a
  // stalled Chat body.
  out.setTimeout = (ms, cb) => {
    const t = setTimeout(() => {
      const err = new Error(`gemini upstream body timeout after ${ms}ms`);
      err.code = 'RELAY_TIMEOUT';
      out.destroy(err);
      if (typeof cb === 'function') cb();
    }, ms);
    if (typeof t.unref === 'function') t.unref();
    out.on('close', () => clearTimeout(t));
    return out;
  };
  converter.on('end', () => { out.complete = true; });
  source.on('error', (err) => out.destroy(err));
  converter.on('error', (err) => out.destroy(err));
  out.on('close', () => { if (!source.destroyed) source.destroy(); if (!converter.destroyed) converter.destroy(); });
  source.pipe(converter).pipe(out);
  return out;
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * createGeminiTransport({ credsService, postJson })
 *   credsService: src/gemini-creds.js service (getAccessToken()).
 *   postJson(url, payloadBuffer, headers): the gateway's own
 *     timeout+retry POST (upstreamPostWithRetry) — injected so this
 *     module stays free of gateway internals, and so tests can point
 *     the transport at a local mock via the upstream's baseUrl.
 *
 * call(chatReq, { stream, model, project, baseUrl }) resolves with a
 * response stream in the Chat surface described above. Transport-level
 * exceptions (connect/timeout) are thrown, exactly like the 'chat'
 * kind, so the attempt layer maps them to 502/504 failures.
 */
function createGeminiTransport({ credsService, postJson }) {
  async function call(chatReq, { stream = false, model = null, project = null, baseUrl = null } = {}) {
    let token;
    try {
      token = await credsService.getAccessToken();
    } catch (err) {
      return syntheticResponse(401, openAiErrorBody(
        `Gemini credentials unavailable (${err.code || 'gemini_creds'}): ${err.message}`,
        'authentication_error',
        'gemini_credentials_unavailable',
      ));
    }
    const geminiBody = chatToGeminiBody(chatReq, { model: model || chatReq.model, project });
    const payload = Buffer.from(JSON.stringify(geminiBody));
    const base = apiBaseFor({ baseUrl });
    const url = base + (stream ? ':streamGenerateContent?alt=sse' : ':generateContent');
    const headers = {
      'content-type': 'application/json',
      'content-length': payload.length,
      accept: stream ? 'text/event-stream' : 'application/json',
      authorization: `Bearer ${token}`,
    };
    const upRes = await postJson(url, payload, headers);
    if (upRes.statusCode < 200 || upRes.statusCode >= 300) {
      const raw = await readAll(upRes);
      return syntheticResponse(upRes.statusCode, googleErrorToOpenAiBody(upRes.statusCode, raw));
    }
    if (!stream) {
      const raw = await readAll(upRes);
      let parsed;
      try { parsed = JSON.parse(raw.toString('utf8')); } catch {
        return syntheticResponse(502, openAiErrorBody('Gemini upstream returned malformed JSON', 'server_error', 'gemini_bad_response'));
      }
      const chat = geminiToChatCompletion(parsed, model || chatReq.model);
      return syntheticResponse(200, Buffer.from(JSON.stringify(chat)));
    }
    return syntheticStreamResponse(upRes, model || chatReq.model);
  }
  return { call };
}

module.exports = {
  createGeminiTransport,
  chatToGeminiBody,
  geminiToChatCompletion,
  createGeminiStreamTransform,
  usageFromGemini,
  DEFAULT_API_BASE,
};
