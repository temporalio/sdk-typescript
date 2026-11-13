import { resolve } from 'node:path';
import { CommandRunner, run } from './utils';

export const repoRoot = resolve(__dirname, '..');
export const corePath = 'packages/core-bridge/sdk-core';

/** `changelog-tool` against `root`. Its output is inherited, so build progress stays visible. */
export function changelogToolFor(root: string): CommandRunner {
  const core = resolve(root, corePath);
  return run({
    command: 'cargo',
    cwd: core,
    stdio: 'inherit',
    args: [
      'run',
      '--manifest-path',
      resolve(core, 'crates/changelog-release-notes/Cargo.toml'),
      '--bin',
      'changelog-tool',
      '--',
      '--repo',
      root,
    ],
  });
}

/** `changelog-tool` against this repository. */
export const changelogTool = changelogToolFor(repoRoot);

if (require.main === module) {
  changelogTool`${process.argv.slice(2)}`;
}
