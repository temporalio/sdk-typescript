import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { globSync } from 'glob';
import { parseVersion } from './prepare-release.ts';
import { pnpm } from './utils.ts';

const repoRoot = resolve(import.meta.dirname, '..');

function main(): void {
  const { tarballDir, version } = parseArguments();
  const packages = publishablePackages(repoRoot);
  checkVersions(packages, version);
  packPackages(packages, tarballDir);
}

////////////////////////////////////////////////////////////////////////////////////////////////////

const help = `Usage: pnpm packages:pack --tarball-dir <dir> [options]

Pack every publishable package into one directory of tarballs, as they are published.
Build the native bridge binaries and the TypeScript code first.

Options:
  --tarball-dir <dir>  Directory to write the tarballs to; tarballs already there are removed
  --version <version>  Version every package must be at (default: the version they share)
  -h, --help           Show this help
`;

function parseArguments(args = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({
      args,
      options: {
        'tarball-dir': { type: 'string' },
        version: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      console.log(help);
      process.exit(0);
    }

    if (!values['tarball-dir']) throw new Error('Expected --tarball-dir; see --help');
    if (values.version) parseVersion(values.version);
    return { tarballDir: resolve(values['tarball-dir']), version: values.version };
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Publishable packages
////////////////////////////////////////////////////////////////////////////////////////////////////

interface PublishablePackage {
  readonly dir: string;
  readonly name: string;
  readonly version?: string;
}

/**
 * List the packages under "packages/" and "contrib/" that have a name and are not private.
 */
export function publishablePackages(root: string): PublishablePackage[] {
  const packages: PublishablePackage[] = [];
  for (const path of globSync('{packages,contrib}/*/package.json', { cwd: root, absolute: true })) {
    const { name, version, private: isPrivate } = JSON.parse(readFileSync(path, 'utf8'));
    if (name && !isPrivate) packages.push({ dir: dirname(path), name, version });
  }
  return packages;
}

/**
 * Throw unless every package is at `version`, which defaults to the version of the first package.
 */
export function checkVersions(packages: PublishablePackage[], version = packages[0]?.version): void {
  const mismatched = packages.filter((pkg) => pkg.version !== version);
  if (mismatched.length > 0) {
    const lines = mismatched.map(({ name, version }) => `  ${name} is at ${version ?? 'no version'}`);
    throw new Error(`Expected every package at ${version}:\n${lines.join('\n')}`);
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Packing
////////////////////////////////////////////////////////////////////////////////////////////////////

function packPackages(packages: PublishablePackage[], tarballDir: string): void {
  mkdirSync(tarballDir, { recursive: true });
  for (const tarball of tarballsIn(tarballDir)) rmSync(tarball);

  for (const { dir, name } of packages) {
    pnpm({ cwd: dir })`pack --pack-destination ${tarballDir}`;
    console.log(`Packed ${name}`);
  }

  const packed = tarballsIn(tarballDir).length;
  if (packed !== packages.length) {
    throw new Error(`Expected ${packages.length} tarballs in ${tarballDir}, found ${packed}`);
  }
}

/** Full paths of the tarballs in `dir`. */
export function tarballsIn(dir: string): string[] {
  return globSync('*.tgz', { cwd: dir, absolute: true });
}

////////////////////////////////////////////////////////////////////////////////////////////////////

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
