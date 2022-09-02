const { resolve } = require('path');
const { writeFileSync } = require('fs');
const { withRegistry, getArgs } = require('./registry');
const { spawnNpx } = require('./utils');

async function main() {
  const { registryDir, initArgs } = await getArgs();

  await withRegistry(registryDir, async () => {
    console.log('spawning npx @temporalio/create with args:', initArgs);
    try {
      const npmConfigFile = resolve(registryDir, 'npmrc-custom');
      const npmConfig = `@temporalio:registry=http://localhost:4873`;
      writeFileSync(npmConfigFile, npmConfig, { encoding: 'utf-8' });

      await spawnNpx(
        ['@temporalio/create', 'example', '--no-git-init', '--temporalio-version', 'latest', ...initArgs],
        {
          stdio: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
          cwd: registryDir,
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
