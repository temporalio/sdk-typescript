import arg from 'arg';
import { interval, range, Observable, OperatorFunction, ReplaySubject, pipe } from 'rxjs';
import { bufferTime, map, mergeMap, tap, takeUntil } from 'rxjs/operators';
import { Connection, WorkflowClient } from '@temporalio/client';
import { StarterArgSpec, starterArgSpec, getRequired } from './args';
import * as os from 'os';

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
  let observable: Observable<any>;

  if (stopCondition instanceof NumberOfWorkflows) {
    observable = range(0, stopCondition.num).pipe(
      mergeMap(() => runWorkflow(client, name, taskQueue), concurrency),
      followProgress(),
      tap(({ numComplete, wfsPerSecond, overallWfsPerSecond }) =>
        process.stderr.write(
          `\rWFs complete (${numComplete}/${stopCondition.num}) -- WFs/s curr ${wfsPerSecond} (acc ${overallWfsPerSecond})  `
        )
      )
    );
  } else {
    const subj = new ReplaySubject<void>(concurrency);
    for (let i = 0; i < concurrency; ++i) {
      subj.next();
    }

    observable = subj.pipe(
      takeUntil(interval(stopCondition.seconds * 1000)),
      mergeMap(() => runWorkflow(client, name, taskQueue)),
      tap(subj),
      followProgress(),
      tap(({ numComplete, wfsPerSecond, overallWfsPerSecond, totalTime }) => {
        const secondsLeft = Math.max(Math.floor(stopCondition.seconds - totalTime), 0);
        process.stderr.write(
          `\rWFs complete (${numComplete}) starting new wfs for (${secondsLeft.toFixed(
            1
          )}s) more -- WFs/s curr ${wfsPerSecond} (acc ${overallWfsPerSecond}) -- MEM (${os.freemem()}/${os.totalmem()})`
        );
      })
    );
  }

  const { numComplete, totalTime } = await observable.toPromise();
  const finalWfsPerSec = numComplete / totalTime;
  if (finalWfsPerSec < minWFPS) {
    console.error(
      `Insufficient overall workflows per second upon test completion: ${finalWfsPerSec} less than ${minWFPS}`
    );
    return false;
  }
  return true;
}

interface Progress {
  numComplete: number;
  totalTime: number;
  /** Formatted number */
  wfsPerSecond: string;
  /** Formatted number */
  overallWfsPerSecond: string;
}

function followProgress(): OperatorFunction<any, Progress> {
  let prevIterationTime = process.hrtime.bigint();
  let totalTime = 0;
  let numComplete = 0;
  let numCompletePrevIteration = 0;

  return pipe(
    tap(() => void ++numComplete),
    bufferTime(1000),
    map(() => {
      const numCompleteThisIteration = numComplete - numCompletePrevIteration;
      const now = process.hrtime.bigint();
      // delta time in seconds
      const dt = Number(now - prevIterationTime) / 1_000_000_000;
      totalTime += dt;
      prevIterationTime = now;
      const wfsPerSecond = (numCompleteThisIteration / dt).toFixed(1);
      const overallWfsPerSecond = (numComplete / totalTime).toFixed(1);
      numCompletePrevIteration = numComplete;
      return { numComplete, wfsPerSecond, overallWfsPerSecond, totalTime };
    })
  );
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
    console.error('Load test did not pass');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
