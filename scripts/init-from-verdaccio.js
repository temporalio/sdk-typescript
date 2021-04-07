const { spawnSync } = require('child_process');
const { withRegistry, getRegistryDirFromArgs } = require('./registry');

async function main() {
  const registryDir = await getRegistryDirFromArgs();
  await withRegistry(registryDir, async () => {
    const { status } = spawnSync('npm', ['init', '@temporalio', 'example'], {
      stdio: 'inherit',
      cwd: registryDir,
      env: { ...process.env, NPM_CONFIG_REGISTRY: 'http://localhost:4873/' },
    });
    if (status !== 0) {
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
