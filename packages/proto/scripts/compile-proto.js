const { resolve } = require('path');
const { promisify } = require('util');
const dedent = require('dedent');
const glob = require('glob');
const { statSync, mkdirsSync, readFileSync, writeFileSync } = require('fs-extra');
const pbjs = require('protobufjs/cli/pbjs');
const pbts = require('protobufjs/cli/pbts');

const outputDir = resolve(__dirname, '../lib');
const jsOutputFile = resolve(outputDir, 'index.js');
const dtsOutputFile = resolve(outputDir, 'index.d.ts');
const protoBaseDir = resolve(__dirname, '../../core-bridge/sdk-core/protos');
mkdirsSync(outputDir);

const coreProtoPath = resolve(protoBaseDir, 'local/core_interface.proto');
const serviceProtoPath = resolve(protoBaseDir, 'api_upstream/temporal/api/workflowservice/v1/service.proto');

const pbjsArgs = [
  '--path',
  resolve(protoBaseDir, 'api_upstream'),
  '--wrap',
  'commonjs',
  '--target',
  'static-module',
  '--force-long',
  '--out',
  jsOutputFile,
  coreProtoPath,
  serviceProtoPath,
];

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

async function main() {
  const protoFiles = glob.sync(resolve(protoBaseDir, '**/*.proto'));
  const protosMTime = Math.max(...protoFiles.map(mtime));

  if (protosMTime < mtime(jsOutputFile)) {
    console.log('Asuming protos are up to date');
    return;
  }

  console.log('Creating protobuf JS definitions');
  await promisify(pbjs.main)(pbjsArgs);

  console.log('Creating protobuf TS definitions');
  await promisify(pbts.main)(['--out', dtsOutputFile, jsOutputFile]);

  const moduleHeader = readFileSync(resolve(__dirname, 'module-header.txt'), 'utf8');
  // Prepend module docs and fix issue where Long is not found in TS definitions (https://github.com/protobufjs/protobuf.js/issues/1533)
  const pbtsOutput = readFileSync(dtsOutputFile, 'utf8');
  writeFileSync(
    dtsOutputFile,
    dedent`
  ${moduleHeader}
  import Long from "long";
  ${pbtsOutput}
  `
  );

  console.log('Done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
