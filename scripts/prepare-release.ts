import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import arg from 'arg';
import { repoRoot, runTool } from './changelog';

export function prepareRelease(version: string, date: string, root = repoRoot): void {
  if (!/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(version)) {
    throw new Error('Expected a release version such as 1.25.0 or 1.25.0-rc.1');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error('Expected a release date in YYYY-MM-DD format');
  }
  const pnpm = process.env.npm_execpath;
  if (!pnpm) throw new Error('Run release preparation with pnpm release:prepare');
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
  const result = spawnSync(process.execPath, [pnpm, 'install', '--lockfile-only', '--ignore-scripts'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm lockfile refresh failed (${result.status ?? result.signal})`);
  runTool(['prepare', '--version', version, '--date', date], root);
}

if (require.main === module) {
  const args = arg({ '--date': String, '--help': Boolean, '-h': '--help' });
  if (args['--help']) {
    console.log('Usage: pnpm release:prepare VERSION [--date YYYY-MM-DD]');
  } else {
    if (args._.length !== 1) throw new Error('Expected one release version; see --help');
    prepareRelease(args._[0], args['--date'] ?? new Date().toISOString().slice(0, 10));
  }
}
