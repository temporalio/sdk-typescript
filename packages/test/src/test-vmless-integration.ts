import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'ava';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { temporal } from '@temporalio/proto';
import { bundleWorkflowCode, DefaultLogger, Worker } from '@temporalio/worker';

test('VM-less automatic bundling, updates, cache-disabled replay, and prebuilt replay work end to end', async (t) => {
  const env = await TestWorkflowEnvironment.createLocal();
  t.teardown(() => env.teardown());
  const workflowsPath = require.resolve('./workflows/vmless-execution');
  const taskQueue = `vmless-${randomUUID()}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowExecutionMode: 'vmless',
    workflowsPath,
    maxCachedWorkflows: 0,
    activities: { echo: async (value: string) => value },
  });
  const history = await worker.runUntil(async () => {
    const handle = await env.client.workflow.start('lifecycle', { taskQueue, workflowId: randomUUID() });
    t.is(await handle.query('state'), 'waiting');
    const update = await handle.executeUpdate('change', { args: ['ready'], updateId: 'change-id' });
    t.is(update, `${handle.firstExecutionRunId}:change-id`);
    t.is(await handle.result(), 'ready:1:true');
    return handle.fetchHistory();
  });
  await t.notThrowsAsync(
    Worker.runReplayHistory(
      {
        workflowExecutionMode: 'vmless',
        workflowsPath,
      },
      history
    )
  );
  const bundle = await bundleWorkflowCode({
    workflowsPath,
    workflowExecutionMode: 'vmless',
    logger: new DefaultLogger('ERROR'),
  });
  await t.notThrowsAsync(
    Worker.runReplayHistory(
      {
        workflowExecutionMode: 'vmless',
        workflowBundle: bundle,
      },
      history
    )
  );
  const restarted = spawnSync(process.execPath, [require.resolve('./vmless-replay-process')], {
    input: JSON.stringify({
      workflowsPath,
      history: Buffer.from(temporal.api.history.v1.History.encode(history).finish()).toString('base64'),
    }),
    encoding: 'utf8',
    timeout: 30000,
    killSignal: 'SIGKILL',
  });
  t.is(restarted.status, 0, restarted.stderr);
});
