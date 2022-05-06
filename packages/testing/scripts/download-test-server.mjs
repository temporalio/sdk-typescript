import stream from 'node:stream';
import util from 'node:util';
import zlib from 'node:zlib';
import fs from 'node:fs';
import got from 'got';
import tar from 'tar-stream';
import unzipper from 'unzipper';
import { outputPath, systemArch, systemPlatform } from './common.mjs';

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

const defaultHeaders = {
  'User-Agent': '@temporalio/testing installer',
};

const { GITHUB_TOKEN } = process.env;
if (GITHUB_TOKEN) {
  console.log(`Using GITHUB_TOKEN`);
  defaultHeaders['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
}

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
      const [_, assetPlatform, _assetArch] = m;
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

if (asset.content_type === 'application/x-gzip' || asset.content_type === 'application/x-gtar') {
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
} else {
  throw new Error(`Unexpected content type for Test server download: ${asset.content_type}`);
}
