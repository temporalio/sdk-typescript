import crypto from 'crypto';
import * as activity from '@temporalio/activity';
import * as testing from '@temporalio/testing';
import * as workflow from '@temporalio/workflow';
import { bundlerOptions, test, Worker } from './helpers';

export async function testWorkflow(): Promise<void> {
  await workflow.proxyActivities({ startToCloseTimeout: '1m' }).testActivity();
}

test('Worker cancels heartbeating activities after shutdown has been requested', async (t) => {
  const env = await testing.TestWorkflowEnvironment.createLocal();
  try {
    let properlyCancelled = false;
    const taskQueue = 'activity-heartbeat-after-shutdown';
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: __filename,
      bundlerOptions,
      activities: {
        async testActivity() {
          const ctx = activity.Context.current();
          worker.shutdown();
          ctx.heartbeat();
          try {
            await ctx.cancelled;
          } catch (err) {
            if (err instanceof activity.CancelledFailure && err.message === 'WORKER_SHUTDOWN') {
              properlyCancelled = true;
            }
            throw err;
          }
        },
      },
    });
    const handle = await env.client.workflow.start(testWorkflow, {
      workflowId: crypto.randomUUID(),
      taskQueue,
    });
    try {
      // If worker completes within graceful shutdown period, the activity has successfully been cancelled
      await worker.run();
    } finally {
      await handle.terminate();
    }
    t.true(properlyCancelled);
  } finally {
    await env.teardown();
  }
});
