import { randomUUID } from 'crypto';
import test from 'ava';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from './helpers';
import { conditionTimeout0Simple } from './workflows/condition-timeout-0';

test('Internal patches does not cause non-determinism error on replay', async (t) => {
  const env = await TestWorkflowEnvironment.createLocal();
  try {
    const taskQueue = `${t.title}-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows/condition-timeout-0'),

      // Disable workflow caching, to force replay after the condition's sleep
      maxCachedWorkflows: 0,
    });
    await worker.runUntil(async () => {
      try {
        await env.client.workflow.execute(conditionTimeout0Simple, {
          taskQueue,
          workflowId: randomUUID(),
        });
        t.pass();
      } catch (e) {
        t.fail((e as Error).message);
      }
    });
  } finally {
    await env.teardown();
  }
});
