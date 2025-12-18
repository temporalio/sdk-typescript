// Script to do the equivalent of:
// pbjs -t json-module -w commonjs -r test -o protos/json-module.js protos/*.proto
// pbjs -t static-module protos/*.proto | pbts -o protos/root.d.ts -
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import * as glob from 'glob';
import { statSync, mkdirsSync } from 'fs-extra';
import * as pbjs from 'protobufjs-cli/pbjs';
import * as pbts from 'protobufjs-cli/pbts';

const outputDir = resolve(__dirname, '../protos');
const moduleOutputFile = resolve(outputDir, 'json-module.js');
const typesOutputFile = resolve(outputDir, 'root.d.ts');
const tempFile = resolve(outputDir, 'temp.js');
const protoBaseDir = resolve(__dirname, '../protos');
const protoFiles = glob.sync('*.proto', { cwd: protoBaseDir, absolute: true, root: '' });

function mtime(path: string) {
  try {
    return statSync(path).mtimeMs;
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') {
      return 0;
    }
    throw err;
  }
}

async function compileProtos(outputFile: string, ...args: string[]) {
  const pbjsArgs = [
    ...args,
    '--wrap',
    'commonjs',
    '--force-long',
    '--no-verify',
    '--alt-comment',
    '--out',
    outputFile,
    ...protoFiles,
  ];
  return await promisify(pbjs.main)(pbjsArgs);
}

async function main() {
  mkdirsSync(outputDir);

  const protosMTime = Math.max(...protoFiles.map(mtime));
  const genMTime = Math.min(mtime(moduleOutputFile), mtime(typesOutputFile));

  if (protosMTime < genMTime) {
    console.log('Assuming protos are up to date');
    return;
  }

  console.log(`Creating protobuf JS definitions from ${protoFiles}`);
  await compileProtos(moduleOutputFile, '--target', 'json-module', '--root', 'test');

  console.log(`Creating protobuf TS definitions from ${protoFiles}`);
  try {
    await compileProtos(tempFile, '--target', 'static-module');
    await promisify(pbts.main)(['--out', typesOutputFile, tempFile]);
  } finally {
    await rm(tempFile);
  }

  console.log('Done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
