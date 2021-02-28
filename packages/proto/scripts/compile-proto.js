const { promisify } = require('util');
const { resolve } = require('path');
const { spawnSync } = require('child_process');
const dedent = require('dedent');
const { removeSync, mkdirsSync, readFileSync, writeFileSync } = require('fs-extra');
const pbjs = require('protobufjs/cli/pbjs');
const pbts = require('protobufjs/cli/pbts');

const outputDir = resolve(__dirname, '..');
const commonjsOutputDir = resolve(outputDir, 'commonjs');
const es2020OutputDir = resolve(outputDir, 'es2020');
const protoBaseDir = resolve(__dirname, '../../../sdk-core/protos');
removeSync(commonjsOutputDir);
removeSync(es2020OutputDir);
mkdirsSync(commonjsOutputDir);
mkdirsSync(es2020OutputDir);

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
  resolve(protoBaseDir, 'local/core_interface.proto'),
  resolve(protoBaseDir, 'api_upstream/temporal/api/workflowservice/v1/service.proto'),
];

async function main() {
  console.log('Creating protobuf JS definitions');
  await promisify(pbjs.main)(pbjsArgs('commonjs', resolve(commonjsOutputDir, 'index.js')));

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

  console.log('Create protobuf JS definitions for isolates');
  await promisify(pbjs.main)(pbjsArgs('es6', resolve(es2020OutputDir, 'index.js')));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
