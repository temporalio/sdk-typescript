import path from 'path';
import arg from 'arg';
import { range } from 'rxjs';
import { mergeMap, take, tap, withLatestFrom } from 'rxjs/operators';
import { Core, Worker, DefaultLogger } from '@temporalio/worker';
import { Connection, WorkflowClient } from '@temporalio/client';
import { msToTs } from '@temporalio/workflow/lib/time';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';

async function createNamespace(connection: Connection, namespace: string, maxAttempts = 100, retryIntervalSecs = 1) {
  for (let attempt = 1; attempt <= maxAttempts; ++attempt) {
    try {
      await connection.service.registerNamespace({ namespace, workflowExecutionRetentionPeriod: msToTs('1 day') });
    } catch (err) {
      if (err.details === 'Namespace already exists.') {
        break;
      }
      if (attempt === maxAttempts) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, retryIntervalSecs * 1000));
    }
  }
}

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

async function runWorkflow(client: WorkflowClient, name: string, taskQueue: string) {
  const workflow = client.stub<any>(name, { taskQueue });
  await workflow.start();
}

function toMB(bytes: number, fractionDigits = 2) {
  return (bytes / 1024 / 1024).toFixed(fractionDigits);
}

interface RunWorkflowOptions {
  worker: Worker;
  client: WorkflowClient;
  workflowName: string;
  taskQueue: string;
  numWorkflows: number;
  concurrency: number;
  heapSampleIteration: number;
}

async function runWorkflows({
  worker,
  client,
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
      mergeMap(() => runWorkflow(client, name, taskQueue), concurrency),
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
  const serverAddress = args['--server-address'] || 'localhost:7233';
  const namespace = args['--ns'] || `bench-${new Date().toISOString()}`;

  // In order for JaegerExporter to transmit packets correctly, increase net.inet.udp.maxdgram to 65536.
  // See: https://github.com/jaegertracing/jaeger-client-node/issues/124#issuecomment-324222456
  const jaegerExporter = new JaegerExporter();
  const otel = new opentelemetry.NodeSDK({
    traceExporter: jaegerExporter,
  });
  await otel.start();
  const taskQueue = 'bench';
  const connection = new Connection({ address: serverAddress });

  await createNamespace(connection, namespace);
  console.log('Registered namespace', { namespace });
  await waitOnNamespace(connection, namespace);
  console.log('Wait complete on namespace', { namespace });

  await Core.install({
    serverOptions: {
      namespace,
      address: serverAddress,
    },
  });

  const worker = await Worker.create({
    workflowsPath: path.join(__dirname, 'workflows'),
    activitiesPath: path.join(__dirname, 'activities'),
    nodeModulesPath: path.join(__dirname, '../../../node_modules'),
    taskQueue,
    maxConcurrentActivityTaskExecutions,
    maxConcurrentWorkflowTaskExecutions,
    maxConcurrentActivityTaskPolls,
    maxConcurrentWorkflowTaskPolls,
    logger: new DefaultLogger(logLevel as any),
  });
  console.log('Created worker');

  const client = new WorkflowClient(connection.service, { namespace });

  await Promise.all([
    (async () => {
      await worker.run();
      await otel.shutdown();
    })(),
    (async () => {
      await runWorkflows({
        worker,
        client,
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
