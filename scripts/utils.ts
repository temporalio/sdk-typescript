import { ChildProcess, spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class ChildProcessError extends Error {
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

interface RunOptions extends SpawnSyncOptions {
  /** Program to run. The template is then only its arguments: `git`status --porcelain`. */
  command?: string;
  /** Arguments inserted before the template arguments. */
  args?: string[];
}

type CommandValue = string | number | readonly string[];

export interface CommandRunner {
  (strings: TemplateStringsArray, ...values: CommandValue[]): string;
  /** Returns a runner with these options merged over the ones already bound. */
  (options: RunOptions): CommandRunner;
}

/**
 * Runs a command to completion and returns its stdout. Throws if the command fails to start or exits non-zero.
 *
 * The command is a template literal. Its literal text is split on whitespace into arguments, and each
 * interpolated value is part of exactly one argument, so values need no quoting or escaping. An interpolated
 * array becomes one argument per element, and must be separated from surrounding text by whitespace.
 * Nothing goes through a shell.
 *
 * Calling the runner with options returns a new runner. The new options merge over the ones already bound.
 *
 * ```ts
 * run`git commit --message ${title}`;
 * const git = run({ command: 'git' });
 * git`status --porcelain`;
 * git`add ${paths}`;
 * const gh = run({ command: 'gh' });
 * gh({ input: body })`pr create --body-file -`;
 * ```
 */
export function run(strings: TemplateStringsArray, ...values: CommandValue[]): string;
export function run(options: RunOptions): CommandRunner;
export function run(first: TemplateStringsArray | RunOptions, ...values: CommandValue[]): string | CommandRunner {
  if ('raw' in first) return execute(first, values, {});
  return runner(first);
}

function runner(options: RunOptions): CommandRunner {
  function command(strings: TemplateStringsArray, ...values: CommandValue[]): string;
  function command(override: RunOptions): CommandRunner;
  function command(first: TemplateStringsArray | RunOptions, ...values: CommandValue[]): string | CommandRunner {
    if ('raw' in first) return execute(first, values, options);
    return runner({ ...options, ...first });
  }
  return command;
}

function execute(strings: TemplateStringsArray, values: CommandValue[], options: RunOptions): string {
  const { command: commandOption, args: leadingArgs = [], ...spawnOptions } = options;
  const parts = [...leadingArgs, ...splitCommand(strings, values, commandOption !== undefined)];
  const command = commandOption ?? parts.shift();
  if (!command) throw new Error('Expected a command to run');
  const result = spawnSync(command, parts, { stdio: ['pipe', 'pipe', 'inherit'], ...spawnOptions, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new ChildProcessError(
      `${[command, ...parts].join(' ')} failed (${result.status ?? result.signal})`,
      result.status,
      result.signal
    );
  }
  return typeof result.stdout === 'string' ? result.stdout.trimEnd() : '';
}

function splitCommand(strings: TemplateStringsArray, values: CommandValue[], allowEmpty: boolean): string[] {
  const args: string[] = [];
  let current: string | undefined;
  strings.forEach((text, i) => {
    for (const part of text.split(/(\s+)/)) {
      if (/^\s+$/.test(part)) {
        if (current !== undefined) args.push(current);
        current = undefined;
      } else if (part) {
        current = (current ?? '') + part;
      }
    }
    if (i >= values.length) return;
    const value = values[i];
    if (Array.isArray(value)) {
      const next = strings[i + 1];
      const standsAlone = current === undefined && (next === '' ? i + 1 === values.length : /^\s/.test(next));
      if (!standsAlone) throw new Error('An interpolated array must be separated from surrounding text by whitespace');
      args.push(...value);
    } else {
      // Text and values that touch, as in `--flag=${value}`, form a single argument.
      current = (current ?? '') + String(value);
    }
  });
  if (current !== undefined) args.push(current);
  if (args.length === 0 && !allowEmpty) throw new Error('Expected a command to run');
  return args;
}

/**
 * pnpm as started by the current `pnpm run`. `npm_execpath` is a JavaScript entry point when pnpm is
 * installed through npm, and a native binary otherwise, so a script entry point is run with node.
 */
export function pnpm(options: SpawnSyncOptions = {}): CommandRunner {
  const bin = process.env.npm_execpath;
  if (!bin) throw new Error('Run this command with pnpm');
  if (/\.[cm]?js$/.test(bin)) return run({ ...options, command: process.execPath, args: [bin] });
  return run({ ...options, command: bin });
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

export async function kill(child: ChildProcess, signal: NodeJS.Signals = 'SIGINT'): Promise<void> {
  if (typeof child.pid !== 'number') {
    throw new TypeError('Expected child with pid');
  }

  // -PID not supported on Windows
  if (process.platform === 'win32') {
    process.kill(child.pid, signal);
  } else {
    process.kill(-child.pid, signal);
  }

  try {
    await waitOnChild(child);
  } catch (err: unknown) {
    const signalNumber = getSignalNumber(signal);

    // Ignore the error if it simply indicates process termination due to the signal we just sent.
    // On Unix, a process may complete with exit code 128 + signal number to indicate
    // that it was terminated by a signal. But we have the signal name.
    const shouldIgnore =
      err instanceof ChildProcessError &&
      (process.platform === 'win32' || err.signal === signal || err.code === 128 + signalNumber);

    if (!shouldIgnore) throw err;
  }
}

function getSignalNumber(signal: NodeJS.Signals): number {
  // We don't need any other signals for now, and probably never will, so no need to list them all.
  // But if any other signals ends up being needed, look at `man 3 signal` for the complete list.
  const SIGNAL_NUMBERS = {
    SIGINT: 2,
    SIGTERM: 15,
  } as Record<NodeJS.Signals, number>;

  if (signal in SIGNAL_NUMBERS) return SIGNAL_NUMBERS[signal];
  throw new TypeError(`Unknown signal in getSignalNumber: '${signal}'. Please add a case for that signal.`);
}

/** Full path to an archived CI log; honors TEST_RESULTS_DIR so it lands with the test artifact. */
export function ciLogPath(name: string): string {
  const dir = process.env.TEST_RESULTS_DIR || join(process.cwd(), '.test-results');
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

// Like spawnNpx, but keeps the (typically very noisy) child output off the console.
const FAILURE_TAIL_LINES = 60;
export async function spawnNpxLogged(
  args: string[],
  opts: SpawnOptions,
  logPath: string,
  label: string
): Promise<void> {
  const npx = /^win/.test(process.platform) ? 'npx.cmd' : 'npx';
  const npxArgs = ['--prefer-offline', '--timing=true', '--yes', '--', ...args];
  const child = spawn(npx, npxArgs, { ...opts, stdio: ['inherit', 'pipe', 'pipe'], shell });

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
