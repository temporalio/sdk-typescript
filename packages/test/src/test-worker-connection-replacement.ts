import { randomUUID } from 'crypto';
import { sleep } from '@temporalio/workflow';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { makeTestFunction, helpers } from './helpers-integration';
import { waitUntil } from './helpers';

const test = makeTestFunction({
  workflowsPath: __filename,
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// WORKER CONNECTION REPLACEMENT

export async function tickingWorkflow(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await sleep(100);
  }
}

test('Worker can replace connection to switch servers', async (t) => {
  // This test validates that a worker can dynamically switch from one connection
  // to another by replacing its connection, without restarting the worker.

  const { createWorker, taskQueue } = helpers(t);

  // We'll start a second ephemeral server and then replace the worker's client. So we will
  // start a no-cache ticking workflow with the current client and confirm it has accomplished
  // at least one task. Then we will start another on the other client, and confirm it gets
  // started too. Then we will terminate both. We have to use a ticking workflow with only one
  // poller to force a quick re-poll to recognize our client change quickly (as opposed to
  // just waiting the minute for poll timeout).

  const env1 = t.context.env;
  const handle1 = await env1.client.workflow.start(tickingWorkflow, {
    taskQueue,
    workflowId: randomUUID(),
    workflowExecutionTimeout: '300s',
  });

  const env2 = await TestWorkflowEnvironment.createLocal({});
  const handle2 = await env2.client.workflow.start(tickingWorkflow, {
    taskQueue,
    workflowId: randomUUID(),
    workflowExecutionTimeout: '300s',
  });

  try {
    // Worker will be initially tied to the first environment's connection
    const worker = await createWorker({
      maxCachedWorkflows: 0,
      workflowTaskPollerBehavior: {
        type: 'simple-maximum',
        maximum: 1,
      },
    });

    await worker.runUntil(async () => {
      // Wait for confirmation that workflow 1 has started execution
      await waitUntil(
        async () => !!(await handle1.fetchHistory()).events?.some((ev) => ev.workflowTaskCompletedEventAttributes),
        4000
      );

      // Confirm that workflow 2 has not yet started execution
      const handle2History = await handle2.fetchHistory();
      t.false(handle2History.events?.some((ev) => ev.workflowTaskCompletedEventAttributes));

      // Now replace the worker's connection to point to the second connection
      worker.connection = env2.nativeConnection;

      // Verify the connection and client were updated
      t.is(worker.connection, env2.nativeConnection);
      t.truthy(worker.client);
      t.not(worker.connection, env1.nativeConnection);

      // Confirm that workflow 2 has started execution
      await waitUntil(
        async () => !!(await handle2.fetchHistory()).events?.some((ev) => ev.workflowTaskCompletedEventAttributes),
        4000
      );
    });
  } finally {
    await env2.teardown();
    // env1 will be cleaned up by the internal SDK test framework
  }
});
