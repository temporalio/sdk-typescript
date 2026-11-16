import { ChildProcess, spawn, SpawnOptions } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

class ChildProcessError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly signal: NodeJS.Signals | null
  ) {
    super(message);
    this.name = 'ChildProcessError';
  }
}

export const shell = /^win/.test(process.platform);

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitOnChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.on('exit', (code: number, signal: NodeJS.Signals) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new ChildProcessError('Process failed', code, signal as NodeJS.Signals));
      }
    });
    child.on('error', reject);
  });
}

/** Full path to an archived CI log; honors TEST_RESULTS_DIR so it lands with the test artifact. */
export function ciLogPath(name: string): string {
  const dir = process.env.TEST_RESULTS_DIR || join(process.cwd(), '.test-results');
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

/**
 * Runs a command already on PATH and keeps its output in `logPath`.
 *
 * On Windows Node wraps `.cmd` shims itself. `shell: true` quotes the command a second time,
 * which is how `npx -- pnpm` produced a path cmd.exe could not run.
 */
const FAILURE_TAIL_LINES = 60;
export async function spawnLogged(
  command: string,
  args: string[],
  opts: SpawnOptions,
  logPath: string,
  label: string
): Promise<void> {
  const executable = shell && !/\.(cmd|exe)$/i.test(command) ? `${command}.cmd` : command;
  const child = spawn(executable, args, { ...opts, stdio: ['inherit', 'pipe', 'pipe'], shell: false });

  const out = createWriteStream(logPath);
  const tail: string[] = [];
  let partial = '';
  const capture = (chunk: string) => {
    out.write(chunk);
    partial += chunk;
    let idx;
    while ((idx = partial.indexOf('\n')) !== -1) {
      tail.push(partial.slice(0, idx));
      if (tail.length > FAILURE_TAIL_LINES) tail.shift();
      partial = partial.slice(idx + 1);
    }
  };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', capture);
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', capture);

  const flush = () => new Promise<void>((resolve) => out.end(resolve));

  try {
    await waitOnChild(child);
    await flush();
    console.log(`✓ ${label}`);
  } catch (err) {
    await flush();
    if (partial) tail.push(partial);
    console.error(`✗ ${label} failed — tail of ${logPath}:\n${tail.join('\n')}`);
    throw err;
  }
}
