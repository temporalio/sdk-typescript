const path = require('path');
const os = require('os');
const fs = require('fs');

const archAlias = { x64: 'x86_64', arm64: 'aarch64' };
const platformMapping = { darwin: 'apple-darwin', linux: 'unknown-linux-gnu', win32: 'pc-windows-gnu' };

const arch = archAlias[os.arch()];
if (arch === undefined) {
  throw new Error(`No prebuilt module for arch ${os.arch()}`);
}
const platform = platformMapping[os.platform()];
if (arch === undefined) {
  throw new Error(`No prebuilt module for platform ${os.platform()}`);
}

const source = path.resolve(__dirname, '../native/releases', `${arch}-${platform}`, 'index.node');
const target = path.resolve(__dirname, '../native', 'index.node');
fs.copyFileSync(source, target);
console.log('Copied prebuilt bridge module', { source, target });
