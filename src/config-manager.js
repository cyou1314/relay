#!/usr/bin/env node
'use strict';
/**
 * Relay config manager — install / restore / status for the Codex provider
 * block in a Codex home's config.toml.
 *
 * Usage:
 *   node src/config-manager.js install --codex-home <dir> [--port 18923]
 *   node src/config-manager.js restore --codex-home <dir>
 *   node src/config-manager.js status  --codex-home <dir>
 * Options: --codex-bin <path> (default: env RELAY_CODEX_BIN, else `codex`).
 *
 * Design (PLAN §3.5 + LEARNING-FROM-AUTOROUTER "managed blocks"):
 *   - install first runs a VERSION GATE: `codex --version` must execute and
 *     print a parseable semver >= MIN_CODEX_VERSION. If the version cannot
 *     be determined, install REFUSES and touches nothing — Relay never edits
 *     a config format it cannot identify.
 *   - The managed content is written as TWO marked blocks, because TOML has
 *     no "return to root table": the one-line `model_provider = "relay"`
 *     selection must live in top-level context (inserted at the very top of
 *     the file), while the `[model_providers.relay]` table is appended at
 *     the end (a new table header is valid in any position). Both blocks
 *     are wrapped in `# BEGIN RELAY MANAGED …` / `# END RELAY MANAGED …`.
 *   - Before any edit, the original file is backed up byte-for-byte to
 *     <codex-home>/config-before-relay.toml (+ a .meta.json sidecar that
 *     records whether config.toml existed). An existing backup is NEVER
 *     overwritten — it holds the pre-Relay original.
 *   - restore writes the backup back verbatim (or removes config.toml if
 *     it did not exist before install) and deletes backup + sidecar, so a
 *     restore is byte-exact by construction.
 *   - If the user's config already selects a different top-level
 *     model_provider, or already defines [model_providers.relay] outside
 *     the managed blocks, install refuses with an explanation rather than
 *     guessing.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const BEGIN_SEL = '# BEGIN RELAY MANAGED (provider selection — do not edit inside Relay managed blocks)';
const END_SEL = '# END RELAY MANAGED (provider selection)';
const BEGIN_DEF = '# BEGIN RELAY MANAGED (provider definition — do not edit inside Relay managed blocks)';
const END_DEF = '# END RELAY MANAGED (provider definition)';
const BACKUP_NAME = 'config-before-relay.toml';
const META_NAME = 'config-before-relay.meta.json';
const MIN_CODEX_VERSION = '0.100.0';
const DEFAULT_PORT = 18923;

function die(message, code = 2) {
  process.stderr.write(`relay config-manager: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, codexHome: null, port: DEFAULT_PORT, codexBin: process.env.RELAY_CODEX_BIN || 'codex' };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--codex-home') opts.codexHome = rest[++i];
    else if (a === '--port') opts.port = Number(rest[++i]);
    else if (a === '--codex-bin') opts.codexBin = rest[++i];
    else die(`unknown argument: ${a}`);
  }
  if (!['install', 'restore', 'status'].includes(command)) die(`unknown command "${command || ''}" — expected install|restore|status`);
  if (!opts.codexHome) die('--codex-home <dir> is required');
  opts.codexHome = path.resolve(opts.codexHome);
  return opts;
}

function semverGte(a, b) {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return true;
}

function codexVersion(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) { resolve(null); return; }
      const m = String(stdout || stderr || '').match(/(\d+)\.(\d+)\.(\d+)/);
      resolve(m ? `${m[1]}.${m[2]}.${m[3]}` : null);
    });
  });
}

function selectionBlock() {
  return `${BEGIN_SEL}\nmodel_provider = "relay"\n${END_SEL}\n`;
}

function definitionBlock(port) {
  return [
    BEGIN_DEF,
    '[model_providers.relay]',
    'name = "Relay (local gateway)"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    'supports_websockets = false',
    END_DEF,
    '',
  ].join('\n');
}

/** Remove both managed blocks (marker line through its END line, inclusive). */
function stripManagedBlocks(content) {
  const lines = content.split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith('# BEGIN RELAY MANAGED')) { skipping = true; continue; }
    if (line.startsWith('# END RELAY MANAGED')) { skipping = false; continue; }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

/**
 * Scan content OUTSIDE the managed blocks for conflicts: a top-level
 * model_provider assignment (before the first table header) or an existing
 * [model_providers.relay] table.
 */
