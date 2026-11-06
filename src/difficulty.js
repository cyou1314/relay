'use strict';
/**
 * Task-difficulty classifier (difficulty axis, v1 — pure heuristics,
 * zero external calls). AutoRouter routes on task complexity as well as
 * on quota/price; Relay v1 estimates complexity from the Responses
 * request body alone and — crucially — returns the evidence with the
 * verdict, so every routing decision that cites a difficulty level can
 * be explained from the log line's signals.
 *
 *   classify(body, { chainDepth }) -> { level, score, signals }
 *     level:  'light' | 'standard' | 'heavy'
 *     score:  additive points from the signals below
 *     signals: human-readable list of what fired (e.g. 'input_tokens~9200:+2')
 *
 * Scoring bands (points):
 *   score <= 1 -> light · 2..4 -> standard · >= 5 -> heavy
 *
 * Calibration notes: a bare chat turn ('say hello', no tools) scores 0.
 * A normal agent turn (a few k tokens of context, a handful of function
 * definitions) lands at 2–3 = standard. Heavy needs several independent
 * signals to agree (very long input, code/diff payloads, explicit high
 * reasoning effort, a deep chain) — no single signal can push a request
 * to heavy on its own except a truly huge input. Thresholds are v1
 * guesses, deliberately conservative; DIFFICULTY-REPORT.md §1 lists them
 * and §5 sketches the v2 plan (a cheap judge model calibrating these
 * heuristics once real credentials land).
 */

// --- thresholds (constants; see header for the calibration rationale) ---
const TOKEN_BANDS = [ // [minEstimatedTokens, points] — highest matching band wins
  [64000, 4], [24000, 3], [8000, 2], [2000, 1],
];
const CHARS_PER_TOKEN = 4; // rough English/code average; CJK is denser, so CJK-heavy input is UNDERestimated (safe direction: it can only under-rate difficulty, never inflate it)
const TOOLS_COUNT_BANDS = [[10, 1], [4, 1]]; // >=4 tools: +1 (cap reached at +1; count alone is a weak signal)
const TOOLS_DEF_CHARS = 6000; // serialized tool definitions beyond this: +1 (big schemas = real agent work)
const CODE_OR_STRUCTURED_POINTS = 2; // fenced code, a unified diff, or a large JSON payload in the input
const LARGE_JSON_CHARS = 4000;
const EFFORT_POINTS = { medium: 1, high: 2, xhigh: 2 }; // explicit reasoning.effort is the client's own difficulty claim — trust it
const CHAIN_BANDS = [[8, 2], [3, 1]]; // deep previous_response_id chains: accumulated context & state
const HEAVY_MIN = 5;
const STANDARD_MIN = 2;

const LEVELS = ['light', 'standard', 'heavy'];
const LEVEL_RANK = { light: 0, standard: 1, heavy: 2 };

/** Extract a flat text view of a Responses `input` (string or item array). */
function inputText(input) {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  const parts = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.content === 'string') parts.push(item.content);
    else if (Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c && typeof c.text === 'string') parts.push(c.text);
        else if (c && typeof c.input_text === 'string') parts.push(c.input_text);
      }
    }
    if (typeof item.output === 'string') parts.push(item.output); // function_call_output
    if (typeof item.arguments === 'string') parts.push(item.arguments); // function_call args
  }
  return parts.join('\n');
}

const CODE_HINTS = [
  /```/, // fenced code block
  /^diff --git /m, // git diff header
  /^--- a\//m, /^@@ -\d+/m, // unified diff hunks
];

function hasCodeOrStructured(text) {
  if (CODE_HINTS.some((re) => re.test(text))) return true;
  // A large embedded JSON payload (long structured content) counts too.
  const brace = text.indexOf('{');
  if (brace >= 0 && text.length - brace >= LARGE_JSON_CHARS) {
    try { JSON.parse(text.slice(brace)); return true; } catch { /* not clean JSON — ignore */ }
    if (text.slice(brace).includes('":')) return true; // JSON-ish dump even if not strictly parseable
  }
  return false;
}

/**
 * @param {object} body  parsed Responses request body
 * @param {object} [opts]
 * @param {number} [opts.chainDepth]  length of the previous_response_id chain behind this request
 * @returns {{level:string, score:number, signals:string[]}}
 */
function classify(body, opts = {}) {
  const signals = [];
  let score = 0;
  const add = (points, label) => { if (points > 0) { score += points; signals.push(`${label}:+${points}`); } };

  const text = inputText(body && body.input);
  const instructions = body && typeof body.instructions === 'string' ? body.instructions : '';
  const estTokens = Math.ceil((text.length + instructions.length) / CHARS_PER_TOKEN);

  for (const [min, pts] of TOKEN_BANDS) {
    if (estTokens >= min) { add(pts, `input_tokens~${estTokens}`); break; }
  }

  const tools = body && Array.isArray(body.tools) ? body.tools : [];
  if (tools.length) {
    let pts = 0;
    for (const [min, p] of TOOLS_COUNT_BANDS) { if (tools.length >= min) { pts = Math.max(pts, p); } }
    add(pts, `tools=${tools.length}`);
    let defChars = 0;
    try { defChars = JSON.stringify(tools).length; } catch { /* unserializable tools: count only */ }
    if (defChars >= TOOLS_DEF_CHARS) add(1, `tool_defs~${defChars}ch`);
  }

  if (hasCodeOrStructured(text)) add(CODE_OR_STRUCTURED_POINTS, 'code_or_structured_input');

  const effort = body && body.reasoning && typeof body.reasoning.effort === 'string' ? body.reasoning.effort.toLowerCase() : null;
  if (effort && EFFORT_POINTS[effort]) add(EFFORT_POINTS[effort], `reasoning_effort=${effort}`);

  const depth = Number(opts.chainDepth || 0);
  for (const [min, pts] of CHAIN_BANDS) {
    if (depth >= min) { add(pts, `chain_depth=${depth}`); break; }
  }

  const level = score >= HEAVY_MIN ? 'heavy' : score >= STANDARD_MIN ? 'standard' : 'light';
  return { level, score, signals };
}

module.exports = {
  classify, inputText, hasCodeOrStructured,
  LEVELS, LEVEL_RANK, HEAVY_MIN, STANDARD_MIN,
  THRESHOLDS: { TOKEN_BANDS, CHARS_PER_TOKEN, TOOLS_COUNT_BANDS, TOOLS_DEF_CHARS, CODE_OR_STRUCTURED_POINTS, LARGE_JSON_CHARS, EFFORT_POINTS, CHAIN_BANDS },
};
