import arg from 'arg';
import { range, ReplaySubject } from 'rxjs';
import { bufferTime, mergeMap, tap, repeatWhen, takeWhile, repeat } from 'rxjs/operators';
import { Connection, WorkflowClient } from '@temporalio/client';
import { StarterArgSpec, starterArgSpec, getRequired } from './args';

async function runWorkflow(client: WorkflowClient, name: string, taskQueue: string) {
  await client.execute({ taskQueue }, name);
}

class NumberOfWorkflows {
  constructor(readonly num: number = 0) {}
}

class UntilSecondsElapsed {
  constructor(readonly seconds: number = 0) {}
}

interface RunWorkflowOptions {
  client: WorkflowClient;
  workflowName: string;
  taskQueue: string;
  // Run either the specified number of workflows, or continue running workflows
  // for the provided number of seconds
  stopCondition: NumberOfWorkflows | UntilSecondsElapsed;
  concurrency: number;
  minWFPS: number;
}

async function runWorkflows({
  client,
  workflowName: name,
  taskQueue,
  stopCondition,
  concurrency,
  minWFPS,
}: RunWorkflowOptions): Promise<boolean> {
  let prevIterationTime = process.hrtime.bigint();
  let totalTime = 0;
  let numComplete = 0;
  let numCompletePrevIteration = 0;
  let runWfPromise = () => runWorkflow(client, name, taskQueue);

  let observable;
  let progressPrinter: () => void;

  if (stopCondition instanceof NumberOfWorkflows) {
    observable = range(0, stopCondition.num);

    progressPrinter = () => process.stderr.write(`\rWFs complete (${numComplete}/${stopCondition.num})`);
  } else {
    const subj = new ReplaySubject<number>(concurrency);
    [...Array(concurrency)].forEach(() => {
      subj.next();
    });
    observable = subj;

    runWfPromise = () =>
      runWorkflow(client, name, taskQueue).then(() => {
        subj.next();
      });

    progressPrinter = () =>
      process.stderr.write(
        `\rWFs complete (${numComplete}) starting new wfs for (${stopCondition.seconds - totalTime}) more seconds`
      );
  }

  let stream = observable.pipe(
    mergeMap(() => runWfPromise(), concurrency),
    tap(() => void ++numComplete)
  );

  if (stopCondition instanceof UntilSecondsElapsed) {
    stream = stream.pipe(
      repeatWhen((obs) => obs),
      takeWhile(() => totalTime <= stopCondition.seconds)
    );
  }

  await stream
    .pipe(
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
        progressPrinter();
        process.stderr.write(` -- WFs/s curr ${wfsPerSecond} (acc ${overallWfsPerSecond})            `);
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
  const workflowName = args['--workflow'] || 'cancelFakeProgress';
  const iterations = args['--iterations'] || 1000;
  const runForSeconds = args['--for-seconds'];
  const concurrentWFClients = args['--concurrent-wf-clients'] || 100;
  const minWFPS = args['--min-wfs-per-sec'] || 35;
  const serverAddress = getRequired(args, '--server-address');
  const namespace = getRequired(args, '--ns');
  const taskQueue = getRequired(args, '--task-queue');

  const connection = new Connection({ address: serverAddress });

  const client = new WorkflowClient(connection.service, { namespace });

  const stopCondition = runForSeconds ? new UntilSecondsElapsed(runForSeconds) : new NumberOfWorkflows(iterations);

  const passed = await runWorkflows({
    client,
    workflowName,
    taskQueue,
    stopCondition,
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
