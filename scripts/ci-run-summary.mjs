// Produces ONE consolidated CI summary answering "did this PR pass, and if not,
// why specifically?" — written to $GITHUB_STEP_SUMMARY (and the console) by the
// `ci-summary` job, which runs after all checks.
//
// Inputs:
//   - NEEDS_JSON: the workflow `needs` context (`${{ toJSON(needs) }}`), i.e.
//     { "<job-id>": { "result": "success|failure|cancelled|skipped" }, ... }
//   - AGG_RESULTS_DIR (default "all-results"): a directory of downloaded
//     `test-logs-*` artifacts, one subdir per matrix cell, each containing the
//     per-package <pkg>.json files written by scripts/ava-ci.mjs.

import { existsSync, readdirSync, readFileSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

// Friendly labels for the top-level checks.
const JOB_LABELS = {
  'compile-native-binaries-debug': 'Compile Native Binaries',
  'integration-tests': 'Integration Tests',
  conventions: 'Lint & Prune',
  'features-tests': 'Features Tests',
  'stress-tests-no-reuse-context': 'Stress Tests (no reuse)',
  'stress-tests-reuse-context': 'Stress Tests (reuse)',
  docs: 'Build Docs',
};

const needs = JSON.parse(process.env.NEEDS_JSON || '{}');
const jobs = Object.entries(needs).map(([id, v]) => ({
  id,
  label: JOB_LABELS[id] || id,
  result: v?.result || 'unknown',
}));

const anyFailed = jobs.some((j) => j.result === 'failure');
const anyCancelled = jobs.some((j) => j.result === 'cancelled');
const passed = !anyFailed && !anyCancelled;

// Recursively collect *.json paths under a directory (robust to whatever nesting
// upload/download-artifact produces, e.g. a preserved `.test-results/` prefix).
function findJsonFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...findJsonFiles(p));
    else if (entry.endsWith('.json')) out.push(p);
  }
  return out;
}

// Per-cell test failures, read from the downloaded artifacts. Each top-level
// subdirectory of AGG_RESULTS_DIR is one matrix cell (artifact `test-logs-<cell>`).
function collectCellFailures() {
  const root = process.env.AGG_RESULTS_DIR || 'all-results';
  const cells = [];
  if (!existsSync(root)) return cells;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const cell = name.replace(/^test-logs-/, '');
    const experimental = /(^|-)bun(-|$)/.test(cell);
    const failures = [];
    for (const file of findJsonFiles(dir)) {
      let r;
      try {
        r = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      const failed = (r.fail || 0) > 0 || r.exitCode !== 0;
      if (!failed) continue;
      if (r.failures && r.failures.length) {
        for (const f of r.failures)
          failures.push({ pkg: r.package, title: f.title, at: f.at, message: f.message, diagnostic: f.diagnostic });
      } else {
        failures.push({ pkg: r.package, title: `${r.fail || '?'} failed (see job log)`, at: '', message: '' });
      }
    }
    if (failures.length) cells.push({ cell, experimental, failures });
  }
  return cells.sort((a, b) => a.cell.localeCompare(b.cell));
}

const cellFailures = collectCellFailures();

// Classify a failure so the reader can tell a likely-flaky timeout from a real
// assertion, a crashed worker, or a test-discovery problem.
function classify(f) {
  const t = `${f.title}\n${f.message || ''}\n${f.diagnostic || ''}`.toLowerCase();
  if (/no tests found/.test(t)) return 'no tests';
  if (/timed out|timeout|no new tests completed within|exceeded/.test(t)) return 'timeout';
  if (
    /exited with a non-zero exit code|exited due to|process\.exit|uncaught|unhandled rejection|sigsegv|sigabrt|segmentation/.test(
      t
    )
  )
    return 'crashed';
  return 'test failure';
}

// `linux-arm-20-reuse` -> `linux-arm · Node 20`. Platform may contain hyphens, so
// peel the trailing reuse + node tokens off the end.
function prettyCell(cell) {
  const parts = cell.split('-');
  parts.pop(); // reuse | noreuse
  const node = parts.pop();
  const platform = parts.join('-');
  return `${platform} · ${node === 'bun' ? 'Bun' : `Node ${node}`}`;
}

const esc = (s) => String(s).replace(/\|/g, '\\|');

// Flatten cell failures into table rows, sorted by cell then test.
const rows = [];
for (const { cell, experimental, failures } of cellFailures) {
  for (const f of failures) {
    const pkg = f.pkg && f.pkg !== '@temporalio/test' ? `${f.pkg.replace('@temporalio/', '')}: ` : '';
    rows.push({
      cell: `${prettyCell(cell)}${experimental ? ' ⚠️' : ''}`,
      type: classify(f),
      test: `${pkg}${f.title}${f.at ? ` (${f.at})` : ''}`,
    });
  }
}
rows.sort((a, b) => a.cell.localeCompare(b.cell) || a.test.localeCompare(b.test));

const failingLabels = jobs.filter((j) => j.result === 'failure').map((j) => j.label);
const otherFailing = failingLabels.filter((l) => l !== 'Integration Tests');
const hasExperimental = cellFailures.some((c) => c.experimental);

// One concise verdict line naming the top-level checks that failed.
function verdictLine() {
  if (passed) return 'All checks passed.';
  if (!anyFailed) return 'Some checks were cancelled and did not complete.';
  const parts = [];
  if (failingLabels.includes('Integration Tests')) {
    const n = cellFailures.length;
    parts.push(`**Integration Tests** — ${n} ${n === 1 ? 'cell' : 'cells'} failed`);
  }
  if (otherFailing.length) parts.push(`**${otherFailing.join('**, **')}** failed`);
  let line = parts.join('; ') + '.';
  if (failingLabels.length === 1 && failingLabels[0] === 'Integration Tests') line += ' All other checks passed.';
  return line;
}

// ---- Markdown ----
const md = [];
md.push(`# ${passed ? '✅ CI passed' : anyFailed ? '❌ CI failed' : '⚪ CI incomplete'}`);
md.push('');
md.push(verdictLine());
md.push('');
if (rows.length) {
  md.push('| Cell | Type | Failing test |');
  md.push('| --- | --- | --- |');
  for (const r of rows) md.push(`| ${esc(r.cell)} | ${r.type} | ${esc(r.test)} |`);
  md.push('');
}
if (hasExperimental) md.push('⚠️ Bun is experimental and does not block the build.');
if (rows.length) md.push('Full per-cell logs: `test-logs-*` artifacts.');

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) appendFileSync(summaryFile, md.join('\n') + '\n');

// ---- Console ----
const useColor = !process.env.NO_COLOR && (process.stdout.isTTY || !!process.env.CI || !!process.env.FORCE_COLOR);
const color = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
console.log('');
console.log(color('1', passed ? '✓ CI passed' : anyFailed ? '✗ CI failed' : 'CI incomplete'));
console.log('  ' + verdictLine().replace(/\*\*/g, ''));
if (rows.length) {
  console.log('');
  for (const r of rows) console.log(`  ${color('31', '✗')} ${r.cell}  [${r.type}]  ${r.test}`);
}

// Always exit 0: writing the summary must not depend on exit code (a non-zero step
// can drop its $GITHUB_STEP_SUMMARY). A separate workflow step sets the job's
// red/green status from the `needs` results.
process.exit(0);
