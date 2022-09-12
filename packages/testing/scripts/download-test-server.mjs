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
const archAlias = { x64: 'amd64', arm64: 'arm64' };

const platform = platformMapping[os.platform()];
if (!platform) {
  throw new Error(`Unsupported platform ${os.platform()}`);
}

const arch = archAlias[os.arch()];
if (!arch) {
  throw new Error(`Unsupported architecture ${os.arch()}`);
}

const ext = platform === 'windows' ? '.exe' : '';
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

const defaultOptions = {
  headers: {
    'User-Agent': '@temporalio/testing installer',
  },
};

const lookupOptions = {
  ...defaultOptions,
  searchParams: { 'sdk-name': 'typescript', 'sdk-version': pkg.version, platform, arch },
};

const lookupUrl = 'https://temporal.download/temporal-test-server/default';
console.log('Looking up default test server', { lookupUrl, options: lookupOptions });
const { archiveUrl, fileToExtract } = await got(
  'https://temporal.download/temporal-test-server/default',
  lookupOptions
).json();

console.log('Downloading test server', { archiveUrl, fileToExtract, outputPath });
if (archiveUrl.endsWith('.tar.gz')) {
  const extract = tar.extract();
  extract.on('entry', (headers, stream, next) => {
    if (headers.name === fileToExtract) {
      stream.pipe(fs.createWriteStream(outputPath));
    }
    next();
  });
  await pipeline(got.stream(archiveUrl, defaultOptions), zlib.createGunzip(), extract);
  await fs.promises.chmod(outputPath, 0o755);
} else if (archiveUrl.endsWith('.zip')) {
  got
    .stream(archiveUrl, defaultOptions)
    .pipe(unzipper.Parse())
    .on('entry', (entry) => {
      if (entry.type === 'File' && entry.path === fileToExtract) {
        entry.pipe(fs.createWriteStream(outputPath));
      } else {
        entry.autodrain();
      }
    });
}
