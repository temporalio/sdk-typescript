import { run, runOrThrow, type CommandResult } from './run';

export function git(...args: string[]): CommandResult {
  return run('git', args);
}

export function gitOrThrow(...args: string[]): string {
  return runOrThrow('git', args);
}

////////////////////////////////////////////////////////////////////////////////////////////////////

export function assertCleanWorkingTree(): void {
  const status = gitOrThrow('status', '--porcelain');
  if (status.length > 0) {
    throw new Error('Working tree is not clean. Commit or stash changes before running release-prepare.');
  }
}

export function fetchBranch(branch: string): void {
  gitOrThrow('fetch', 'origin', branch);
}

export function remoteBranchExists(branch: string): boolean {
  return git('rev-parse', '--verify', `origin/${branch}`).status === 0;
}

export function currentBranch(): string {
  return gitOrThrow('rev-parse', '--abbrev-ref', 'HEAD');
}

export function remoteHasBranch(branch: string): boolean {
  return git('ls-remote', '--heads', 'origin', branch).stdout.length > 0;
}

export function checkoutBranch(branch: string): void {
  gitOrThrow('checkout', branch);
}

export function checkoutNewBranch(branch: string, startPoint?: string): void {
  if (startPoint) {
    gitOrThrow('checkout', '-B', branch, startPoint);
  } else {
    gitOrThrow('checkout', '-B', branch);
  }
}

export function mergeFastForward(ref: string): void {
  gitOrThrow('merge', '--ff-only', ref);
}

export function revParse(ref: string): string {
  return gitOrThrow('rev-parse', ref);
}

export function stageAll(): void {
  gitOrThrow('add', '-A');
}

export function hasStagedChanges(): boolean {
  return git('diff', '--cached', '--quiet').status !== 0;
}

export function commit(message: string): void {
  gitOrThrow('commit', '-m', message);
}

export function pushBranchForceWithLease(branch: string): void {
  gitOrThrow('push', '--force-with-lease', 'origin', branch);
}

export function setIdentity(name: string, email: string): void {
  gitOrThrow('config', 'user.name', name);
  gitOrThrow('config', 'user.email', email);
}

/** Push a new branch, or replace an existing one only if nobody else has moved it. */
export function pushReleaseBranch(branch: string): void {
  const fetched = git('fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`);
  if (fetched.status === 0) {
    gitOrThrow('push', '--force-with-lease', 'origin', branch);
  } else {
    gitOrThrow('push', '--set-upstream', 'origin', branch);
  }
}

export function getOriginUrl(): string {
  return gitOrThrow('remote', 'get-url', 'origin');
}
