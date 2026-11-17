import { spawnSync, type SpawnSyncOptions } from 'node:child_process';

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
