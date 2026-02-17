import { sep } from 'node:path';
import test from 'ava';
import { discoverTests } from './ci/activities';

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
