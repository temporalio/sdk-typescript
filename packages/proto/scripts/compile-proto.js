const { promisify } = require('util');
const { resolve } = require('path');
const dedent = require('dedent');
const glob = require('glob');
const { statSync, removeSync, mkdirsSync, readFileSync, writeFileSync } = require('fs-extra');
const pbjs = require('protobufjs/cli/pbjs');
const pbts = require('protobufjs/cli/pbts');

const outputDir = resolve(__dirname, '..');
const commonjsOutputDir = resolve(outputDir, 'commonjs');
const es2020OutputDir = resolve(outputDir, 'es2020');
const protoBaseDir = resolve(__dirname, '../../worker/native/sdk-core/protos');
mkdirsSync(commonjsOutputDir);
mkdirsSync(es2020OutputDir);

const coreProtoPath = resolve(protoBaseDir, 'local/core_interface.proto');
const serviceProtoPath = resolve(protoBaseDir, 'api_upstream/temporal/api/workflowservice/v1/service.proto');

const pbjsArgs = (wrap, out) => [
  '--path',
  resolve(protoBaseDir, 'api_upstream'),
  '--wrap',
  wrap,
  '--target',
  'static-module',
  '--force-number',
  '--out',
  out,
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
  // TODO: any proto file could have changed
  const protosMTime = Math.max(...protoFiles.map(mtime));

  const commonjsImplPath = resolve(commonjsOutputDir, 'index.js');
  if (protosMTime < mtime(commonjsImplPath)) {
    console.log('Asuming protos are up to date');
    return;
  }

  console.log('Creating protobuf JS definitions');
  await promisify(pbjs.main)(pbjsArgs('commonjs', commonjsImplPath));

  console.log('Creating protobuf TS definitions');
  await promisify(pbts.main)([
    '--out',
    resolve(commonjsOutputDir, 'index.d.ts'),
    resolve(commonjsOutputDir, 'index.js'),
  ]);

  console.log('Converting protobufjs/minimal to ES module for isolate import');
  const protobufjsSource = readFileSync(require.resolve('protobufjs/dist/minimal/protobuf.js'));
  writeFileSync(
    resolve(es2020OutputDir, 'protobuf.js'),
    dedent`
  const module = { exports: {} }; 
  ${protobufjsSource}
  const { Reader, Writer, util, roots, rpc } = module.exports;
  export { Reader, Writer, util, roots, rpc };
  `
  );

  console.log('Creating protobuf JS definitions for isolates');
  await promisify(pbjs.main)(pbjsArgs('es6', resolve(es2020OutputDir, 'index.js')));
  console.log('Done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
