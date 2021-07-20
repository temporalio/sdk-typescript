import arg from 'arg';
import { range } from 'rxjs';
import { mergeMap, take, tap } from 'rxjs/operators';
import { Connection, WorkflowClient } from '@temporalio/client';
import { StarterArgSpec, starterArgSpec, getRequired } from './args';

async function runWorkflow(client: WorkflowClient, name: string, taskQueue: string) {
  const workflow = client.stub<any>(name, { taskQueue });
  await workflow.execute();
}

function toMB(bytes: number, fractionDigits = 2) {
  return (bytes / 1024 / 1024).toFixed(fractionDigits);
}

interface RunWorkflowOptions {
  client: WorkflowClient;
  workflowName: string;
  taskQueue: string;
  numWorkflows: number;
  concurrency: number;
  heapSampleIteration: number;
}

async function runWorkflows({
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
      tap(() => {
        ++numComplete;
        console.log(`Workflow complete (${numComplete}/${numWorkflows})`);
        if (numComplete % heapSampleIteration === 0) {
          const { heapUsed, heapTotal } = process.memoryUsage();
          console.log(`🔵 heap used / total MB: ${toMB(heapUsed)} / ${toMB(heapTotal)})`);
        }
      })
    )
    .toPromise();
}

async function main() {
  const args = arg<StarterArgSpec>(starterArgSpec);
  const workflowName = args['--workflow'] || 'cancel-fake-progress';
  const iterations = args['--iterations'] || 1000;
  const concurrentWFClients = args['--concurrent-wf-clients'] || 100;
  const serverAddress = getRequired(args, '--server-address');
  const namespace = getRequired(args, '--ns');
  const taskQueue = getRequired(args, '--task-queue');

  const connection = new Connection({ address: serverAddress });

  const client = new WorkflowClient(connection.service, { namespace });

  await runWorkflows({
    client,
    workflowName,
    taskQueue,
    numWorkflows: iterations,
    heapSampleIteration: 20,
    concurrency: concurrentWFClients,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
