const { spawnSync } = require('child_process');
const { withRegistry, getArgs } = require('./registry');

async function main() {
  const { registryDir, initArgs } = await getArgs();

  await withRegistry(registryDir, async () => {
    console.log('npm init @temporalio -- -v :');
    console.log('spawning npx @temporalio/create with args:', initArgs);
    const { status } = spawnSync('npx', ['@temporalio/create', 'example'].concat(initArgs), {
      stdio: 'inherit',
      cwd: registryDir,
      env: { ...process.env, NPM_CONFIG_REGISTRY: 'http://localhost:4873/' },
    });
    if (status !== 0) {
      throw new Error('Failed to init example');
    }
  });
  spawnSync('ls', ['-la'], { cwd: registryDir, stdio: 'inherit' });
  console.log('done ls -la');
  spawnSync('npm', ['run', 'build'], { cwd: '/tmp/registry/example', stdio: 'inherit' });
  console.log('done building');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
