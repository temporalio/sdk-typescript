import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { globSync } from 'glob';
import semver from 'semver';
import { changelogToolFor } from './changelog';
import { pnpm, run } from './utils';

const repoRoot = resolve(__dirname, '..');
const git = run({ cwd: repoRoot, command: 'git' });
const gh = run({ cwd: repoRoot, command: 'gh' });

function main(): void {
  const { version, date, openPr } = parseArguments();
  const packageJsons = packageJsonsWithVersion(repoRoot);

  const pullRequest = openPr ? planPullRequest(version) : undefined;
  if (pullRequest && packageJsons.every(({ json }) => json.version === version)) {
    console.log(`Packages are already at ${version}; nothing to do`);
    return;
  }

  try {
    bumpPackageVersions(version, packageJsons);
    updateLockfile();
    const changelogNotes = rollChangelog(version, date);

    if (pullRequest) {
      openPullRequest({ ...pullRequest, body: changelogNotes });
    }
  } catch (error) {
    console.warn('Warning: release preparation failed and the working copy is left in an unstable state');
    throw error;
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

const help = `Usage: pnpm release:prepare <version> [options]

Update package versions, the lockfile, and the changelog for a release.

Options:
  --date <YYYY-MM-DD>  Release date (default: today, UTC)
  --open-pr            Also commit the changes on release-<version>-bump, push that branch,
                       open or update a pull request, then check out the original branch.
                       Must run from a clean main or releases/X.Y.x checkout that matches its upstream.
  -h, --help           Show this help
`;

function parseArguments(args = process.argv.slice(2)) {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        date: { type: 'string' },
        'open-pr': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      console.log(help);
      process.exit(0);
    }
    if (positionals.length !== 1) throw new Error('Expected one release version; see --help');

    const [version] = positionals;
    parseVersion(version);
    return {
      version,
      date: parseDate(values.date ?? new Date().toISOString().slice(0, 10)),
      openPr: values['open-pr'] ?? false,
    };
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

export function parseVersion(version: string): semver.SemVer {
  const parsed = semver.parse(version);
  if (!parsed || parsed.version !== version) {
    throw new Error('Expected a release version such as 1.25.0 or 1.25.0-rc.1');
  }
  return parsed;
}

function parseDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error('Expected a release date in YYYY-MM-DD format');
  }
  return date;
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Package.json management
////////////////////////////////////////////////////////////////////////////////////////////////////

interface PackageJson {
  readonly path: string;
  readonly json: { version: string; [key: string]: unknown };
}

/**
 * List all "package.json" files under "packages/" and "contrib/" that declare a version.
 */
export function packageJsonsWithVersion(root: string): PackageJson[] {
  const packageJsons: PackageJson[] = [];
  for (const path of globSync('{packages,contrib}/*/package.json', { cwd: root, absolute: true })) {
    const json = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof json.version === 'string') packageJsons.push({ path, json });
  }
  return packageJsons;
}

/**
 * Bump the versions of the given packages to `version`.
 */
export function bumpPackageVersions(version: string, packageJsons: PackageJson[]): void {
  for (const { path, json } of packageJsons) {
    json.version = version;
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  }
}

/**
 * Update PNPM's lockfile.
 */
