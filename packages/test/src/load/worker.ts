import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { TelemetryOptions } from '@temporalio/core-bridge';
import { Runtime, DefaultLogger, Worker, NativeConnection } from '@temporalio/worker';
import arg from 'arg';
import * as activities from '../activities';
import { getRequired, WorkerArgSpec, workerArgSpec } from './args';

async function main() {
  const args = arg<WorkerArgSpec>(workerArgSpec);
  const maxConcurrentActivityTaskExecutions = args['--max-concurrent-at-executions'] ?? 100;
  const maxConcurrentWorkflowTaskExecutions = args['--max-concurrent-wft-executions'] ?? 100;
  const maxConcurrentActivityTaskPolls = args['--max-concurrent-at-polls'] ?? 20;
  const maxConcurrentWorkflowTaskPolls = args['--max-concurrent-wft-polls'] ?? 20;
  const maxCachedWorkflows = args['--max-cached-wfs'];
  const oTelUrl = args['--otel-url'] ?? 'grpc://localhost:4317';
  const logLevel = (args['--log-level'] || 'INFO').toUpperCase();
  const serverAddress = getRequired(args, '--server-address');
  const namespace = getRequired(args, '--ns');
  const taskQueue = getRequired(args, '--task-queue');

  let exporter = undefined;
  let telemetryOptions: TelemetryOptions | undefined = undefined;
  let otel;
  if (oTelUrl) {
    exporter = new OTLPTraceExporter({ url: oTelUrl });
    telemetryOptions = {
      oTelCollectorUrl: oTelUrl,
      tracingFilter: 'temporal_sdk_core=DEBUG',
      logForwardingLevel: 'DEBUG',
    };
    otel = new opentelemetry.NodeSDK({
      resource: new opentelemetry.resources.Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: 'load-worker',
        taskQueue,
      }),
      traceExporter: exporter,
    });
    await otel.start();
  }

  Runtime.install({
    telemetryOptions,
    logger: new DefaultLogger(logLevel as any),
  });

  const connection = await NativeConnection.create({
    address: serverAddress,
  });

  const worker = await Worker.create({
    connection,
    namespace,
    activities,
    workflowsPath: require.resolve('../workflows'),
    taskQueue,
    maxConcurrentActivityTaskExecutions,
    maxConcurrentWorkflowTaskExecutions,
    maxConcurrentActivityTaskPolls,
    maxConcurrentWorkflowTaskPolls,
    maxCachedWorkflows,
  });
  console.log('Created worker with options', worker.options);

  await worker.run();
  await connection.close();
  if (otel) {
    await otel.shutdown().catch(console.error);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
