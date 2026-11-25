import assert from 'node:assert/strict';
import test from 'node:test';
import { publishedReleaseProblem } from './check-publish';

test('publish check rejects a tag other than v plus the package version', () => {
  assert.equal(
    publishedReleaseProblem('1.26.0', 'v1.25.0'),
    'Release tag v1.25.0 does not match package version 1.26.0'
  );
  assert.equal(publishedReleaseProblem('1.26.0', '1.26.0'), 'Release tag 1.26.0 does not match package version 1.26.0');
});
