/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Connection, WorkflowClient } from '@temporalio/client';
import { DefaultLogger, InjectedSinks, Runtime, WorkerOptions, LogEntry } from '@temporalio/worker';
import { SearchAttributes, WorkflowInfo } from '@temporalio/workflow';
import { UnsafeWorkflowInfo } from '@temporalio/workflow/src/interfaces';
import { SdkComponent } from '@temporalio/common';
import { RUN_INTEGRATION_TESTS, Worker, asSdkLoggerSink, registerDefaultCustomSearchAttributes } from './helpers';
import { defaultOptions } from './mock-native-worker';
import * as workflows from './workflows';

class DependencyError extends Error {
  constructor(
    public readonly ifaceName: string,
    public readonly fnName: string
  ) {
    super(`${ifaceName}.${fnName}`);
  }
}

if (RUN_INTEGRATION_TESTS) {
  const recordedLogs: { [workflowId: string]: LogEntry[] } = {};

  test.before(async (_) => {
    await registerDefaultCustomSearchAttributes(await Connection.connect({}));
    Runtime.install({
      logger: new DefaultLogger('DEBUG', (entry: LogEntry) => {
        const workflowId = (entry.meta as any)?.workflowInfo?.workflowId;
        recordedLogs[workflowId] ??= [];
        recordedLogs[workflowId].push(entry);
      }),
    });
  });

  test('Worker injects sinks', async (t) => {
    interface RecordedCall {
      info: WorkflowInfo;
      counter: number;
      fn: string;
    }

    function fixWorkflowInfoDates(input: WorkflowInfo): WorkflowInfo {
      delete (input.unsafe as any).now;
      return input;
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

    // Capture volatile values that are hard to predict
    const { historySize, startTime, runStartTime, currentBuildId } = recordedCalls[0].info;
    t.true(historySize > 300);

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
      continueAsNewSuggested: false,
      // values ignored for the purpose of comparison
      historySize,
      startTime,
      runStartTime,
      currentBuildId,
      // unsafe.now() doesn't make it through serialization, but .now is required, so we need to cast
      unsafe: {
        isReplaying: false,
      } as UnsafeWorkflowInfo,
    };

    t.deepEqual(recordedCalls, [
      { info, fn: 'success.runSync', counter: 0 },
      { info, fn: 'success.runAsync', counter: 1 },
      { info, fn: 'error.throwSync', counter: 2 },
      { info, fn: 'error.throwAsync', counter: 3 },
    ]);

    t.deepEqual(
      recordedLogs[info.workflowId].map((x: LogEntry) => ({
        ...x,
        meta: {
          ...x.meta,
          workflowInfo: fixWorkflowInfoDates(x.meta?.workflowInfo),
          namespace: info.namespace,
          runId: info.runId,
          workflowId: info.workflowId,
          workflowType: info.workflowType,
        },
        timestampNanos: undefined,
      })),
      thrownErrors.map((error) => ({
        level: 'ERROR',
        message: 'External sink function threw an error',
        meta: {
          error,
          ifaceName: error.ifaceName,
          fnName: error.fnName,
          workflowInfo: info,
          sdkComponent: SdkComponent.worker,
          taskQueue,
          namespace: info.namespace,
          runId: info.runId,
          workflowId: info.workflowId,
          workflowType: info.workflowType,
        },
        timestampNanos: undefined,
      }))
    );
  });

  test('Sink functions are not called during replay if callDuringReplay is unset', async (t) => {
    const taskQueue = `${__filename}-${t.title}`;

    const recordedMessages = Array<{ message: string; historyLength: number; isReplaying: boolean }>();
    const sinks: InjectedSinks<workflows.CustomLoggerSinks> = {
      customLogger: {
        info: {
          async fn(info, message) {
            recordedMessages.push({
              message,
              historyLength: info.historyLength,
              isReplaying: info.unsafe.isReplaying,
            });
          },
        },
      },
    };

    const client = new WorkflowClient();
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      sinks,
      maxCachedWorkflows: 0,
      maxConcurrentWorkflowTaskExecutions: 2,
    });
    await worker.runUntil(client.execute(workflows.logSinkTester, { taskQueue, workflowId: uuid4() }));

    t.deepEqual(recordedMessages, [
      {
        message: 'Workflow execution started, replaying: false, hl: 3',
        historyLength: 3,
        isReplaying: false,
      },
      {
        message: 'Workflow execution completed, replaying: false, hl: 8',
        historyLength: 8,
        isReplaying: false,
      },
    ]);
  });

  test('Sink functions are called during replay if callDuringReplay is set', async (t) => {
    const taskQueue = `${__filename}-${t.title}`;

    const recordedMessages = Array<{ message: string; historyLength: number; isReplaying: boolean }>();
    const sinks: InjectedSinks<workflows.CustomLoggerSinks> = {
      customLogger: {
        info: {
          fn: async (info, message) => {
            recordedMessages.push({
              message,
              historyLength: info.historyLength,
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
        historyLength: 3,
        isReplaying: false,
      },
      {
        message: 'Workflow execution started, replaying: true, hl: 3',
        historyLength: 3,
        isReplaying: true,
      },
    ]);
    t.deepEqual(recordedMessages[recordedMessages.length - 1], {
      message: 'Workflow execution completed, replaying: false, hl: 8',
      historyLength: 8,
      isReplaying: false,
    });
  });

  test('Sink functions are not called in runReplayHistories if callDuringReplay is unset', async (t) => {
    const recordedMessages = Array<{ message: string; historyLength: number; isReplaying: boolean }>();
    const sinks: InjectedSinks<workflows.CustomLoggerSinks> = {
      customLogger: {
        info: {
          fn: async (info, message) => {
            recordedMessages.push({
              message,
              historyLength: info.historyLength,
              isReplaying: info.unsafe.isReplaying,
            });
          },
        },
      },
    };

    const client = new WorkflowClient();
    const taskQueue = `${__filename}-${t.title}`;
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      sinks,
    });
    const workflowId = uuid4();
    await worker.runUntil(client.execute(workflows.logSinkTester, { taskQueue, workflowId }));
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
    const taskQueue = `${__filename}-${t.title}`;

    const recordedMessages = Array<{ message: string; historyLength: number; isReplaying: boolean }>();
    const sinks: InjectedSinks<workflows.CustomLoggerSinks> = {
      customLogger: {
        info: {
          fn: async (info, message) => {
            recordedMessages.push({
              message,
              historyLength: info.historyLength,
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

    t.deepEqual(recordedMessages.slice(0, 2), [
      {
        message: 'Workflow execution started, replaying: true, hl: 3',
        isReplaying: true,
        historyLength: 3,
      },
      {
        message: 'Workflow execution completed, replaying: false, hl: 7',
        isReplaying: false,
        historyLength: 7,
      },
    ]);
  });

  test('Sink functions contains upserted search attributes', async (t) => {
    const taskQueue = `${__filename}-${t.title}`;

    const recordedMessages = Array<{ message: string; searchAttributes: SearchAttributes }>();
    const sinks = asSdkLoggerSink(async (info, message, _attrs) => {
      recordedMessages.push({
        message,
        searchAttributes: info.searchAttributes,
      });
    });

    const client = new WorkflowClient();
    const date = new Date();

    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      sinks,
    });
    await worker.runUntil(
      client.execute(workflows.upsertAndReadSearchAttributes, {
        taskQueue,
        workflowId: uuid4(),
        args: [date.getTime()],
      })
    );

    t.deepEqual(recordedMessages, [
      {
        message: 'Workflow started',
        searchAttributes: {},
      },
      {
        message: 'Workflow completed',
        searchAttributes: {
          CustomBoolField: [true],
          CustomIntField: [], // clear
          CustomKeywordField: ['durable code'],
          CustomTextField: ['is useful'],
          CustomDatetimeField: [date],
          CustomDoubleField: [3.14],
        },
      },
    ]);
  });

  test('Core issue 589', async (t) => {
    const taskQueue = `${__filename}-${t.title}`;

    const recordedMessages = Array<{ message: string; historyLength: number; isReplaying: boolean }>();
    const sinks: InjectedSinks<workflows.CustomLoggerSinks> = {
      customLogger: {
        info: {
          fn: async (info, message) => {
            recordedMessages.push({
              message,
              historyLength: info.historyLength,
              isReplaying: info.unsafe.isReplaying,
            });
          },
          callDuringReplay: true,
        },
      },
    };

    const client = new WorkflowClient();
    const handle = await client.start(workflows.coreIssue589, { taskQueue, workflowId: uuid4() });

    const workerOptions: WorkerOptions = {
      ...defaultOptions,
      taskQueue,
      sinks,
      maxCachedWorkflows: 2,
      maxConcurrentWorkflowTaskExecutions: 2,

      // Cut down on execution time
      stickyQueueScheduleToStartTimeout: 1,
    };

    // Start the first worker and wait for the first task to complete before shutdown that worker
    await (await Worker.create(workerOptions)).runUntil(handle.query('q'));

    // Start the second worker
    await (
      await Worker.create(workerOptions)
    ).runUntil(async () => {
      await handle.query('q');
      await handle.signal(workflows.unblockSignal);
      await handle.result();
    });

    const checkpointEntries = recordedMessages.filter((m) => m.message.startsWith('Checkpoint'));
    t.deepEqual(checkpointEntries, [
      {
        message: 'Checkpoint, replaying: false, hl: 8',
        historyLength: 8,
        isReplaying: false,
      },
    ]);
  });
}
