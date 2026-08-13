/**
 * Run every Cloud-eligible integration test against the server configured through envconfig.
 *
 * Set TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, and any required TLS or profile variables before
 * running `pnpm test:cloud` locally.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { findCloudTestFiles } from './cloud-test-inventory';

const workspaceRoot = join(__dirname, '..');
const testPackage = join(workspaceRoot, 'packages', 'test');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function printTestFiles(testFiles: readonly string[]): void {
  // Keep stdout as valid TAP so CI can save it directly with `tee`.
  console.error(`Cloud test files (${testFiles.length}):`);
  for (const testFile of testFiles) console.error(`  ${testFile}`);
}

function runAva(testFiles: readonly string[]): number {
  const result = spawnSync(pnpm, ['exec', 'ava', '--tap', ...testFiles], {
    cwd: testPackage,
    env: {
      ...process.env,
      TEMPORAL_TEST_ENV_CONFIG_SERVER: process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER ?? 'true',
    },
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.signal) throw new Error(`AVA terminated by signal ${result.signal}`);
  if (result.status === null) throw new Error('AVA terminated without an exit status');
  return result.status;
}

async function main(): Promise<void> {
  const testFiles = await findCloudTestFiles();
  printTestFiles(testFiles);
  process.exitCode = runAva(testFiles);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
