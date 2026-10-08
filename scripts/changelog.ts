import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const repoRoot = resolve(__dirname, '..');
export const corePath = 'packages/core-bridge/sdk-core';

export function runTool(args: string[], root = repoRoot): void {
  const core = resolve(root, corePath);
  const result = spawnSync(
    'cargo',
    [
      'run',
      '--manifest-path',
      resolve(core, 'crates/changelog-release-notes/Cargo.toml'),
      '--bin',
      'changelog-tool',
      '--',
      ...args,
      '--repo',
      root,
    ],
    { cwd: core, stdio: 'inherit' }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Changelog tool failed (${result.status ?? result.signal})`);
}

if (require.main === module) runTool(process.argv.slice(2));
