const { resolve } = require('path');
const { promisify } = require('util');
const dedent = require('dedent');
const glob = require('glob');
const { statSync, mkdirsSync, readFileSync, writeFileSync } = require('fs-extra');
const pbjs = require('protobufjs/cli/pbjs');
const pbts = require('protobufjs/cli/pbts');

const outputDir = resolve(__dirname, '../lib');
const coresdkJsOutputFile = resolve(outputDir, 'coresdk.js');
const serviceJsOutputFile = resolve(outputDir, 'temporal.js');
const protoBaseDir = resolve(__dirname, '../../core-bridge/sdk-core/protos');

const coreProtoPath = resolve(protoBaseDir, 'local/temporal/sdk/core/core_interface.proto');
const serviceProtoPath = resolve(protoBaseDir, 'api_upstream/temporal/api/workflowservice/v1/service.proto');

function mtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return 0;
    }
    throw err;
  }
}

async function compileProtos(protoPath, jsOutputFile, dtsOutputFile, ...args) {
  console.log(`Creating protobuf JS definitions from ${protoPath}`);

  const pbjsArgs = [
    ...args,
    '--wrap',
    'commonjs',
    '--target',
    'static-module',
    '--force-long',
    '--no-verify',
    '--no-create',
    '--out',
    jsOutputFile,
    protoPath,
  ];
  await promisify(pbjs.main)(pbjsArgs);

  console.log(`Creating protobuf TS definitions from ${protoPath}`);
  await promisify(pbts.main)(['--out', dtsOutputFile, jsOutputFile]);

  // Fix issue where Long is not found in TS definitions (https://github.com/protobufjs/protobuf.js/issues/1533)
  const pbtsOutput = readFileSync(dtsOutputFile, 'utf8');
  writeFileSync(
    dtsOutputFile,
    dedent`
  import Long from "long";
  ${pbtsOutput}
  `
  );

  // Get rid of most comments in file (cuts size in half)
  const pbjsOutput = readFileSync(jsOutputFile, 'utf8');
  const sanitizedOutput = pbjsOutput
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\*\*)/.test(l))
    .join('\n');
  writeFileSync(jsOutputFile, sanitizedOutput);
}

async function main() {
  mkdirsSync(outputDir);

  const protoFiles = glob.sync(resolve(protoBaseDir, '**/*.proto'));
  const protosMTime = Math.max(...protoFiles.map(mtime));
  const genMTime = Math.min(mtime(coresdkJsOutputFile), mtime(serviceJsOutputFile));

  if (protosMTime < genMTime) {
    console.log('Asuming protos are up to date');
    return;
  }

  await compileProtos(
    coreProtoPath,
    coresdkJsOutputFile,
    resolve(outputDir, 'coresdk.d.ts'),
    '--path',
    resolve(protoBaseDir, 'api_upstream'),
    '--path',
    resolve(protoBaseDir, 'local')
  );
  await compileProtos(
    serviceProtoPath,
    serviceJsOutputFile,
    resolve(outputDir, 'temporal.d.ts'),
    '--path',
    resolve(protoBaseDir, 'api_upstream')
  );

  console.log('Done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
