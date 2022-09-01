const { withRegistry, getArgs } = require('./registry');
const { spawnNpxSync } = require('./utils');
const { spawn, spawnSync } = require('child_process');

async function main() {
  const { registryDir } = await getArgs();
  await withRegistry(registryDir, async () => {
    const { status, error } = spawnNpxSync(
      ['lerna', 'publish', 'from-package', '--yes', '--registry', 'http://localhost:4873/'],
      {
        stdio: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      }
    );
    if (status !== 0) {
      console.error(error);
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
