import { spawnSync } from 'node:child_process';

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
  });

  return {
    status: result.status,
    stdout: (result.stdout ?? '').trimEnd(),
    stderr: (result.stderr ?? '').trimEnd(),
  };
}

export function runOrThrow(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = run(command, args, options);
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n');
    throw new Error(`Command failed (${command} ${args.join(' ')}): ${detail || 'unknown error'}`);
  }
  return result.stdout;
}
