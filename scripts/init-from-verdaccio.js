const { spawnSync } = require('child_process');
const { withRegistry, getArgs } = require('./registry');

async function main() {
  const { registryDir, initArgs } = await getArgs();
  await withRegistry(registryDir, async () => {
    console.log('spawning npm init with args: ', initArgs);
    const { status } = spawnSync('npm', ['init', '@temporalio', 'example'].concat(initArgs), {
      stdio: 'pipe',
      cwd: registryDir,
      env: { ...process.env, NPM_CONFIG_REGISTRY: 'http://localhost:4873/' },
    });
    if (status !== 0) {
      throw new Error('Failed to init example');
    }
  });
  spawnSync('ls', ['-la', '/tmp/registry/example'], { stdio: 'pipe' });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
