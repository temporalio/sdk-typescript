import path from 'path';
import arg from 'arg';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { Core, Worker, DefaultLogger } from '@temporalio/worker';
import { CollectorTraceExporter } from '@opentelemetry/exporter-collector-grpc';
import { WorkerArgSpec, workerArgSpec, getRequired } from './args';
import { TelemetryOptions } from "@temporalio/core-bridge";

async function main() {
  const args = arg<WorkerArgSpec>(workerArgSpec);
  const maxConcurrentActivityTaskExecutions = args['--max-concurrent-at-executions'] ?? 100;
  const maxConcurrentWorkflowTaskExecutions = args['--max-concurrent-wft-executions'] ?? 100;
  const maxConcurrentActivityTaskPolls = args['--max-concurrent-at-polls'] ?? 20;
  const maxConcurrentWorkflowTaskPolls = args['--max-concurrent-wft-polls'] ?? 20;
  const isolatePoolSize = args['--isolate-pool-size'] ?? 16;
  const maxCachedWorkflows = args['--max-cached-wfs'] ?? 2500;
  const oTelUrl = args['--otel-url'] ?? 'grpc://localhost:4317';
  const logLevel = (args['--log-level'] || 'INFO').toUpperCase();
  const serverAddress = getRequired(args, '--server-address');
  const namespace = getRequired(args, '--ns');
  const taskQueue = getRequired(args, '--task-queue');

  let exporter = undefined;
  let telemetryOptions: TelemetryOptions | undefined = undefined;
  if (oTelUrl) {
    exporter = new CollectorTraceExporter({ url: oTelUrl });
    telemetryOptions = {
      oTelCollectorUrl: oTelUrl,
      tracingFilter: 'temporal_sdk_core=DEBUG',
      logForwardingLevel: 'OFF'
    };
  }
  const otel = new opentelemetry.NodeSDK({
    resource: new opentelemetry.resources.Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'load-worker',
      taskQueue,
    }),
    traceExporter: exporter,
  });
  await otel.start();

  await Core.install({
    serverOptions: {
      namespace,
      address: serverAddress,
    },
    telemetryOptions,
  });

  const worker = await Worker.create({
    workDir: path.join(__dirname, '..'),
    nodeModulesPath: path.join(__dirname, '../../../../node_modules'),
    taskQueue,
    maxConcurrentActivityTaskExecutions,
    maxConcurrentWorkflowTaskExecutions,
    maxConcurrentActivityTaskPolls,
    maxConcurrentWorkflowTaskPolls,
    maxCachedWorkflows,
    isolatePoolSize,
    logger: new DefaultLogger(logLevel as any),
  });
  console.log('Created worker');

  await worker.run();
  await otel.shutdown().catch(console.error);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
