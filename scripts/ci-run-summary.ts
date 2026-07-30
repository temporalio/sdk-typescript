// Produces ONE consolidated CI summary answering "did this PR pass, and if not,
// why specifically?" — written to $GITHUB_STEP_SUMMARY (and the console) by the
// `ci-summary` job, which runs after all checks.
//
// Inputs:
//   - NEEDS_JSON: the workflow `needs` context (`${{ toJSON(needs) }}`) — top-level
//     check results: { "<job-id>": { "result": "success|failure|cancelled|skipped" } }.
//   - JOBS_JSON_FILE: path to the GitHub "list jobs for a run" API response. Gives
//     the per-matrix-cell conclusions (including cancelled), which `needs` does not.
//   - AGG_RESULTS_DIR (default "all-results"): downloaded `test-logs-*` artifacts,
//     one subdir per matrix cell, holding the per-package <pkg>.json from ava-ci.ts.

import { existsSync, readdirSync, readFileSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

interface Failure {
  pkg: string;
  title: string;
  at: string;
  message?: string;
  diagnostic?: string;
}

interface Cell {
  id: string;
  label: string;
  conclusion: string | null;
}

interface Row {
  job: string;
  type: string;
  test: string;
}

const JOB_LABELS: Record<string, string> = {
  'compile-native-binaries-debug': 'Compile Native Binaries',
  'integration-tests': 'Integration Tests',
  conventions: 'Lint & Prune',
  'features-tests': 'Features Tests',
  'stress-tests-no-reuse-context': 'Stress Tests (no reuse)',
  'stress-tests-reuse-context': 'Stress Tests (reuse)',
  docs: 'Build Docs',
};

const needs: Record<string, { result?: string }> = JSON.parse(process.env.NEEDS_JSON || '{}');
const topLevel = Object.entries(needs).map(([id, v]) => ({
  id,
  label: JOB_LABELS[id] || id,
  result: v?.result || 'unknown',
}));
const anyFailed = topLevel.some((j) => j.result === 'failure');
const anyCancelled = topLevel.some((j) => j.result === 'cancelled');
const passed = !anyFailed && !anyCancelled;

// --- per-package failures from the downloaded artifacts, keyed by cell id ---
function findJsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...findJsonFiles(p));
    else if (entry.endsWith('.json')) out.push(p);
  }
  return out;
}

function collectFailuresByCell(): Record<string, Failure[]> {
  const root = process.env.AGG_RESULTS_DIR || 'all-results';
  const byCell: Record<string, Failure[]> = {};
  if (!existsSync(root)) return byCell;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const cellId = name.replace(/^test-logs-/, ''); // e.g. linux-arm-20-reuse
    const failures: Failure[] = [];
    for (const file of findJsonFiles(dir)) {
      let r;
      try {
        r = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      if ((r.fail || 0) === 0 && r.exitCode === 0) continue;
      if (r.failures && r.failures.length) {
        for (const f of r.failures)
          failures.push({ pkg: r.package, title: f.title, at: f.at, message: f.message, diagnostic: f.diagnostic });
      } else {
        failures.push({ pkg: r.package, title: `${r.fail || '?'} failed (see job log)`, at: '', message: '' });
      }
    }
    if (failures.length) byCell[cellId] = failures;
  }
  return byCell;
}

function readIntegrationCells(): Cell[] | null {
  const file = process.env.JOBS_JSON_FILE;
  if (!file || !existsSync(file)) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const cells: Cell[] = [];
  for (const j of data.jobs || []) {
    const m = /^Run Integration Tests \((.+)\)$/.exec(j.name || '');
    if (!m) continue;
    const [platform, nodePart, reusePart] = m[1].split(', ');
    const node = nodePart === 'Bun' ? 'bun' : nodePart.replace(/^Node /, '');
    const reuse = /true\s*$/.test(reusePart || '') ? 'reuse' : 'noreuse';
    cells.push({
      id: `${platform}-${node}-${reuse}`,
      label: `${platform} · ${node === 'bun' ? 'Bun (non-blocking)' : `Node ${node}`}`,
      conclusion: j.conclusion, // success | failure | cancelled | skipped | null
    });
  }
  return cells.length ? cells : null;
}

