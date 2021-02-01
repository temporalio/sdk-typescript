const { resolve } = require('path');
const { spawnSync } = require('child_process');
const dedent = require('dedent');
const { removeSync, mkdirsSync, readFileSync, writeFileSync } = require('fs-extra');

const outputDir = resolve(__dirname, '../proto');
const isolateOutputDir = resolve(outputDir, 'isolate');
const protoBaseDir = resolve(__dirname, '../../sdk-core/protos');
removeSync(outputDir);
mkdirsSync(isolateOutputDir);

function npx(...args) {
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
  '--out',
  out,
  resolve(protoBaseDir, 'local/core_interface.proto'),
];

console.log('Creating protobuf JS definitions');
npx(...pbjsArgs('commonjs', resolve(outputDir, 'core-interface.js')));

console.log('Creating protobuf TS definitions');
npx('pbts', '--out', resolve(outputDir, 'core-interface.d.ts'), resolve(outputDir, 'core-interface.js'));

console.log('Converting protobufjs/minimal to ES module for isolate import');
const protobufjsSource = readFileSync(resolve(__dirname, '../node_modules/protobufjs/dist/minimal/protobuf.js'));
writeFileSync(resolve(isolateOutputDir, 'protobuf.js'), dedent`
  const module = { exports: {} }; 
  ${protobufjsSource}
  const { Reader, Writer, util, roots, rpc } = module.exports;
  export { Reader, Writer, util, roots, rpc };
  `
);

console.log('Create protobuf JS definitions for isolates');
npx(...pbjsArgs('es6', resolve(isolateOutputDir, 'core-interface.js')));
