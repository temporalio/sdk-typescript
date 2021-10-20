/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test from 'ava';
import { WorkflowInfo } from '@temporalio/workflow';
import { WorkflowClient } from '@temporalio/client';
import { Worker, DefaultLogger, Core, InjectedDependencies } from '@temporalio/worker';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS } from './helpers';
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
  test.before(async (_) => {
    await Core.install({
      logger: new DefaultLogger('DEBUG', ({ level, message, meta }) => {
        if (message === 'External dependency function threw an error') recordedLogs.push({ level, message, meta });
      }),
    });
  });

  test('Worker injects external dependencies', async (t) => {
    const recordedCalls: RecordedCall[] = [];
    const taskQueue = 'test-dependencies';
    const thrownErrors = Array<DependencyError>();
    const dependencies: InjectedDependencies<workflows.TestDependencies> = {
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
      dependencies,
    });
    const p = worker.run();
    const conn = new WorkflowClient();
    const wf = conn.createWorkflowHandle(workflows.dependenciesWorkflow, { taskQueue });
    const runId = await wf.start();
    await wf.result();
    worker.shutdown();
    await p;
    const info: WorkflowInfo = {
      namespace: 'default',
      taskQueue,
      workflowId: wf.workflowId,
      runId,
      workflowType: 'dependenciesWorkflow',
      isReplaying: false,
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
        message: 'External dependency function threw an error',
        meta: {
          error,
          ifaceName: error.ifaceName,
          fnName: error.fnName,
          workflowInfo: info,
        },
      }))
    );
  });

  test.todo('Dependency functions are called during replay if callDuringReplay is set');
}
