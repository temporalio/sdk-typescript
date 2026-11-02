/**
 * Shared code for scripts/build.js and index.js
 *
 * @module
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// List of tested compile targets
const targets = [
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  // TODO: this is not supported on macos
  'x86_64-pc-windows-msvc',
  'x86_64-pc-windows-gnu',
];

const archAlias = { x64: 'x86_64', arm64: 'aarch64' };
const platformMapping = { darwin: 'apple-darwin', linux: 'unknown-linux-gnu', win32: 'pc-windows-msvc' };

class PrebuildError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PrebuildError';
  }
}

function getPrebuiltTargetName() {
  const arch = archAlias[os.arch()];
  if (arch === undefined) {
    throw new PrebuildError(`No prebuilt module for arch ${os.arch()}`);
  }
  const platform = platformMapping[os.platform()];
  if (platform === undefined) {
    throw new PrebuildError(`No prebuilt module for platform ${os.platform()}`);
  }
  return `${arch}-${platform}`;
}

function getPrebuiltPath() {
  const binary = path.resolve(__dirname, 'releases', getPrebuiltTargetName(), 'index.node');
  if (fs.existsSync(binary)) {
    return binary;
  } else {
    throw new PrebuildError(`No prebuilt module found at ${binary}`);
  }
}

/**
 * Load the prebuilt native module for the current platform.
 *
 * Each target is required through a literal path, so that bundlers that embed native modules
 * (such as `bun build --compile`, or esbuild and webpack with a `.node` loader) can find it: a
 * path computed at run time, as in {@link getPrebuiltPath}, is invisible to them. The platform and
 * architecture checks are literal too, so a bundler that knows its target can drop the modules of
 * the other platforms. Unsupported targets and missing modules fail with the same
 * {@link PrebuildError} as before.
 */
function requirePrebuilt() {
  try {
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      return require('./releases/aarch64-apple-darwin/index.node');
    }
    if (process.platform === 'darwin' && process.arch === 'x64') {
      return require('./releases/x86_64-apple-darwin/index.node');
    }
    if (process.platform === 'linux' && process.arch === 'arm64') {
      return require('./releases/aarch64-unknown-linux-gnu/index.node');
    }
    if (process.platform === 'linux' && process.arch === 'x64') {
      return require('./releases/x86_64-unknown-linux-gnu/index.node');
    }
    if (process.platform === 'win32' && process.arch === 'x64') {
      return require('./releases/x86_64-pc-windows-msvc/index.node');
    }
  } catch (err) {
    if (err?.code !== 'MODULE_NOT_FOUND') throw err;
  }
  return require(getPrebuiltPath());
}

module.exports = {
  targets,
  archAlias,
  platformMapping,
  PrebuildError,
  getPrebuiltPath,
  getPrebuiltTargetName,
  requirePrebuilt,
};
