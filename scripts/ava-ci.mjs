// Quiet, CI-friendly wrapper around `ava`.
//
// This wraps ava and prints only:
//   - failures, as soon as they are parsed;
//   - a periodic heartbeat so a long suite isn't silent;
//   - a one-line per-package summary.
//
// It also writes a machine-readable `<pkg>.json` that scripts/ci-run-summary.mjs
// aggregates (across all matrix cells) into the single GitHub Actions job summary.
//
// Usage (from a package's `test` script): node ../../scripts/ava-ci.mjs <ava args>

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

const cwd = process.cwd();

function findWorkspaceRoot(start) {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start; // fall back to cwd if not found
    dir = parent;
  }
}

const root = findWorkspaceRoot(cwd);

let pkgName = basename(cwd);
try {
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  if (pkg.name) pkgName = pkg.name;
} catch {
  // keep directory-name fallback
}
const safeName = pkgName.replace(/[^a-z0-9._-]+/gi, '_');

const resultsDir = process.env.TEST_RESULTS_DIR || join(root, '.test-results');
mkdirSync(resultsDir, { recursive: true });
const logPath = join(resultsDir, `${safeName}.log`);
const jsonPath = join(resultsDir, `${safeName}.json`);
const logStream = createWriteStream(logPath);

// ANSI colors: honor NO_COLOR, and enable in a terminal or CI (GitHub is non-TTY
// but renders ANSI). Stay plain when output is redirected to a file/pipe locally.
const useColor = !process.env.NO_COLOR && (process.stdout.isTTY || !!process.env.CI || !!process.env.FORCE_COLOR);
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const green = (s) => c('32', s);
const red = (s) => c('31', s);
const dim = (s) => c('2', s);

function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

// --- TAP parsing state ---
let pass = 0;
let fail = 0;
let skip = 0;
let todo = 0;
const failures = [];
let pendingFailure = null; // { title, diag: [], started } while consuming a diagnostic block

function dedent(lines) {
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min));
}

