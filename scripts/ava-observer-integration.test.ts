import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readTimingDirectory } from './ava-ci-timing.ts';

const workspaceRoot = process.cwd();
const testPackage = join(workspaceRoot, 'packages', 'test');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function runWrapper(t: test.TestContext, mode: 'complete' | 'hang', timeoutMs = 10_000) {
  const resultsDirectory = mkdtempSync(join(tmpdir(), 'ava-observer-'));
  t.after(() => rmSync(resultsDirectory, { recursive: true, force: true }));
  const nativeTypeScript = Number(process.versions.node.split('.')[0]) >= 23;
  const command = nativeTypeScript ? process.execPath : pnpm;
  const args = nativeTypeScript
    ? ['../../scripts/ava-ci.ts', './fixtures/ava-ci-observer.cjs']
    : ['exec', 'tsx', '../../scripts/ava-ci.ts', './fixtures/ava-ci-observer.cjs'];
  const child = spawnSync(command, args, {
    cwd: testPackage,
    encoding: 'utf8',
    env: {
      ...process.env,
      AVA_OBSERVER_FIXTURE_MODE: mode,
      AVA_WALL_CLOCK_TIMEOUT_MS: String(timeoutMs),
      NO_COLOR: '1',
      TEST_RESULTS_DIR: resultsDirectory,
    },
    shell: process.platform === 'win32',
    timeout: timeoutMs + 10_000,
  });
  const result = JSON.parse(readFileSync(join(resultsDirectory, '_temporalio_test.json'), 'utf8'));
  return { child, result, resultsDirectory };
}

test('the real preload records completed file and test timing', (t) => {
  const run = runWrapper(t, 'complete');
  assert.equal(run.child.status, 0, run.child.stderr || run.child.stdout);
  const snapshot = readTimingDirectory(run.resultsDirectory, run.result.finishedAtMs, run.result.observerRunId);

  assert.equal(snapshot.files.length, 1);
  assert.deepEqual(snapshot.cases.map((value) => value.title).sort(), ['concurrent case', 'macro case', 'serial case']);
  assert.equal(snapshot.activeFiles.length, 0);
  assert.equal(snapshot.activeCases.length, 0);
});

test('a wrapper timeout preserves the active and last-completed tests', (t) => {
  const run = runWrapper(t, 'hang', 1500);
  assert.equal(run.child.status, 1);
  const snapshot = readTimingDirectory(run.resultsDirectory, run.result.finishedAtMs, run.result.observerRunId);

  assert.equal(snapshot.activeCases[0].title, 'never completes');
  assert.equal(snapshot.lastCompleted?.title, 'completed before hang');
  assert.match(run.child.stdout, /active: .*never completes/);
  assert.match(run.child.stdout, /last completed: .*completed before hang/);
});

test('ordinary direct AVA runs do not activate the observer', (t) => {
  const resultsDirectory = mkdtempSync(join(tmpdir(), 'ava-observer-disabled-'));
  t.after(() => rmSync(resultsDirectory, { recursive: true, force: true }));
  const child = spawnSync(pnpm, ['exec', 'ava', '--tap', './fixtures/ava-ci-observer.cjs'], {
    cwd: testPackage,
    encoding: 'utf8',
    env: { ...process.env, TEST_RESULTS_DIR: resultsDirectory },
    shell: process.platform === 'win32',
    timeout: 10_000,
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(
    readdirSync(resultsDirectory).some((name) => name.startsWith('ava-observer-')),
    false
  );
});