function findConflicts(content) {
  const stripped = stripManagedBlocks(content);
  const conflicts = [];
  let inTable = false;
  for (const rawLine of stripped.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inTable = true;
      if (/^\[\s*model_providers\.relay\s*\]/.test(line)) conflicts.push('config already defines [model_providers.relay] outside the Relay managed blocks');
      continue;
    }
    if (!inTable && /^model_provider\s*=/.test(line)) conflicts.push('config already sets a top-level model_provider outside the Relay managed blocks');
  }
  return conflicts;
}

function atomicWrite(file, data) {
  const tmp = `${file}.relay-tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

async function cmdInstall(opts) {
  const version = await codexVersion(opts.codexBin);
  if (!version) {
    die(`could not determine the Codex version (tried \`${opts.codexBin} --version\`). Refusing to modify config.toml: Relay only edits configs of a Codex version it can identify (>= ${MIN_CODEX_VERSION}). Set --codex-bin or RELAY_CODEX_BIN to the right binary.`);
  }
  if (!semverGte(version, MIN_CODEX_VERSION)) {
    die(`Codex ${version} is too old (Relay requires >= ${MIN_CODEX_VERSION}). Refusing to modify config.toml — update Codex first.`);
  }
  fs.mkdirSync(opts.codexHome, { recursive: true });
  const configPath = path.join(opts.codexHome, 'config.toml');
  const backupPath = path.join(opts.codexHome, BACKUP_NAME);
  const metaPath = path.join(opts.codexHome, META_NAME);
  const existed = fs.existsSync(configPath);
  const original = existed ? fs.readFileSync(configPath) : Buffer.alloc(0);

  const conflicts = findConflicts(original.toString('utf8'));
  if (conflicts.length) die(`refusing to install: ${conflicts.join('; ')}. Remove that setting first, or let Relay manage this Codex home from a clean config.`);

  // Back up the pre-Relay original exactly once.
  if (!fs.existsSync(backupPath)) {
    fs.writeFileSync(backupPath, original);
    fs.writeFileSync(metaPath, JSON.stringify({ existed, backedUpAt: new Date().toISOString() }, null, 2) + '\n');
  }

  // Rebuild: user content (managed blocks stripped) + fresh managed blocks.
  let body = stripManagedBlocks(original.toString('utf8'));
  // Drop blank padding left where blocks used to be at the edges.
  body = body.replace(/^\n+/, '').replace(/\n+$/, '');
  const parts = [selectionBlock().replace(/\n$/, '')];
  if (body) parts.push(body);
  const rebuilt = parts.join('\n') + '\n\n' + definitionBlock(opts.port);
  atomicWrite(configPath, rebuilt);
  process.stdout.write(JSON.stringify({ ok: true, action: 'install', codexVersion: version, config: configPath, backup: backupPath, baseUrl: `http://127.0.0.1:${opts.port}/v1` }) + '\n');
}

function cmdRestore(opts) {
  const configPath = path.join(opts.codexHome, 'config.toml');
  const backupPath = path.join(opts.codexHome, BACKUP_NAME);
  const metaPath = path.join(opts.codexHome, META_NAME);
  if (!fs.existsSync(backupPath)) die('no Relay backup found in this Codex home — nothing to restore.');
  let existed = true;
  if (fs.existsSync(metaPath)) {
    try { existed = JSON.parse(fs.readFileSync(metaPath, 'utf8')).existed !== false; } catch { /* default true */ }
  }
  if (existed) atomicWrite(configPath, fs.readFileSync(backupPath));
  else { try { fs.unlinkSync(configPath); } catch { /* already gone */ } }
  fs.unlinkSync(backupPath);
  try { fs.unlinkSync(metaPath); } catch { /* absent is fine */ }
  process.stdout.write(JSON.stringify({ ok: true, action: 'restore', config: configPath, restoredToExisted: existed }) + '\n');
}

function cmdStatus(opts) {
  const configPath = path.join(opts.codexHome, 'config.toml');
  const backupPath = path.join(opts.codexHome, BACKUP_NAME);
  const configExists = fs.existsSync(configPath);
  const content = configExists ? fs.readFileSync(configPath, 'utf8') : '';
  const managed = content.includes('# BEGIN RELAY MANAGED');
  const m = content.match(/base_url\s*=\s*"(http:\/\/127\.0\.0\.1:\d+\/v1)"/);
  process.stdout.write(JSON.stringify({
    ok: true, action: 'status', codexHome: opts.codexHome, configExists,
    backupExists: fs.existsSync(backupPath), managed,
    provider: managed ? 'relay' : null, baseUrl: managed && m ? m[1] : null,
  }) + '\n');
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === 'install') await cmdInstall(opts);
  else if (opts.command === 'restore') cmdRestore(opts);
  else cmdStatus(opts);
})();
