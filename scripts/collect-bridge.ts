import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { globSync } from 'glob';
import { targets } from '../packages/core-bridge/common';

const repoRoot = resolve(__dirname, '..');
const releasesDir = resolve(repoRoot, 'packages/core-bridge/releases');

function main(): void {
  const { from } = parseArguments();
  if (from) collectBinaries(from, releasesDir);

  const collected = binaryTargets(releasesDir);
  if (collected.length === 0) throw new Error(`No native bridge binary in ${releasesDir}`);
  console.log(`Native bridge binaries: ${collected.join(', ')}`);
}

////////////////////////////////////////////////////////////////////////////////////////////////////

const help = `Usage: pnpm bridge:collect [options]

Place native bridge binaries at packages/core-bridge/releases/<target>/index.node, then list them.
Without --from, only lists the binaries already there, such as the one built by
\`pnpm --filter @temporalio/core-bridge build\`.

Options:
  --from <dir>  Copy every <target>/index.node found under <dir>, at any depth,
                such as the artifacts downloaded by \`actions/download-artifact\`
  -h, --help    Show this help
`;

function parseArguments(args = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({
      args,
      options: {
        from: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      console.log(help);
      process.exit(0);
    }
    return { from: values.from && resolve(values.from) };
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Native binaries
////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Copy every `<target>/index.node` found under `from` to `<releases>/<target>/index.node`.
 */
export function collectBinaries(from: string, releases: string): void {
  const binaries = globSync('**/index.node', { cwd: from, absolute: true });
  if (binaries.length === 0) throw new Error(`No native bridge binary under ${from}`);
  for (const binary of binaries) {
    const target = basename(dirname(binary));
    if (!targets.includes(target)) throw new Error(`${binary} is not in a directory named after a known target`);
    mkdirSync(join(releases, target), { recursive: true });
    copyFileSync(binary, join(releases, target, 'index.node'));
  }
}

/**
 * Targets that have a binary in `releases`.
 */
export function binaryTargets(releases: string): string[] {
  return globSync('*/index.node', { cwd: releases })
    .map((binary) => basename(dirname(binary)))
    .sort();
}

////////////////////////////////////////////////////////////////////////////////////////////////////

if (require.main === module) {
  main();
}
