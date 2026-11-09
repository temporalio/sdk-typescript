import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { corePath, repoRoot } from './changelog';
import { prepareRelease } from './prepare-release';

function fixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'sdk-typescript-release-'));
  const files = {
    'package.json': '{"name":"release-fixture","private":true}\n',
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - 'contrib/*'\n  - scripts\n",
    'packages/common/package.json': '{"name":"@temporalio/common","version":"1.24.0"}\n',
    'packages/docs/package.json': '{"name":"@temporalio/docs","private":true}\n',
    'contrib/example/package.json': '{"name":"@temporalio/example","version":"1.24.0"}\n',
    'scripts/package.json': '{"name":"scripts","version":"1.24.0","private":true}\n',
    'CHANGELOG.md': '# Changelog\n\n## [1.24.0] - 2026-09-14\n\n- Previous release.\n',
    'changelog/stabilized/dancing-teapot.md': 'Feature is stable.\nAnother feature is stable.\n',
  };
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), contents);
  }
  mkdirSync(dirname(resolve(root, corePath)), { recursive: true });
  symlinkSync(resolve(repoRoot, corePath), resolve(root, corePath), 'junction');
  return root;
}

test('release preparation updates versions and lockfile, then consumes fragments', () => {
  const root = fixture();
  try {
    const history = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
    prepareRelease('1.25.0', '2026-10-08', root);
    for (const path of ['packages/common', 'contrib/example', 'scripts']) {
      assert.equal(JSON.parse(readFileSync(resolve(root, path, 'package.json'), 'utf8')).version, '1.25.0');
    }
    assert.equal(JSON.parse(readFileSync(resolve(root, 'packages/docs/package.json'), 'utf8')).version, undefined);
    assert.ok(existsSync(resolve(root, 'pnpm-lock.yaml')));
    const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
    assert.ok(changelog.endsWith(history.slice('# Changelog\n\n'.length)));
    assert.match(
      changelog,
      /## \[1\.25\.0\] - 2026-10-08\n\n### Stabilized\n\n- Feature is stable\.\n- Another feature is stable\./
    );
    assert.ok(!existsSync(resolve(root, 'changelog/stabilized/dancing-teapot.md')));
    writeFileSync(resolve(root, 'changelog/stabilized/late-marshmallow.md'), 'Keep for the next release.\n');
    assert.throws(() => prepareRelease('1.25.0', '2026-10-08', root));
    assert.equal(readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8'), changelog);
    assert.ok(existsSync(resolve(root, 'changelog/stabilized/late-marshmallow.md')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid version or date leaves release files untouched', () => {
  const root = fixture();
  try {
    const manifest = readFileSync(resolve(root, 'packages/common/package.json'), 'utf8');
    assert.throws(() => prepareRelease('v1.25.0', '2026-10-08', root));
    assert.throws(() => prepareRelease('1.25.0', '2026-02-30', root));
    assert.equal(readFileSync(resolve(root, 'packages/common/package.json'), 'utf8'), manifest);
    assert.ok(!existsSync(resolve(root, 'pnpm-lock.yaml')));
    assert.ok(existsSync(resolve(root, 'changelog/stabilized/dancing-teapot.md')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
