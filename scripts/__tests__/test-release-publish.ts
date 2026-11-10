import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  assertPublishRuntime,
  assertShaOnReleaseLine,
  distTag,
  matchTarballs,
  npmPublishArgs,
  parseContainingBranches,
  publishOrder,
  readPackedManifest,
  tarballFilename,
  versionFromTag,
} from '../release-publish';
import { waitUntilVisible } from '../release-smoke';

test('versionFromTag accepts v-prefixed release versions', () => {
  assert.equal(versionFromTag('v1.26.0'), '1.26.0');
  assert.equal(versionFromTag('v1.26.0-rc.1'), '1.26.0-rc.1');
  assert.throws(() => versionFromTag('1.26.0'), /v1\.26\.0/);
});

test('distTag is derived from the version', () => {
  assert.equal(distTag('1.26.0'), 'latest');
  assert.equal(distTag('1.26.0-rc.1'), 'next');
  assert.equal(distTag('1.26.0-beta.2'), 'beta');
  assert.equal(distTag('1.26.0-alpha.1'), 'alpha');
  assert.throws(() => distTag('1.26.0-dev.1'), /Unsupported prerelease/);
});

test('tarballFilename follows the npm pack name', () => {
  assert.equal(tarballFilename('@temporalio/client', '1.26.0-rc.1'), 'temporalio-client-1.26.0-rc.1.tgz');
});

test('assertPublishRuntime enforces the trusted-publishing minimums', () => {
  assert.doesNotThrow(() => assertPublishRuntime('22.22.3', '11.5.1'));
  assert.throws(() => assertPublishRuntime('22.13.0', '11.5.1'), /Node/);
  assert.throws(() => assertPublishRuntime('22.14.0', '11.5.0'), /npm/);
});

test('assertShaOnReleaseLine accepts main or the matching release branch', () => {
  assert.doesNotThrow(() => assertShaOnReleaseLine('1.26.0', ['origin/main']));
  assert.doesNotThrow(() => assertShaOnReleaseLine('1.24.1', ['origin/releases/1.24.x']));
  assert.throws(() => assertShaOnReleaseLine('1.24.1', ['origin/releases/1.25.x']), /releases\/1\.24\.x/);
  assert.throws(() => assertShaOnReleaseLine('1.26.0', []), /no remote branch/);
});

test('parseContainingBranches drops the origin/HEAD alias', () => {
  const output = '  origin/HEAD -> origin/main\n  origin/main\n  origin/releases/1.26.x\n';
  assert.deepEqual(parseContainingBranches(output), ['origin/main', 'origin/releases/1.26.x']);
});

test('matchTarballs rejects a missing or extra archive', () => {
  const packages = [
    { name: '@temporalio/common', version: '1.26.0' },
    { name: '@temporalio/client', version: '1.26.0' },
  ];
  assert.deepEqual(matchTarballs(packages, ['temporalio-client-1.26.0.tgz', 'temporalio-common-1.26.0.tgz']), [
    { name: '@temporalio/common', file: 'temporalio-common-1.26.0.tgz' },
    { name: '@temporalio/client', file: 'temporalio-client-1.26.0.tgz' },
  ]);
  assert.throws(() => matchTarballs(packages, ['temporalio-common-1.26.0.tgz']), /missing/);
  assert.throws(() => matchTarballs(packages, ['temporalio-common-1.26.0.tgz', 'temporalio-client-1.26.0.tgz', 'extra.tgz']), /unexpected/);
});

test('publishOrder publishes dependencies first', () => {
  const order = publishOrder([
    { name: '@temporalio/client', dependencies: ['@temporalio/common', 'long'] },
    { name: '@temporalio/common', dependencies: [] },
    { name: '@temporalio/worker', dependencies: ['@temporalio/client', '@temporalio/common'] },
  ]);
  assert.deepEqual(order, ['@temporalio/common', '@temporalio/client', '@temporalio/worker']);
  assert.throws(
    () =>
      publishOrder([
        { name: 'a', dependencies: ['b'] },
        { name: 'b', dependencies: ['a'] },
      ]),
    /cycle/
  );
});

test('npmPublishArgs opts into provenance without a token', () => {
  assert.deepEqual(npmPublishArgs('dist/temporalio-client-1.26.0.tgz', 'latest'), [
    'publish',
    'dist/temporalio-client-1.26.0.tgz',
    '--tag',
    'latest',
    '--access',
    'public',
    '--provenance',
    '--ignore-scripts',
  ]);
});

test('readPackedManifest reads the packed package.json', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'sdk-typescript-tarball-'));
  try {
    mkdirSync(resolve(root, 'package'));
    writeFileSync(
      resolve(root, 'package/package.json'),
      JSON.stringify({ name: '@temporalio/common', version: '1.26.0', dependencies: { tslib: '^2.0.0' } })
    );
    const packed = spawnSync('tar', ['-czf', 'common.tgz', 'package'], { cwd: root });
    assert.equal(packed.status, 0);
    assert.deepEqual(readPackedManifest(resolve(root, 'common.tgz')), {
      name: '@temporalio/common',
      version: '1.26.0',
      dependencies: ['tslib'],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('waitUntilVisible retries until every package is visible', async () => {
  const seen = new Map<string, number>();
  const isPublished = (name: string) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return name === '@temporalio/common' || count > 2;
  };
  const pauses: number[] = [];
  await waitUntilVisible(['@temporalio/common', '@temporalio/client'], '1.26.0', isPublished, 4, 5, async (ms) => {
    pauses.push(ms);
  });
  assert.deepEqual(pauses, [5, 5]);
});
