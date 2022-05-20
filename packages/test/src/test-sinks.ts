/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import { WorkflowClient } from '@temporalio/client';
import { DefaultLogger, InjectedSinks, Runtime, Worker } from '@temporalio/worker';
import { WorkflowInfo } from '@temporalio/workflow';
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { defaultOptions } from './mock-native-worker';
import * as workflows from './workflows';

interface RecordedCall {
  info: WorkflowInfo;
  counter: number;
  fn: string;
}

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

  test('Worker injects sinks', async (t) => {
    const recordedCalls: RecordedCall[] = [];
    const taskQueue = 'test-sinks';
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
    const p = worker.run();
    const conn = new WorkflowClient();
    const wf = await conn.start(workflows.sinksWorkflow, { taskQueue, workflowId: uuid4() });
    await wf.result();
    worker.shutdown();
    await p;
    const info: WorkflowInfo = {
      more: { namespace: 'default', firstExecutionRunId: wf.originalRunId, attempt: 1 },
      taskQueue,
      workflowId: wf.workflowId,
      runId: wf.originalRunId,
      type: 'sinksWorkflow',
      unsafe: { isReplaying: false },
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

  test.todo('Sink functions are called during replay if callDuringReplay is set');
}
