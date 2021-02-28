const { resolve } = require('path');
const { spawnSync } = require('child_process');
const dedent = require('dedent');
const { removeSync, mkdirsSync, readFileSync, writeFileSync } = require('fs-extra');

const outputDir = resolve(__dirname, '..');
const commonjsOutputDir = resolve(outputDir, 'commonjs');
const es2020OutputDir = resolve(outputDir, 'es2020');
const protoBaseDir = resolve(__dirname, '../../../sdk-core/protos');
removeSync(commonjsOutputDir);
removeSync(es2020OutputDir);
mkdirsSync(commonjsOutputDir);
mkdirsSync(es2020OutputDir);

function npx(...args) {
  console.log(...args);
  const { status } = spawnSync('npx', args, { stdio: 'inherit' });
  if (status !== 0) {
    throw new Error(`Failed to run ${args[0]}`);
  }
}

const pbjsArgs = (wrap, out) => [
  'pbjs',
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

console.log('Creating protobuf JS definitions');
npx(...pbjsArgs('commonjs', resolve(commonjsOutputDir, 'index.js')));

console.log('Creating protobuf TS definitions');
npx('pbts', '--out', resolve(commonjsOutputDir, 'index.d.ts'), resolve(commonjsOutputDir, 'index.js'));

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
npx(...pbjsArgs('es6', resolve(es2020OutputDir, 'index.js')));
