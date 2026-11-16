import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionContext } from 'ava';

const shell = process.platform === 'win32';
export const npm = shell ? 'npm.cmd' : 'npm';
const npx = shell ? 'npx.cmd' : 'npx';
const failureTailLines = 60;

/** Version of the `@temporalio/*` packages under test; set by `scripts/run.ts`. */
export const sdkVersion: string =
  process.env.TEMPORAL_E2E_SDK_VERSION ??
  JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;

/** A new temporary directory, deleted when the test ends. */
export function tempDir(t: ExecutionContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'temporal-test-e2e-'));
  t.teardown(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

function logPath(name: string): string {
  const dir = process.env.TEST_RESULTS_DIR || join(process.cwd(), '.test-results');
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

/**
 * Runs a command to completion and returns its combined output, which is also written to the log file `logName`.
 * Throws if the command exits non-zero, with the tail of its output.
 */
export async function runLogged(
  command: string,
  args: string[],
  options: SpawnOptions,
  logName: string
): Promise<string> {
  const path = logPath(logName);
  const log = createWriteStream(path);
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], shell });
  let output = '';
  const capture = (chunk: Buffer) => {
    output += chunk.toString();
    log.write(chunk);
  };
  child.stdout!.on('data', capture);
  child.stderr!.on('data', capture);
  const result = await new Promise<number | NodeJS.Signals | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(signal ?? code));
  }).finally(() => new Promise<void>((resolve) => log.end(resolve)));
  if (result !== 0) {
    const tail = output.split('\n').slice(-failureTailLines).join('\n');
    throw new Error(`${command} ${args.join(' ')} exited with ${result}; tail of ${path}:\n${tail}`);
  }
  return output;
}

/** Starts a long-running command, with its output written to the log file `logName`. Stop it with `stopProcess`. */
export function startLogged(command: string, args: string[], options: SpawnOptions, logName: string): ChildProcess {
  const log = createWriteStream(logPath(logName));
  // Detached on POSIX so that `stopProcess` can signal the whole process group (npm, then node).
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], detached: !shell, shell });
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  child.once('close', () => log.end());
  return child;
}

export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  if (shell) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f']);
  } else {
    process.kill(-child.pid, 'SIGINT');
  }
  await closed;
}

/** `env` without the `TEMPORAL_*` variables, which would point the samples at another server. */
export function withoutTemporalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('TEMPORAL_')));
}

export interface Sample {
  /** Directory of the sample in the samples-typescript repo. */
  name: string;
  /** npm script that runs a workflow, once the sample's worker is started. */
  script: string;
  /** A line the script must print. */
  expectedOutput: string;
  /** Environment variables for the sample, on top of this process's (minus `TEMPORAL_*`). */
  env?: NodeJS.ProcessEnv;
}

/** Creates the sample project with `@temporalio/create`, then starts its worker and runs one of its workflows. */
export async function testSample(t: ExecutionContext, { name, script, expectedOutput, env }: Sample): Promise<void> {
  const root = tempDir(t);
  const dir = join(root, name);
  const sampleEnv = { ...withoutTemporalEnv(process.env), ...env };

  await runLogged(
    npx,
    [
      '--yes',
      // FIXME: `min-release-age-exclude` is ignored by `npm exec` (and so by npx). It resolves the
      // package to run through pacote with the `before` date already set, and never checks the
      // exclusion list, so a freshly published @temporalio/create is rejected. `--min-release-age=0`
      // clears that cutoff for this command only; npm does not export it to child processes, so the
      // sample's own `npm install` still honors the exclusion in the registry `.npmrc`.
      '--min-release-age=0',
      '--',
      `@temporalio/create@${sdkVersion}`,
      dir,
      '--no-git-init',
      '--sdk-version',
      sdkVersion,
      '--sample',
      `https://github.com/temporalio/samples-typescript/tree/main/${name}`,
    ],
    { cwd: root, env: sampleEnv },
    `sample-${name}-create.log`
  );

  const worker = startLogged(npm, ['start'], { cwd: dir, env: sampleEnv }, `sample-${name}-worker.log`);
  try {
    const output = await runLogged(npm, ['run', script], { cwd: dir, env: sampleEnv }, `sample-${name}-${script}.log`);
    t.true(output.includes(`${expectedOutput}\n`), `\`npm run ${script}\` must print "${expectedOutput}"`);
  } finally {
    await stopProcess(worker);
  }
}
