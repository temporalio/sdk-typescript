import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import arg from 'arg';
import semver from 'semver';
import { repoRoot } from './changelog';
import { assertReleaseCheckout } from './release-pack';
import * as npm from './utils/npm';
import { runOrThrow } from './utils/run';

const MIN_NODE = '22.14.0';
const MIN_NPM = '11.5.1';
const PUBLISH_ATTEMPTS = 8;
const PUBLISH_RETRY_SECONDS = 15;

export function versionFromTag(tag: string): string {
  if (!/^v\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/.test(tag)) {
    throw new Error(`Release tag '${tag}' must look like v1.26.0 or v1.26.0-rc.1.`);
  }
  return tag.slice(1);
}

/** npm dist-tag derived from the version. Never taken as an input. */
export function distTag(version: string): string {
  const id = semver.prerelease(version)?.[0];
  if (id == null) return 'latest';
  if (id === 'rc') return 'next';
  if (id === 'beta') return 'beta';
  if (id === 'alpha') return 'alpha';
  throw new Error(`Unsupported prerelease id '${String(id)}' in '${version}'. Expected rc, beta, or alpha.`);
}

export function tarballFilename(packageName: string, version: string): string {
  return `${packageName.replace(/^@/, '').replace(/\//g, '-')}-${version}.tgz`;
}

export function assertPublishRuntime(nodeVersion: string, npmVersion: string): void {
  const node = semver.coerce(nodeVersion);
  const npmVersionParsed = semver.coerce(npmVersion);
  if (!node || semver.lt(node, MIN_NODE)) {
    throw new Error(`Trusted publishing requires Node >= ${MIN_NODE}, found ${nodeVersion}.`);
  }
  if (!npmVersionParsed || semver.lt(npmVersionParsed, MIN_NPM)) {
    throw new Error(`Trusted publishing requires npm >= ${MIN_NPM}, found ${npmVersion}.`);
  }
}

export function parseContainingBranches(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('origin/') && !line.includes('->'));
}

/** The tagged commit must be on main or the release branch for its X.Y line. */
export function assertShaOnReleaseLine(version: string, branches: string[]): void {
  const parsed = semver.parse(version);
  if (!parsed) throw new Error(`Invalid version '${version}'.`);
  const releaseBranch = `origin/releases/${parsed.major}.${parsed.minor}.x`;
  if (branches.includes('origin/main') || branches.includes(releaseBranch)) return;
  const found = branches.length > 0 ? branches.join(', ') : 'no remote branch';
  throw new Error(`Tag commit is not on 'main' or '${releaseBranch}'. It is contained in: ${found}.`);
}

export function matchTarballs(packages: { name: string; version: string }[], filenames: string[]): { name: string; file: string }[] {
  const expected = new Map(packages.map((pkg) => [tarballFilename(pkg.name, pkg.version), pkg.name]));
  const missing = [...expected.keys()].filter((name) => !filenames.includes(name));
  const extra = filenames.filter((name) => !expected.has(name));
  if (missing.length > 0 || extra.length > 0) {
    const parts = [];
    if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
    if (extra.length > 0) parts.push(`unexpected ${extra.join(', ')}`);
    throw new Error(`Release tarballs do not match the publishable packages: ${parts.join('; ')}.`);
  }
  return packages.map((pkg) => ({ name: pkg.name, file: tarballFilename(pkg.name, pkg.version) }));
}

/** Dependency order within the publish set. External dependencies are ignored. */
export function publishOrder(packages: { name: string; dependencies: string[] }[]): string[] {
  const names = new Set(packages.map((pkg) => pkg.name));
  const remaining = new Map<string, Set<string>>();
  for (const pkg of packages) {
    remaining.set(pkg.name, new Set(pkg.dependencies.filter((dep) => names.has(dep) && dep !== pkg.name)));
  }
  const order: string[] = [];
  while (order.length < packages.length) {
    const ready = [...remaining.keys()]
      .filter((name) => remaining.get(name)!.size === 0)
      .sort();
    if (ready.length === 0) throw new Error('Publish set has a dependency cycle.');
    for (const name of ready) remaining.delete(name);
    for (const deps of remaining.values()) {
      for (const name of ready) deps.delete(name);
    }
    order.push(...ready);
  }
  return order;
}

