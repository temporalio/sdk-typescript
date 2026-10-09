const test = require('node:test');
const assert = require('node:assert/strict');
const { relativeDocUrl } = require('./sidebars');

test('relativeDocUrl keeps forward-slash namespaced paths', () => {
  assert.equal(relativeDocUrl('api/namespaces/client.md'), 'api/namespaces/client');
  assert.equal(relativeDocUrl('api/namespaces/client'), 'api/namespaces/client');
});

test('relativeDocUrl normalizes Windows-style separators', () => {
  // `path.relative` yields backslashes on Windows; the sidebar code splits and
  // links on forward slashes, so the Windows form must be normalized too.
  assert.equal(relativeDocUrl('api\\namespaces\\client.md'), 'api/namespaces/client');
});

test('relativeDocUrl strips only the trailing .md extension', () => {
  assert.equal(relativeDocUrl('api\\namespaces\\workflowStreamsClient.md'), 'api/namespaces/workflowStreamsClient');
  assert.equal(relativeDocUrl('api\\namespaces\\client.v1.md'), 'api/namespaces/client.v1');
});
