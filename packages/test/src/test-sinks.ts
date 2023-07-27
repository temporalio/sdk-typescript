/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { WorkflowClient } from '@temporalio/client';
import { DefaultLogger, InjectedSinks, Runtime } from '@temporalio/worker';
import { WorkflowInfo } from '@temporalio/workflow';
import { UnsafeWorkflowInfo } from '@temporalio/workflow/src/interfaces';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
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

    const dummyDate = new Date(2000, 1, 0, 0, 0, 0);
    function fixWorkflowInfoDates(input: WorkflowInfo): WorkflowInfo {
      return {
        ...input,
        startTime: dummyDate,
        runStartTime: dummyDate,
      };
    }

    const recordedCalls: RecordedCall[] = [];
    const taskQueue = `${__filename}-${t.title}`;
    const thrownErrors = Array<DependencyError>();
    const sinks: InjectedSinks<workflows.TestSinks> = {
      success: {
        runAsync: {
          async fn(info, counter) {
            recordedCalls.push({ info: fixWorkflowInfoDates(info), counter, fn: 'success.runAsync' });
          },
        },
        runSync: {
          fn(info, counter) {
            recordedCalls.push({ info: fixWorkflowInfoDates(info), counter, fn: 'success.runSync' });
          },
        },
      },
      error: {
        throwAsync: {
          async fn(info, counter) {
            recordedCalls.push({ info: fixWorkflowInfoDates(info), counter, fn: 'error.throwAsync' });
            const error = new DependencyError('error', 'throwAsync');
            thrownErrors.push(error);
            throw error;
          },
        },
        throwSync: {
          fn(info, counter) {
            recordedCalls.push({ info: fixWorkflowInfoDates(info), counter, fn: 'error.throwSync' });
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
      searchAttributes: {},
      historyLength: 3,
      startTime: dummyDate,
      runStartTime: dummyDate,
      // unsafe.now() doesn't make it through serialization, but .now is required, so we need to cast
      unsafe: { isReplaying: false } as UnsafeWorkflowInfo,
    };

    t.deepEqual(recordedCalls, [
      { info, fn: 'success.runSync', counter: 0 },
      { info, fn: 'success.runAsync', counter: 1 },
      { info, fn: 'error.throwSync', counter: 2 },
      { info, fn: 'error.throwAsync', counter: 3 },
    ]);

    t.deepEqual(
      recordedLogs.map((x) => ({
        ...x,
        meta: {
          ...x.meta,
          workflowInfo: fixWorkflowInfoDates(x.meta.workflowInfo),
        },
      })),
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
    const recordedMessages = Array<{ message: string; hl: number; isReplaying: boolean }>();
    const taskQueue = `${__filename}-${t.title}`;
    const sinks: InjectedSinks<workflows.LoggerSinks> = {
      logger: {
        info: {
          async fn(info, message) {
            recordedMessages.push({
              message,
              hl: info.historyLength,
              isReplaying: info.unsafe.isReplaying,
            });
          },
        },
      },
    };

    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      sinks,
      maxCachedWorkflows: 0,
      maxConcurrentWorkflowTaskExecutions: 2,
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
      {
        message: 'Workflow execution started, replaying: false, hl: 3',
        hl: 3,
        isReplaying: false,
      },
      {
        message: 'Workflow execution completed, replaying: false, hl: 8',
        hl: 8,
        isReplaying: false,
      },
    ]);
  });

  test('Sink functions are called during replay if callDuringReplay is set', async (t) => {
    const recordedMessages = Array<{ message: string; hl: number; isReplaying: boolean }>();
    const taskQueue = `${__filename}-${t.title}`;
    const sinks: InjectedSinks<workflows.LoggerSinks> = {
      logger: {
        info: {
          async fn(info, message) {
            recordedMessages.push({
              message,
              hl: info.historyLength,
              isReplaying: info.unsafe.isReplaying,
            });
          },
          callDuringReplay: true,
        },
      },
    };

    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      sinks,
      maxCachedWorkflows: 0,
      maxConcurrentWorkflowTaskExecutions: 2,
    });
    const client = new WorkflowClient();
    await worker.runUntil(client.execute(workflows.logSinkTester, { taskQueue, workflowId: uuid4() }));

    // Note that task may be replayed more than once and record the first messages multiple times.
    t.deepEqual(recordedMessages.slice(0, 2), [
      {
        message: 'Workflow execution started, replaying: false, hl: 3',
        hl: 3,
        isReplaying: false,
      },
      {
        message: 'Workflow execution started, replaying: true, hl: 3',
        hl: 3,
        isReplaying: true,
      },
    ]);
    t.deepEqual(recordedMessages[recordedMessages.length - 1], {
      message: 'Workflow execution completed, replaying: false, hl: 8',
      hl: 8,
      isReplaying: false,
    });
  });

  test('Sink functions are not called in runReplayHistories if callDuringReplay is unset', async (t) => {
    const recordedMessages = Array<{ message: string; hl: number; isReplaying: boolean }>();
    const taskQueue = `${__filename}-${t.title}`;
    const sinks: InjectedSinks<workflows.LoggerSinks> = {
      logger: {
        info: {
          async fn(info, message) {
            recordedMessages.push({
              message,
              hl: info.historyLength,
              isReplaying: info.unsafe.isReplaying,
            });
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
    const workflowId = uuid4();
    await worker.runUntil(async () => {
      await client.execute(workflows.logSinkTester, { taskQueue, workflowId });
    });
    const history = await client.getHandle(workflowId).fetchHistory();

    // Last 3 events are WorkflowExecutionStarted, WorkflowTaskCompleted and WorkflowExecutionCompleted
    history.events = history!.events!.slice(0, -3);

    recordedMessages.length = 0;
    await Worker.runReplayHistory(
      {
        ...defaultOptions,
        sinks,
      },
      history,
      workflowId
    );

    t.deepEqual(recordedMessages, []);
  });

  test('Sink functions are called in runReplayHistories if callDuringReplay is set', async (t) => {
    const recordedMessages = Array<{ message: string; hl: number; isReplaying: boolean }>();
    const taskQueue = `${__filename}-${t.title}`;
    const sinks: InjectedSinks<workflows.LoggerSinks> = {
      logger: {
        info: {
          async fn(info, message) {
            recordedMessages.push({
              message,
              hl: info.historyLength,
              isReplaying: info.unsafe.isReplaying,
            });
          },
          callDuringReplay: true,
        },
      },
    };

    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      sinks,
    });
    const client = new WorkflowClient();
    const workflowId = uuid4();
    await worker.runUntil(async () => {
      await client.execute(workflows.logSinkTester, { taskQueue, workflowId });
    });
    const history = await client.getHandle(workflowId).fetchHistory();

    // Last 3 events are WorkflowExecutionStarted, WorkflowTaskCompleted and WorkflowExecutionCompleted
    history.events = history!.events!.slice(0, -3);

    recordedMessages.length = 0;
    await Worker.runReplayHistory(
      {
        ...defaultOptions,
        sinks,
      },
      history,
      workflowId
    );

    // Note that task may be replayed more than once and record the first messages multiple times.
    t.deepEqual(recordedMessages.slice(0, 2), [
      {
        message: 'Workflow execution started, replaying: true, hl: 3',
        isReplaying: true,
        hl: 3,
      },
      {
        message: 'Workflow execution completed, replaying: true, hl: 7',
        isReplaying: true,
        hl: 7,
      },
    ]);
  });
}