function classify(f: Failure): string {
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

const failuresByCell = collectFailuresByCell();
const cells = readIntegrationCells();

// --- build one row per non-passing (job, test) ---
const esc = (s: string): string => String(s).replace(/\|/g, '\\|');
const rows: Row[] = [];
let intFailed = 0;
let intCancelled = 0;

function testCol(f: Failure): string {
  const pkg = f.pkg && f.pkg !== '@temporalio/test' ? `${f.pkg.replace('@temporalio/', '')}: ` : '';
  return `${pkg}${f.title}${f.at ? ` (${f.at})` : ''}`;
}

if (cells) {
  // Complete picture: iterate every integration cell from the jobs API.
  for (const c of cells.sort((a, b) => a.label.localeCompare(b.label))) {
    if (c.conclusion === 'success' || c.conclusion === 'skipped' || c.conclusion == null) continue;
    if (c.conclusion === 'cancelled') {
      intCancelled++;
      rows.push({ job: c.label, type: 'cancelled', test: 'did not finish' });
      continue;
    }
    intFailed++;
    const fails = failuresByCell[c.id];
    if (fails && fails.length) {
      for (const f of fails) rows.push({ job: c.label, type: classify(f), test: testCol(f) });
    } else {
      rows.push({ job: c.label, type: 'no results', test: 'no test results captured — see job log' });
    }
  }
} else {
  // Fallback (e.g. local run, no jobs API): artifact failures only.
  for (const [cellId, fails] of Object.entries(failuresByCell)) {
    const label = cellId
      .replace(/-(reuse|noreuse)$/, '')
      .replace(/-(\d+|bun)$/, (_, n) => ` · ${n === 'bun' ? 'Bun' : `Node ${n}`}`);
    intFailed++;
    for (const f of fails) rows.push({ job: label, type: classify(f), test: testCol(f) });
  }
}

const otherFailing = topLevel.filter((j) => j.result === 'failure' && j.id !== 'integration-tests').map((j) => j.label);

function verdictLine(): string {
  if (passed) return 'All checks passed.';
  const parts: string[] = [];
  if (intFailed || intCancelled) {
    const bits: string[] = [];
    if (intFailed) bits.push(`${intFailed} failed`);
    if (intCancelled) bits.push(`${intCancelled} cancelled`);
    parts.push(`**Integration Tests** — ${bits.join(', ')}`);
  } else if (needs['integration-tests']?.result === 'failure') {
    parts.push('**Integration Tests** failed');
  }
  for (const label of otherFailing) parts.push(`**${label}** failed`);
  if (!parts.length && anyCancelled) return 'Some checks were cancelled and did not complete.';
  return parts.join('; ') + '.';
}

// ---- Markdown ----
const md: string[] = [];
md.push(`# ${passed ? '✅ Passed' : anyFailed ? '❌ Failed' : '⚪ Incomplete'}`);
md.push('');
md.push(verdictLine());
md.push('');
if (rows.length) {
  md.push('| Job | Type | Failing test |');
  md.push('| --- | --- | --- |');
  for (const r of rows) md.push(`| ${esc(r.job)} | ${r.type} | ${esc(r.test)} |`);
  md.push('');
  md.push('Full per-job logs: `test-logs-*` artifacts.');
}

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) appendFileSync(summaryFile, md.join('\n') + '\n');

// ---- Console ----
const useColor = !process.env.NO_COLOR && (process.stdout.isTTY || !!process.env.CI || !!process.env.FORCE_COLOR);
const color = (code: string, s: string): string => (useColor ? `[${code}m${s}[0m` : s);
console.log('');
console.log(color('1', passed ? '✓ Passed' : anyFailed ? '✗ Failed' : 'Incomplete'));
console.log('  ' + verdictLine().replace(/\*\*/g, ''));
if (rows.length) {
  console.log('');
  for (const r of rows) console.log(`  ${color('31', '✗')} ${r.job}  [${r.type}]  ${r.test}`);
}

// Always exit 0: writing the summary must not depend on exit code. A separate
// workflow step sets the job's red/green status from the `needs` results.
process.exit(0);