export function npmPublishArgs(file: string, tag: string): string[] {
  return ['publish', file, '--tag', tag, '--access', 'public', '--provenance', '--ignore-scripts'];
}

export interface PackedPackage {
  name: string;
  version: string;
  dependencies: string[];
}

export function readPackedManifest(tarballPath: string): PackedPackage {
  const result = spawnSync('tar', ['-xOf', tarballPath, 'package/package.json'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Cannot read package.json from ${tarballPath}: ${result.stderr || 'tar failed'}`);
  }
  const manifest = JSON.parse(result.stdout) as {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  if (!manifest.name || !manifest.version) throw new Error(`${tarballPath} has no name or version.`);
  return {
    name: manifest.name,
    version: manifest.version,
    dependencies: Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }),
  };
}

function publishWithRetry(file: string, tag: string): void {
  const args = npmPublishArgs(file, tag);
  let detail = '';
  for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
    const result = npm.npm(...args);
    if (result.status === 0) return;
    detail = [result.stderr, result.stdout].filter(Boolean).join('\n');
    console.error(`npm publish ${file} failed (attempt ${attempt}/${PUBLISH_ATTEMPTS}): ${detail}`);
    if (attempt < PUBLISH_ATTEMPTS) spawnSync('sleep', [String(PUBLISH_RETRY_SECONDS)]);
  }
  throw new Error(`npm publish ${file} failed after ${PUBLISH_ATTEMPTS} attempts: ${detail}`);
}

function main(): void {
  const args = arg({ '--tag': String, '--tarballs': String, '--sha': String });
  const tag = args['--tag'];
  const sha = args['--sha'];
  if (!tag) throw new Error('Missing required argument: --tag');
  if (!sha) throw new Error('Missing required argument: --sha');

  const version = versionFromTag(tag);
  assertPublishRuntime(process.versions.node, npm.npmOrThrow('--version'));
  assertReleaseCheckout(repoRoot, version);

  const tagSha = runOrThrow('git', ['rev-parse', `${tag}^{commit}`], { cwd: repoRoot });
  if (tagSha !== sha) throw new Error(`Tag ${tag} points at ${tagSha}, not ${sha}.`);
  const branchOutput = runOrThrow('git', ['branch', '-r', '--contains', sha], { cwd: repoRoot });
  assertShaOnReleaseLine(version, parseContainingBranches(branchOutput));

  const tarballDir = resolve(repoRoot, args['--tarballs'] ?? 'dist');
  const filenames = readdirSync(tarballDir).filter((name) => name.endsWith('.tgz'));
  const workspacePackages = assertReleaseCheckout(repoRoot, version).map((dir) => {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, dir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    return { name: manifest.name, version: manifest.version };
  });
  const matched = matchTarballs(workspacePackages, filenames);
  const packed = matched.map((item) => {
    const manifest = readPackedManifest(resolve(tarballDir, item.file));
    if (manifest.name !== item.name) {
      throw new Error(`${item.file} contains '${manifest.name}', expected '${item.name}'.`);
    }
    if (manifest.version !== version) {
      throw new Error(`${item.file} is version '${manifest.version}', expected '${version}'.`);
    }
    return { ...manifest, file: resolve(tarballDir, item.file) };
  });

  const order = publishOrder(packed);
  const tagName = distTag(version);
  for (const name of order) {
    const item = packed.find((pkg) => pkg.name === name)!;
    if (npm.isPublished(name, version)) {
      console.log(`Skipping ${name}@${version}; it is already on npm.`);
      continue;
    }
    console.log(`Publishing ${name}@${version} with dist-tag ${tagName}.`);
    publishWithRetry(item.file, tagName);
  }
  console.log(`npm publish complete for ${version}.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
