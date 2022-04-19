import os from 'node:os';
import { URL, fileURLToPath } from 'node:url';

const platformMapping = { darwin: 'macOS', linux: 'linux', win32: 'windows' };
const archAlias = { x64: 'amd64', arm64: 'aarch64' };

export const systemPlatform = platformMapping[os.platform()];
if (!systemPlatform) {
  throw new Error(`Unsupported platform ${os.platform()}`);
}

export const systemArch = archAlias[os.arch()];
if (!systemArch) {
  throw new Error(`Unsupported architecture ${os.arch()}`);
}

const ext = systemPlatform === 'windows' ? '.exe' : '';
export const outputPath = fileURLToPath(new URL(`../test-server${ext}`, import.meta.url));