export function updateLockfile(root = repoRoot): void {
  pnpm({ cwd: root, stdio: 'inherit' })`install --lockfile-only --ignore-scripts`;
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Pull Request creation
////////////////////////////////////////////////////////////////////////////////////////////////////

interface PullRequest {
  /** The title of the pull request (e.g. "chore: prepare for 1.25.0 release"). */
  readonly title: string;

  /** The target branch for the pull request (e.g. "main" or "releases/1.25.x"). */
  readonly base: string;

  /** The branch for the pull request (e.g. "release-1.25.0-bump"). */
  readonly head: string;

  /** The remote the base branch tracks (e.g. "origin"), where the bump branch is pushed. */
  readonly remote: string;

  /**
   * The remote sha of the head branch when planning started, or empty if it did not exist.
   * Captured early to avoid race conditions when pushing the pull request.
   */
  readonly remoteHeadSha: string;

  /** Release notes for this version, without the version heading. */
  readonly body: string;
}

/**
 * Checks that the repository is in a state that will allow opening a release pull request,
 * before we start making any changes.
 */
function planPullRequest(version: string): Omit<PullRequest, 'body'> {
  const { major, minor } = parseVersion(version);
  const expectedReleaseBranch = `releases/${major}.${minor}.x`;

  // 1) Working tree is clean
  if (git`status --porcelain`) {
    throw new Error('Working tree is not clean');
  }

  // 2) Current branch is either the 'main' branch or the correct release branch for version
  // FIXME: ATM, we allow any version from the main branch which is not necessarily correct.
  //        We'll narrow this down in the future.
  const currentBranch = git`branch --show-current`;
  if (currentBranch !== 'main' && currentBranch !== expectedReleaseBranch) {
    throw new Error(
      `Prepare ${version} from main or ${expectedReleaseBranch}, not ${currentBranch || 'a detached HEAD'}`
    );
  }

  // 3) Current branch is in sync with the remote it tracks
  const remote = gitUpstreamRemote(currentBranch);
  if (gitRemoteSha(remote, currentBranch) !== git`rev-parse HEAD`) {
    throw new Error(`${currentBranch} is not in sync with ${remote}/${currentBranch}`);
  }

  const head = `release-${version}-bump`;
  return {
    title: `chore: prepare for ${version} release`,
    base: currentBranch,
    head,
    remote,
    remoteHeadSha: gitRemoteSha(remote, head),
  };
}

function openPullRequest(pullRequest: PullRequest): void {
  const { base, head, remote, title, remoteHeadSha, body } = pullRequest;

  // Assert no unexpected changes
  const unexpectedChanges = unexpectedReleasePaths(git`status --porcelain --untracked-files=all`);
  if (unexpectedChanges.length > 0) {
    throw new Error(`Release preparation changed unexpected paths:\n${unexpectedChanges.join('\n')}`);
  }

  // Commit the changes and push the branch
  git`checkout -B ${head}`;
  git`add --all`;
  git`commit --message ${title}`;
  git`push --force-with-lease=refs/heads/${head}:${remoteHeadSha} ${remote} HEAD:refs/heads/${head}`;

  // Open or update the pull request
  const existing = findOpenPullRequest(pullRequest);
  const ghWithBody = gh({ input: body });
  if (existing) {
    ghWithBody`pr edit ${existing} --add-label skip-changelog --body-file -`;
  } else {
    ghWithBody`pr create --base ${base} --head ${head} --title ${title} --label skip-changelog --body-file -`;
  }

  // Return to the branch the pull request targets, which is where preparation started.
  git`checkout ${base}`;
}

/** Returns the number of the open pull request from the release branch, if there is one. */
function findOpenPullRequest({ base, head }: Pick<PullRequest, 'base' | 'head'>): string | undefined {
  // `// empty` prints nothing when the list is empty. A bare `.[0].number` prints "null".
  return gh`pr list --head ${head} --base ${base} --json number --jq ${'.[0].number // empty'}` || undefined;
}

/** Name of the remote that `branch` tracks. */
function gitUpstreamRemote(branch: string): string {
  const remote = git`for-each-ref --format=%(upstream:remotename) refs/heads/${branch}`;
  if (!remote) throw new Error(`${branch} does not track a remote`);
  return remote;
}

/** Remote sha of `branch` on `remote`, or '' when that remote has no such branch. */
function gitRemoteSha(remote: string, branch: string): string {
  return git`ls-remote ${remote} refs/heads/${branch}`.split('\t')[0];
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// CHANGELOG management
////////////////////////////////////////////////////////////////////////////////////////////////////

/** Prepares the changelog for `version` and returns that version's notes, without the version heading. */
export function rollChangelog(version: string, date: string, root = repoRoot): string {
  const tool = changelogToolFor(root);
  tool`prepare --version ${version} --date ${date}`;
  return tool({ stdio: ['pipe', 'pipe', 'inherit'] })`notes --version ${version}`;
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Git status management
////////////////////////////////////////////////////////////////////////////////////////////////////

/** Returns the `git status --porcelain` lines that release preparation is not expected to produce. */
export function unexpectedReleasePaths(status: string): string[] {
  return status.split('\n').filter((line) => line && !isReleaseChange(line.slice(0, 2).trim(), line.slice(3)));
}

function isReleaseChange(code: string, path: string): boolean {
  if (/^changelog\/[^/]+\/[^/]+\.md$/.test(path)) return code === 'D';
  return (
    code === 'M' &&
    (path === 'CHANGELOG.md' || path === 'pnpm-lock.yaml' || /^(packages|contrib)\/[^/]+\/package\.json$/.test(path))
  );
}

////////////////////////////////////////////////////////////////////////////////////////////////////

if (require.main === module) {
  main();
}
