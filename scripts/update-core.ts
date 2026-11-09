import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { corePath, repoRoot, runTool } from './changelog';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  runTool(['update-core', '--help']);
} else {
  runTool(['update-core', '--submodule', corePath, ...args]);
  const result = spawnSync('cargo', ['fetch'], { cwd: resolve(repoRoot, 'packages/core-bridge'), stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Bridge lockfile refresh failed (${result.status ?? result.signal})`);
}
