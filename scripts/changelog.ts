import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type CommandRunner, run } from './utils.ts';

export const repoRoot = resolve(import.meta.dirname, '..');
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  changelogTool`${process.argv.slice(2)}`;
}
