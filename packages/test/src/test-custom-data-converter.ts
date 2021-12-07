import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Worker } from '@temporalio/worker';
import { WorkflowClient, Connection } from '@temporalio/client';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { protobufWorkflow } from './workflows';
import { dataConverter, messageInstance } from './data-converter';

if (RUN_INTEGRATION_TESTS) {
  test('Client and Worker work with provided dataConverter/dataConverterPath', async (t) => {
    const taskQueue = 'custom-data-converter';
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      dataConverterPath: require.resolve('./data-converter'),
    });
    const connection = new Connection();
    const client = new WorkflowClient(connection.service, { dataConverter });
    const runAndShutdown = async () => {
      const result = await client.execute(protobufWorkflow, {
        args: [messageInstance],
        workflowId: uuid4(),
        taskQueue,
      });
      t.is(result, messageInstance);
      worker.shutdown();
    };
    await Promise.all([worker.run(), runAndShutdown()]);
  });
}
