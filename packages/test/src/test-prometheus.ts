import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import fetch from 'node-fetch';
import { WorkflowClient } from '@temporalio/client';
import { Runtime } from '@temporalio/worker';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, getRandomPort } from './helpers';
import * as workflows from './workflows';

test.serial('Runtime.install() throws meaningful error when passed invalid metrics.prometheus.bindAddress', (t) => {
  t.throws(() => Runtime.install({ telemetryOptions: { metrics: { prometheus: { bindAddress: ':invalid' } } } }), {
    instanceOf: TypeError,
    message: 'Invalid telemetryOptions.metrics.prometheus.bindAddress',
  });
});

test.serial(
  'Runtime.install() throws meaningful error when metrics.prometheus.bindAddress port is already taken',
  async (t) => {
    await getRandomPort(async (port: number) => {
      t.throws(
        () => Runtime.install({ telemetryOptions: { metrics: { prometheus: { bindAddress: `127.0.0.1:${port}` } } } }),
        {
          instanceOf: Error,
          message: /Address already in use/,
        }
      );
    });
  }
);

test.serial('Exporting Prometheus metrics from Core works', async (t) => {
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
  const localEnv = await TestWorkflowEnvironment.createLocal();
  try {
    const worker = await Worker.create({
      connection: localEnv.nativeConnection,
      workflowsPath: require.resolve('./workflows'),
      taskQueue: 'test-prometheus',
    });
    const client = new WorkflowClient({
      connection: localEnv.connection,
    });
    await worker.runUntil(async () => {
      await client.execute(workflows.successString, {
        taskQueue: 'test-prometheus',
        workflowId: uuid4(),
      });
      const resp = await fetch(`http://127.0.0.1:${port}/metrics`);
      // We're not concerned about exact details here, just that the metrics are present
      const text = await resp.text();
      t.assert(text.includes('task_slots'));
    });
  } finally {
    await localEnv.teardown();
  }
});
