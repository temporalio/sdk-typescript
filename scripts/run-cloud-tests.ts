/**
 * Run every Cloud-eligible integration test against the server configured through envconfig.
 *
 * Set TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, and any required TLS or profile variables before
 * running `pnpm test:cloud` locally.
 */
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { findCloudTestFiles } from './cloud-test-inventory';

const workspaceRoot = join(__dirname, '..');
const testPackage = join(workspaceRoot, 'packages', 'test');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

// Hard wall-clock cap, comfortably under the CI step's own timeout, so a wedged AVA is killed here
// (with the TAP captured so far) instead of burning the full CI budget.
const AVA_WALL_CLOCK_TIMEOUT_MS = 15 * 60_000;

function printTestFiles(testFiles: readonly string[]): void {
  // Keep stdout as valid TAP so CI can save it directly with `tee`.
  console.error(`Cloud test files (${testFiles.length}):`);
  for (const testFile of testFiles) console.error(`  ${testFile}`);
}

function runAva(testFiles: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpm, ['exec', 'ava', '--tap', ...testFiles], {
      cwd: testPackage,
      env: {
        ...process.env,
        TEMPORAL_TEST_ENV_CONFIG_SERVER: process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER ?? 'true',
      },
      shell: process.platform === 'win32',
      stdio: 'inherit',
      // Run AVA in its own process group (POSIX) so its test workers can be reaped as a tree.
      detached: process.platform !== 'win32',
    });

    // Kill AVA and every process it spawned. A worker that outlives AVA keeps the inherited stdout
    // (the CI `tee` pipe) open, which would otherwise hang the step until its own 20-minute cap.
    const killTree = (): void => {
      const pid = child.pid;
      if (pid == null) return;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/t', '/f']);
      } else {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Process group already gone.
        }
      }
    };

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`\nAVA exceeded ${AVA_WALL_CLOCK_TIMEOUT_MS}ms wall clock; killing process tree.`);
      killTree();
    }, AVA_WALL_CLOCK_TIMEOUT_MS);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (status, signal) => {
      clearTimeout(timer);
      // Reap any workers AVA left behind so they cannot hold the `tee` pipe open after we exit.
      killTree();
      if (timedOut) return resolve(1);
      if (signal) return reject(new Error(`AVA terminated by signal ${signal}`));
      if (status === null) return reject(new Error('AVA terminated without an exit status'));
      resolve(status);
    });
  });
}

async function main(): Promise<void> {
  const testFiles = await findCloudTestFiles();
  printTestFiles(testFiles);
  process.exitCode = await runAva(testFiles);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
