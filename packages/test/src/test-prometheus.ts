import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { WorkflowClient } from '@temporalio/client';
import { DefaultLogger, NativeConnection, Runtime } from '@temporalio/worker';
import * as activities from './activities';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import * as workflows from './workflows';
import fetch from 'node-fetch';

if (RUN_INTEGRATION_TESTS) {
  test.serial('Prometheus metrics work', async (t) => {
    const logger = new DefaultLogger('DEBUG');
    Runtime.install({
      logger,
      telemetryOptions: {
        metrics: {
          prometheus: {
            bindAddress: '0.0.0.0:9090',
          },
        },
      },
    });
    const connection = await NativeConnection.connect({
      address: 'localhost:7233',
    });
    const worker = await Worker.create({
      connection,
      workflowsPath: require.resolve('./workflows'),
      activities,
      taskQueue: 'test-prometheus',
    });

    const client = new WorkflowClient();
    await worker.runUntil(async () => {
      await client.execute(workflows.cancelFakeProgress, {
        taskQueue: 'test-prometheus',
        workflowId: uuid4(),
      });
      const resp = await fetch('http://localhost:9090/metrics');
      // We're not concerned about exact details here, just that the metrics are present
      const text = await resp.text();
      t.assert(text.includes('task_slots'));
    });

    t.pass();
  });
}
