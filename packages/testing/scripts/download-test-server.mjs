import stream from 'node:stream';
import util from 'node:util';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import got from 'got';
import tar from 'tar-stream';
import unzipper from 'unzipper';
import { URL, fileURLToPath } from 'node:url';

const platformMapping = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
const archAlias = { x64: 'amd64', arm64: 'aarch64' };

const systemPlatform = platformMapping[os.platform()];
if (!systemPlatform) {
  throw new Error(`Unsupported platform ${os.platform()}`);
}

const systemArch = archAlias[os.arch()];
if (!systemArch) {
  throw new Error(`Unsupported architecture ${os.arch()}`);
}

const ext = systemPlatform === 'windows' ? '.exe' : '';
const assetExt = systemPlatform === 'windows' ? 'zip' : 'tar.gz';
const outputPath = fileURLToPath(new URL(`../test-server${ext}`, import.meta.url));
const pkgPath = fileURLToPath(new URL(`../package.json`, import.meta.url));
const pkg = JSON.parse(fs.readFileSync(pkgPath));

try {
  if (fs.statSync(outputPath).isFile) {
    console.log('Found existing test server executable', { path: outputPath });
    process.exit(0);
  }
} catch (err) {
  if (err.code !== 'ENOENT') {
    throw err;
  }
}

const pipeline = util.promisify(stream.pipeline);

const options = {
  headers: {
    'User-Agent': '@temporalio/testing installer',
  },
  searchParams: { 'sdk-name': 'typescript', 'sdk-version': pkg.version },
};

// TODO: use "real" arch when we get arm builds for test server
const assetUrl = `https://temporal.download/temporal-test-server/temporal-test-server_default_${systemPlatform}_amd64.${assetExt}`;
console.log('Downloading test server', { assetUrl, outputPath });

if (assetExt === 'tar.gz') {
  const extract = tar.extract();
  extract.on('entry', (_headers, stream, next) => {
    stream.pipe(fs.createWriteStream(outputPath));
    next();
  });
  await pipeline(got.stream(assetUrl, options), zlib.createGunzip(), extract);
  await fs.promises.chmod(outputPath, 0o755);
} else if (assetExt === 'zip') {
  got
    .stream(assetUrl, options)
    .pipe(unzipper.Parse())
    .on('entry', (entry) => {
      if (entry.type === 'File') {
        entry.pipe(fs.createWriteStream(outputPath));
      } else {
        entry.autodrain();
      }
    });
}
