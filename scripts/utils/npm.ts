import { run, runOrThrow, type CommandResult } from './run';

export function npm(...args: string[]): CommandResult {
  return run('npm', args);
}

export function npmOrThrow(...args: string[]): string {
  return runOrThrow('npm', args);
}

////////////////////////////////////////////////////////////////////////////////////////////////////

export function isPublished(packageName: string, version: string): boolean {
  return npm('view', `${packageName}@${version}`, 'version').status === 0;
}
