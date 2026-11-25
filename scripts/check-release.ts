import { relative } from 'node:path';
import { parseArgs } from 'node:util';
import { changelogToolFor, repoRoot } from './changelog';
import { packageJsonsWithVersion, parseVersion, releaseBranchFor } from './prepare-release';
import { ChildProcessError, run } from './utils';

const git = run({ cwd: repoRoot, command: 'git' });
const gh = run({ cwd: repoRoot, command: 'gh' });

function main(): void {
  const { version, branch, commit } = parseArguments();

  const { failures, outputs } = checkRelease(version, branch, commit);
  if (failures.length > 0) {
    console.error(`Release ${version} is not ready:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
    process.exit(1);
  }

  console.error(
    `Release ${version} is ready: commit ${outputs.commit} on ${branch}, using artifacts from merge-to-main run ${outputs.buildRunId}`
  );

  console.log(`commit=${outputs.commit}`);
  console.log(`build-run-id=${outputs.buildRunId}`);
}

////////////////////////////////////////////////////////////////////////////////////////////////////

const help = `Usage: pnpm release:check <version> [options]

Check that a commit can be drafted as a release. Reports every failed check.

Options:
  --branch <name>  Branch the release is cut from (default: $GITHUB_REF_NAME, else the current branch)
  --commit <ref>   Commit to release (default: HEAD)
  -h, --help       Show this help

On success, stdout is exactly "commit=<sha>" and "build-run-id=<id>", one per line,
suitable for $GITHUB_OUTPUT. Everything else goes to stderr.
`;

function parseArguments(args = process.argv.slice(2)) {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        branch: { type: 'string' },
        commit: { type: 'string' },
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
      branch: values.branch ?? process.env.GITHUB_REF_NAME ?? git`branch --show-current`,
      commit: values.commit ?? 'HEAD',
    };
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

interface ReleaseCheck {
  readonly failures: string[];
  readonly outputs: { commit?: string; buildRunId?: string };
}

/** Runs every release check for `version` at `commitRef` on `branch`, collecting failures instead of throwing. */
export function checkRelease(version: string, branch: string, commitRef: string): ReleaseCheck {
  const failures: string[] = [];
  const outputs: ReleaseCheck['outputs'] = {};
  const check = (fn: () => string | undefined) => {
    try {
      const failure = fn();
      if (failure) failures.push(failure);
    } catch (e) {
      failures.push((e as Error).message);
    }
  };
  const tag = `v${version}`;

  check(() => releaseBranchProblem(version, branch));
  check(() => {
    const mismatches = mismatchedPackageVersions(version);
    if (mismatches.length > 0) return `Packages are not at ${version}:\n    ${mismatches.join('\n    ')}`;
  });
  check(() => changelogSectionProblem(version));
  check(() => {
    if (isPublished(tag)) return `Release ${tag} is already published`;
  });

  let commit: string;
  try {
    commit = git`rev-parse --verify ${`${commitRef}^{commit}`}`;
    outputs.commit = commit;
  } catch {
    failures.push(`Cannot resolve commit ${commitRef}`);
    return { failures, outputs };
  }
  check(() => {
    if (!isOnRemoteBranch(commit, branch)) return `${commit} is not on origin/${branch}`;
  });
  check(() => {
    const tagged = remoteTagCommit(tag);
    if (tagged && tagged !== commit) return `Tag ${tag} points at ${tagged}, not ${commit}`;
  });
  check(() => {
    const runId = successfulBuildRun(commit);
    if (!runId) return `No successful merge-to-main build for ${commit}; wait for it to finish, or re-run it`;
    outputs.buildRunId = runId;
    if (!hasUnexpiredTarballs(runId))
      return `Merge-to-main run ${runId} no longer has a package-tarballs artifact; re-run it`;
  });

  return { failures, outputs };
}

/** Returns why `branch` cannot release `version`, if it cannot. */
export function releaseBranchProblem(version: string, branch: string): string | undefined {
  const releaseBranch = releaseBranchFor(version);
  if (branch !== 'main' && branch !== releaseBranch) {
    return `Release ${version} from main or ${releaseBranch}, not ${branch || 'a detached HEAD'}`;
  }
}

/** Returns `<path> <version>` for each versioned package that is not at `version`. */
export function mismatchedPackageVersions(version: string, root = repoRoot): string[] {
  return packageJsonsWithVersion(root)
    .filter(({ json }) => json.version !== version)
    .map(({ path, json }) => `${relative(root, path)} ${json.version}`)
    .sort();
}

/** Returns why the changelog section for `version` is not releasable, if it is not. */
export function changelogSectionProblem(version: string, root = repoRoot): string | undefined {
  let notes: string;
  try {
    notes = changelogToolFor(root)({ stdio: ['pipe', 'pipe', 'inherit'] })`release-notes --version ${version}`;
  } catch {
    return `Cannot read the changelog section for ${version}; see the changelog-tool error above`;
  }
  // `release-notes` always prints this heading, even for an empty section.
  if (!notes.replace(/^## Notable Changes\s*/, '').trim()) return `The changelog section for ${version} is empty`;
}

/** True when `commit` is contained in `origin/<branch>`. Fetches that one branch. */
export function isOnRemoteBranch(commit: string, branch: string): boolean {
  try {
    git`fetch --quiet origin refs/heads/${branch}`;
  } catch {
    throw new Error(`Cannot fetch ${branch} from origin`);
  }
  try {
    git`merge-base --is-ancestor ${commit} FETCH_HEAD`;
    return true;
  } catch (e) {
    if (e instanceof ChildProcessError && e.code === 1) return false;
    throw e;
  }
}

/** Commit that `tag` points at on origin, or '' when origin has no such tag. */
function remoteTagCommit(tag: string): string {
  const refs = new Map(
    git`ls-remote --tags origin refs/tags/${tag} refs/tags/${tag}^{}`
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t').reverse() as [string, string])
  );
  return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? '';
}

function isPublished(tag: string): boolean {
  const jq = `map(select(.tagName == ${JSON.stringify(tag)})) | length`;
  return gh`release list --exclude-drafts --limit 1000 --json tagName --jq ${jq}` !== '0';
}

function successfulBuildRun(commit: string): string {
  // `// empty` prints nothing when the list is empty. A bare `.[0].databaseId` prints "null".
  const jq = '.[0].databaseId // empty';
  return gh`run list --workflow on-merge-to-main.yml --commit ${commit} --status success --json databaseId --jq ${jq}`;
}

function hasUnexpiredTarballs(runId: string): boolean {
  const jq = '[.artifacts[] | select(.name == "package-tarballs" and (.expired | not))] | length';
  return gh`api repos/{owner}/{repo}/actions/runs/${runId}/artifacts --jq ${jq}` !== '0';
}

if (require.main === module) {
  main();
}
