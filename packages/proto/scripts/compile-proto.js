const { rm, readFile, writeFile } = require('fs/promises');
const { resolve } = require('path');
const { promisify } = require('util');
const dedent = require('dedent');
const glob = require('glob');
const { statSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const pbjs = require('protobufjs-cli/pbjs');
const pbts = require('protobufjs-cli/pbts');

const outputDir = resolve(__dirname, '../protos');
const jsOutputFile = resolve(outputDir, 'json-module.js');
const tempFile = resolve(outputDir, 'temp.js');
const protoBaseDir = resolve(__dirname, '../../core-bridge/sdk-core/protos');

const coreProtoPath = resolve(protoBaseDir, 'local/temporal/sdk/core/core_interface.proto');
const workflowServiceProtoPath = resolve(protoBaseDir, 'api_upstream/temporal/api/workflowservice/v1/service.proto');
const operatorServiceProtoPath = resolve(protoBaseDir, 'api_upstream/temporal/api/operatorservice/v1/service.proto');
const testServiceRRProtoPath = resolve(
  protoBaseDir,
  'testsrv_upstream/temporal/api/testservice/v1/request_response.proto'
);
const testServiceProtoPath = resolve(protoBaseDir, 'testsrv_upstream/temporal/api/testservice/v1/service.proto');
const healthServiceProtoPath = resolve(protoBaseDir, 'grpc/health/v1/health.proto');

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

async function compileProtos(dtsOutputFile, ...args) {
  // Use --root to avoid conflicting with user's root
  // and to avoid this error: https://github.com/protobufjs/protobuf.js/issues/1114
  const pbjsArgs = [
    ...args,
    '--wrap',
    'commonjs',
    '--force-long',
    '--no-verify',
    '--alt-comment',
    '--root',
    '__temporal',
    resolve(require.resolve('protobufjs'), '../google/protobuf/descriptor.proto'),
    coreProtoPath,
    workflowServiceProtoPath,
    operatorServiceProtoPath,
    testServiceRRProtoPath,
    testServiceProtoPath,
    healthServiceProtoPath,
  ];

  console.log(`Creating protobuf JS definitions from ${coreProtoPath} and ${workflowServiceProtoPath}`);
  await promisify(pbjs.main)([...pbjsArgs, '--target', 'json-module', '--out', jsOutputFile]);

  console.log(`Creating protobuf TS definitions from ${coreProtoPath} and ${workflowServiceProtoPath}`);
  try {
    await promisify(pbjs.main)([...pbjsArgs, '--target', 'static-module', '--out', tempFile]);

    // pbts internally calls jsdoc, which do strict validation of jsdoc tags.
    // Unfortunately, some protobuf comment about cron syntax contains the
    // "@every" shorthand at the begining of a line, making it appear as a
    // (invalid) jsdoc tag. We fix this by rewriting all cron shorthand
    // using markdown "code" syntax.
    let tempFileContent = await readFile(tempFile, 'utf8');
    tempFileContent = tempFileContent.replace(/(@(?:yearly|monthly|weekly|daily|hourly|every))/g, '`$1`');
    await writeFile(tempFile, tempFileContent, 'utf-8');

    await promisify(pbts.main)(['--out', dtsOutputFile, tempFile]);
  } finally {
    await rm(tempFile);
  }
}

async function main() {
  mkdirSync(outputDir, { recursive: true });

  const protoFiles = glob.sync(resolve(protoBaseDir, '**/*.proto'));
  const protosMTime = Math.max(...protoFiles.map(mtime));
  const genMTime = mtime(jsOutputFile);

  if (protosMTime < genMTime) {
    console.log('Assuming protos are up to date');
    return;
  }

  await compileProtos(
    resolve(outputDir, 'root.d.ts'),
    '--path',
    resolve(protoBaseDir, 'api_upstream'),
    '--path',
    resolve(protoBaseDir, 'local')
  );

  console.log('Done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
