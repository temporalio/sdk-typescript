import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startChildSupervisor, type ChildSpec } from './child-supervisor';
import { makeWorkerEnvironment } from './run-workers';

const WAIT_FOR_SIGNAL = `
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1_000);
`;

function nodeChild(name: string, source: string): ChildSpec {
  return { name, command: process.execPath, args: ['-e', source] };
}

void test('the runner environment assigns the child Task Queue and preserves connection settings', () => {
  const env = makeWorkerEnvironment('tenant-alpha', {
    TEMPORAL_ADDRESS: 'example.tmprl.cloud:7233',
    TEMPORAL_NAMESPACE: 'example',
  });

  assert.equal(env['TEMPORAL_TASK_QUEUE'], 'tenant-alpha');
  assert.equal(env['TEMPORAL_ADDRESS'], 'example.tmprl.cloud:7233');
  assert.equal(env['TEMPORAL_NAMESPACE'], 'example');
});

void test('graceful shutdown is forwarded to every child', async () => {
  const supervisor = startChildSupervisor([
    nodeChild('tenant-alpha', WAIT_FOR_SIGNAL),
    nodeChild('tenant-beta', WAIT_FOR_SIGNAL),
    nodeChild('tenant-gamma', WAIT_FOR_SIGNAL),
  ]);

  await new Promise((resolve) => setTimeout(resolve, 100));
  supervisor.shutdown();
  await supervisor.completion;
});

void test('an unexpected child exit terminates its siblings and rejects completion', async () => {
  const supervisor = startChildSupervisor([
    nodeChild('failed-tenant', 'process.exit(7)'),
    nodeChild('waiting-tenant', WAIT_FOR_SIGNAL),
  ]);

  await assert.rejects(supervisor.completion, /failed-tenant.*code 7/);
});
