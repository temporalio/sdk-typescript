import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import dedent from 'dedent';
import glob from 'glob';
import { statSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import pbjs from 'protobufjs/cli/pbjs.js';
import pbts from 'protobufjs/cli/pbts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(__dirname, '../generated-protos');
const outputFile = resolve(outputDir, 'index.js');
const protoBaseDir = resolve(__dirname, '../proto');

const serviceProtoPath = resolve(protoBaseDir, 'temporal/api/testservice/v1/service.proto');

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
    '--root',
    '__temporal_testing',
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
}

mkdirSync(outputDir, { recursive: true });

const protoFiles = glob.sync(resolve(protoBaseDir, '**/*.proto'));
const protosMTime = Math.max(...protoFiles.map(mtime));
const genMTime = mtime(outputFile);

if (protosMTime < genMTime) {
  console.log('Assuming protos are up to date');
  process.exit(0);
}

await compileProtos(serviceProtoPath, outputFile, resolve(outputDir, 'index.d.ts'), '--path', resolve(protoBaseDir));

console.log('Done');
