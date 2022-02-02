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

function getPrebuiltPath() {
  const arch = archAlias[os.arch()];
  if (arch === undefined) {
    throw new PrebuildError(`No prebuilt module for arch ${os.arch()}`);
  }
  const platform = platformMapping[os.platform()];
  if (platform === undefined) {
    throw new PrebuildError(`No prebuilt module for platform ${os.platform()}`);
  }
  const binary = path.resolve(__dirname, 'releases', `${arch}-${platform}`, 'index.node');
  if (fs.existsSync(binary)) {
    console.log('Found prebuilt bridge module', { binary });
    return binary;
  } else {
    throw new PrebuildError(`No prebuilt module found at ${binary}`);
  }
}

module.exports = { targets, archAlias, platformMapping, PrebuildError, getPrebuiltPath };
