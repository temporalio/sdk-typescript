import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

class ChildProcessError extends Error {
  public readonly code: number | null;
  public readonly signal: NodeJS.Signals | null;

  constructor(message: string, code: number | null, signal: NodeJS.Signals | null) {
    super(message);
    this.name = 'ChildProcessError';
    this.code = code;
    this.signal = signal;
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
 * Runs a command already on PATH and keeps its (typically very noisy) output off the console.
 *
 * Don't route through npx: on Windows, `npx -- pnpm` runs npx's own cached pnpm, whose shim
 * cmd.exe can't execute.
 */
const FAILURE_TAIL_LINES = 60;
export async function spawnLogged(
  command: string,
  args: string[],
  opts: SpawnOptions,
  logPath: string,
  label: string
): Promise<void> {
  const child = spawn(command, args, { ...opts, stdio: ['inherit', 'pipe', 'pipe'], shell });

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
