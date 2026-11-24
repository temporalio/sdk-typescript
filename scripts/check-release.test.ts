import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { corePath, repoRoot } from './changelog';
import { changelogSectionProblem, mismatchedPackageVersions, releaseBranchProblem } from './check-release';

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(resolve(tmpdir(), 'sdk-typescript-check-release-'));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), contents);
  }
  mkdirSync(dirname(resolve(root, corePath)), { recursive: true });
  symlinkSync(resolve(repoRoot, corePath), resolve(root, corePath), 'junction');
  return root;
}

test('package version check reports every versioned package not at the version', () => {
  const root = fixture({
    'packages/client/package.json': '{"name":"@temporalio/client","version":"1.25.0"}\n',
    'packages/common/package.json': '{"name":"@temporalio/common","version":"1.24.0"}\n',
    'packages/docs/package.json': '{"name":"@temporalio/docs","private":true}\n',
    'contrib/example/package.json': '{"name":"@temporalio/example","version":"0.0.1"}\n',
    'scripts/package.json': '{"name":"scripts","version":"1.24.0","private":true}\n',
  });
  try {
    assert.deepEqual(mismatchedPackageVersions('1.25.0', root), [
      'contrib/example/package.json 0.0.1',
      'packages/common/package.json 1.24.0',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('changelog check requires a section with at least one entry', () => {
  const root = fixture({
    'CHANGELOG.md':
      '# Changelog\n\n## [1.25.0] - 2026-10-08\n\n### Fixed\n\n- A fix.\n\n## [1.24.0] - 2026-09-14\n\n## [1.23.0] - 2026-08-01\n\n- Older.\n',
  });
  try {
    assert.equal(changelogSectionProblem('1.25.0', root), undefined);
    assert.match(changelogSectionProblem('1.24.0', root) ?? '', /section for 1\.24\.0 is empty/);
    assert.match(changelogSectionProblem('1.26.0', root) ?? '', /Cannot read the changelog section for 1\.26\.0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('branch check accepts main and the matching release branch only', () => {
  assert.equal(releaseBranchProblem('1.25.1', 'main'), undefined);
  assert.equal(releaseBranchProblem('1.25.1', 'releases/1.25.x'), undefined);
  assert.equal(releaseBranchProblem('1.25.0-rc.1', 'releases/1.25.x'), undefined);
  assert.match(
    releaseBranchProblem('1.25.1', 'releases/1.24.x') ?? '',
    /main or releases\/1\.25\.x, not releases\/1\.24\.x/
  );
  assert.match(releaseBranchProblem('1.25.1', 'release-1.25.1-bump') ?? '', /not release-1\.25\.1-bump/);
  assert.match(releaseBranchProblem('1.25.1', '') ?? '', /not a detached HEAD/);
});
