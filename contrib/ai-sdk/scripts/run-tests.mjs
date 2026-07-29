// The AI SDK v7 packages require Node >= 22 (and unflagged require(esm), added in
// 22.12.0), but the workspace-wide CI test run also executes on older Node versions.
// Skip instead of failing there.
import { spawnSync } from 'node:child_process';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.log(`Skipping @temporalio/ai-sdk tests: requires Node >= 22.12.0, running on ${process.versions.node}`);
  process.exit(0);
}

const { status } = spawnSync('npx', ['ava', './lib/__tests__/test-*.js'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(status ?? 1);
