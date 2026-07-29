import { randomUUID } from 'crypto';
import * as otelApi from '@opentelemetry/api';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import test from 'ava';
import { MetricsBuffer, Runtime, Worker } from '@temporalio/worker';
import {
  RUN_INTEGRATION_TESTS,
  createTestWorkflowEnvironment,
  type TestWorkflowEnvironment,
} from '@temporalio/test-helpers';
import { OpenTelemetryPlugin } from '..';
import * as activities from './activities';
import * as workflows from './workflows';

const metricTagsTest = RUN_INTEGRATION_TESTS ? test.serial : test.skip;
const sdkMetricAttributeKeys = new Set(['activityType', 'taskQueue', 'workflowType']);

metricTagsTest('OpenTelemetryPlugin does not attach trace context to metric tags', async (t) => {
  const buffer = new MetricsBuffer({ maxBufferSize: 1000 });
  Runtime.install({
    telemetryOptions: {
      metrics: { buffer },
    },
  });

  const traceExporter = new InMemorySpanExporter();
  const staticResource = new opentelemetry.resources.Resource({
    [SEMRESATTRS_SERVICE_NAME]: 'ts-test-otel-metric-tags-worker',
  });
  const otel = new opentelemetry.NodeSDK({ resource: staticResource, traceExporter });
  let env: TestWorkflowEnvironment | undefined;

  try {
    otel.start();

    const plugin = new OpenTelemetryPlugin({
      resource: staticResource,
      spanProcessor: new SimpleSpanProcessor(traceExporter),
    });
    env = await createTestWorkflowEnvironment({ plugins: [plugin] });
    const taskQueue = `test-otel-metric-tags-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      workflowsPath: require.resolve('./workflows'),
      activities,
      taskQueue,
      plugins: [plugin],
    });

    await worker.runUntil(
      env.client.workflow.execute(workflows.metricTraceTags, {
        taskQueue,
        workflowId: randomUUID(),
      })
    );

    const metricAssertions = Array.from(buffer.retrieveUpdates())
      .filter((update) => ['otel-plugin-workflow-counter', 'otel-plugin-activity-counter'].includes(update.metric.name))
      .map((update) => ({
        metricName: update.metric.name,
        value: update.value,
        attributes: Object.fromEntries(
          Object.entries(update.attributes).filter(([key]) => !sdkMetricAttributeKeys.has(key))
        ),
      }))
      .sort((a, b) => a.metricName.localeCompare(b.metricName));

    t.deepEqual(metricAssertions, [
      {
        metricName: 'otel-plugin-activity-counter',
        value: 1,
        attributes: {
          namespace: 'default',
          source: 'activity',
        },
      },
      {
        metricName: 'otel-plugin-workflow-counter',
        value: 1,
        attributes: {
          namespace: 'default',
          source: 'workflow',
        },
      },
    ]);
  } finally {
    await env?.teardown();
    await otel.shutdown();
    otelApi.trace.disable();
    await Runtime._instance?.shutdown();
  }
});
