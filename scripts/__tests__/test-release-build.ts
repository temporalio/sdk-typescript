import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { assertReleaseCheckout, listPublishablePackages } from '../release-pack';

function fixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'sdk-typescript-pack-'));
  const files: Record<string, string> = {
    'packages/common/package.json': '{"name":"@temporalio/common","version":"1.26.0"}\n',
    'packages/docs/package.json': '{"name":"@temporalio/docs","private":true,"version":"0.0.0"}\n',
    'contrib/example/package.json': '{"name":"@temporalio/example","version":"1.26.0"}\n',
    'CHANGELOG.md': '# Changelog\n\n## [1.26.0] - 2026-11-10\n\n- A change.\n',
  };
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), contents);
  }
  return root;
}

test('listPublishablePackages skips private packages', () => {
  const root = fixture();
  try {
    assert.deepEqual(listPublishablePackages(root), ['contrib/example', 'packages/common']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertReleaseCheckout accepts a checkout whose packages and changelog match', () => {
  const root = fixture();
  try {
    assert.deepEqual(assertReleaseCheckout(root, '1.26.0'), ['contrib/example', 'packages/common']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertReleaseCheckout rejects a package on a different version', () => {
  const root = fixture();
  try {
    writeFileSync(resolve(root, 'packages/common/package.json'), '{"name":"@temporalio/common","version":"1.25.0"}\n');
    assert.throws(() => assertReleaseCheckout(root, '1.26.0'), /packages\/common/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertReleaseCheckout rejects a missing changelog section', () => {
  const root = fixture();
  try {
    writeFileSync(resolve(root, 'CHANGELOG.md'), '# Changelog\n\n## [1.25.0] - 2026-10-08\n\n- Older.\n');
    assert.throws(() => assertReleaseCheckout(root, '1.26.0'), /CHANGELOG.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
