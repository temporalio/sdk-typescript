import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const workflowDir = resolve(__dirname, '..');
const repoRoot = resolve(workflowDir, '../..');
const supportFile = resolve(workflowDir, 'system-nexus-support.ts');
const output = resolve(workflowDir, 'src/nexus/system/generated');
const witRoot = resolve(workflowDir, 'system-nexus-wit');
const nexgen = process.env.NEXGEN_BIN;
const protoRoot = resolve(repoRoot, 'packages/core-bridge/sdk-core/crates/protos/protos');

const protoRoots = [
  resolve(protoRoot, 'api_upstream'),
  protoRoot,
];

const workflowServiceRequestResponseProto =
  'temporal/api/workflowservice/v1/request_response.proto';

async function main() {
  if (nexgen == null) {
    throw new Error('NEXGEN_BIN must name the local nexgen executable');
  }
  const descriptorDirectory = await mkdtemp(join(tmpdir(), 'temporal-system-nexus-'));
  const descriptor = join(descriptorDirectory, 'temporal_api.bin');
  try {
    await promisify(execFile)('protoc', [
      ...protoRoots.flatMap((dir) => ['-I', dir]),
      '--include_imports',
      `--descriptor_set_out=${descriptor}`,
      workflowServiceRequestResponseProto,
    ]);
    await promisify(execFile)(nexgen, [
      'typescript',
      '--native-api',
      '--system-nexus',
      '--format',
      '--descriptors',
      descriptor,
      '--support-file',
      supportFile,
      '--output',
      output,
      resolve(witRoot, 'workflow-service.wit'),
      resolve(witRoot, 'deps'),
    ]);
  } finally {
    await rm(descriptorDirectory, { force: true, recursive: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
