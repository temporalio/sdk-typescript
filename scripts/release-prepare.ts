import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import arg from 'arg';
import semver from 'semver';
import { repoRoot, runTool } from './changelog';
import * as git from './utils/git';
import * as github from './utils/github';
import * as npm from './utils/npm';

/**
 * Two modes:
 *
 *   pnpm release:prepare 1.26.0 [--date YYYY-MM-DD]
 *     Edits versions, the lockfile, and the changelog. Does not commit.
 *     This is the command documented in CONTRIBUTING.md.
 *
 *   pnpm release:prepare 1.26.0 --release-type ga --open-pr
 *     Same edits, then commits them on release-<version>-bump, force-pushes,
 *     and opens (or updates) the pull request. This is what release-prepare.yml runs.
 */

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/;
const CHANGELOG_PATH = 'CHANGELOG.md';
const VERSION_CARRIER = 'packages/client/package.json';
const NPM_CANONICAL_PACKAGE = '@temporalio/client';
const FRAGMENT_PATH = /^changelog\/(added|stabilized|changed|deprecated|breaking-changes|fixed|security)\/[^/]+\.md$/;

export type ReleaseKind = 'ga' | 'rc' | 'beta' | 'alpha';

////////////////////////////////////////////////////////////////////////////////////////////////////
// File changes (versions, lockfile, changelog). No git.
////////////////////////////////////////////////////////////////////////////////////////////////////