function flushPendingFailure() {
  if (!pendingFailure) return;
  const diag = dedent(pendingFailure.diag);
  const text = diag.join('\n');
  // `at:` (source location) and `message:` are the two most useful fields for the
  // compact table; the full diagnostic block is kept verbatim for the detail view.
  const messageMatch = text.match(/^message:\s*(.+)$/m);
  const atMatch = text.match(/^at:\s*(.+)$/m);
  const nameMatch = text.match(/^name:\s*(.+)$/m);
  const assertionMatch = text.match(/^assertion:\s*(.+)$/m);
  const unquote = (s) => s.trim().replace(/^['"]|['"]$/g, '');
  const message = messageMatch
    ? unquote(messageMatch[1])
    : [nameMatch && nameMatch[1].trim(), assertionMatch && `(${assertionMatch[1].trim()})`].filter(Boolean).join(' ');
  const at = atMatch ? unquote(atMatch[1]).replace(/^file:\/\//, '') : '';
  failures.push({ title: pendingFailure.title, message, at, diagnostic: text });

  // Print the failure live so it surfaces the moment it happens.
  process.stdout.write(`${red('✗')} ${pendingFailure.title}\n`);
  for (const l of diag) process.stdout.write(dim(`    ${l}\n`));
  pendingFailure = null;
}

const TEST_LINE = /^(ok|not ok) (\d+) - (.*)$/;

function handleTapLine(line) {
  // A diagnostic block immediately follows a `not ok` line and is written
  // atomically by ava, so worker output can't interleave inside it. The block is
  // delimited by `  ---` / `  ...`; some `not ok` lines have no block at all.
  if (pendingFailure) {
    const trimmed = line.trim();
    if (!pendingFailure.started) {
      if (trimmed === '---') {
        pendingFailure.started = true;
        return;
      }
      // No diagnostic block for this failure; flush and reprocess the line.
      flushPendingFailure();
    } else {
      if (trimmed === '...') {
        flushPendingFailure();
      } else {
        pendingFailure.diag.push(line);
      }
      return;
    }
  }

  const m = TEST_LINE.exec(line);
  if (!m) return;
  const [, status, , rawTitle] = m;

  // Directives: `... # SKIP` / `... # TODO`
  const skipMatch = / # SKIP\s*$/.exec(rawTitle);
  const todoMatch = / # TODO\s*$/.exec(rawTitle);
  const title = rawTitle.replace(/ # (SKIP|TODO)\s*$/, '').trim();

  if (skipMatch) {
    skip++;
    return;
  }
  if (todoMatch) {
    todo++;
    return;
  }
  if (status === 'ok') {
    pass++;
    return;
  }
  // not ok -> begin buffering its diagnostic block (may or may not be present)
  fail++;
  pendingFailure = { title, diag: [], started: false };
}

// --- line-buffered stdout parsing ---
let buffer = '';
function consume(chunk) {
  logStream.write(chunk);
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    handleTapLine(line);
  }
}

const started = Date.now();

// Heartbeat so a long suite (packages/test can run ~5min) isn't silent.
const heartbeat = setInterval(() => {
  const done = pass + fail + skip;
  const elapsed = fmtDuration(Date.now() - started);
  process.stdout.write(dim(`  … ${done} tests, ${fail} failure${fail === 1 ? '' : 's'} (${elapsed})\n`));
}, 30_000);
if (typeof heartbeat.unref === 'function') heartbeat.unref();

// Launch ava under the requested runtime. Default is Node (via npx). When
// AVA_RUNTIME=bun, run ava under Bun — mirroring `bun run -b ava` — so the Bun test
// matrix still exercises the SDK under Bun while sharing this wrapper's quiet output.
const forwarded = process.argv.slice(2);
const [cmd, cmdArgs] =
  process.env.AVA_RUNTIME === 'bun'
    ? ['bun', ['run', '-b', 'ava', '--tap', ...forwarded]]
    : [process.platform === 'win32' ? 'npx.cmd' : 'npx', ['ava', '--tap', ...forwarded]];
const child = spawn(cmd, cmdArgs, {
  cwd,
  shell: process.platform === 'win32',
  stdio: ['inherit', 'pipe', 'pipe'],
});

child.stdout.setEncoding('utf8');
child.stdout.on('data', consume);
// ava writes some diagnostics to stderr; archive but don't parse for TAP.
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => logStream.write(chunk));

function finish(exitCode) {
  clearInterval(heartbeat);
  if (buffer.length) handleTapLine(buffer);
  flushPendingFailure();

  const durationMs = Date.now() - started;
  const result = { package: pkgName, pass, fail, skip, todo, durationMs, exitCode, failures, logPath };

  logStream.end();
  try {
    writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  } catch {
    // non-fatal: summary aggregation just won't include this package
  }

  const relLog = relative(root, logPath);
  const parts = [`${pass} passed`];
  if (skip) parts.push(`${skip} skipped`);
  if (todo) parts.push(`${todo} todo`);
  const counts = parts.join(', ');
  const duration = dim(`(${fmtDuration(durationMs)})`);

  const succeeded = exitCode === 0 && fail === 0;
  if (succeeded) {
    process.stdout.write(`${green('✓')} ${pkgName}  ${counts}  ${duration}  ${dim(`→ ${relLog}`)}\n`);
  } else {
    const failCount = fail || 'unknown';
    process.stdout.write(`${red('✗')} ${pkgName}  ${red(`${failCount} FAILED`)}, ${counts}  ${duration}\n`);
    // A non-zero exit with no parsed failures means ava crashed (bad glob, syntax
    // error, process.exit, timeout). Surface the tail of the log so it's findable.
    if (fail === 0) {
      const tail = readFileSync(logPath, 'utf8').split('\n').slice(-40).join('\n');
      process.stdout.write(dim(`  ava exited ${exitCode} with no test failures — tail of ${relLog}:\n`));
      process.stdout.write(`${tail}\n`);
    }
    process.stdout.write(dim(`  full log: ${relLog}\n`));
  }

  process.exit(succeeded ? 0 : exitCode || 1);
}

child.on('error', (err) => {
  logStream.write(`\nFailed to spawn ava: ${err.stack || err}\n`);
  finish(1);
});
child.on('close', (code) => finish(code ?? 1));
