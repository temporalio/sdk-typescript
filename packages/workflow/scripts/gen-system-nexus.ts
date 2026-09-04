import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const workflowDir = resolve(__dirname, '..');
const repoRoot = resolve(workflowDir, '../..');
const descriptor = resolve(repoRoot, 'packages/proto/protos/temporal_api.bin');
const supportFile = resolve(workflowDir, 'system-nexus-support.ts');
const output = resolve(workflowDir, 'src/nexus/system/generated');
const witRoot = resolve(workflowDir, 'system-nexus-wit');
const nexgen = process.env.NEXGEN_BIN;

async function main() {
  if (nexgen == null) {
    throw new Error('NEXGEN_BIN must name the local nexgen executable');
  }
  await access(descriptor);
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
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
