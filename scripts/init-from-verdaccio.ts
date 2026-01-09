import { dirname } from 'node:path';
import { getArgs, withRegistry } from './registry';
import { spawnNpx } from './utils';

// Force samples to use the same version of @temporalio/* packages as the one
// we are testing. This is required when testing against a pre-release version,
// which would not be otherwise matched by specifier like ^1.8.0.
// eslint-disable-next-line import/order
import { version } from '../packages/client/package.json';

async function main() {
  const { registryDir, targetDir, initArgs } = await getArgs();

  await withRegistry(registryDir, dirname(targetDir), async (npmConfigFile) => {
    console.log('spawning npx @temporalio/create with args:', initArgs);
    try {
      await spawnNpx(
        [`@temporalio/create@${version}`, targetDir, '--no-git-init', '--sdk-version', version, ...initArgs],
        {
          stdio: 'inherit',
          cwd: dirname(targetDir),
          env: {
            ...process.env,
            NPM_CONFIG_USERCONFIG: npmConfigFile,
          },
        }
      );
    } catch (e) {
      console.error(e);
      throw new Error('Failed to init example');
    }
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
