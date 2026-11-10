import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { corePath, repoRoot } from '../changelog';
import {
  assertVersionIsNewer,
  expectedBaseBranch,
  prepareRelease,
  unexpectedReleasePaths,
  validateReleaseType,
} from '../release-prepare';

////////////////////////////////////////////////////////////////////////////////////////////////////
// prepareRelease: versions, lockfile, and fragment consumption.
// Transferred from scripts/prepare-release.test.ts.
////////////////////////////////////////////////////////////////////////////////////////////////////

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

////////////////////////////////////////////////////////////////////////////////////////////////////
// validateReleaseType
////////////////////////////////////////////////////////////////////////////////////////////////////

test('validateReleaseType: ga accepts a non-prerelease version', () => {
  validateReleaseType('1.2.3', 'ga');
});

test('validateReleaseType: ga rejects a prerelease version', () => {
  assert.throws(() => validateReleaseType('1.2.3-rc.1', 'ga'));
  assert.throws(() => validateReleaseType('1.2.3-beta.1', 'ga'));
  assert.throws(() => validateReleaseType('1.2.3-alpha.1', 'ga'));
});

test('validateReleaseType: rc accepts rc.N and rejects others', () => {
  validateReleaseType('1.2.3-rc.1', 'rc');
  assert.throws(() => validateReleaseType('1.2.3', 'rc'));
  assert.throws(() => validateReleaseType('1.2.3-beta.1', 'rc'));
});

test('validateReleaseType: beta accepts beta.N and rejects others', () => {
  validateReleaseType('1.2.3-beta.1', 'beta');
  assert.throws(() => validateReleaseType('1.2.3', 'beta'));
  assert.throws(() => validateReleaseType('1.2.3-rc.1', 'beta'));
});

test('validateReleaseType: alpha accepts alpha.N and rejects others', () => {
  validateReleaseType('1.2.3-alpha.1', 'alpha');
  assert.throws(() => validateReleaseType('1.2.3', 'alpha'));
  assert.throws(() => validateReleaseType('1.2.3-beta.1', 'alpha'));
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// assertVersionIsNewer
////////////////////////////////////////////////////////////////////////////////////////////////////

test('assertVersionIsNewer: greater version needs a bump', () => {
  assert.equal(assertVersionIsNewer('1.2.4', '1.2.3'), true);
});

test('assertVersionIsNewer: lower version throws', () => {
  assert.throws(() => assertVersionIsNewer('1.2.2', '1.2.3'));
});

test('assertVersionIsNewer: same version is already prepared', () => {
  assert.equal(assertVersionIsNewer('1.2.3', '1.2.3'), false);
});

// When run on the release-1.17 branch, current is 1.17.3 even if main is on 1.18.0.
test('assertVersionIsNewer: patch on an older line (1.17.4 on release-1.17 with current 1.17.3)', () => {
  assert.equal(assertVersionIsNewer('1.17.4', '1.17.3'), true);
});

// In semver, 1.2.3-rc.1 < 1.2.3, so publishing an RC after the GA on the same triplet must fail.
test('assertVersionIsNewer: rejects prerelease on a GA-published triplet (1.2.3-rc.1 with current 1.2.3)', () => {
  assert.throws(() => assertVersionIsNewer('1.2.3-rc.1', '1.2.3'));
});

// On release-1.4 with current 1.4.4 (1.5.x already shipped from main), 1.4.5-rc.1 is valid.
test('assertVersionIsNewer: patch prerelease on an older line (1.4.5-rc.1 with current 1.4.4)', () => {
  assert.equal(assertVersionIsNewer('1.4.5-rc.1', '1.4.4'), true);
});

test('assertVersionIsNewer: next rc on the same triplet (1.18.0-rc.2 with current 1.18.0-rc.1)', () => {
  assert.equal(assertVersionIsNewer('1.18.0-rc.2', '1.18.0-rc.1'), true);
});

test('assertVersionIsNewer: GA after its own rc (1.18.0 with current 1.18.0-rc.3)', () => {
  assert.equal(assertVersionIsNewer('1.18.0', '1.18.0-rc.3'), true);
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// expectedBaseBranch
////////////////////////////////////////////////////////////////////////////////////////////////////

test('expectedBaseBranch: on the matching release branch', () => {
  assert.equal(
    expectedBaseBranch({
      targetVersion: '1.17.4',
      currentBranch: 'releases/1.17.x',
    }),
    'releases/1.17.x'
  );
});

test('expectedBaseBranch: on main with matching X.Y and no back-port branch', () => {
  assert.equal(
    expectedBaseBranch({
      targetVersion: '1.18.1',
      currentBranch: 'main',
      mainVersion: '1.18.0',
      releaseBranchExistsOnRemote: false,
    }),
    'main'
  );
});

test('expectedBaseBranch: on main but target X.Y differs from main', () => {
  assert.throws(() =>
    expectedBaseBranch({
      targetVersion: '1.17.4',
      currentBranch: 'main',
      mainVersion: '1.18.0',
      releaseBranchExistsOnRemote: false,
    })
  );
});

test('expectedBaseBranch: on main but releases/X.Y.x already exists on origin', () => {
  assert.throws(() =>
    expectedBaseBranch({
      targetVersion: '1.18.1',
      currentBranch: 'main',
      mainVersion: '1.18.0',
      releaseBranchExistsOnRemote: true,
    })
  );
});

test('expectedBaseBranch: on the wrong release branch', () => {
  assert.throws(() =>
    expectedBaseBranch({
      targetVersion: '1.17.4',
      currentBranch: 'releases/1.16.x',
    })
  );
});

test('expectedBaseBranch: on a feature branch', () => {
  assert.throws(() =>
    expectedBaseBranch({
      targetVersion: '1.17.4',
      currentBranch: 'feature-something',
    })
  );
});

test('expectedBaseBranch: prerelease versions resolve to the same release branch', () => {
  assert.equal(
    expectedBaseBranch({
      targetVersion: '1.18.0-rc.1',
      currentBranch: 'main',
      mainVersion: '1.18.0-rc.0',
      releaseBranchExistsOnRemote: false,
    }),
    'main'
  );
  assert.equal(
    expectedBaseBranch({
      targetVersion: '1.4.5-rc.1',
      currentBranch: 'releases/1.4.x',
    }),
    'releases/1.4.x'
  );
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// Diff guard
////////////////////////////////////////////////////////////////////////////////////////////////////

test('unexpectedReleasePaths: accepts the release file set and rejects anything else', () => {
  const allowed = [
    ' M packages/client/package.json',
    ' M scripts/package.json',
    ' M pnpm-lock.yaml',
    ' M CHANGELOG.md',
    ' D changelog/fixed/tap-dancing-teapot.md',
  ].join('\n');
  assert.deepEqual(unexpectedReleasePaths(allowed), []);

  const rejected = unexpectedReleasePaths(
    [' M README.md', '?? notes.txt', ' D packages/client/package.json', ' M changelog/fixed/tap-dancing-teapot.md'].join('\n')
  );
  assert.equal(rejected.length, 4);
});
