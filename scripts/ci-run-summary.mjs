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

// Friendly labels + display order for the top-level checks.
const JOB_LABELS = {
  'compile-native-binaries-debug': 'Compile Native Binaries',
  'integration-tests': 'Integration Tests',
  conventions: 'Lint & Prune',
  'features-tests': 'Features Tests',
  'stress-tests-no-reuse-context': 'Stress Tests (no reuse)',
  'stress-tests-reuse-context': 'Stress Tests (reuse)',
  docs: 'Build Docs',
};

const RESULT_ICON = { success: '✅', failure: '❌', cancelled: '⚪', skipped: '⏭️' };

const needs = JSON.parse(process.env.NEEDS_JSON || '{}');
const jobs = Object.entries(needs).map(([id, v]) => ({
  id,
  label: JOB_LABELS[id] || id,
  result: v?.result || 'unknown',
}));

const anyFailed = jobs.some((j) => j.result === 'failure');
const anyCancelled = jobs.some((j) => j.result === 'cancelled');
const passed = !anyFailed && !anyCancelled;

// Per-cell test failures, read from the downloaded artifacts.
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
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      let r;
      try {
        r = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      } catch {
        continue;
      }
      const failed = (r.fail || 0) > 0 || r.exitCode !== 0;
      if (!failed) continue;
      if (r.failures && r.failures.length) {
        for (const f of r.failures) failures.push({ pkg: r.package, title: f.title, at: f.at, message: f.message });
      } else {
        failures.push({ pkg: r.package, title: `${r.fail || '?'} failed (see job log)`, at: '', message: '' });
      }
    }
    if (failures.length) cells.push({ cell, experimental, failures });
  }
  return cells.sort((a, b) => a.cell.localeCompare(b.cell));
}

const cellFailures = collectCellFailures();

// ---- Markdown ----
const md = [];
md.push(`# CI Summary — ${passed ? '✅ Passed' : anyFailed ? '❌ Failed' : '⚪ Incomplete'}`);
md.push('');
if (passed) {
  md.push('All required checks passed.');
} else if (anyFailed) {
  const names = jobs.filter((j) => j.result === 'failure').map((j) => j.label);
  md.push(`Failing checks: **${names.join(', ')}**.`);
} else {
  md.push('Some checks were cancelled and did not complete.');
}
md.push('');

md.push('| Check | Result |');
md.push('| --- | --- |');
for (const j of jobs) md.push(`| ${j.label} | ${RESULT_ICON[j.result] || ''} ${j.result} |`);
md.push('');

if (cellFailures.length) {
  md.push('## What failed');
  md.push('');
  for (const { cell, experimental, failures } of cellFailures) {
    md.push(`**${cell}**${experimental ? ' _(experimental, non-blocking)_' : ''}`);
    for (const f of failures) {
      const loc = f.at ? ` — \`${f.at}\`` : '';
      md.push(`- ${f.pkg}: ${f.title}${loc}`);
      if (f.message) md.push(`  - ${f.message}`);
    }
    md.push('');
  }
} else if (anyFailed) {
  // A non-test check failed (lint, docs, features, ...) — no per-test detail to show.
  md.push('## What failed');
  md.push('');
  md.push('No per-test failures were captured; open the failing check(s) above for details.');
  md.push('');
}

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) appendFileSync(summaryFile, md.join('\n') + '\n');

// ---- Console ----
const useColor = !process.env.NO_COLOR && (process.stdout.isTTY || !!process.env.CI || !!process.env.FORCE_COLOR);
const color = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
console.log('');
console.log(color('1', `CI Summary — ${passed ? 'Passed' : anyFailed ? 'FAILED' : 'Incomplete'}`));
for (const j of jobs) {
  const ok = j.result === 'success' || j.result === 'skipped';
  console.log(`  ${ok ? color('32', '✓') : color('31', '✗')} ${j.label.padEnd(28)} ${j.result}`);
}
for (const { cell, experimental, failures } of cellFailures) {
  console.log(color('31', `  ✗ ${cell}${experimental ? ' (experimental)' : ''}`));
  for (const f of failures) console.log(`      ${f.pkg}: ${f.title}${f.at ? `  (${f.at})` : ''}`);
}

// Always exit 0: writing the summary must not depend on exit code (a non-zero step
// can drop its $GITHUB_STEP_SUMMARY). A separate workflow step sets the job's
// red/green status from the `needs` results.
process.exit(0);
