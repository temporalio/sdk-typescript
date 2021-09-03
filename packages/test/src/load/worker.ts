import path from 'path';
import arg from 'arg';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { Core, Worker, DefaultLogger } from '@temporalio/worker';
import { WorkerArgSpec, workerArgSpec, getRequired } from './args';

async function main() {
  const args = arg<WorkerArgSpec>(workerArgSpec);
  const maxConcurrentActivityTaskExecutions = args['--max-concurrent-at-executions'] ?? 100;
  const maxConcurrentWorkflowTaskExecutions = args['--max-concurrent-wft-executions'] ?? 100;
  const maxConcurrentActivityTaskPolls = args['--max-concurrent-at-polls'] ?? 20;
  const maxConcurrentWorkflowTaskPolls = args['--max-concurrent-wft-polls'] ?? 20;
  const isolatePoolSize = args['--isolate-pool-size'] ?? 16;
  const maxCachedWorkflows = args['--max-cached-wfs'] ?? 2500;
  const logLevel = (args['--log-level'] || 'INFO').toUpperCase();
  const serverAddress = getRequired(args, '--server-address');
  const namespace = getRequired(args, '--ns');
  const taskQueue = getRequired(args, '--task-queue');

  // In order for JaegerExporter to transmit packets correctly, increase net.inet.udp.maxdgram to 65536.
  // See: https://github.com/jaegertracing/jaeger-client-node/issues/124#issuecomment-324222456
  const jaegerTraceExport = new JaegerExporter();
  const prometheusMetricExport = new PrometheusExporter({ port: 9464 });
  const otel = new opentelemetry.NodeSDK({
    resource: new opentelemetry.resources.Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'load-worker',
      taskQueue,
    }),
    traceExporter: jaegerTraceExport,
    metricExporter: prometheusMetricExport,
  });
  await otel.start();

  await Core.install({
    serverOptions: {
      namespace,
      address: serverAddress,
    },
    spanExporter: jaegerTraceExport,
    metricExporter: prometheusMetricExport,
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
  await otel.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
