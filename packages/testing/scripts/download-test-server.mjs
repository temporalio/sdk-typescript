import stream from 'node:stream';
import util from 'node:util';
import os from 'node:os';
import zlib from 'node:zlib';
import fs from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import got from 'got';
import tar from 'tar-stream';
import unzipper from 'unzipper';

const pipeline = util.promisify(stream.pipeline);

const platformMapping = { darwin: 'macOS', linux: 'linux', win32: 'windows' };
const archAlias = { x64: 'amd64', arm64: 'aarch64' };
const defaultHeaders = {
  'User-Agent': '@temporalio/testing installer',
};

const systemPlatform = platformMapping[os.platform()];
if (!systemPlatform) {
  throw new Error(`Unsupported platform ${os.platform()}`);
}

const systemArch = archAlias[os.arch()];
if (!systemArch) {
  throw new Error(`Unsupported architecture ${os.arch()}`);
}

const ext = systemPlatform === 'windows' ? '.exe' : '';
const outputPath = fileURLToPath(new URL(`../test-server${ext}`, import.meta.url));

const latestReleaseRes = await got('https://api.github.com/repos/temporalio/sdk-java/releases/latest', {
  headers: {
    ...defaultHeaders,
    Accept: 'application/vnd.github.v3+json',
  },
}).json();

function findTestServerAsset(assets) {
  for (const asset of assets) {
    const m = asset.name.match(/^temporal-test-server_[^_]+_([^_]+)_([^.]+)\.(?:zip|tar.gz)$/);
    if (m) {
      const [_, assetPlatform, assetArch] = m;
      if (assetPlatform === systemPlatform) {
        // TODO: assetArch === systemArch (no arm builds for test server yet)
        return asset;
      }
    }
  }
  throw new Error(`No prebuilt test server for ${systemPlatform}-${systemArch}`);
}

const asset = findTestServerAsset(latestReleaseRes.assets);
console.log('Downloading test server', { asset: asset.name, outputPath });

if (asset.content_type === 'application/x-gzip') {
  const extract = tar.extract();
  extract.on('entry', (_headers, stream, next) => {
    stream.pipe(fs.createWriteStream(outputPath));
    next();
  });
  await pipeline(
    got.stream(asset.browser_download_url, {
      headers: {
        ...defaultHeaders,
      },
    }),
    zlib.createGunzip(),
    extract
  );
  await fs.promises.chmod(outputPath, 0o755);
} else if (asset.content_type === 'application/zip') {
  got
    .stream(asset.browser_download_url, {
      headers: {
        ...defaultHeaders,
      },
    })
    .pipe(unzipper.Parse())
    .on('entry', (entry) => {
      if (entry.type === 'File') {
        entry.pipe(fs.createWriteStream(outputPath));
      } else {
        entry.autodrain();
      }
    });
}
