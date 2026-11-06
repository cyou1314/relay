'use strict';
/**
 * Gemini OAuth credential layer (wiring phase, Gemini step).
 *
 * The Gemini pool rides the same Google account sign-in as the Gemini
 * CLI / Antigravity family: an OAuth2 credential file in the Gemini
 * CLI's `oauth_creds.json` shape —
 *   { access_token, refresh_token, scope, token_type, expiry_date }
 * with `expiry_date` in unix MILLISECONDS (the google-auth-library
 * `Credentials` JSON; verified against the public gemini-cli source,
 * packages/core/src/code_assist/oauth2.ts, and its documented file
 * location ~/.gemini/oauth_creds.json — see docs/GEMINI-REPORT.md).
 *
 * This module only READS that file and refreshes the access token
 * against Google's token endpoint when it is expired (or inside the
 * 60 s skew window). It never starts a sign-in flow: the interactive
 * browser authorization happens with the owner present (checklist in
 * docs/GEMINI-REPORT.md). Token values live in process memory and in
 * the credential file itself — they are never logged, never returned
 * by any API, and never written anywhere else.
 *
 * Refresh: POST https://oauth2.googleapis.com/token with
 * grant_type=refresh_token (the standard installed-app exchange, the
 * same one google-auth-library performs). The OAuth client is the
 * Gemini CLI's public installed-app client (its source states the
 * embedded secret is not treated as a secret for installed apps);
 * Relay nevertheless does NOT hardcode the secret: the client id
 * defaults to the Gemini CLI's public one, and the secret is taken
 * from env RELAY_GEMINI_OAUTH_CLIENT_SECRET when set (the token
 * endpoint accepts the refresh exchange for this client with the id
 * alone in some flows — whether the secret is REQUIRED is on the
 * unverified list in docs/GEMINI-REPORT.md, to be settled at the
 * in-person authorization step; both env overrides exist so that step
 * needs no code change).
 *
 * Failure contract: every failure is a thrown Error carrying a stable
 * `.code` ('gemini_creds_missing' | 'gemini_creds_invalid' |
 * 'gemini_creds_expired' | 'gemini_refresh_failed'). The Gemini
 * transport turns any of them into a synthetic 401 for that upstream
 * only, so the router's existing fallback_auth semantics take over —
 * a dead Gemini credential can never block the other upstreams.
 *
 * The HTTP layer is injectable (httpPost) and the clock too (nowFn),
 * exactly like the codex-usage source in src/quota.js; all tests run
 * against fakes — no real Google request is ever made by this module's
 * test coverage.
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const os = require('node:os');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Public installed-app OAuth client id of the Gemini CLI
// (google-gemini/gemini-cli, packages/core/src/code_assist/oauth2.ts).
const DEFAULT_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const EXPIRY_SKEW_MS = 60_000;
const REFRESH_TIMEOUT_MS = 10_000;
// When a credential file carries no usable expiry, trust its access
// token only briefly instead of forever (the real file format always
// carries expiry_date, so this is a corner-case guard).
const UNKNOWN_EXPIRY_TRUST_MS = 5 * 60_000;

function credsError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Default form POST to the token endpoint (injectable for tests). */
function defaultHttpPost(url, bodyString) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      {
        method: 'POST', hostname: target.hostname, port: target.port || 443,
        path: target.pathname + target.search,
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(bodyString) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.setTimeout(REFRESH_TIMEOUT_MS, () => req.destroy(new Error('gemini token request timed out')));
    req.on('error', reject);
    req.end(bodyString);
  });
}

