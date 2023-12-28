const { resolve, dirname } = require('path');
const { writeFileSync } = require('fs');
const { withRegistry, getArgs } = require('./registry');
const { spawnNpx } = require('./utils');

async function main() {
  const { registryDir, targetDir, initArgs } = await getArgs();
  // Force samples to use the same version of @temporalio/* packages as the one
  // we are testing. This is required when testing against a pre-release version,
  // which would not be otherwise matched by specifier like ^1.8.0.
  const { version } = require('../lerna.json');

  await withRegistry(registryDir, async () => {
    console.log('spawning npx @temporalio/create with args:', initArgs);
    try {
      const npmConfigFile = resolve(registryDir, 'npmrc-custom');
      const npmConfig = `@temporalio:registry=http://localhost:4873`;
      writeFileSync(npmConfigFile, npmConfig, { encoding: 'utf-8' });

      await spawnNpx(
        [`@temporalio/create@${version}`, targetDir, '--no-git-init', '--sdk-version', version, ...initArgs],
        {
          stdio: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
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
