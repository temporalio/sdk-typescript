import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import arg from 'arg';
import { repoRoot } from './changelog';
import { listPublishablePackages } from './release-pack';
import { versionFromTag } from './release-publish';
import * as npm from './utils/npm';

const ATTEMPTS = 12;
const DELAY_MS = 10_000;

/** Poll until every package version is visible. Registry replicas lag behind a publish. */
export async function waitUntilVisible(
  names: string[],
  version: string,
  isPublished: (name: string, version: string) => boolean,
  attempts = ATTEMPTS,
  delayMs = DELAY_MS,
  pause: (ms: number) => Promise<void> = sleep
): Promise<void> {
  let missing = names;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    missing = names.filter((name) => !isPublished(name, version));
    if (missing.length === 0) return;
    console.log(`Waiting for ${missing.length} package(s) on npm (attempt ${attempt}/${attempts}).`);
    if (attempt < attempts) await pause(delayMs);
  }
  throw new Error(`These packages are not visible on npm as ${version}: ${missing.join(', ')}.`);
}

function packageNames(root: string): string[] {
  return listPublishablePackages(root).map((dir) => {
    const manifest = JSON.parse(readFileSync(resolve(root, dir, 'package.json'), 'utf8')) as { name: string };
    return manifest.name;
  });
}

function installAndLoad(version: string): void {
  const dir = mkdtempSync(resolve(tmpdir(), 'sdk-typescript-smoke-'));
  const init = spawnSync('npm', ['init', '-y'], { cwd: dir, stdio: 'inherit' });
  if (init.status !== 0) throw new Error(`npm init failed (${init.status ?? init.signal}).`);
  const specs = ['@temporalio/client', '@temporalio/core-bridge'].map((name) => `${name}@${version}`);
  const install = spawnSync('npm', ['install', '--ignore-scripts', ...specs], { cwd: dir, stdio: 'inherit' });
  if (install.status !== 0) throw new Error(`npm install of the published packages failed (${install.status ?? install.signal}).`);
  const load = spawnSync(
    process.execPath,
    ['-e', "require('@temporalio/client'); require('@temporalio/core-bridge'); console.log('loaded published packages');"],
    { cwd: dir, stdio: 'inherit' }
  );
  if (load.status !== 0) throw new Error(`Requiring the published packages failed (${load.status ?? load.signal}).`);
}

async function main(): Promise<void> {
  const args = arg({ '--version': String });
  const rawVersion = args['--version'];
  if (!rawVersion) throw new Error('Missing required argument: --version');
  const version = rawVersion.startsWith('v') ? versionFromTag(rawVersion) : rawVersion;
  const names = packageNames(repoRoot);
  await waitUntilVisible(names, version, npm.isPublished);
  installAndLoad(version);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
