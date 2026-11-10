import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import arg from 'arg';
import semver from 'semver';
import { repoRoot } from './changelog';
import { assertReleaseCheckout } from './release-pack';
import * as github from './utils/github';

/**
 * Create or replace the draft GitHub Release for this commit.
 * Tarballs must already have been built by scripts/release-pack.ts.
 */
function main(): void {
  const args = arg({ '--version': String, '--tarballs': String, '--target': String });
  const version = args['--version'];
  const target = args['--target'];
  if (!version) throw new Error('Missing required argument: --version');
  if (!target) throw new Error('Missing required argument: --target');

  assertReleaseCheckout(repoRoot, version);
  const tarballDir = resolve(repoRoot, args['--tarballs'] ?? 'dist');
  const tarballs = readdirSync(tarballDir)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => resolve(tarballDir, name));
  if (tarballs.length === 0) throw new Error(`No tarballs found in ${tarballDir}.`);

  const notes = resolve(repoRoot, 'release-notes.md');
  const notesRun = spawnSync('pnpm', ['release:notes', '--version', version, '--output', notes], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (notesRun.error) throw notesRun.error;
  if (notesRun.status !== 0) throw new Error(`release:notes failed (${notesRun.status ?? notesRun.signal})`);

  const tag = `v${version}`;
  replaceExistingDraft(tag);
  const createArgs = ['release', 'create', tag, '--draft', '--target', target, '--title', tag, '--notes-file', notes, '--generate-notes'];
  if (semver.prerelease(version)) createArgs.push('--prerelease');
  createArgs.push(...tarballs);
  github.ghOrThrow(undefined, ...createArgs);
  console.log(`Draft release ${tag} created at ${target}.`);
}

function replaceExistingDraft(tag: string): void {
  const view = github.gh(undefined, 'release', 'view', tag, '--json', 'isDraft');
  if (view.status !== 0) return;
  const info = JSON.parse(view.stdout) as { isDraft?: boolean };
  if (!info.isDraft) throw new Error(`Release ${tag} is already published.`);
  github.ghOrThrow(undefined, 'release', 'delete', tag, '--yes', '--cleanup-tag');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
