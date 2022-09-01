const { spawnSync } = require('child_process');
const { withRegistry, getArgs } = require('./registry');
const { spawnNpx } = require('./utils');

async function main() {
  const { registryDir, initArgs } = await getArgs();

  await withRegistry(registryDir, async () => {
    console.log('spawning npx @temporalio/create with args:', initArgs);
    try {
      await spawnNpx(
        ['@temporalio/create', 'example', '--no-git-init', '--temporalio-version', 'latest'].concat(initArgs),
        {
          stdio: 'inherit',
          cwd: registryDir,
          env: { ...process.env, NPM_CONFIG_REGISTRY: 'http://localhost:4873/' },
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
