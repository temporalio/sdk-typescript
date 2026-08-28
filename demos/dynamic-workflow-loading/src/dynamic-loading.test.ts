import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { TASK_QUEUES } from './config';
import { startCustomerWorkflows } from './start-workflows';
import { loadWorkflowBundle } from './worker';

void test('each Task Queue runs its own bundle under the same Workflow type', { timeout: 60_000 }, async () => {
  const testEnv = await TestWorkflowEnvironment.createLocal();
  const workers = await Promise.all(
    TASK_QUEUES.map(async (taskQueue) => {
      const { code } = await loadWorkflowBundle(taskQueue);
      return await Worker.create({
        connection: testEnv.nativeConnection,
        namespace: 'default',
        taskQueue,
        workflowBundle: { code },
      });
    })
  );
  const workerRuns = workers.map(async (worker) => await worker.run());

  try {
    const results = await startCustomerWorkflows(testEnv.client);

    assert.deepEqual(
      results,
      TASK_QUEUES.map((taskQueue) => ({ taskQueue, result: `I am workflow ${taskQueue}` }))
    );
  } finally {
    for (const worker of workers) worker.shutdown();
    await Promise.all(workerRuns);
    await testEnv.teardown();
  }
});
