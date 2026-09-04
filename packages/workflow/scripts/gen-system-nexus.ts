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
  resolve(protoRoot, 'testsrv_upstream'),
  resolve(protoRoot, 'local'),
  resolve(protoRoot, 'api_cloud_upstream'),
  protoRoot,
];

const protoEntrypoints = [
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
      ...protoEntrypoints,
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
