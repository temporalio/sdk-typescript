import { randomUUID } from 'crypto';
import test from 'ava';
import { WorkflowClient } from '@temporalio/client';
import { Runtime } from '@temporalio/worker';
import { Worker, getRandomPort, TestWorkflowEnvironment, assertEventually } from './helpers';
import * as workflows from './workflows';

test.serial('Runtime.install() throws meaningful error when passed invalid metrics.prometheus.bindAddress', (t) => {
  t.throws(() => Runtime.install({ telemetryOptions: { metrics: { prometheus: { bindAddress: ':invalid' } } } }), {
    instanceOf: TypeError,
    message: /metricsExporter.prometheus.socketAddr/,
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
          message: /(Address already in use|socket address)/,
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
        metricPrefix: 'myprefix_',
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
        workflowId: randomUUID(),
      });
      // Metrics are pushed to the Prometheus exporter asynchronously, so retry until present.
      await assertEventually(t, async (tt) => {
        const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
        // We're not concerned about exact details here, just that the metrics are present
        tt.assert(text.includes('myprefix_worker_task_slots_available'), `Actual: \n-------\n${text}\n-------`);
      });
    });
  } finally {
    await localEnv.teardown();
  }
});

test.serial('Exporting Prometheus metrics from Core works with lots of options', async (t) => {
  const port = await getRandomPort();
  Runtime.install({
    telemetryOptions: {
      metrics: {
        globalTags: {
          my_tag: 'my_value',
        },
        attachServiceName: true,
        prometheus: {
          bindAddress: `127.0.0.1:${port}`,
          countersTotalSuffix: true,
          unitSuffix: true,
          useSecondsForDurations: true,
          histogramBucketOverrides: {
            request_latency: [3, 31, 314, 3141, 31415],
            workflow_task_execution_latency: [3, 31, 314, 3141, 31415, 314159],
          },
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
    await worker.runUntil(async () => {
      await localEnv.client.workflow.execute(workflows.successString, {
        taskQueue: 'test-prometheus',
        workflowId: randomUUID(),
      });

      // The metrics below are recorded by the worker's Core runtime and pushed to the Prometheus
      // exporter asynchronously, so they may not be visible in the scrape immediately after the
      // workflow completes. Retry until they appear, otherwise this test flakes on slower runners.
      await assertEventually(t, async (tt) => {
        const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();

        // Verify use seconds & unit suffix
        tt.assert(
          text.includes(
            'temporal_workflow_task_execution_latency_seconds_bucket{namespace="default",' +
              'service_name="temporal-core-sdk",task_queue="test-prometheus",' +
              'workflow_type="successString",my_tag="my_value",le="31415"}'
          ),
          `Actual: \n-------\n${text}\n-------`
        );

        // Verify histogram overrides
        tt.assert(
          text.match(/temporal_request_latency_seconds_bucket\{.*,le="31415"/),
          `Actual: \n-------\n${text}\n-------`
        );
        tt.assert(
          text.match(/workflow_task_execution_latency_seconds_bucket\{.*,le="31415"/),
          `Actual: \n-------\n${text}\n-------`
        );

        // Verify prefix exists on client request metrics
        tt.assert(text.includes('temporal_long_request{'), `Actual: \n-------\n${text}\n-------`);
      });
    });
  } finally {
    await localEnv.teardown();
  }
});
