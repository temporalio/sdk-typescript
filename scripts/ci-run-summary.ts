// Produces ONE consolidated CI summary answering "did this PR pass, why did it fail,
// and where did the current run spend its time?" The ci-summary job writes this to
// $GITHUB_STEP_SUMMARY after every other CI job has completed.
//
// Inputs:
//   - NEEDS_JSON: the workflow `needs` context.
//   - JOBS_JSON_FILE: paginated GitHub "list jobs for a run" responses.
//   - AGG_RESULTS_DIR: downloaded `test-logs-*` artifacts containing ava-ci JSON.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

import {
  buildSummary,
  collectPackageObservations,
  parseNeedsJson,
  parseWorkflowJobsJson,
} from './ci-run-summary-lib.ts';

const needs = parseNeedsJson(process.env.NEEDS_JSON);
const jobsFile = process.env.JOBS_JSON_FILE;
const jobs = jobsFile && existsSync(jobsFile) ? parseWorkflowJobsJson(readFileSync(jobsFile, 'utf8')) : [];
const observations = collectPackageObservations(process.env.AGG_RESULTS_DIR || 'all-results');
const report = buildSummary(needs, jobs, observations);

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) appendFileSync(summaryFile, report.markdown);

const useColor = !process.env.NO_COLOR && (process.stdout.isTTY || !!process.env.CI || !!process.env.FORCE_COLOR);
const color = (code: string, value: string): string => (useColor ? `\u001B[${code}m${value}\u001B[0m` : value);
const heading = report.status === 'passed' ? '✓ Passed' : report.status === 'failed' ? '✗ Failed' : 'Incomplete';

console.log('');
console.log(color('1', heading));
console.log(`  ${report.verdict.replace(/\*\*/g, '')}`);
for (const row of report.rows) console.log(`  ${color('31', '✗')} ${row.jobLabel}  [${row.type}]  ${row.test}`);
if (report.executionSpanMs !== null) {
  const slowest = report.slowestJob
    ? `; slowest job: ${report.slowestJob.name} (${Math.round(report.slowestJob.durationMs / 1000)}s)`
    : '';
  console.log(`  Timing recorded for this run${slowest}.`);
}

// Always exit 0: summary rendering must not hide the report. The workflow's separate
// final status step owns the rollup check conclusion.
process.exit(0);
