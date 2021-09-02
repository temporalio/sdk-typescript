import arg from 'arg';
import { range } from 'rxjs';
import { bufferTime, mergeMap, take, tap } from 'rxjs/operators';
import { Connection, WorkflowClient } from '@temporalio/client';
import { StarterArgSpec, starterArgSpec, getRequired } from './args';

async function runWorkflow(client: WorkflowClient, name: string, taskQueue: string) {
  await client.execute({ taskQueue }, name);
}

interface RunWorkflowOptions {
  client: WorkflowClient;
  workflowName: string;
  taskQueue: string;
  numWorkflows: number;
  concurrency: number;
  minWFPS: number;
}

async function runWorkflows({
  client,
  workflowName: name,
  taskQueue,
  numWorkflows,
  concurrency,
  minWFPS,
}: RunWorkflowOptions): Promise<boolean> {
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
  const finalWfsPerSec = numComplete / totalTime;
  if (finalWfsPerSec < minWFPS) {
    console.error(
      `Insufficient overall workflows per second upon test completion: ${finalWfsPerSec} less than ${minWFPS}`
    );
    return false;
  }
  return true;
}

async function main() {
  const args = arg<StarterArgSpec>(starterArgSpec);
  const workflowName = args['--workflow'] || 'cancel-fake-progress';
  const iterations = args['--iterations'] || 1000;
  const concurrentWFClients = args['--concurrent-wf-clients'] || 100;
  const minWFPS = args['--min-wfs-per-sec'] || 35;
  const serverAddress = getRequired(args, '--server-address');
  const namespace = getRequired(args, '--ns');
  const taskQueue = getRequired(args, '--task-queue');

  const connection = new Connection({ address: serverAddress });

  const client = new WorkflowClient(connection.service, { namespace });

  const passed = await runWorkflows({
    client,
    workflowName,
    taskQueue,
    numWorkflows: iterations,
    concurrency: concurrentWFClients,
    minWFPS,
  });
  if (!passed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
