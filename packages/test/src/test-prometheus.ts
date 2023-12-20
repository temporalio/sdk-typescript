import * as net from 'net';
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import fetch from 'node-fetch';
import { WorkflowClient } from '@temporalio/client';
import { NativeConnection, Runtime } from '@temporalio/worker';
import * as activities from './activities';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import * as workflows from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test.serial('Prometheus metrics work', async (t) => {
    const port = await new Promise((res) => {
      const srv = net.createServer();
      srv.listen(0, () => {
        const addr = srv.address();
        if (typeof addr === 'string' || addr === null) {
          throw new Error('Unexpected server address type');
        }
        srv.close((_) => res(addr.port));
      });
    });
    Runtime.install({
      telemetryOptions: {
        metrics: {
          prometheus: {
            bindAddress: `127.0.0.1:${port}`,
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
      const resp = await fetch(`http://localhost:${port}/metrics`);
      // We're not concerned about exact details here, just that the metrics are present
      const text = await resp.text();
      t.assert(text.includes('task_slots'));
    });

    t.pass();
  });
}
