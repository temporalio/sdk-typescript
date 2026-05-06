import os from 'node:os';
import fs, { readFileSync } from 'node:fs';
import arg from 'arg';
import pidusage from 'pidusage';
import * as grpc from '@grpc/grpc-js';
import { v4 as uuid4 } from 'uuid';
import type { Observable, OperatorFunction } from 'rxjs';
import { interval, range, ReplaySubject, pipe, lastValueFrom } from 'rxjs';
import { bufferTime, map, mergeMap, tap, takeUntil } from 'rxjs/operators';
import { Connection, ServiceError, WorkflowClient, isGrpcServiceError } from '@temporalio/client';
import { toMB } from '@temporalio/worker/lib/utils';
import type { StarterArgSpec } from './args';
import { starterArgSpec, getRequired } from './args';

const ACCEPTABLE_QUERY_ERROR_CODES = [grpc.status.NOT_FOUND, grpc.status.DEADLINE_EXCEEDED];

async function runWorkflow({ client, workflowName, taskQueue, queryingOptions }: RunWorkflowOptions) {
  const handle = await client.start(workflowName, { args: [], taskQueue, workflowId: uuid4() });

  let wfRunning = true;
  const wfDoneProm = handle.result().finally(() => (wfRunning = false));
  const proms = [wfDoneProm];

  if (queryingOptions) {
    const queryProm = (async () => {
      await new Promise((resolve) => setTimeout(resolve, queryingOptions.initialQueryDelayMs));
      while (wfRunning) {
        try {
          await handle.query(queryingOptions.queryName);
        } catch (err) {
          if (
            err instanceof ServiceError &&
            isGrpcServiceError(err.cause) &&
            err.cause.code !== undefined &&
            ACCEPTABLE_QUERY_ERROR_CODES.includes(err.cause.code)
          ) {
            console.warn(`Got ${grpc.status[err.cause.code]} response to query`);
          } else {
            throw err;
          }
        }
        if (queryingOptions.queryIntervalMs) {
          await new Promise((resolve) => setTimeout(resolve, queryingOptions.queryIntervalMs));
        } else {
          break;
        }
      }
    })();
    proms.push(queryProm);
  }

  await Promise.all(proms);
}

class NumberOfWorkflows {
  constructor(readonly num: number = 0) {}
}

class UntilSecondsElapsed {
  constructor(readonly seconds: number = 0) {}
}

interface QueryingOptions {
  queryName: string;
  initialQueryDelayMs?: number;
  queryIntervalMs?: number;
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
  workerMemoryLogFile?: string;
  workerCPULogFile?: string;
  queryingOptions?: QueryingOptions;
}

async function runWorkflows(options: RunWorkflowOptions): Promise<void> {
  const { workflowName, stopCondition, concurrency, workerPid, workerMemoryLogFile, workerCPULogFile, minWFPS } =
    options;
  let observable: Observable<any>;
  let recordMemUsage = (_mem: number) => undefined;
  let recordCPUUsage = (_cpu: string) => undefined;
  if (workerMemoryLogFile) {
    const stream = fs.createWriteStream(workerMemoryLogFile);
    recordMemUsage = (mem) => void stream.write(`${mem}\n`);
  }
  if (workerCPULogFile) {
    const stream = fs.createWriteStream(workerCPULogFile);
    recordCPUUsage = (cpu) => void stream.write(`${cpu}\n`);
  }

  if (stopCondition instanceof NumberOfWorkflows) {
    observable = range(0, stopCondition.num).pipe(
      mergeMap(() => runWorkflow(options), concurrency),
      followProgress(),
      mergeMap(async (progress) => ({ progress, workerResources: workerPid ? await pidusage(workerPid) : undefined })),
      tap(({ progress: { numComplete, wfsPerSecond, overallWfsPerSecond }, workerResources }) => {
        let resourceString = '';
        if (workerResources) {
          resourceString = `CPU ${workerResources.cpu.toFixed(0)}%, MEM ${toMB(workerResources.memory)}MB`;
          recordMemUsage(workerResources.memory);
          recordCPUUsage(workerResources.cpu.toFixed(0));
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
      mergeMap(() => runWorkflow(options)),
      tap(subj),
      followProgress(),
      mergeMap(async (progress) => ({ progress, workerResources: workerPid ? await pidusage(workerPid) : undefined })),
      tap(({ progress: { numComplete, wfsPerSecond, overallWfsPerSecond, totalTime }, workerResources }) => {
        let resourceString = '';
        if (workerResources) {
          resourceString = `CPU ${workerResources.cpu.toFixed(0)}%, MEM ${toMB(workerResources.memory)}MB`;
          recordMemUsage(workerResources.memory);
          recordCPUUsage(workerResources.cpu.toFixed(0));
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
      `Insufficient overall workflows per second upon test completion: ${finalWfsPerSec} less than ${minWFPS} for workflow ${workflowName}`
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
  const workflowName = getRequired(args, '--workflow');
  const iterations = args['--iterations'] || 1000;
  const runForSeconds = args['--for-seconds'];
  const concurrentWFClients = args['--concurrent-wf-clients'] || 100;
  const minWFPS = args['--min-wfs-per-sec'] || 35;
  const queryName = args['--do-query'];
  const queryIntervalMs = args['--query-interval-ms'];
  const initialQueryDelayMs = args['--initial-query-delay-ms'] || queryIntervalMs;
  const serverAddress = getRequired(args, '--server-address');
  const namespace = getRequired(args, '--ns');
  const taskQueue = getRequired(args, '--task-queue');
  const workerPid = args['--worker-pid'];
  const workerMemoryLogFile = args['--worker-memory-log-file'];
  const workerCPULogFile = args['--worker-cpu-log-file'];

  const clientCertPath = args['--client-cert-path'];
  const clientKeyPath = args['--client-key-path'];

  const tlsConfig =
    clientCertPath && clientKeyPath
      ? {
          tls: {
            clientCertPair: {
              crt: readFileSync(clientCertPath),
              key: readFileSync(clientKeyPath),
            },
          },
        }
      : {};

  const connection = await Connection.connect({ address: serverAddress, ...tlsConfig });
  const client = new WorkflowClient({ connection, namespace });
  const stopCondition = runForSeconds ? new UntilSecondsElapsed(runForSeconds) : new NumberOfWorkflows(iterations);
  const queryingOptions = queryName ? { queryName, queryIntervalMs, initialQueryDelayMs } : undefined;

  console.log(`Starting tests on machine with ${toMB(os.totalmem(), 0)}MB of RAM and ${os.cpus().length} CPUs`);

  console.log(`+++ Starting test for ${workflowName} workflows`);
  await runWorkflows({
    client,
    workflowName,
    taskQueue,
    stopCondition,
    concurrency: concurrentWFClients,
    minWFPS,
    workerPid,
    workerMemoryLogFile,
    workerCPULogFile,
    queryingOptions,
  });
}

main().catch((err) => {
  console.error('Starter encountered error', err);
  process.exit(1);
});
