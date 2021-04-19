const { spawnSync } = require('child_process');
const { withRegistry, getRegistryDirFromArgs } = require('./registry');

async function main() {
  const registryDir = await getRegistryDirFromArgs();
  await withRegistry(registryDir, async () => {
    const { status } = spawnSync(
      'npx',
      ['lerna', 'publish', 'from-package', '--no-git-reset', '--yes', '--registry', 'http://localhost:4873/'],
      {
        stdio: 'inherit',
      }
    );
    if (status !== 0) {
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
