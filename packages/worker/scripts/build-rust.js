const path = require('path');
const { spawnSync } = require('child_process');

process.chdir(path.resolve(__dirname, '../native'));

const targets = ['x86_64-apple-darwin', 'aarch64-apple-darwin', 'x86_64-unknown-linux-gnu', 'x86_64-pc-windows-gnu'];

const requestedTargets =
  process.env.TEMPORAL_WORKER_BUILD_TARGETS === 'all'
    ? targets
    : process.env.TEMPORAL_WORKER_BUILD_TARGETS
    ? process.env.TEMPORAL_WORKER_BUILD_TARGETS.split(':')
    : [];

function compile(target) {
  console.log('Compiling bridge', { target });
  const { status } = spawnSync(
    'cargo-cp-artifact',
    [
      '--artifact',
      'cdylib',
      'temporal_sdk_node_bridge',
      ...(target ? [`releases/${target}/index.node`] : ['index.node']),
      '--',
      'cargo',
      'build',
      '--message-format=json-render-diagnostics',
      '--release',
      ...(target ? ['--target', target] : []),
    ],
    { stdio: 'inherit' }
  );
  if (status !== 0) {
    throw new Error(`Failed to build${target ? ' for ' + target : ''}`);
  }
}

if (requestedTargets.length > 0) {
  for (const target of requestedTargets) {
    compile(target);
  }
} else {
  compile();
}
