import { rm, readFile, writeFile } from 'node:fs/promises';
import { statSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import * as glob from 'glob';
import * as pbjs from 'protobufjs-cli/pbjs';
import * as pbts from 'protobufjs-cli/pbts';

const outputDir = resolve(__dirname, '../protos');
const jsOutputFile = resolve(outputDir, 'json-module.js');
const tempFile = resolve(outputDir, 'temp.js');

const protoBaseDir = resolve(__dirname, '../../core-bridge/sdk-core/crates/common/protos');

function mtime(path: string) {
  try {
    return statSync(path).mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return 0;
    }
    throw err;
  }
}

async function compileProtos(dtsOutputFile: string, ...args: string[]) {
  const pbjsArgs = [
    ...['--wrap', 'commonjs'],
    '--force-long',
    '--no-verify',
    '--alt-comment',
    // Use --root to avoid conflicting with user's root
    // and to avoid this error: https://github.com/protobufjs/protobuf.js/issues/1114
    ...['--root', '__temporal'],
    ...args,
  ];

  console.log(`Creating protobuf JS definitions`);
  await promisify(pbjs.main)([...pbjsArgs, '--target', 'json-module', '--out', jsOutputFile]);

  console.log(`Creating protobuf TS definitions`);
  try {
    await promisify(pbjs.main)([...pbjsArgs, '--target', 'static-module', '--out', tempFile]);

    // pbts internally calls jsdoc, which do strict validation of jsdoc tags.
    // Unfortunately, some protobuf comment about cron syntax contains the
    // "@every" shorthand at the begining of a line, making it appear as a
    // (invalid) jsdoc tag. Similarly, docusaurus trips on <interval> and other
    // things that looks like html tags. We fix both cases by rewriting these
    // using markdown "inline code" syntax.
    let tempFileContent = await readFile(tempFile, 'utf8');
    tempFileContent = tempFileContent.replace(/(@(?:yearly|monthly|weekly|daily|hourly|every))/g, '`$1`');
    tempFileContent = tempFileContent.replace(/<((?:interval|phase|timezone)(?: [^>]+)?)>/g, '`<$1>`');
    await writeFile(tempFile, tempFileContent, 'utf-8');

    await promisify(pbts.main)(['--out', dtsOutputFile, tempFile]);
  } finally {
    await rm(tempFile);
  }
}

async function main() {
  mkdirSync(outputDir, { recursive: true });

  const protoFiles = glob.sync('**/*.proto', { cwd: protoBaseDir, absolute: true, root: '' });
  const protosMTime = Math.max(...protoFiles.map(mtime));
  const compileScriptMTime = mtime(resolve(__dirname, __filename));
  const genMTime = mtime(jsOutputFile);

  if (protosMTime < genMTime && compileScriptMTime < genMTime) {
    console.log('Assuming protos are up to date');
    return;
  }

  const rootDirs = [
    resolve(protoBaseDir, 'api_upstream'),
    resolve(protoBaseDir, 'testsrv_upstream'),
    resolve(protoBaseDir, 'local'),
    resolve(protoBaseDir, 'api_cloud_upstream'),
    protoBaseDir, // 'grpc' and 'google' are directly under protoBaseDir
  ];

  const entrypoints = [
    'temporal/sdk/core/core_interface.proto',
    'temporal/api/workflowservice/v1/service.proto',
    'temporal/api/operatorservice/v1/service.proto',
    'temporal/api/cloud/cloudservice/v1/service.proto',
    'temporal/api/errordetails/v1/message.proto',
    'temporal/api/sdk/v1/workflow_metadata.proto',
    'temporal/api/testservice/v1/request_response.proto',
    'temporal/api/testservice/v1/service.proto',
    'grpc/health/v1/health.proto',
    'google/rpc/status.proto',
  ];

  await compileProtos(
    resolve(outputDir, 'root.d.ts'),
    // Make sure to include all
    ...rootDirs.flatMap((dir) => ['--path', dir]),
    ...entrypoints
  );

  console.log('Done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
