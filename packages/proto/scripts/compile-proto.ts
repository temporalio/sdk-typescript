import { rm, readFile, writeFile } from 'node:fs/promises';
import { statSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import * as glob from 'glob';
import * as pbjs from 'protobufjs-cli/pbjs';
import * as pbts from 'protobufjs-cli/pbts';

const outputDir = resolve(__dirname, '../protos');
const jsOutputFile = resolve(outputDir, 'json-module.js');
const tempFile = resolve(outputDir, 'temp.js');
// Kept alongside the generated protobuf bindings so consumers which need a
// descriptor (such as System Nexus binding generation) use precisely the same
// proto sources and entry points.
const descriptorOutputFile = resolve(outputDir, 'temporal_api.bin');

const protoBaseDir = resolve(__dirname, '../../core-bridge/sdk-core/crates/protos/protos');

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

async function compileProtos(dtsOutputFile: string, ...args: string[]) {
  const pbjsArgs = [
    ...['--wrap', 'commonjs'],
    '--force-long',
    '--no-verify',
    '--no-typeurl',
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

    // We ship the json-module output, whose messages are reflection-backed, so `new Foo()` never
    // works — `Foo.create()` is the only way to build one. Emitting private constructors turns
    // that documented footgun into a compile error.
    await promisify(pbts.main)(['--no-constructor', '--out', dtsOutputFile, tempFile]);
    await dropUnknownFieldsMember(dtsOutputFile);
    await undeprecateLegacyMessageTypeAliases(dtsOutputFile);
  } finally {
    await rm(tempFile);
  }
}

/**
 * protobufjs 8 declares a `$unknowns` member on every generated message, holding the raw bytes of
 * fields that were not recognized while decoding. Retention is opt-in through the reader's
 * `discardUnknown` flag, which defaults to `true`, so the property is never actually present on
 * any message we hand out. Declaring it anyway is not free: `$unknowns` is the one member every
 * message has in common, which makes distinct message types far less distinguishable structurally,
 * and it leaks into anything mapping over a message's keys (`Required<IFoo>` and friends).
 */
async function dropUnknownFieldsMember(dtsFile: string) {
  let content = await readFile(dtsFile, 'utf8');

  const declaration = String.raw`[ \t]*\$unknowns\?: Uint8Array\[\];[ \t]*\r?\n`;
  const expected = (content.match(new RegExp(`^${declaration}`, 'gm')) ?? []).length;

  // Messages and their `$Properties` interfaces declare the member with a leading doc comment,
  // which we take along with the blank line that separates it from the previous member.
  const documented = new RegExp(
    String.raw`(?:[ \t]*\r?\n)?[ \t]*/\*\* Unknown fields preserved while decoding when enabled \*/\r?\n${declaration}`,
    'g'
  );
  // Inside `$Shape` bodies the member is emitted bare.
  content = content.replace(documented, '').replace(new RegExp(`^${declaration}`, 'gm'), '');

  const leftovers = (content.match(/\$unknowns|Unknown fields preserved/g) ?? []).length;
  if (expected === 0 || leftovers > 0) {
    throw new Error(
      `Unexpected pbts output in ${dtsFile}: found ${expected} '$unknowns' declarations, ` +
        `${leftovers} references left after removal`
    );
  }

  await writeFile(dtsFile, content, 'utf-8');
}

/**
 * protobufjs 8.3 renamed the generated "properties" interfaces from `IFoo` to
 * `Foo.$Properties`, keeping `IFoo` around as a deprecated alias. We're not ready to move our
 * public API over to the new spelling, so we drop the deprecation notices; `IFoo` remains the
 * form we recommend, and both spellings stay visible in the meantime.
 *
 * FIXME: Revisit once we're ready to start the transition to the new names.
 */
async function undeprecateLegacyMessageTypeAliases(dtsFile: string) {
  const content = await readFile(dtsFile, 'utf8');

  const notice = /^[ \t]*\*[ \t]*@deprecated Use [\w.]+\.\$Properties instead\.[ \t]*\r?\n/gm;
  const removed = (content.match(notice) ?? []).length;
  const patched = content.replace(notice, '');

  const leftovers = (patched.match(/@deprecated Use [\w.]+\.\$Properties instead\./g) ?? []).length;
  if (removed === 0 || leftovers > 0) {
    throw new Error(
      `Unexpected pbts output in ${dtsFile}: removed ${removed} '$Properties' deprecation notices, ` +
        `${leftovers} left`
    );
  }

  await writeFile(dtsFile, patched, 'utf-8');
}

async function main() {
  mkdirSync(outputDir, { recursive: true });

  const protoFiles = glob.sync('**/*.proto', { cwd: protoBaseDir, absolute: true, root: '' });
  const protosMTime = Math.max(...protoFiles.map(mtime));
  const compileScriptMTime = mtime(resolve(__dirname, __filename));
  const genMTime = Math.min(mtime(jsOutputFile), mtime(descriptorOutputFile));

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
    'temporal/api/sdk/v1/external_storage.proto',
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

  console.log(`Creating protobuf descriptor set`);
  await promisify(execFile)('protoc', [
    ...rootDirs.flatMap((dir) => ['-I', dir]),
    '--include_imports',
    `--descriptor_set_out=${descriptorOutputFile}`,
    ...entrypoints,
  ]);

  console.log('Done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