export function prepareRelease(version: string, date: string, root = repoRoot): void {
  if (!VERSION_RE.test(version)) {
    throw new Error('Expected a release version such as 1.25.0 or 1.25.0-rc.1');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error('Expected a release date in YYYY-MM-DD format');
  }
  const pnpm = process.env.npm_execpath;
  if (!pnpm) throw new Error('Run release preparation with pnpm release:prepare');
  // npm_execpath is a Node script for pnpm installed by npm, and a native
  // binary for the standalone builds (mise, the pnpm setup action).
  const pnpmIsScript = /\.(c|m)?js$/.test(pnpm);
  const directories = ['scripts'];
  for (const parent of ['packages', 'contrib']) {
    for (const entry of readdirSync(resolve(root, parent), { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(`${parent}/${entry.name}`);
    }
  }
  for (const directory of directories) {
    const path = resolve(root, directory, 'package.json');
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof manifest.version !== 'string') continue;
    manifest.version = version;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const result = spawnSync(pnpmIsScript ? process.execPath : pnpm, [...(pnpmIsScript ? [pnpm] : []), 'install', '--lockfile-only', '--ignore-scripts'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm lockfile refresh failed (${result.status ?? result.signal})`);
  runTool(['prepare', '--version', version, '--date', date], root);
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Checks
////////////////////////////////////////////////////////////////////////////////////////////////////

export function validateReleaseType(version: string, releaseType: ReleaseKind): void {
  const prereleaseId = semver.prerelease(version)?.[0];

  switch (releaseType) {
    case 'ga':
      if (prereleaseId) {
        throw new Error(`Release type 'ga' requires a non-prerelease version, got '${version}'.`);
      }
      return;
    case 'rc':
      if (prereleaseId !== 'rc') {
        throw new Error(`Release type 'rc' requires an -rc.N prerelease version, got '${version}'.`);
      }
      return;
    case 'beta':
      if (prereleaseId !== 'beta') {
        throw new Error(`Release type 'beta' requires a -beta.N prerelease version, got '${version}'.`);
      }
      return;
    case 'alpha':
      if (prereleaseId !== 'alpha') {
        throw new Error(`Release type 'alpha' requires an -alpha.N prerelease version, got '${version}'.`);
      }
      return;
    default: {
      const _exhaustive: never = releaseType;
      throw new Error(`Unhandled release type: ${_exhaustive}`);
    }
  }
}

/** @returns true when the packages still need to be bumped to `targetVersion`. */
export function assertVersionIsNewer(targetVersion: string, currentVersion: string): boolean {
  if (targetVersion === currentVersion) return false;
  if (semver.lte(targetVersion, currentVersion)) {
    throw new Error(`Target version '${targetVersion}' must be greater than current version '${currentVersion}'.`);
  }
  return true;
}

export function expectedBaseBranch(args: {
  targetVersion: string;
  currentBranch: string;
  mainVersion?: string;
  releaseBranchExistsOnRemote?: boolean;
}): string {
  const target = semver.parse(args.targetVersion);
  if (!target) throw new Error(`Invalid target version: ${args.targetVersion}`);
  const releaseBranch = `releases/${target.major}.${target.minor}.x`;

  if (args.currentBranch === releaseBranch) {
    return releaseBranch;
  }

  if (args.currentBranch === 'main') {
    if (args.mainVersion === undefined) {
      throw new Error(`Internal error: mainVersion required when currentBranch is 'main'.`);
    }
    const main = semver.parse(args.mainVersion);
    if (!main) throw new Error(`Invalid package.json version on main: ${args.mainVersion}`);
    if (main.major !== target.major || main.minor !== target.minor) {
      throw new Error(
        `Cannot release ${args.targetVersion} from 'main': main is on the ${main.major}.${main.minor} line. ` +
          `Check out '${releaseBranch}' first.`
      );
    }
    if (args.releaseBranchExistsOnRemote) {
      throw new Error(
        `Cannot release ${args.targetVersion} from 'main': '${releaseBranch}' exists on origin. ` +
          `Check out '${releaseBranch}' to back-port this release.`
      );
    }
    return 'main';
  }

  throw new Error(
    `Current branch '${args.currentBranch}' is not a valid base for ${args.targetVersion}. ` +
      `Check out '${releaseBranch}' or 'main' first.`
  );
}

/** Lines from `git status --porcelain` that a release commit must not contain. */
export function unexpectedReleasePaths(porcelain: string): string[] {
  const unexpected: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.length === 0) continue;
    const status = line.slice(0, 2);
    const path = line.slice(3);
    if (isAllowedReleaseChange(status, path)) continue;
    unexpected.push(line);
  }
  return unexpected;
}

function isAllowedReleaseChange(status: string, path: string): boolean {
  const deleted = status.includes('D') && !/[MA?]/.test(status);
  const written = /[MA]/.test(status) && !status.includes('?') && !status.includes('D');
  if (path === CHANGELOG_PATH || path === 'pnpm-lock.yaml' || path.endsWith('/package.json')) {
    return written;
  }
  if (FRAGMENT_PATH.test(path)) return deleted;
  return false;
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// CLI
////////////////////////////////////////////////////////////////////////////////////////////////////

function main(): void {
  const args = arg(
    {
      '--date': String,
      '--release-type': String,
      '--open-pr': Boolean,
      '--dry-run': Boolean,
      '--repo': String,
      '--help': Boolean,
      '-h': '--help',
    },
    { permissive: false }
  );
  if (args['--help']) {
    console.log(
      'Usage: pnpm release:prepare VERSION [--date YYYY-MM-DD]\n' +
        '       pnpm release:prepare VERSION --release-type ga|rc|beta|alpha --open-pr [--dry-run]'
    );
    return;
  }
  if (args._.length !== 1) throw new Error('Expected one release version; see --help');
  const version = args._[0];
  const date = args['--date'] ?? new Date().toISOString().slice(0, 10);

  if (!args['--open-pr']) {
    if (args['--dry-run']) throw new Error('--dry-run is only meaningful with --open-pr');
    prepareRelease(version, date);
    return;
  }

  const releaseType = args['--release-type'] as ReleaseKind | undefined;
  if (!releaseType || !['ga', 'rc', 'beta', 'alpha'].includes(releaseType)) {
    throw new Error('--open-pr requires --release-type ga|rc|beta|alpha');
  }
  openReleasePullRequest({ version, date, releaseType, dryRun: Boolean(args['--dry-run']), repo: args['--repo'] });
}

function openReleasePullRequest(options: {
  version: string;
  date: string;
  releaseType: ReleaseKind;
  dryRun: boolean;
  repo: string | undefined;
}): void {
  if (!VERSION_RE.test(options.version)) {
    throw new Error('Expected a release version such as 1.25.0 or 1.25.0-rc.1');
  }
  validateReleaseType(options.version, options.releaseType);

  const currentVersion = readCurrentVersion();
  const baseBranch = expectedBaseBranch({
    targetVersion: options.version,
    currentBranch: git.currentBranch(),
    mainVersion: git.currentBranch() === 'main' ? currentVersion : undefined,
    releaseBranchExistsOnRemote: git.currentBranch() === 'main' ? git.remoteHasBranch(releaseBranchName(options.version)) : false,
  });

  if (!options.dryRun) {
    git.assertCleanWorkingTree();
    applyGitIdentity();
    assertBranchUpToDate(baseBranch);
  }

  assertNotPublished(options.version);
  assertTagAbsent(`v${options.version}`);

  const needsBump = assertVersionIsNewer(options.version, currentVersion);
  if (!needsBump) {
    extractChangelogSection(options.version);
    console.log(`Version ${options.version} is already prepared on ${baseBranch}. Nothing to do.`);
    return;
  }

  if (options.dryRun) {
    console.log(`[dry-run] Would prepare ${options.version}, commit on release-${options.version}-bump, and open a PR into ${baseBranch}`);
    return;
  }

  prepareRelease(options.version, options.date);
  const status = git.git('status', '--porcelain');
  if (status.status !== 0) {
    throw new Error(`git status failed: ${status.stderr || 'unknown error'}`);
  }
  const dirty = status.stdout;
  const unexpected = unexpectedReleasePaths(dirty);
  if (unexpected.length > 0) {
    throw new Error(`Release preparation changed unexpected files:\n${unexpected.join('\n')}`);
  }
  if (dirty.length === 0) {
    throw new Error('Release preparation produced no changes.');
  }

  const headBranch = `release-${options.version}-bump`;
  git.checkoutNewBranch(headBranch);
  git.stageAll();
  git.commit(`chore(release): prepare for ${options.version}`);
  git.pushReleaseBranch(headBranch);

  const repo = github.resolveRepo(options.repo);
  const body = buildPrBody(extractChangelogSection(options.version));
  const title = `chore(release): prepare for ${options.version}`;
  const prNumber = upsertPullRequest({ repo, base: baseBranch, head: headBranch, title, body });
  github.addLabel(prNumber, 'skip-changelog', repo);
  github.enableAutoMerge(prNumber, repo);
  console.log(`Release pull request #${prNumber} is open against ${baseBranch}.`);
}

function upsertPullRequest(options: {
  repo: string | undefined;
  base: string;
  head: string;
  title: string;
  body: string;
}): string {
  const existing = github.findOpenPrNumber(options.head, options.repo);
  if (existing) {
    github.editPrBody(existing, options.body, options.repo);
    return existing;
  }
  try {
    github.createPr({ base: options.base, head: options.head, title: options.title, body: options.body, repo: options.repo });
  } catch (error) {
    const recovered = github.findOpenPrNumber(options.head, options.repo);
    if (!recovered) throw error;
    github.editPrBody(recovered, options.body, options.repo);
    return recovered;
  }
  const created = github.findOpenPrNumber(options.head, options.repo);
  if (!created) throw new Error(`Created the pull request for ${options.head} but could not find it afterwards.`);
  return created;
}

function buildPrBody(excerpt: string): string {
  return `## Release notes preview\n\n${excerpt}\n\n---\n_Automated version bump PR._`;
}

function extractChangelogSection(version: string): string {
  const changelog = readFileSync(resolve(repoRoot, CHANGELOG_PATH), 'utf8');
  const sectionRe = new RegExp(`^## \\[${escapeRegExp(version)}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[|$)`);
  const match = changelog.match(sectionRe);
  if (!match) {
    throw new Error(`CHANGELOG.md does not contain a section for version '${version}'.`);
  }
  const headerLine = changelog.match(new RegExp(`^## \\[${escapeRegExp(version)}\\][^\\n]*`, 'm'));
  return `${headerLine?.[0] ?? `## [${version}]`}\n${match[1] ?? ''}`.trimEnd();
}

function readCurrentVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, VERSION_CARRIER), 'utf8')) as { version?: string };
  if (!pkg.version) throw new Error(`Could not read version from ${VERSION_CARRIER}`);
  return pkg.version;
}

