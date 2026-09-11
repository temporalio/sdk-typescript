import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildSummary,
  collectPackageObservations,
  formatDuration,
  parseNeedsJson,
  parseWorkflowJobsJson,
  type PackageObservation,
  type WorkflowJob,
  type WorkflowStep,
} from './ci-run-summary-lib.ts';

const START = Date.parse('2026-09-10T12:00:00Z');

function timestamp(offsetMs: number): string {
  return new Date(START + offsetMs).toISOString();
}

function step(name: string, startMs: number, endMs: number): WorkflowStep {
  return {
    name,
    startedAt: timestamp(startMs),
    completedAt: timestamp(endMs),
  };
}

function job(
  name: string,
  startMs: number | null,
  endMs: number | null,
  overrides: Partial<WorkflowJob> = {}
): WorkflowJob {
  return {
    name,
    htmlUrl: `https://github.com/temporalio/sdk-typescript/actions/runs/1/job/1`,
    conclusion: endMs === null ? null : 'success',
    startedAt: startMs === null ? null : timestamp(startMs),
    completedAt: endMs === null ? null : timestamp(endMs),
    steps: [],
    ...overrides,
  };
}

function packageObservation(
  cellId: string,
  packageName: string,
  durationMs: number,
  overrides: Partial<PackageObservation['result']> = {}
): PackageObservation {
  return {
    cellId,
    cellLabel: cellId,
    result: {
      package: packageName,
      fail: 0,
      exitCode: 0,
      durationMs,
      failures: [],
      ...overrides,
    },
  };
}

test('parses paginated workflow jobs and ignores malformed entries', () => {
  const jobs = parseWorkflowJobsJson(
    JSON.stringify([
      {
        jobs: [
          {
            id: 1,
            name: 'Compile',
            html_url: 'https://github.com/example/job/1',
            status: 'completed',
            conclusion: 'success',
            started_at: timestamp(0),
            completed_at: timestamp(1000),
            steps: [
              {
                name: 'Build',
                conclusion: 'success',
                started_at: timestamp(100),
                completed_at: timestamp(900),
              },
            ],
          },
          { id: 2 },
        ],
      },
      { jobs: [{ id: 3, name: 'Test', status: 'queued', conclusion: null }] },
    ])
  );

  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].name, 'Compile');
  assert.equal(jobs[0].steps[0].name, 'Build');
  assert.equal(jobs[1].name, 'Test');
  assert.deepEqual(parseWorkflowJobsJson('not JSON'), []);
});

