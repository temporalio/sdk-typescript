/**
 * Test usage of a default workflow handler
 */
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { WorkflowClient } from '@temporalio/client';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { existing } from './workflows/default-workflow-function';

if (RUN_INTEGRATION_TESTS) {
  test('Default workflow handler is used if requested workflow does not exist', async (t) => {
    const taskQueue = `${t.title}-${uuid4()}`;
    const worker = await Worker.create({
      taskQueue,
      workflowsPath: require.resolve('./workflows/default-workflow-function'),
    });
    const client = new WorkflowClient();
    await worker.runUntil(async () => {
      const result = client.execute('non-existing', { taskQueue, workflowId: uuid4(), args: ['test', 'foo', 'bar'] });
      t.is((await result).handler, 'default');
      t.is((await result).workflowType, 'non-existing');
      t.deepEqual((await result).args, ['test', 'foo', 'bar']);
    });
  });

  test('Default workflow handler is not used if requested workflow exists', async (t) => {
    const taskQueue = `${t.title}-${uuid4()}`;
    const worker = await Worker.create({
      taskQueue,
      workflowsPath: require.resolve('./workflows/default-workflow-function'),
    });
    const client = new WorkflowClient();
    await worker.runUntil(async () => {
      const result = client.execute(existing, { taskQueue, workflowId: uuid4(), args: ['test', 'foo', 'bar'] });
      t.is((await result).handler, 'existing');
      t.deepEqual((await result).args, ['test', 'foo', 'bar']);
    });
  });
}
