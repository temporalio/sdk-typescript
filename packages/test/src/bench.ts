import path from 'path';
import arg from 'arg';
import { URL } from 'url';
import { range } from 'rxjs';
import { mergeMap, take, tap, withLatestFrom } from 'rxjs/operators';
import { Worker, DefaultLogger } from '@temporalio/worker';
import { Connection } from '@temporalio/client';
import { msStrToTs } from '@temporalio/workflow/lib/time';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';

async function waitOnNamespace(connection: Connection, namespace: string, maxAttempts = 100, retryIntervalSecs = 1) {
  for (let attempt = 1; attempt <= maxAttempts; ++attempt) {
    try {
      await connection.service.getWorkflowExecutionHistory({
        namespace,
        execution: { workflowId: 'fake', runId: '12345678-1234-1234-1234-1234567890ab' },
      });
    } catch (err) {
      if (err.details === 'Requested workflow history not found, may have passed retention period.') {
        break;
      }
      if (attempt === maxAttempts) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, retryIntervalSecs * 1000));
    }
  }
}

async function runWorkflow(connection: Connection, namespace: string, name: string, taskQueue: string) {
  const workflow = connection.workflow<any>(name, { namespace, taskQueue });
  await workflow.start();
}

function toMB(bytes: number, fractionDigits = 2) {
  return (bytes / 1024 / 1024).toFixed(fractionDigits);
}

interface RunWorkflowOptions {
  namespace: string;
  worker: Worker;
  connection: Connection;
  workflowName: string;
  taskQueue: string;
  numWorkflows: number;
  concurrency: number;
  heapSampleIteration: number;
}

async function runWorkflows({
  namespace,
  worker,
  connection,
  workflowName: name,
  taskQueue,
  numWorkflows,
  concurrency,
  heapSampleIteration,
}: RunWorkflowOptions) {
  let numComplete = 0;
  await range(0, numWorkflows)
    .pipe(
      take(numWorkflows),
      mergeMap(() => runWorkflow(connection, namespace, name, taskQueue), concurrency),
      withLatestFrom(worker.numInFlightActivations$, worker.numRunningWorkflowInstances$),
      tap(([_, numInFlightActivations, numRunningWorkflowInstances]) => {
        ++numComplete;
        console.log(
          `Workflow complete (${numComplete}/${numWorkflows}) (in flight - WFs: ${numRunningWorkflowInstances}, activations: ${numInFlightActivations})`
        );
        if (numComplete % heapSampleIteration === 0) {
          const { heapUsed, heapTotal } = process.memoryUsage();
          console.log(`🔵 heap used / total MB: ${toMB(heapUsed)} / ${toMB(heapTotal)})`);
        }
      })
    )
    .toPromise();
}
async function main() {
  const args = arg({
    '--iterations': Number,
    '--workflow': String,
    '--ns': String,
    '--max-concurrent-at-executions': Number,
    '--max-concurrent-wft-executions': Number,
    '--max-concurrent-at-polls': Number,
    '--max-concurrent-wft-polls': Number,
    '--concurrent-wf-clients': Number,
    '--log-level': String,
    '--server-address': String,
  });
  const workflowName = args['--workflow'] || 'cancel-fake-progress';
  const iterations = args['--iterations'] || 1000;
  const maxConcurrentActivityTaskExecutions = args['--max-concurrent-at-executions'] || 100;
  const maxConcurrentWorkflowTaskExecutions = args['--max-concurrent-wft-executions'] || 100;
  const maxConcurrentActivityTaskPolls = args['--max-concurrent-at-polls'] || 20;
  const maxConcurrentWorkflowTaskPolls = args['--max-concurrent-wft-polls'] || 20;
  const concurrentWFClients = args['--concurrent-wf-clients'] || 100;
  const logLevel = (args['--log-level'] || 'INFO').toUpperCase();
  const serverAddress = args['--server-address'] || 'http://localhost:7233';
  const namespace = args['--ns'] || `bench-${new Date().toISOString()}`;
  const serverUrl = new URL(serverAddress);

  // In order for JaegerExporter to transmit packets correctly, increase net.inet.udp.maxdgram to 65536.
  // See: https://github.com/jaegertracing/jaeger-client-node/issues/124#issuecomment-324222456
  const jaegerExporter = new JaegerExporter({
    serviceName: 'bench',
  });
  const otel = new opentelemetry.NodeSDK({
    traceExporter: jaegerExporter,
  });
  await otel.start();
  const taskQueue = 'bench';
  const connection = new Connection({ address: serverUrl.host });

  try {
    await connection.service.registerNamespace({ namespace, workflowExecutionRetentionPeriod: msStrToTs('1 day') });
  } catch (err) {
    if (!(err.details === 'Namespace already exists.')) {
      throw err;
    }
  }
  console.log('Registered namespace', { namespace });
  await waitOnNamespace(connection, namespace);
  console.log('Wait complete on namespace', { namespace });

  const worker = await Worker.create({
    workflowsPath: path.join(__dirname, '../../test-workflows/lib'),
    activitiesPath: path.join(__dirname, '../../test-activities/lib'),
    nodeModulesPath: path.join(__dirname, '../../../node_modules'),
    taskQueue,
    maxConcurrentActivityTaskExecutions,
    maxConcurrentWorkflowTaskExecutions,
    maxConcurrentActivityTaskPolls,
    maxConcurrentWorkflowTaskPolls,
    logger: new DefaultLogger(logLevel as any),
    serverOptions: {
      namespace,
      url: serverAddress,
    },
  });
  console.log('Created worker');

  await Promise.all([
    (async () => {
      await worker.run();
      await otel.shutdown();
    })(),
    (async () => {
      await runWorkflows({
        worker,
        connection,
        namespace,
        workflowName,
        taskQueue,
        numWorkflows: iterations,
        heapSampleIteration: 20,
        concurrency: concurrentWFClients,
      });
      worker.shutdown();
    })(),
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
