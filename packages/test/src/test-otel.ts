/**
 * Manual tests to inspect tracing output
 */
import test from 'ava';
import { Core, DefaultLogger, InjectedDependencies, Worker } from '@temporalio/worker';
import { CollectorTraceExporter } from '@opentelemetry/exporter-collector-grpc';
import * as activities from './activities';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import * as workflows from './workflows';
import { WorkflowClient } from '@temporalio/client';
import { OpenTelemetryWorkflowClientCallsInterceptor } from '@temporalio/interceptors-opentelemetry/lib/client';
import {
  makeWorkflowExporter,
  OpenTelemetryActivityInboundInterceptor,
} from '@temporalio/interceptors-opentelemetry/lib/worker';
import { OpenTelemetryDependencies } from '@temporalio/interceptors-opentelemetry/lib/workflow';

// Un-skip this test and run it by hand to inspect outputted traces
test.skip('Otel spans connected', async (t) => {
  const oTelUrl = 'grpc://localhost:4317';
  const exporter = new CollectorTraceExporter({ url: oTelUrl });
  const staticResource = new opentelemetry.resources.Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'node-test-otel-worker',
  });
  const otel = new opentelemetry.NodeSDK({
    resource: staticResource,
    traceExporter: exporter,
  });
  await otel.start();

  const logger = new DefaultLogger('DEBUG');
  await Core.install({
    logger,
    telemetryOptions: {
      oTelCollectorUrl: oTelUrl,
      tracingFilter: 'temporal_sdk_core=DEBUG',
      logForwardingLevel: 'INFO',
    },
  });
  const dependencies: InjectedDependencies<OpenTelemetryDependencies> = {
    exporter: makeWorkflowExporter(exporter, staticResource),
  };
  const worker = await Worker.create({
    workflowsPath: require.resolve('./workflows'),
    activities,
    taskQueue: 'test-otel',
    interceptors: {
      workflowModules: [require.resolve('./workflows/otel-interceptors')],
      activityInbound: [() => new OpenTelemetryActivityInboundInterceptor()],
    },
    dependencies,
  });

  const client = new WorkflowClient(undefined, {
    interceptors: {
      calls: [() => new OpenTelemetryWorkflowClientCallsInterceptor()],
    },
  });
  const workflow = client.createWorkflowHandle(workflows.cancelFakeProgress, { taskQueue: 'test-otel' });

  await Promise.all([workflow.execute().finally(() => worker.shutdown()), worker.run()]).catch((err) => {
    console.error('Caught error while worker was running', err);
  });
  await otel.shutdown();
  // Allow some time to ensure spans are flushed out to collector
  await new Promise((resolve) => setTimeout(resolve, 5000));
  t.pass();
});
