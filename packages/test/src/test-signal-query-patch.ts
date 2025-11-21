import crypto from 'node:crypto';
import test from 'ava';
import * as wf from '@temporalio/workflow';
import { Worker, TestWorkflowEnvironment } from './helpers';
import * as workflows from './workflows/signal-query-patch-pre-patch';

test('Signal+Query+Patch does not cause non-determinism error on replay', async (t) => {
  const env = await TestWorkflowEnvironment.createLocal();
  try {
    const workflowId = crypto.randomUUID();

    // Create the first worker with pre-patched version of the workflow
    const worker1 = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'signal-query-patch',
      workflowsPath: require.resolve('./workflows/signal-query-patch-pre-patch'),

      // Avoid waiting for sticky execution timeout on worker transition
      stickyQueueScheduleToStartTimeout: '1s',
    });

    // Start the workflow, wait for the first task to be processed, then send it a signal and wait for it to be completed
    const handle = await worker1.runUntil(async () => {
      const handle = await env.client.workflow.start(workflows.patchQuerySignal, {
        taskQueue: 'signal-query-patch',
        workflowId,
      });
      await handle.signal(wf.defineSignal('signal'));

      // Make sure the signal got processed before we shutdown the worker
      await handle.query('query');
      return handle;
    });

    // Create the second worker with post-patched version of the workflow
    const worker2 = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'signal-query-patch',
      workflowsPath: require.resolve('./workflows/signal-query-patch-post-patch'),
    });

    // Trigger a query and wait for it to be processed
    const enteredPatchBlock = await worker2.runUntil(async () => {
      await handle.query('query');
      await handle.signal('unblock');

      return await handle.result();
    });

    t.false(enteredPatchBlock);
  } finally {
    await env.teardown();
  }
});
