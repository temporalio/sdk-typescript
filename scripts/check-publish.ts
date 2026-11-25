import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { repoRoot } from './changelog';
import { isOnRemoteBranch } from './check-release';
import { parseVersion, releaseBranchFor } from './prepare-release';
import { run } from './utils';

const git = run({ cwd: repoRoot, command: 'git' });

function main(): void {
  const tag = parseArguments();
  const version = commonPackageVersion();
  const failure = publishedReleaseProblem(version, tag);
  if (failure) {
    console.error(failure);
    process.exit(1);
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

const help = `Usage: pnpm release:check-publish [--tag <tag>]

Check that a published release can go to npm. The version is packages/common's version.
The tag must be v plus that version, and HEAD must be on origin/main or on the matching
origin/releases/X.Y.x branch.

Options:
  --tag <tag>  Release tag (default: $GITHUB_REF_NAME)
  -h, --help   Show this help
`;

function parseArguments(args = process.argv.slice(2)): string {
  try {
    const { values } = parseArgs({
      args,
      options: {
        tag: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      console.log(help);
      process.exit(0);
    }
    const tag = values.tag ?? process.env.GITHUB_REF_NAME;
    if (!tag) throw new Error('Expected --tag or GITHUB_REF_NAME; see --help');
    return tag;
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

/** Returns why publishing `tag` from this checkout should be refused, if it should. */
export function publishedReleaseProblem(version: string, tag: string): string | undefined {
  if (tag !== `v${version}`) return `Release tag ${tag} does not match package version ${version}`;

  const commit = git`rev-parse --verify ${'HEAD^{commit}'}`;
  if (isOnRemoteBranch(commit, 'main')) return;

  const line = releaseBranchFor(version);
  if (isOnRemoteBranch(commit, line)) return;
  return `Commit is not on main or ${line}`;
}

/** Version declared by packages/common. */
function commonPackageVersion(): string {
  const path = resolve(repoRoot, 'packages/common/package.json');
  const { version } = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
  if (typeof version !== 'string') throw new Error('packages/common/package.json has no version');
  return parseVersion(version).version;
}

if (require.main === module) {
  main();
}
