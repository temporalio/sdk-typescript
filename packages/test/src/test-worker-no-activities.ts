import test from 'ava';
import { Worker } from '@temporalio/worker';
import { WorkflowClient } from '@temporalio/client';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS } from './helpers';
import * as workflow from './workflows/sync';

if (RUN_INTEGRATION_TESTS) {
  test('Worker functions when asked not to run Activities', async (t) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { activities, taskQueue, ...rest } = defaultOptions;
    const worker = await Worker.create({ taskQueue: 'only-workflows', ...rest });
    const client = new WorkflowClient();
    const runner = client.stub<typeof workflow>('sync', {
      taskQueue: 'only-workflows',
    });
    const runAndShutdown = async () => {
      const result = await runner.execute();
      t.is(result, 'success');
      worker.shutdown();
    };
    await Promise.all([worker.run(), runAndShutdown()]);
  });
}
