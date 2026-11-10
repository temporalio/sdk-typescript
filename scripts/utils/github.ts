import { run, runOrThrow, type CommandResult } from './run';
import { getOriginUrl } from './git';

export function gh(repo: string | undefined, ...args: string[]): CommandResult {
  return run('gh', ghArgs(repo, args));
}

export function ghOrThrow(repo: string | undefined, ...args: string[]): string {
  return runOrThrow('gh', ghArgs(repo, args));
}

function ghArgs(repo: string | undefined, extra: string[]): string[] {
  return repo ? ['-R', repo, ...extra] : extra;
}

////////////////////////////////////////////////////////////////////////////////////////////////////

export function resolveRepo(cliRepo: string | undefined): string | undefined {
  if (cliRepo) return cliRepo;
  const url = getOriginUrl();
  const match = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
  return match?.[1];
}

export function findOpenPrNumber(headBranch: string, repo: string | undefined): string | undefined {
  const result = gh(repo, 'pr', 'list', '--head', headBranch, '--state', 'open', '--json', 'number');
  if (result.status !== 0) {
    throw new Error(`Failed to query open PRs: ${result.stderr || result.stdout}`);
  }
  if (!result.stdout) return undefined;
  const prs = JSON.parse(result.stdout) as Array<{ number: number }>;
  return prs[0]?.number?.toString();
}

export function editPrBody(prNumber: string, body: string, repo: string | undefined): void {
  ghOrThrow(repo, 'pr', 'edit', prNumber, '--body', body);
}

export function createPr(options: {
  base: string;
  head: string;
  title: string;
  body: string;
  repo: string | undefined;
}): string {
  return ghOrThrow(
    options.repo,
    'pr',
    'create',
    '--base',
    options.base,
    '--head',
    options.head,
    '--title',
    options.title,
    '--body',
    options.body
  );
}

export function addLabel(prNumber: string, label: string, repo: string | undefined): void {
  ghOrThrow(repo, 'pr', 'edit', prNumber, '--add-label', label);
}

/** Requires the repository's "Allow auto-merge" setting. Squash-merges once required checks pass. */
export function enableAutoMerge(prNumber: string, repo: string | undefined): void {
  ghOrThrow(repo, 'pr', 'merge', prNumber, '--squash', '--auto');
}
