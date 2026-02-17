import test from 'ava';
import { discoverTests } from './ci/activities';

test('discoverTests returns sorted test files', async (t) => {
  const files = await discoverTests();
  t.true(files.length > 0);
  t.true(files.every((f) => f.startsWith('lib/test-') || f.startsWith('./lib/test-')));
  t.true(files.every((f) => f.endsWith('.js')));

  // Verify sorted
  const sorted = [...files].sort();
  t.deepEqual(files, sorted);
});
