import crypto from 'node:crypto';
import test from 'ava';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from './helpers';
import * as workflows from './workflows/sdk-internal-patch-before';

test('SDK Internal Patch does not cause non-determinism error if user code modified', async (t) => {
  const env = await TestWorkflowEnvironment.createLocal();
  try {
    const workflowId = crypto.randomUUID();

    // Create the first worker with pre-patched version of the workflow
    const worker1 = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'sdk-internal-patch',
      workflowsPath: require.resolve('./workflows/sdk-internal-patch-before'),
      // Avoid waiting for sticky execution timeout on each worker transition
      maxCachedWorkflows: 0,
    });

    // Start the workflow and wait for the first task to be processed
    const handle = await worker1.runUntil(async () => {
      const handle = await env.client.workflow.start(workflows.sdkInternalPatch, {
        taskQueue: 'sdk-internal-patch',
        workflowId,
      });
      await handle.query('__stack_trace');
      return handle;
    });

    // Create the second worker with post-patched version of the workflow
    const worker2 = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'sdk-internal-patch',
      workflowsPath: require.resolve('./workflows/sdk-internal-patch-after'),
      maxCachedWorkflows: 0,
    });

    // Trigger a signal and wait for it to be processed
    await worker2.runUntil(async () => {
      await handle.query('__stack_trace');
    });

    // If the workflow completes, commands are generated in the right order and SDK internal patch are safe
    t.pass();
  } finally {
    await env.teardown();
  }
});
