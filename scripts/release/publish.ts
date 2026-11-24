import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { distTag, parseVersion } from './prepare';
import { tarballsIn } from './pack';
import { npm, run } from '../utils';

const repoRoot = resolve(__dirname, '../..');
const attempts = 3;

function main(): void {
  const tarballDir = parseArguments();
  const tarballs = tarballsIn(tarballDir);
  if (tarballs.length === 0) throw new Error(`No tarballs in ${tarballDir}`);
  for (const tarball of tarballs) publishTarball(tarball);
}

////////////////////////////////////////////////////////////////////////////////////////////////////

const help = `Usage: pnpm release:publish --tarball-dir <dir>

Publish each tarball that is not already on npm. A stable version is tagged latest.
rc, beta, and alpha versions use that dist-tag. Retries each publish ${attempts} times.

Options:
  --tarball-dir <dir>  Directory of package tarballs
  -h, --help           Show this help
`;

function parseArguments(args = process.argv.slice(2)): string {
  try {
    const { values } = parseArgs({
      args,
      options: {
        'tarball-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      console.log(help);
      process.exit(0);
    }
    if (!values['tarball-dir']) throw new Error('Expected --tarball-dir; see --help');
    return resolve(values['tarball-dir']);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

function publishTarball(tarball: string): void {
  const manifest = JSON.parse(run`tar -xOf ${tarball} package/package.json`) as { name: string; version: string };
  const { name, version } = manifest;
  const tag = distTag(parseVersion(version));
  const publish = npm({ cwd: repoRoot, stdio: 'inherit' });
  for (let attempt = 1; ; attempt++) {
    if (npmVersions(name).includes(version)) {
      console.log(`${name}@${version} is already published`);
      return;
    }
    try {
      publish`publish ${tarball} --provenance --tag ${tag}`;
      console.log(`Published ${name}@${version} with tag ${tag}`);
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      console.warn(`Publishing ${name}@${version} failed (${attempt}/${attempts}); retrying`);
      run`sleep 10`;
    }
  }
}

/** Versions of `name` currently on the npm registry. */
function npmVersions(name: string): string[] {
  const versions = JSON.parse(npm({ cwd: repoRoot })`view ${name} versions --json`);
  return Array.isArray(versions) ? versions : [versions];
}

////////////////////////////////////////////////////////////////////////////////////////////////////

if (require.main === module) {
  main();
}
