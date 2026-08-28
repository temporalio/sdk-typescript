import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { getBundlePath, getTaskQueue, TASK_QUEUES } from './config';
import { loadWorkflowBundle } from './worker';

void test('reads a safe Task Queue from the environment', () => {
  assert.equal(getTaskQueue({ TEMPORAL_TASK_QUEUE: 'tenant-123_alpha' }), 'tenant-123_alpha');
});

void test('rejects missing and unsafe Task Queue names', () => {
  assert.throws(() => getTaskQueue({}), /Missing required environment variable/);
  assert.throws(() => getTaskQueue({ TEMPORAL_TASK_QUEUE: '../tenant-alpha' }), /must contain only/);
  assert.throws(() => getTaskQueue({ TEMPORAL_TASK_QUEUE: 'tenant/alpha' }), /must contain only/);
});

void test('maps every configured Task Queue to its correspondingly named bundle', () => {
  for (const taskQueue of TASK_QUEUES) {
    assert.equal(path.basename(getBundlePath(taskQueue)), `${taskQueue}.js`);
  }
});

void test('reports a useful error when a bundle is unavailable', async () => {
  await assert.rejects(loadWorkflowBundle('not-built'), /Run "pnpm build:bundles" first/);
});
