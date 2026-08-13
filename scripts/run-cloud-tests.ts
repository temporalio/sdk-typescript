/**
 * Run every Cloud-eligible integration test against the server configured through envconfig.
 *
 * Set TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, and any required TLS or profile variables before
 * running `pnpm test:cloud` locally.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { finished } from 'node:stream/promises';
import { findCloudTestFiles } from './cloud-test-inventory';

const workspaceRoot = join(__dirname, '..');
const testPackage = join(workspaceRoot, 'packages', 'test');
const resultsDirectory = process.env.TEST_RESULTS_DIR ?? join(workspaceRoot, '.test-results');
const tapOutputPath = join(resultsDirectory, 'cloud-integration.tap');

function printTestFiles(testFiles: readonly string[]): void {
  const useGitHubGroup = process.env.GITHUB_ACTIONS === 'true';
  if (useGitHubGroup) console.log(`::group::Cloud test files (${testFiles.length})`);
  else console.log(`Cloud test files (${testFiles.length}):`);

  for (const testFile of testFiles) console.log(`  ${testFile}`);
  if (useGitHubGroup) console.log('::endgroup::');
}

async function runAva(testFiles: readonly string[]): Promise<void> {
  await mkdir(dirname(tapOutputPath), { recursive: true });

  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const child = spawn(pnpm, ['--dir', testPackage, 'exec', 'ava', '--tap', ...testFiles], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      RUN_INTEGRATION_TESTS: process.env.RUN_INTEGRATION_TESTS ?? 'true',
      REUSE_V8_CONTEXT: process.env.REUSE_V8_CONTEXT ?? 'true',
      TEMPORAL_TEST_ENV_CONFIG_SERVER: process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER ?? 'true',
    },
    stdio: ['inherit', 'pipe', 'inherit'],
  });

  if (!child.stdout) throw new Error('AVA did not provide a stdout stream');

  const tapOutput = createWriteStream(tapOutputPath);
  child.stdout.pipe(process.stdout, { end: false });
  child.stdout.pipe(tapOutput);

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  await finished(tapOutput);

  if (result.code !== 0) {
    const status = result.signal === null ? `exit code ${result.code}` : `signal ${result.signal}`;
    throw new Error(`Cloud integration tests failed with ${status}`);
  }
}

async function main(): Promise<void> {
  const testFiles = await findCloudTestFiles();
  printTestFiles(testFiles);
  console.log(`TAP output: ${relative(process.cwd(), tapOutputPath)}`);
  await runAva(testFiles);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
