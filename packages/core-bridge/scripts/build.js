const path = require('path');
const arg = require('arg');
const fs = require('fs');
const which = require('which');
const { spawnSync } = require('child_process');
const { version } = require('../package.json');
const { targets, getPrebuiltPath, PrebuildError } = require('../common');

process.chdir(path.resolve(__dirname, '..'));

const args = arg({
  '--help': Boolean,
  '-h': '--help',
  '--version': Boolean,
  '-v': '--version',
  '--release': Boolean,
  '--target': [String],
  '--force': Boolean,
  '-f': '--force',
});

const HELP_STRING = `${path.basename(
  process.argv[1]
)} compiles the Core SDK and temporal-sdk-typescript-bridge Rust libraries

Options:

-h, --help     Show this help message and exit
-v, --version  Show program's version number and exit
-f, --force    Forces a build instead of using a prebuilt binary
--release      Build in release mode (or set BUILD_CORE_RELEASE env var)
--target       Compilation targets, choose any of:
  ${targets.concat('all').join('\n  ')}

Happy compiling!`;

if (args['--help']) {
  console.log(HELP_STRING);
  process.exit();
}
if (args['--version']) {
  console.log(version);
  process.exit();
}

// prepare recompile options
const targetsArg = args['--target'] || [];
const requestedTargets = targetsArg.includes('all') ? targets : targetsArg;
const unsupportedTargets = requestedTargets.filter((t) => !targets.includes(t));
if (unsupportedTargets.length) {
  console.error(`Unsupported targets ${JSON.stringify(unsupportedTargets)}`);
  process.exit(1);
}
const forceBuild = args['--force'];
const buildRelease = args['--release'] || process.env.BUILD_CORE_RELEASE !== undefined;

function compile(target) {
  console.log('Compiling bridge', { target, buildRelease });

  const out = target ? `releases/${target}/index.node` : 'default-build/index.node';
  try {
    fs.unlinkSync(out);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }

  const argv = [
    '--artifact',
    'cdylib',
    'temporal_sdk_typescript_bridge',
    out,
    '--',
    'cargo',
    'build',
    '--message-format=json-render-diagnostics',
    ...(buildRelease ? ['--release'] : []),
    ...(target ? ['--target', target] : []),
  ];
  const cmd = which.sync('cargo-cp-artifact');

  console.log('Running', cmd, argv);
  const { status } = spawnSync(cmd, argv, {
    stdio: 'inherit',
  });
  if (status !== 0) {
    throw new Error(`Failed to build${target ? ' for ' + target : ''}`);
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
      getPrebuiltPath();
    } catch (err) {
      if (err instanceof PrebuildError) {
        console.warn(err.message);
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
