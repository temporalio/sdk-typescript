const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');
const which = require('which');
const { ArgumentParser } = require('argparse');
const { version } = require('../package.json');

process.chdir(path.resolve(__dirname, '..'));

const targets = [
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-pc-windows-gnu',
];

// parse arguments
const parser = new ArgumentParser({
  prog: path.basename(__filename),
  description: '%(prog)s compiles the sdk-core via cargo and then packages it as javascript module',
  epilog: 'Happy compiling!',
});
parser.add_argument('-v', '--version', { action: 'version', version });
parser.add_argument('-t', '--targets', {
  action: 'append',
  default: [],
  choices: [...targets, 'all'],
  help: 'specifies the targets to build for (formerly env.TEMPORAL_WORKER_BUILD_TARGETS)',
});
parser.add_argument('-f', '--force', {
  action: 'store_const',
  default: false,
  const: true,
  help: 'forces a clean rebuild of sdk-core and repackaging (formerly env.TEMPORAL_WORKER_FORCE_BUILD)',
});
const parsed_arguments = parser.parse_args();

// prepare recompile options
const requestedTargets = parsed_arguments.targets.includes('all') ? targets : parsed_arguments.targets;
const forceBuild = parsed_arguments.force;
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

  argv = [
    '--artifact',
    'cdylib',
    'temporal_sdk_typescript_bridge',
    out,
    '--',
    'cargo',
    'build',
    '--message-format=json-render-diagnostics',
    '--release',
    ...(target ? ['--target', target] : []),
  ];
  const { status, output, error } = spawnSync(which.sync('cargo-cp-artifact'), argv, {
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  if (error !== undefined) {
    console.error(`./> ${which.sync('cargo-cp-artifact')} ${argv.join(' ')}`);
    console.error(`Failed to build${target ? ' for ' + target : ''} with output:`);
    console.error(output);
    throw error;
  }
  if (status !== 0) {
    console.error(`./> ${which.sync('cargo-cp-artifact')} ${argv.join(' ')}`);
    console.error(`rc=${status} failed to build${target ? ' for ' + target : ''} with output:`);
    console.error(output);
    throw new Error(`Failed to build${target ? ' for ' + target : ''}`);
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
    console.log('Forced the build via --force');
    compile();
  }
}
