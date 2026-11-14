import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { checkVersions, publishablePackages } from './pack-packages.ts';

function fixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'sdk-typescript-pack-'));
  const files = {
    'packages/common/package.json': '{"name":"@temporalio/common","version":"1.25.0"}\n',
    'packages/meta/package.json': '{"name":"temporalio","version":"1.24.0","private":true}\n',
    'packages/docs/package.json': '{"private":true}\n',
    'contrib/example/package.json': '{"name":"@temporalio/example","version":"1.25.0"}\n',
    'scripts/package.json': '{"name":"scripts","version":"1.24.0"}\n',
  };
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), contents);
  }
  return root;
}

test('publishable packages are the named, non-private ones, all at the same version', () => {
  const root = fixture();
  try {
    const packages = publishablePackages(root);
    assert.deepEqual(packages.map(({ name }) => name).sort(), ['@temporalio/common', '@temporalio/example']);
    checkVersions(packages);
    checkVersions(packages, '1.25.0');
    assert.throws(() => checkVersions(packages, '1.25.1'), /@temporalio\/common is at 1\.25\.0/);

    writeFileSync(resolve(root, 'contrib/example/package.json'), '{"name":"@temporalio/example"}\n');
    assert.throws(() => checkVersions(publishablePackages(root)), /@temporalio\/example is at no version/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
