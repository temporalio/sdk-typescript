// Keep the test launcher runnable on the Node versions covered by the workspace.
const { spawnSync } = require('node:child_process');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.log(`Skipping @temporalio/ai-sdk tests: requires Node >= 22.12.0, running on ${process.versions.node}`);
  process.exit(0);
}

const { status } = spawnSync(process.execPath, ['../../scripts/ava-ci.js', './lib/__tests__/test-*.js'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(status ?? 1);
