const { withRegistry, getArgs } = require('./registry');
const { spawnNpx } = require('./utils');

async function main() {
  const { registryDir } = await getArgs();
  await withRegistry(registryDir, async () => {
    try {
      await spawnNpx(['lerna', 'publish', 'from-package', '--yes', '--registry', 'http://127.0.0.1:4873/'], {
        stdio: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
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
