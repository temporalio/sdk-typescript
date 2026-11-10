import { run, runOrThrow, type CommandResult } from './run';

export function pnpm(...args: string[]): CommandResult {
  return run('pnpm', args);
}

export function pnpmOrThrow(...args: string[]): string {
  return runOrThrow('pnpm', args);
}

////////////////////////////////////////////////////////////////////////////////////////////////////

export function setVersionRecursive(version: string): void {
  pnpmOrThrow('-r', 'version', version, '--no-git-tag-version');
}

export function installLockfileOnly(): void {
  pnpmOrThrow('install', '--lockfile-only');
}
