const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');
const cargo_cp_artifact = require('cargo-cp-artifact');

process.chdir(path.resolve(__dirname, '..'));

const targets = [
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-pc-windows-gnu',
];

const requestedTargets =
  process.env.TEMPORAL_WORKER_BUILD_TARGETS === 'all'
    ? targets
    : process.env.TEMPORAL_WORKER_BUILD_TARGETS
    ? process.env.TEMPORAL_WORKER_BUILD_TARGETS.split(':')
    : [];

// Only applicable if TEMPORAL_WORKER_BUILD_TARGETS is not specified
const forceBuild = new Set(['y', 't', '1', 'yes', 'true']).has(
  (process.env.TEMPORAL_WORKER_FORCE_BUILD || '').toLowerCase()
);

const archAlias = { x64: 'x86_64', arm64: 'aarch64' };
const platformMapping = { darwin: 'apple-darwin', linux: 'unknown-linux-gnu', win32: 'pc-windows-gnu' };

function compile(target) {
  console.log('Compiling bridge', { target });

  const out = target ? `releases/${target}/index.node` : 'index.node';
  try {
    fs.unlinkSync(out);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }

  try {
    argv = ['--artifact', 'cdylib', 'temporal_sdk_typescript_bridge', out, '--', 'cargo', 'build', '--message-format=json-render-diagnostics', '--release', ...(target ? ['--target', target] : []), ]
    cargo_cp_artifact(argv, process.env)
  } catch (error) {
    console.error(`Failed to build${target ? ' for ' + target : ''}`);
    throw error
  }
}

class PrebuildError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PrebuildError';
  }
}

function usePrebuilt() {
  const arch = archAlias[os.arch()];
  if (arch === undefined) {
    throw new PrebuildError(`No prebuilt module for arch ${os.arch()}`);
  }
  const platform = platformMapping[os.platform()];
  if (arch === undefined) {
    throw new PrebuildError(`No prebuilt module for platform ${os.platform()}`);
  }
  const source = path.resolve(__dirname, '../releases', `${arch}-${platform}`, 'index.node');
  const target = path.resolve(__dirname, '..', 'index.node');
  try {
    fs.copyFileSync(source, target);
    console.log('Copied prebuilt bridge module', { source, target });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new PrebuildError(`No prebuilt module found at ${source}`);
    }
    throw err;
  }
}

if (requestedTargets.length > 0) {
  // NOTE: no forceBuild
  for (const target of requestedTargets) {
    compile(target);
  }
} else {
  if (!forceBuild) {
    try {
      usePrebuilt();
    } catch (err) {
      if (err instanceof PrebuildError) {
        compile();
      } else {
        throw err;
      }
    }
  } else {
    console.log('Force build via TEMPORAL_WORKER_FORCE_BUILD env var');
    compile();
  }
}
