// Aggregates the per-package `<pkg>.json` files written by scripts/ava-ci.mjs into:
//   - a Markdown table + failures section appended to $GITHUB_STEP_SUMMARY
//     (this is what shows up on the Actions run summary page), and
//   - the same table printed to the console as a final overview.
// Exits non-zero if any package reported failures, so it can double as a gate.
//
// Usage: node scripts/ci-test-summary.mjs   (reads TEST_RESULTS_DIR or ./.test-results)

import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const resultsDir = process.env.TEST_RESULTS_DIR || join(root, '.test-results');

if (!existsSync(resultsDir)) {
  console.log(`No test results found at ${resultsDir}; nothing to summarize.`);
  process.exit(0);
}

const results = readdirSync(resultsDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => {
    try {
      return JSON.parse(readFileSync(join(resultsDir, f), 'utf8'));
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .sort((a, b) => a.package.localeCompare(b.package));

if (results.length === 0) {
  console.log(`No parseable test results in ${resultsDir}.`);
  process.exit(0);
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

const totals = results.reduce(
  (acc, r) => {
    acc.pass += r.pass || 0;
    acc.fail += r.fail || 0;
    acc.skip += r.skip || 0;
    acc.durationMs += r.durationMs || 0;
    return acc;
  },
  { pass: 0, fail: 0, skip: 0, durationMs: 0 }
);
const anyFailed = results.some((r) => (r.fail || 0) > 0 || r.exitCode !== 0);

// --- Markdown for the GitHub job summary ---
const md = [];
md.push(`## Test results ${anyFailed ? '❌' : '✅'}`);
md.push('');
md.push('| Package | Result | Passed | Failed | Skipped | Duration |');
md.push('| --- | --- | ---: | ---: | ---: | ---: |');
for (const r of results) {
  const ok = (r.fail || 0) === 0 && r.exitCode === 0;
  md.push(
    `| \`${r.package}\` | ${ok ? '✅' : '❌'} | ${r.pass || 0} | ${r.fail || 0} | ${r.skip || 0} | ${fmtDuration(
      r.durationMs
    )} |`
  );
}
md.push(
  `| **Total** | ${anyFailed ? '❌' : '✅'} | **${totals.pass}** | **${totals.fail}** | **${
    totals.skip
  }** | **${fmtDuration(totals.durationMs)}** |`
);
md.push('');
md.push('_Full per-package logs are archived in the `test-logs-*` build artifact._');
md.push('');

if (anyFailed) {
  md.push('### Failures');
  md.push('');
  for (const r of results) {
    if (!r.failures || r.failures.length === 0) continue;
    md.push(`#### \`${r.package}\``);
    md.push('');
    for (const f of r.failures) {
      md.push(`**${f.title}**`);
      if (f.at) md.push(`\`${f.at}\``);
      if (f.diagnostic) {
        md.push('```');
        md.push(f.diagnostic);
        md.push('```');
      } else if (f.message) {
        md.push(`> ${f.message}`);
      }
      md.push('');
    }
  }
}

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) {
  mkdirSync(join(summaryFile, '..'), { recursive: true });
  appendFileSync(summaryFile, md.join('\n') + '\n');
}

// --- Console overview ---
const useColor = !process.env.NO_COLOR && (process.stdout.isTTY || !!process.env.CI || !!process.env.FORCE_COLOR);
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
console.log('');
console.log(c('1', 'Test summary'));
for (const r of results) {
  const ok = (r.fail || 0) === 0 && r.exitCode === 0;
  const mark = ok ? c('32', '✓') : c('31', '✗');
  const counts = `${r.pass || 0} passed${r.skip ? `, ${r.skip} skipped` : ''}${
    r.fail ? `, ${c('31', `${r.fail} failed`)}` : ''
  }`;
  console.log(`  ${mark} ${r.package.padEnd(42)} ${counts}  ${c('2', `(${fmtDuration(r.durationMs)})`)}`);
}
console.log(
  `  ${anyFailed ? c('31', '✗') : c('32', '✓')} total: ${totals.pass} passed, ${totals.fail} failed, ${
    totals.skip
  } skipped  ${c('2', `(${fmtDuration(totals.durationMs)})`)}`
);
console.log(`  ${c('2', `full logs: ${resultsDir}`)}`);

process.exit(anyFailed ? 1 : 0);
