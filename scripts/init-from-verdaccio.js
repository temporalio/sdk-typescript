const { spawnSync } = require('child_process');
const { withRegistry, getArgs } = require('./registry');
const { spawnNpxSync } = require('./utils');

async function main() {
  const { registryDir, initArgs } = await getArgs();

  await withRegistry(registryDir, async () => {
    console.log('spawning npx @temporalio/create with args:', initArgs);
    const { status, error } = await spawnNpxSync(
      ['--yes', '@temporalio/create', 'example', '--no-git-init', '--temporalio-version', 'latest'].concat(initArgs),
      {
        stdio: 'inherit',
        cwd: registryDir,
        env: { ...process.env, NPM_CONFIG_REGISTRY: 'http://localhost:4873/' },
      }
    );
    if (status !== 0) {
      console.error(error);
      throw new Error('Failed to init example');
    }
  });
  spawnSync('ls', ['-la'], { cwd: '/tmp/registry/example', stdio: 'inherit' });
  spawnSync('cat', ['package.json'], { cwd: '/tmp/registry/example', stdio: 'inherit' });
  spawnSync('ls', ['node_modules'], { cwd: '/tmp/registry/example', stdio: 'inherit' });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
