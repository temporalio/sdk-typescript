import { cwd } from 'process';
import { getArgs, withRegistry } from './registry';
import { spawnNpx } from './utils';

async function main(): Promise<void> {
  const { registryDir } = await getArgs();
  await withRegistry(registryDir, cwd(), async (_npmConfigFile: string) => {
    try {
      await spawnNpx(['pnpm', '--recursive', 'publish', '--no-git-checks', '--force'], {
        stdio: 'inherit',
        // For some reason, `pnpm publish --recursive` doesn't respect any form of `[P]?NPM_CONFIG_*`
        // env variables, so we have to rely on the `.npmrc` file being in the right place.
      });
    } catch (e) {
      console.error(e);
      throw new Error('Failed to publish to registry');
    }
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