test('renders current-run span without summing parallel jobs', () => {
  const jobs = [
    job('Compile', 0, 10 * 60_000, {
      steps: [step('Compile Rust', 0, 9 * 60_000), step('Upload', 9 * 60_000, 10 * 60_000)],
    }),
    job('Run Integration Tests (linux-x64, Node 24, Reuse V8 Context false)', 5 * 60_000, 15 * 60_000, {
      htmlUrl: 'https://github.com/example/integration',
      steps: [step('Run Tests', 6 * 60_000, 14 * 60_000)],
    }),
    job('CI', 15 * 60_000, null),
  ];
  const observations = [
    packageObservation('linux-x64-24-noreuse', '@temporalio/common', 10_000),
    packageObservation('linux-x64-24-noreuse', '@temporalio/test', 4 * 60_000),
  ];
  const report = buildSummary({ 'integration-tests': { result: 'success' } }, jobs, observations);

  assert.equal(report.status, 'passed');
  assert.equal(report.executionSpanMs, 15 * 60_000);
  assert.match(report.markdown, /Execution span:\*\* 15m00s across 2 completed jobs/);
  assert.match(report.markdown, /```text[\s\S]*Compile[\s\S]*Tests · linux-x64/);
  assert.match(report.markdown, /Slowest steps[\s\S]*Compile Rust[\s\S]*Run Tests/);
  assert.match(report.markdown, /Slowest test package runs[\s\S]*@temporalio\/test[\s\S]*@temporalio\/common/);
  assert.match(report.markdown, /\[linux-x64 · Node 24 · no reuse\]\(https:\/\/github.com\/example\/integration\)/);
});

test('links failed and cancelled jobs while preserving test diagnostics', () => {
  const integrationName = 'Run Integration Tests (windows-x64, Node 20, Reuse V8 Context true)';
  const jobs = [
    job(integrationName, 0, 2000, {
      conclusion: 'failure',
      htmlUrl: 'https://github.com/example/integration-failure',
    }),
    job('Build Docs', 0, 1000, {
      conclusion: 'cancelled',
      htmlUrl: 'https://github.com/example/docs',
    }),
  ];
  const observations = [
    packageObservation('windows-x64-20-reuse', '@temporalio/test', 1500, {
      fail: 1,
      exitCode: 1,
      failures: [
        {
          title: 'test-worker › reports useful output',
          message: 'expected true',
          at: 'packages/test/src/test-worker.ts:10:2',
          diagnostic: 'assertion: true',
        },
      ],
    }),
  ];
  const report = buildSummary(
    { 'integration-tests': { result: 'failure' }, docs: { result: 'cancelled' } },
    jobs,
    observations
  );

  assert.equal(report.status, 'failed');
  assert.match(
    report.markdown,
    /\[windows-x64 · Node 20 · reuse\]\(https:\/\/github.com\/example\/integration-failure\)/
  );
  assert.match(report.markdown, /test-worker › reports useful output.*expected true/);
  assert.match(report.markdown, /\[Build Docs\]\(https:\/\/github.com\/example\/docs\).*cancelled/);
});

test('does not turn a successful non-blocking Bun cell red from artifact failures', () => {
  const jobs = [
    job('Run Integration Tests (linux-x64, Bun, Reuse V8 Context false)', 0, 1000, {
      conclusion: 'failure',
    }),
  ];
  const observations = [
    packageObservation('linux-x64-bun-noreuse', '@temporalio/test', 900, {
      fail: 1,
      exitCode: 1,
      failures: [{ title: 'experimental failure', message: '', at: '', diagnostic: '' }],
    }),
  ];
  const report = buildSummary({ 'integration-tests': { result: 'success' } }, jobs, observations);

  assert.equal(report.status, 'passed');
  assert.equal(report.rows.length, 1);
  assert.match(report.markdown, /Bun \(non-blocking\)/);
});

test('degrades cleanly when API and artifact inputs are unavailable', () => {
  const report = buildSummary(parseNeedsJson('{"docs":{"result":"cancelled"}}'), [], []);

  assert.equal(report.status, 'incomplete');
  assert.match(report.markdown, /Build Docs.*cancelled/);
  assert.match(report.markdown, /Job timing data was unavailable/);
  assert.deepEqual(parseNeedsJson('invalid'), {});
});

test('uses completed job conclusions when needs metadata is unavailable', () => {
  const report = buildSummary(
    {},
    [job('Compile', 0, 1000, { conclusion: 'timed_out', htmlUrl: 'https://github.com/example/compile' })],
    []
  );

  assert.equal(report.status, 'failed');
  assert.match(report.markdown, /\[Compile\]\(https:\/\/github.com\/example\/compile\).*timed out/);
  assert.equal(formatDuration(119_900), '2m00s');
});

test('renders package timing when job timing is unavailable', () => {
  const report = buildSummary(
    { 'integration-tests': { result: 'success' } },
    [],
    [packageObservation('linux-x64-24-noreuse', '@temporalio/test', 90_000)]
  );

  assert.equal(report.status, 'passed');
  assert.match(report.markdown, /Job timing data was unavailable/);
  assert.match(report.markdown, /Slowest test package runs[\s\S]*@temporalio\/test[\s\S]*1m30s/);
});

test('expanded timing tables contain only rows beyond the visible top five', () => {
  const jobs = Array.from({ length: 7 }, (_, index) => job(`Job ${index + 1}`, 0, (index + 1) * 1000));
  const report = buildSummary({ docs: { result: 'success' } }, jobs, []);
  const details = report.markdown.split('<summary>Additional timing details</summary>')[1];

  assert(details);
  assert.doesNotMatch(details, /Job 7/);
  assert.match(details, /Job 2/);
  assert.match(details, /Job 1/);
});

test('escapes job, step, and failure text in Markdown tables', () => {
  const jobs = [
    job('Build | Docs\nInjected', 0, 1000, {
      conclusion: 'failure',
      steps: [step('Slow | step\ncontinued', 0, 900)],
    }),
  ];
  const report = buildSummary({ docs: { result: 'failure' } }, jobs, []);

  assert.match(report.markdown, /Build \\\| Docs Injected/);
  assert.match(report.markdown, /Slow \\\| step continued/);
  assert.doesNotMatch(report.markdown, /Docs\nInjected/);
});

test('collects valid package results and ignores malformed JSON files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ci-run-summary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifact = join(root, 'test-logs-linux-arm-24-reuse');
  mkdirSync(artifact);
  writeFileSync(
    join(artifact, 'test.json'),
    JSON.stringify({ package: '@temporalio/test', fail: 0, exitCode: 0, durationMs: 1234, failures: [] })
  );
  writeFileSync(join(artifact, 'malformed.json'), '{');
  writeFileSync(join(artifact, 'not-a-result.json'), JSON.stringify({ package: 'missing-duration' }));

  const observations = collectPackageObservations(root);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].cellId, 'linux-arm-24-reuse');
  assert.equal(observations[0].cellLabel, 'linux-arm · Node 24 · reuse');
  assert.equal(observations[0].result.durationMs, 1234);
});
