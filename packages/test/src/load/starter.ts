import arg from 'arg';
import { range } from 'rxjs';
import { bufferTime, mergeMap, take, tap } from 'rxjs/operators';
import { Connection, WorkflowClient } from '@temporalio/client';
import { StarterArgSpec, starterArgSpec, getRequired } from './args';

async function runWorkflow(client: WorkflowClient, name: string, taskQueue: string) {
  const workflow = client.stub<any>(name, { taskQueue });
  await workflow.execute();
}

interface RunWorkflowOptions {
  client: WorkflowClient;
  workflowName: string;
  taskQueue: string;
  numWorkflows: number;
  concurrency: number;
}

async function runWorkflows({ client, workflowName: name, taskQueue, numWorkflows, concurrency }: RunWorkflowOptions) {
  let prevIterationTime = process.hrtime.bigint();
  let totalTime = 0;
  let numComplete = 0;
  let numCompletePrevIteration = 0;
  await range(0, numWorkflows)
    .pipe(
      take(numWorkflows),
      mergeMap(() => runWorkflow(client, name, taskQueue), concurrency),
      tap(() => void ++numComplete),
      bufferTime(1000),
      tap(() => {
        const numCompleteThisIteration = numComplete - numCompletePrevIteration;
        const now = process.hrtime.bigint();
        // delta time in seconds
        const dt = Number(now - prevIterationTime) / 1_000_000_000;
        totalTime += dt;
        prevIterationTime = now;
        const wfsPerSecond = (numCompleteThisIteration / dt).toFixed(1);

        const overallWfsPerSecond = (numComplete / totalTime).toFixed(1);
        process.stderr.write(
          `\rWFs complete (${numComplete}/${numWorkflows}), WFs/s curr ${wfsPerSecond} (acc ${overallWfsPerSecond})  `
        );
        numCompletePrevIteration = numComplete;
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
    concurrency: concurrentWFClients,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
