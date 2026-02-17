import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import { Context } from '@temporalio/activity';
import { parseTapOutput } from './tap-parser';
import type { TestFile, TestBatchResult, FlakyTest } from './types';

const TEST_PKG_DIR = path.resolve(__dirname, '../..');

export async function discoverTests(): Promise<TestFile[]> {
  const pattern = './lib/test-*.js';
  const files = await glob(pattern, { cwd: TEST_PKG_DIR });
  console.log(`Discovered ${files.length} test files`);
  return files.sort();
}

export async function runTests(files: TestFile[], env?: Record<string, string>): Promise<TestBatchResult> {
  const ctx = Context.current();

  // Resume from last heartbeat checkpoint if this is a retry after worker crash
  const checkpoint = ctx.info.heartbeatDetails as TestBatchResult | undefined;
  const completedFiles = new Set([...(checkpoint?.passed ?? []), ...(checkpoint?.failed ?? [])]);
  const result: TestBatchResult = {
    passed: [...(checkpoint?.passed ?? [])],
    failed: [...(checkpoint?.failed ?? [])],
    failureDetails: { ...(checkpoint?.failureDetails ?? {}) },
  };

  const remainingFiles = files.filter((f) => !completedFiles.has(f));

  if (checkpoint && completedFiles.size > 0) {
    console.log(
      `Resuming from checkpoint: ${completedFiles.size} files already completed, ${remainingFiles.length} remaining`
    );
  }

  console.log(`Running ${remainingFiles.length} test file(s)`);

  for (const file of remainingFiles) {
    console.log(`Running: ${file}`);
    const fileResult = await runSingleFile(file, env);

    if (fileResult.failed.length > 0) {
      result.failed.push(file);
      result.failureDetails[file] = fileResult.failureDetails[file] ?? [];
      console.log(`FAIL: ${file}`);
    } else {
      result.passed.push(file);
      console.log(`PASS: ${file}`);
    }

    // Heartbeat with accumulated results so this activity can resume here on retry
    ctx.heartbeat(result);
  }

  console.log(`Finished: ${result.passed.length} passed, ${result.failed.length} failed`);
  return result;
}

function runSingleFile(file: TestFile, env?: Record<string, string>): Promise<TestBatchResult> {
  const avaPath = path.resolve(TEST_PKG_DIR, 'node_modules/.bin/ava');
  const args = ['--tap', '--timeout', '60s', '--no-worker-threads', file];

  return new Promise<TestBatchResult>((resolve, reject) => {
    const child = spawn(avaPath, args, {
      cwd: TEST_PKG_DIR,
      env: {
        ...process.env,
        ...env,
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60 * 1000,
      // On Windows, .bin entries are .cmd files that need a shell to execute
      shell: process.platform === 'win32',
    });

    const stdoutChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('ok ') || trimmed.startsWith('not ok ')) {
          console.log(trimmed);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString();
      if (code !== null && code !== 0 && stdout.length === 0) {
        reject(new Error(`AVA exited with code ${code} and no output for ${file}`));
      } else {
        resolve(parseTapOutput(stdout, [file]));
      }
    });
  });
}

export async function alertFlakes(flakes: FlakyTest[]): Promise<void> {
  if (flakes.length === 0) return;

  const lines = ['## Flaky Tests Detected', ''];
  for (const flake of flakes) {
    lines.push(`- **${flake.file}** passed on attempt ${flake.attemptsToPass}`);
  }
  const summary = lines.join('\n');

  console.log(summary);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await fs.promises.appendFile(summaryPath, summary + '\n');
  }
}
