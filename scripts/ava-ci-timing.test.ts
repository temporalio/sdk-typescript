import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  collectTimingRuns,
  formatTimingHeartbeat,
  readTimingDirectory,
  renderTimingSummary,
  type TimingEnvironment,
  type TimingRun,
} from './ava-ci-timing.ts';

function event(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: 1,
    runId: 'run-1',
    workerId: 'worker-1',
    wallTimeMs: 1000,
    file: 'packages/test/lib/test-example.js',
    event: 'file-start',
    ...overrides,
  });
}

function environment(id: string, label: string, jobUrl: string): TimingEnvironment {
  return { id, label, jobUrl, completedAtMs: 5000 };
}

test('collects completed and unfinished observations while ignoring a truncated record', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ava-ci-timing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'test-logs-linux-x64-24-noreuse');
  mkdirSync(directory);
  writeFileSync(
    join(directory, 'ava-observer.jsonl'),
    [
      event({}),
      event({ event: 'case-start', wallTimeMs: 1100, caseId: 'complete', title: 'completed test' }),
      event({
        event: 'case-end',
        wallTimeMs: 1300,
        caseId: 'complete',
        title: 'completed test',
        durationMs: 200,
      }),
      event({ event: 'case-start', wallTimeMs: 1500, caseId: 'active', title: 'still active' }),
      '{truncated',
    ].join('\n')
  );
  writeFileSync(
    join(directory, '_temporalio_test.json'),
    JSON.stringify({ observerRunId: 'run-1', finishedAtMs: 3000 })
  );
  const env = environment('linux-x64-24-noreuse', 'Linux · Node 24', 'https://github.com/example/jobs/linux');

  const runs = collectTimingRuns(root, new Map([[env.id, env]]));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].snapshot.cases[0].title, 'completed test');
  assert.equal(runs[0].snapshot.activeCases[0].title, 'still active');
  assert.equal(runs[0].snapshot.activeCases[0].elapsedMs, 1500);
  assert.deepEqual(runs[0].snapshot.lastCompleted, {
    file: 'packages/test/lib/test-example.js',
    title: 'completed test',
  });

  const markdown = renderTimingSummary(runs).join('\n');
  assert.match(markdown, /Active at termination/);
  assert.match(markdown, /still active/);
  assert.match(markdown, /completed test \(`packages\/test\/src\/test-example\.ts`\)/);
  assert.match(markdown, /not necessarily the cause/);
  assert.match(formatTimingHeartbeat(runs[0].snapshot) ?? '', /active: .*last completed:/);
});

test('ranks the top ten files and tests by median and links the contributing jobs', () => {
  const linux = environment('linux', 'Linux · Node 24', 'https://github.com/example/jobs/linux');
  const windows = environment('windows', 'Windows · Node 24', 'https://github.com/example/jobs/windows');
  const observations = (durationMs: number) => ({
    files: Array.from({ length: 11 }, (_, index) => ({
      file: `packages/test/lib/test-${index}.js`,
      durationMs: durationMs + index * 100,
    })),
    cases: Array.from({ length: 11 }, (_, index) => ({
      caseId: `case-${durationMs}-${index}`,
      file: `packages/test/lib/test-${index}.js`,
      title: `test ${index}`,
      durationMs: durationMs / 2 + index * 50,
    })),
    activeFiles: [],
    activeCases: [],
    lastCompleted: null,
  });
  const runs: TimingRun[] = [
    { environment: linux, snapshot: observations(1000) },
    { environment: windows, snapshot: observations(3000) },
  ];

  const markdown = renderTimingSummary(runs).join('\n');
  assert.match(markdown, /Slowest test files/);
  assert.match(markdown, /3\.0s between \[2\.0s · Linux · Node 24\]/);
  assert.match(markdown, /\[4\.0s · Windows · Node 24\]/);
  assert.match(markdown, /\| 2 \|/);
  assert.match(markdown, /test-10\.ts/);
  assert.doesNotMatch(markdown, /test-0\.ts/);
  assert.doesNotMatch(markdown, /Per-environment/);
});

test('reduces a completed file and maps compiled paths back to source', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ava-ci-timing-directory-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    join(directory, 'ava-observer.jsonl'),
    [event({}), event({ event: 'file-end', wallTimeMs: 2500, durationMs: 1500 })].join('\n')
  );

  const snapshot = readTimingDirectory(directory, 3000, 'run-1');
  assert.equal(snapshot.files[0].durationMs, 1500);
  const markdown = renderTimingSummary([
    {
      environment: environment('local', 'Local', ''),
      snapshot,
    },
  ]).join('\n');
  assert.match(markdown, /`packages\/test\/src\/test-example\.ts`/);
});
