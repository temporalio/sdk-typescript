import crypto from 'node:crypto';
import test from 'ava';
import { WorkflowClient } from '@temporalio/client';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import * as workflows from './workflows/patch-and-condition-pre-patch';

if (RUN_INTEGRATION_TESTS) {
  test('Patch in condition does not cause non-determinism error on replay', async (t) => {
    const client = new WorkflowClient();
    const workflowId = crypto.randomUUID();

    // Create the first worker with pre-patched version of the workflow
    const worker1 = await Worker.create({
      taskQueue: 'patch-in-condition',
      workflowsPath: require.resolve('./workflows/patch-and-condition-pre-patch'),
      // Avoid waiting for sticky execution timeout on each worker transition
      maxCachedWorkflows: 0,
    });

    // Start the workflow and wait for the first task to be processed
    const handle = await worker1.runUntil(async () => {
      const handle = await client.start(workflows.patchInCondition, {
        taskQueue: 'patch-in-condition',
        workflowId,
      });
      await handle.query('__temporal_workflow_metadata');
      return handle;
    });

    // Create the second worker with post-patched version of the workflow
    const worker2 = await Worker.create({
      taskQueue: 'patch-in-condition',
      workflowsPath: require.resolve('./workflows/patch-and-condition-post-patch'),
      maxCachedWorkflows: 0,
    });

    // Trigger a signal and wait for it to be processed
    await worker2.runUntil(async () => {
      await handle.signal(workflows.generateCommandSignal);
      await handle.query('__temporal_workflow_metadata');
    });

    // Create the third worker that is identical to the second one
    const worker3 = await Worker.create({
      taskQueue: 'patch-in-condition',
      workflowsPath: require.resolve('./workflows/patch-and-condition-post-patch'),
      maxCachedWorkflows: 0,
    });

    // Trigger a workflow task that will cause replay.
    await worker3.runUntil(async () => {
      await handle.signal(workflows.generateCommandSignal);
      await handle.result();
    });

    // If the workflow completes, commands are generated in the right order and it is safe to use a patched statement
    // inside a condition.
    t.pass();
  });
}
