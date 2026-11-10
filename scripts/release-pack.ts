import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import arg from 'arg';
import { repoRoot } from './changelog';

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/;

/** Workspace directories whose package.json is not private. */
export function listPublishablePackages(root: string): string[] {
  const found: string[] = [];
  for (const parent of ['packages', 'contrib']) {
    for (const entry of readdirSync(resolve(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${parent}/${entry.name}`;
      const manifestPath = resolve(root, dir, 'package.json');
      let manifest: { private?: boolean; name?: string };
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch {
        continue;
      }
      if (manifest.private || !manifest.name) continue;
      found.push(dir);
    }
  }
  found.sort();
  return found;
}

/** Fail unless every publishable package and the changelog agree on `version`. */
export function assertReleaseCheckout(root: string, version: string): string[] {
  if (!VERSION_RE.test(version)) {
    throw new Error(`Expected a release version such as 1.25.0 or 1.25.0-rc.1, got '${version}'.`);
  }
  const dirs = listPublishablePackages(root);
  if (dirs.length === 0) throw new Error('No publishable packages found.');
  for (const dir of dirs) {
    const manifest = JSON.parse(readFileSync(resolve(root, dir, 'package.json'), 'utf8')) as { version?: string };
    if (manifest.version !== version) {
      throw new Error(`${dir} is at version '${manifest.version ?? ''}', expected '${version}'.`);
    }
  }
  const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
  const heading = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^## \\[${heading}\\]`, 'm').test(changelog)) {
    throw new Error(`CHANGELOG.md has no section for ${version}.`);
  }
  return dirs;
}

function pack(version: string, outDir: string, root = repoRoot): void {
  const dirs = assertReleaseCheckout(root, version);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const dir of dirs) {
    const result = spawnSync('pnpm', ['pack', '--pack-destination', outDir], {
      cwd: resolve(root, dir),
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`pnpm pack failed in ${dir} (${result.status ?? result.signal})`);
  }
  const tarballs = readdirSync(outDir).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== dirs.length) {
    throw new Error(`Expected ${dirs.length} tarballs in ${outDir}, found ${tarballs.length}.`);
  }
  console.log(`Packed ${tarballs.length} packages into ${outDir}.`);
}

if (require.main === module) {
  try {
    const args = arg({ '--version': String, '--out': String });
    if (!args['--version']) throw new Error('Missing required argument: --version');
    pack(args['--version'], resolve(repoRoot, args['--out'] ?? 'dist'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