function createGeminiCredsService({ credsPath, httpPost, nowFn, clientId, clientSecret } = {}) {
  const post = typeof httpPost === 'function' ? httpPost : defaultHttpPost;
  const now = typeof nowFn === 'function' ? nowFn : Date.now;
  const filePath = () => credsPath || process.env.RELAY_GEMINI_CREDS || path.join(os.homedir(), '.gemini', 'oauth_creds.json');
  const cid = () => clientId || process.env.RELAY_GEMINI_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID;
  const csecret = () => (clientSecret !== undefined ? clientSecret : (process.env.RELAY_GEMINI_OAUTH_CLIENT_SECRET || null));

  let cached = null; // { accessToken, refreshToken, expiryMs }
  let inflight = null;

  function parseCreds(raw, sourceLabel) {
    if (!raw || typeof raw !== 'object') {
      throw credsError('gemini_creds_invalid', `Gemini credentials in ${sourceLabel} are not a JSON object`);
    }
    const accessToken = typeof raw.access_token === 'string' && raw.access_token ? raw.access_token : null;
    const refreshToken = typeof raw.refresh_token === 'string' && raw.refresh_token ? raw.refresh_token : null;
    if (!accessToken && !refreshToken) {
      throw credsError('gemini_creds_invalid', `Gemini credentials in ${sourceLabel} carry neither access_token nor refresh_token`);
    }
    let expiryMs = null;
    if (Number.isFinite(Number(raw.expiry_date)) && Number(raw.expiry_date) > 0) expiryMs = Number(raw.expiry_date);
    else if (typeof raw.expiry === 'string') { const t = Date.parse(raw.expiry); if (Number.isFinite(t)) expiryMs = t; }
    return { accessToken, refreshToken, expiryMs, raw };
  }

  function loadFromFile() {
    const p = filePath();
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch {
      throw credsError('gemini_creds_missing', `Gemini credentials file not found at ${p} (set RELAY_GEMINI_CREDS; sign-in happens with the owner present)`);
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      throw credsError('gemini_creds_invalid', `Gemini credentials file at ${p} is not valid JSON`);
    }
    return parseCreds(parsed, p);
  }

  async function refresh(creds) {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: cid(),
    });
    const sec = csecret();
    if (sec) form.set('client_secret', sec);
    let resp;
    try {
      resp = await post(TOKEN_URL, form.toString());
    } catch (err) {
      throw credsError('gemini_refresh_failed', `Gemini token refresh request failed: ${err.message}`);
    }
    if (!resp || resp.status !== 200) {
      // The body may name the failure (invalid_grant etc.) — its TEXT is
      // safe to surface; it never contains token values.
      throw credsError('gemini_refresh_failed', `Gemini token refresh answered HTTP ${resp ? resp.status : 'none'}`);
    }
    let json;
    try { json = JSON.parse(resp.body); } catch {
      throw credsError('gemini_refresh_failed', 'Gemini token refresh returned malformed JSON');
    }
    if (!json || typeof json.access_token !== 'string' || !json.access_token) {
      throw credsError('gemini_refresh_failed', 'Gemini token refresh returned no access_token');
    }
    const fresh = {
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : creds.refreshToken,
      expiryMs: Number.isFinite(Number(json.expires_in)) && Number(json.expires_in) > 0
        ? now() + Number(json.expires_in) * 1000
        : now() + 3600_000,
    };
    // Persist back into the credential file (same behavior as the
    // Gemini CLI / google-auth-library 'tokens' event): merge, keep
    // every other field, best effort — a read-only file must not fail
    // an otherwise successful refresh.
    try {
      const merged = { ...(creds.raw || {}), access_token: fresh.accessToken, refresh_token: fresh.refreshToken, expiry_date: fresh.expiryMs };
      fs.writeFileSync(filePath(), JSON.stringify(merged, null, 2));
    } catch { /* best effort */ }
    return fresh;
  }

  /**
   * A usable access token: the file's own while it is fresh, a
   * refreshed one when it is expired and a refresh token exists.
   * Throws a coded credsError otherwise (see the module header for the
   * failure contract).
   */
  async function getAccessToken() {
    if (cached && cached.expiryMs != null && cached.expiryMs - now() > EXPIRY_SKEW_MS) return cached.accessToken;
    if (inflight) return inflight;
    inflight = (async () => {
      const creds = loadFromFile();
      if (creds.accessToken && creds.expiryMs != null && creds.expiryMs - now() > EXPIRY_SKEW_MS) {
        cached = creds;
        return creds.accessToken;
      }
      if (creds.accessToken && creds.expiryMs == null) {
        // No expiry recorded: trust the token for a short window.
        cached = { ...creds, expiryMs: now() + UNKNOWN_EXPIRY_TRUST_MS };
        return creds.accessToken;
      }
      if (!creds.refreshToken) {
        throw credsError('gemini_creds_expired', 'Gemini access token is expired and the credentials file has no refresh_token');
      }
      const fresh = await refresh(creds);
      cached = fresh;
      return fresh.accessToken;
    })();
    try { return await inflight; } finally { inflight = null; }
  }

  return { getAccessToken, credsPath: filePath, TOKEN_URL };
}

module.exports = { createGeminiCredsService, TOKEN_URL, DEFAULT_CLIENT_ID };