function assertNotPublished(version: string): void {
  if (npm.isPublished(NPM_CANONICAL_PACKAGE, version)) {
    throw new Error(`Version '${version}' is already published on npm for ${NPM_CANONICAL_PACKAGE}.`);
  }
}

function assertTagAbsent(tag: string): void {
  const listed = git.git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`);
  if (listed.status === 0 && listed.stdout.length > 0) {
    throw new Error(`Tag '${tag}' already exists on origin.`);
  }
}

function assertBranchUpToDate(branch: string): void {
  git.fetchBranch(branch);
  if (!git.remoteBranchExists(branch)) {
    throw new Error(`Branch '${branch}' does not exist on origin.`);
  }
  const localSha = git.revParse('HEAD');
  const remoteSha = git.revParse(`origin/${branch}`);
  if (localSha !== remoteSha) {
    throw new Error(`Branch '${branch}' is not up to date with origin/${branch}. Pull before releasing.`);
  }
}

function applyGitIdentity(): void {
  const name = process.env.GIT_AUTHOR_NAME;
  const email = process.env.GIT_AUTHOR_EMAIL;
  if (name && email) git.setIdentity(name, email);
}

function releaseBranchName(version: string): string {
  const parsed = semver.parse(version);
  if (!parsed) throw new Error(`Invalid target version: ${version}`);
  return `releases/${parsed.major}.${parsed.minor}.x`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
