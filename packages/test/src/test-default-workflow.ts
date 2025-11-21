/**
 * Test usage of a default workflow handler
 */
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { TestWorkflowEnvironment, Worker } from './helpers';
import { existing } from './workflows/default-workflow-function';

test('Default workflow handler is used if requested workflow does not exist', async (t) => {
  const env = await TestWorkflowEnvironment.createLocal();
  try {
    const taskQueue = `${t.title}-${uuid4()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows/default-workflow-function'),
    });
    await worker.runUntil(async () => {
      const result = env.client.workflow.execute('non-existing', {
        taskQueue,
        workflowId: uuid4(),
        args: ['test', 'foo', 'bar'],
      });
      t.is((await result).handler, 'default');
      t.is((await result).workflowType, 'non-existing');
      t.deepEqual((await result).args, ['test', 'foo', 'bar']);
    });
  } finally {
    await env.teardown();
  }
});

test('Default workflow handler is not used if requested workflow exists', async (t) => {
  const env = await TestWorkflowEnvironment.createLocal();
  try {
    const taskQueue = `${t.title}-${uuid4()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows/default-workflow-function'),
    });
    await worker.runUntil(async () => {
      const result = env.client.workflow.execute(existing, {
        taskQueue,
        workflowId: uuid4(),
        args: ['test', 'foo', 'bar'],
      });
      t.is((await result).handler, 'existing');
      t.deepEqual((await result).args, ['test', 'foo', 'bar']);
    });
  } finally {
    await env.teardown();
  }
});
