import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { tarballsIn } from './pack-packages.ts';
import { createTempRegistryDir, withRegistry } from './registry.ts';
import { ciLogPath, spawnNpxLogged } from './utils.ts';

const repoRoot = resolve(import.meta.dirname, '..');

async function main(): Promise<void> {
  const { tarballDir, registryDir } = parseArguments();
  const tarballs = tarballsIn(tarballDir);
  if (tarballs.length === 0) throw new Error(`No tarballs in ${tarballDir}`);

  await withRegistry(registryDir ?? (await createTempRegistryDir()), repoRoot, () => publishTarballs(tarballs));
}

////////////////////////////////////////////////////////////////////////////////////////////////////

const help = `Usage: pnpm tsx scripts/publish-to-verdaccio.ts --tarball-dir <dir> [options]

Publish the tarballs written by \`pnpm packages:pack\` to a local Verdaccio registry.

Options:
  --tarball-dir <dir>   Directory of the tarballs to publish
  --registry-dir <dir>  Directory to create the registry in (default: a new temporary directory)
  -h, --help            Show this help
`;

function parseArguments(args = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({
      args,
      options: {
        'tarball-dir': { type: 'string' },
        'registry-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      console.log(help);
      process.exit(0);
    }

    if (!values['tarball-dir']) throw new Error('Expected --tarball-dir; see --help');
    return { tarballDir: resolve(values['tarball-dir']), registryDir: values['registry-dir'] };
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Publishing
////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Publishes `tarballs`, keeping the (typically very noisy) output in log files.
 *
 * The registry runs in this process, so publishing must not block the event loop.
 */
async function publishTarballs(tarballs: string[]): Promise<void> {
  for (const tarball of tarballs) {
    const name = basename(tarball, '.tgz');
    await spawnNpxLogged(
      ['pnpm', 'publish', tarball, '--no-git-checks', '--force'],
      // `pnpm publish` ignores `[P]?NPM_CONFIG_*` env variables, so it must run where `withRegistry`
      // wrote the `.npmrc` file.
      { cwd: repoRoot },
      ciLogPath(`verdaccio-publish-${name}.log`),
      `Published ${name} to Verdaccio`
    );
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
