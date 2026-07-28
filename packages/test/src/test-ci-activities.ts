import fs from 'node:fs';
import os from 'node:os';
import path, { sep } from 'node:path';
import test from 'ava';
import { discoverTests, alertFlakes } from './ci/activities';

const TEST_PREFIX = `lib${sep}test-`;

test('discoverTests returns sorted test files', async (t) => {
  const files = await discoverTests();
  t.true(files.length > 0);
  t.true(files.every((f) => f.startsWith(TEST_PREFIX) || f.startsWith(`.${sep}${TEST_PREFIX}`)));
  t.true(files.every((f) => f.endsWith('.js')));

  // Verify sorted
  const sorted = [...files].sort();
  t.deepEqual(files, sorted);
});

test('alertFlakes does nothing for empty list', async (t) => {
  await alertFlakes([]);
  t.pass();
});

test('alertFlakes writes to GITHUB_STEP_SUMMARY', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `step-summary-${Date.now()}.md`);
  const original = process.env.GITHUB_STEP_SUMMARY;
  try {
    process.env.GITHUB_STEP_SUMMARY = tmpFile;
    await alertFlakes([{ file: 'lib/test-a.js', attemptsToPass: 2 }]);
    const content = await fs.promises.readFile(tmpFile, 'utf-8');
    t.regex(content, /Flaky Tests Detected/);
    t.regex(content, /lib\/test-a\.js/);
    t.regex(content, /attempt 2/);
  } finally {
    if (original !== undefined) {
      process.env.GITHUB_STEP_SUMMARY = original;
    } else {
      delete process.env.GITHUB_STEP_SUMMARY;
    }
    await fs.promises.unlink(tmpFile).catch(() => {});
  }
});
