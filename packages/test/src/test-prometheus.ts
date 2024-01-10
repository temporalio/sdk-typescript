import * as net from 'net';
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import fetch from 'node-fetch';
import { WorkflowClient } from '@temporalio/client';
import { NativeConnection, Runtime } from '@temporalio/worker';
import * as activities from './activities';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import * as workflows from './workflows';

async function getRandomPort(): Promise<number> {
  return new Promise<number>((res) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === 'string' || addr === null) {
        throw new Error('Unexpected server address type');
      }
      srv.close((_) => res(addr.port));
    });
  });
}

if (RUN_INTEGRATION_TESTS) {
  test.serial('Prometheus metrics work', async (t) => {
    const port = await getRandomPort();
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
      address: '127.0.0.1:7233',
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
      const resp = await fetch(`http://127.0.0.1:${port}/metrics`);
      // We're not concerned about exact details here, just that the metrics are present
      const text = await resp.text();
      t.assert(text.includes('task_slots'));
    });

    t.pass();
  });
}
