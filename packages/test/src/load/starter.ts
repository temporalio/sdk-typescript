import arg from 'arg';
import os from 'os';
import pidusage from 'pidusage';
import { v4 as uuid4 } from 'uuid';
import { interval, range, Observable, OperatorFunction, ReplaySubject, pipe, lastValueFrom } from 'rxjs';
import { bufferTime, map, mergeMap, tap, takeUntil } from 'rxjs/operators';
import { Connection, isServerErrorResponse, ServiceError, WorkflowClient } from '@temporalio/client';
import { toMB } from '@temporalio/worker/lib/utils';
import { StarterArgSpec, starterArgSpec, getRequired } from './args';

async function runWorkflow(client: WorkflowClient, name: string, taskQueue: string, queryingOptions?: QueryingOptions) {
  const handle = await client.start(name, { args: [], taskQueue, workflowId: uuid4() });

  let wfDoneProm = handle.result();
  let wfRunning = true;
  const proms = [];

  if (queryingOptions) {
    wfDoneProm = wfDoneProm.then(() => (wfRunning = false));
    const queryProm = (async () => {
      while (wfRunning) {
        await new Promise((resolve) => setTimeout(resolve, queryingOptions.queryInterval));
        try {
          await handle.query(queryingOptions.queryName);
        } catch (err) {
          if (err instanceof ServiceError && isServerErrorResponse(err.cause)) {
            if (err.cause.code === 5) {
              console.warn('Got not found response to query');
              continue;
            }
            if (err.cause.code === 4) {
              console.warn('Got deadline exceeded response to query');
              continue;
            }
          }
          throw err;
        }
      }
    })();
    proms.push(queryProm);
  }
  proms.push(wfDoneProm);

  await Promise.all(proms);
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
  workerPid?: number;
  queryingOptions?: QueryingOptions;
}

interface QueryingOptions {
  queryName: string;
  queryInterval: number;
}

async function runWorkflows({
  client,
  workflowName: name,
  taskQueue,
  stopCondition,
  concurrency,
  workerPid,
  minWFPS,
  queryingOptions,
}: RunWorkflowOptions): Promise<void> {
  let observable: Observable<any>;

  if (stopCondition instanceof NumberOfWorkflows) {
    observable = range(0, stopCondition.num).pipe(
      mergeMap(() => runWorkflow(client, name, taskQueue, queryingOptions), concurrency),
      followProgress(),
      mergeMap(async (progress) => ({ progress, workerResources: workerPid ? await pidusage(workerPid) : undefined })),
      tap(({ progress: { numComplete, wfsPerSecond, overallWfsPerSecond }, workerResources }) => {
        let resourceString = '';
        if (workerResources) {
          resourceString = `CPU ${workerResources.cpu.toFixed(0)}%, MEM ${toMB(workerResources.memory)}MB`;
        }
        process.stderr.write(
          `\rWFs complete (${numComplete}/${stopCondition.num}) -- WFs/s curr ${wfsPerSecond} (acc ${overallWfsPerSecond}) -- ${resourceString}  `
        );
      })
    );
  } else {
    const subj = new ReplaySubject<void>(concurrency);
    for (let i = 0; i < concurrency; ++i) {
      subj.next();
    }

    observable = subj.pipe(
      takeUntil(interval(stopCondition.seconds * 1000)),
      mergeMap(() => runWorkflow(client, name, taskQueue, queryingOptions)),
      tap(subj),
      followProgress(),
      mergeMap(async (progress) => ({ progress, workerResources: workerPid ? await pidusage(workerPid) : undefined })),
      tap(({ progress: { numComplete, wfsPerSecond, overallWfsPerSecond, totalTime }, workerResources }) => {
        let resourceString = '';
        if (workerResources) {
          resourceString = `CPU ${workerResources.cpu.toFixed(0)}%, MEM ${toMB(workerResources.memory)}MB`;
        }
        const secondsLeft = Math.max(Math.floor(stopCondition.seconds - totalTime), 0);
        process.stderr.write(
          `\rWFs complete (${numComplete}) starting new wfs for (${secondsLeft.toFixed(
            1
          )}s) more -- WFs/s curr ${wfsPerSecond} (acc ${overallWfsPerSecond}) -- ${resourceString}  `
        );
      })
    );
  }

  const { numComplete, totalTime } = await lastValueFrom(observable);
  process.stderr.write('\n');

  const finalWfsPerSec = numComplete / totalTime;
  if (finalWfsPerSec < minWFPS) {
    throw new Error(
      `Insufficient overall workflows per second upon test completion: ${finalWfsPerSec} less than ${minWFPS} for workflow ${name}`
    );
  }
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
  const queryName = args['--do-query'];
  const queryInterval = args['--ms-between-queries'] || 2000;
  const serverAddress = getRequired(args, '--server-address');
  const namespace = getRequired(args, '--ns');
  const taskQueue = getRequired(args, '--task-queue');
  const workerPid = args['--worker-pid'];

  const connection = new Connection({ address: serverAddress });
  const client = new WorkflowClient(connection.service, { namespace });
  const stopCondition = runForSeconds ? new UntilSecondsElapsed(runForSeconds) : new NumberOfWorkflows(iterations);
  const queryingOptions = queryName ? { queryName, queryInterval } : undefined;

  console.log(`Starting tests on machine with ${toMB(os.totalmem(), 0)}MB of RAM and ${os.cpus().length} CPUs`);

  let workflowsToRun: string[];
  if (workflowName === 'yummy-sampler-mode') {
    // Special workflow alias to run many different load tests sequentially.
    // Expected wf/sec should be set low since some of these by their nature have
    // higher latency.
    workflowsToRun = ['cancelFakeProgress', 'childWorkflowCancel', 'childWorkflowSignals', 'smorgasbord'];
  } else {
    workflowsToRun = [workflowName];
  }

  for (const wfName of workflowsToRun) {
    console.log(`+++ Starting test for ${wfName} workflows`);
    await runWorkflows({
      client,
      workflowName: wfName,
      taskQueue,
      stopCondition,
      concurrency: concurrentWFClients,
      minWFPS,
      workerPid,
      queryingOptions,
    });
  }
}

main().catch((err) => {
  console.error('Starter encountered error', err);
  process.exit(1);
});
