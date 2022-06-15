/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import { WorkflowClient } from '@temporalio/client';
import { DefaultLogger, InjectedSinks, Runtime, Worker } from '@temporalio/worker';
import { WorkflowInfo } from '@temporalio/workflow';
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { defaultOptions } from './mock-native-worker';
import * as workflows from './workflows';

class DependencyError extends Error {
  constructor(public readonly ifaceName: string, public readonly fnName: string) {
    super(`${ifaceName}.${fnName}`);
  }
}

if (RUN_INTEGRATION_TESTS) {
  const recordedLogs: any[] = [];
  test.before((_) => {
    Runtime.install({
      logger: new DefaultLogger('DEBUG', ({ level, message, meta }) => {
        if (message === 'External sink function threw an error') recordedLogs.push({ level, message, meta });
      }),
    });
  });

  // Must be serial because it uses the global Runtime to check for error messages
  test.serial('Worker injects sinks', async (t) => {
    interface RecordedCall {
      info: WorkflowInfo;
      counter: number;
      fn: string;
    }

    const recordedCalls: RecordedCall[] = [];
    const taskQueue = `${__filename}-${t.title}`;
    const thrownErrors = Array<DependencyError>();
    const sinks: InjectedSinks<workflows.TestSinks> = {
      success: {
        runAsync: {
          async fn(info, counter) {
            recordedCalls.push({ info, counter, fn: 'success.runAsync' });
          },
        },
        runSync: {
          fn(info, counter) {
            recordedCalls.push({ info, counter, fn: 'success.runSync' });
          },
        },
      },
      error: {
        throwAsync: {
          async fn(info, counter) {
            recordedCalls.push({ info, counter, fn: 'error.throwAsync' });
            const error = new DependencyError('error', 'throwAsync');
            thrownErrors.push(error);
            throw error;
          },
        },
        throwSync: {
          fn(info, counter) {
            recordedCalls.push({ info, counter, fn: 'error.throwSync' });
            const error = new DependencyError('error', 'throwSync');
            thrownErrors.push(error);
            throw error;
          },
        },
      },
    };

    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      sinks,
    });
    const client = new WorkflowClient();
    const wf = await worker.runUntil(async () => {
      const wf = await client.start(workflows.sinksWorkflow, { taskQueue, workflowId: uuid4() });
      await wf.result();
      return wf;
    });
    const info: WorkflowInfo = {
      namespace: 'default',
      firstExecutionRunId: wf.firstExecutionRunId,
      attempt: 1,
      taskTimeoutMs: 10_000,
      continuedFromExecutionRunId: undefined,
      cronSchedule: undefined,
      cronScheduleToScheduleInterval: undefined,
      executionExpirationTime: undefined,
      executionTimeoutMs: undefined,
      retryPolicy: undefined,
      runTimeoutMs: undefined,
      taskQueue,
      workflowId: wf.workflowId,
      runId: wf.firstExecutionRunId,
      workflowType: 'sinksWorkflow',
      lastFailure: undefined,
      lastResult: undefined,
      memo: undefined,
      parent: undefined,
      searchAttributes: undefined,
    };

    t.deepEqual(recordedCalls, [
      { info, fn: 'success.runSync', counter: 0 },
      { info, fn: 'success.runAsync', counter: 1 },
      { info, fn: 'error.throwSync', counter: 2 },
      { info, fn: 'error.throwAsync', counter: 3 },
    ]);

    t.deepEqual(
      recordedLogs,
      thrownErrors.map((error) => ({
        level: 'ERROR',
        message: 'External sink function threw an error',
        meta: {
          error,
          ifaceName: error.ifaceName,
          fnName: error.fnName,
          workflowInfo: info,
        },
      }))
    );
  });

  test('Sink functions are not called during replay if callDuringReplay is unset', async (t) => {
    const recordedMessages = Array<string>();
    const taskQueue = `${__filename}-${t.title}`;
    const sinks: InjectedSinks<workflows.LoggerSinks> = {
      logger: {
        info: {
          async fn(_info, message) {
            recordedMessages.push(message);
          },
        },
      },
    };

    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      sinks,
      maxCachedWorkflows: 1,
      maxConcurrentWorkflowTaskExecutions: 1,
    });
    const client = new WorkflowClient();
    await Promise.all([
      (async () => {
        try {
          await client.execute(workflows.logSinkTester, { taskQueue, workflowId: uuid4() });
        } finally {
          worker.shutdown();
        }
      })(),
      worker.run(),
    ]);

    t.deepEqual(recordedMessages, [
      'Workflow execution started, replaying: false, hl: 3',
      'Workflow execution completed, replaying: false, hl: 12',
    ]);
  });

  test('Sink functions are called during replay if callDuringReplay is set', async (t) => {
    const recordedMessages = Array<string>();
    const taskQueue = `${__filename}-${t.title}`;
    const sinks: InjectedSinks<workflows.LoggerSinks> = {
      logger: {
        info: {
          async fn(_info, message) {
            recordedMessages.push(message);
          },
          callDuringReplay: true,
        },
      },
    };

    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      sinks,
      maxCachedWorkflows: 1,
      maxConcurrentWorkflowTaskExecutions: 1,
    });
    const client = new WorkflowClient();
    await worker.runUntil(client.execute(workflows.logSinkTester, { taskQueue, workflowId: uuid4() }));

    // Note that task may be replayed more than once and record the first messages multiple times.
    t.deepEqual(recordedMessages.slice(0, 2), [
      'Workflow execution started, replaying: false, hl: 3',
      'Workflow execution started, replaying: true, hl: 3',
    ]);
    t.is(recordedMessages[recordedMessages.length - 1], 'Workflow execution completed, replaying: false, hl: 12');
  });
}
