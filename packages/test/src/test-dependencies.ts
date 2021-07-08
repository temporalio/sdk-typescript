/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test from 'ava';
import { WorkflowInfo } from '@temporalio/workflow';
import { Worker, ApplyMode, DefaultLogger } from '@temporalio/worker';
import { IgnoredTestDependencies, TestDependencies } from './interfaces/dependencies';
import { defaultOptions } from './mock-native-worker';
import { WorkflowClient } from '@temporalio/client';
import { RUN_INTEGRATION_TESTS } from './helpers';

interface RecordedCall {
  info: WorkflowInfo;
  counter: number;
  fn: string;
}

if (RUN_INTEGRATION_TESTS) {
  test('Worker injects external dependencies', async (t) => {
    const recordedCalls: RecordedCall[] = [];
    const taskQueue = 'test-dependencies';

    const worker = await Worker.create<{ dependencies: TestDependencies }>({
      ...defaultOptions,
      taskQueue,
      logger: new DefaultLogger('DEBUG'),
      dependencies: {
        syncVoid: {
          promise: {
            async fn(info, counter) {
              recordedCalls.push({ info, counter, fn: 'syncVoid.promise' });
            },
            applyMode: ApplyMode.SYNC_PROMISE,
            arguments: 'copy',
          },
          ignoredAsyncImpl: {
            async fn(info, counter) {
              recordedCalls.push({ info, counter, fn: 'syncVoid.ignoredAsyncImpl' });
            },
            applyMode: ApplyMode.SYNC_IGNORED,
            arguments: 'copy',
          },
          sync: {
            fn(info, counter) {
              recordedCalls.push({ info, counter, fn: 'syncVoid.sync' });
            },
            applyMode: ApplyMode.SYNC,
            arguments: 'copy',
          },
          ignoredSyncImpl: {
            fn(info, counter) {
              recordedCalls.push({ info, counter, fn: 'syncVoid.ignoredSyncImpl' });
            },
            applyMode: ApplyMode.SYNC_IGNORED,
            arguments: 'copy',
          },
        },
        asyncIgnored: {
          syncImpl: {
            fn(info, counter) {
              recordedCalls.push({ info, counter, fn: 'asyncIgnored.syncImpl' });
            },
            applyMode: ApplyMode.ASYNC_IGNORED,
          },
          asyncImpl: {
            async fn(info, counter) {
              recordedCalls.push({ info, counter, fn: 'asyncIgnored.asyncImpl' });
            },
            applyMode: ApplyMode.ASYNC_IGNORED,
          },
        },
        sync: {
          syncImpl: {
            fn(info, counterRef) {
              const counter = counterRef.copySync();
              recordedCalls.push({ info, counter, fn: 'sync.syncImpl' });
              return counter + 1;
            },
            applyMode: ApplyMode.SYNC,
            arguments: 'reference',
          },
          asyncImpl: {
            async fn(info, counter) {
              recordedCalls.push({ info, counter, fn: 'sync.asyncImpl' });
              return counter + 1;
            },
            applyMode: ApplyMode.SYNC_PROMISE,
            arguments: 'copy',
          },
        },
        async: {
          syncImpl: {
            fn(info, counter) {
              recordedCalls.push({ info, counter, fn: 'async.syncImpl' });
              return counter + 1;
            },
            applyMode: ApplyMode.ASYNC,
          },
          asyncImpl: {
            async fn(info, counter) {
              recordedCalls.push({ info, counter, fn: 'async.asyncImpl' });
              return counter + 1;
            },
            applyMode: ApplyMode.ASYNC,
          },
        },
        error: {
          throwAsync: {
            async fn(info, counter) {
              recordedCalls.push({ info, counter, fn: 'error.throwAsync' });
              throw new Error(`${counter + 1}`);
            },
            applyMode: ApplyMode.ASYNC,
          },
          throwSync: {
            fn(info, counter) {
              recordedCalls.push({ info, counter, fn: 'error.throwSync' });
              throw new Error(`${counter + 1}`);
            },
            applyMode: ApplyMode.SYNC,
            arguments: 'copy',
          },
          throwSyncPromise: {
            async fn(info, counter) {
              recordedCalls.push({ info, counter, fn: 'error.throwSyncPromise' });
              throw new Error(`${counter + 1}`);
            },
            applyMode: ApplyMode.SYNC_PROMISE,
            arguments: 'copy',
          },
        },
      },
    });
    const p = worker.run();
    const conn = new WorkflowClient();
    const wf = conn.stub<{ main(): number }>('dependencies', { taskQueue });
    const runId = await wf.start();
    const result = await wf.result();
    worker.shutdown();
    await p;
    const info: WorkflowInfo = {
      namespace: 'default',
      taskQueue,
      workflowId: wf.workflowId,
      runId,
      filename: 'dependencies',
      isReplaying: false,
    };

    t.deepEqual(recordedCalls, [
      { info, fn: 'syncVoid.promise', counter: 0 },
      { info, fn: 'syncVoid.ignoredAsyncImpl', counter: 1 },
      { info, fn: 'syncVoid.sync', counter: 2 },
      { info, fn: 'syncVoid.ignoredSyncImpl', counter: 3 },
      { info, fn: 'sync.syncImpl', counter: 6 },
      { info, fn: 'sync.asyncImpl', counter: 7 },
      { info, fn: 'asyncIgnored.syncImpl', counter: 4 },
      { info, fn: 'asyncIgnored.asyncImpl', counter: 5 },
      { info, fn: 'async.syncImpl', counter: 8 },
      { info, fn: 'async.asyncImpl', counter: 9 },
      { info, fn: 'error.throwAsync', counter: 10 },
      { info, fn: 'error.throwSync', counter: 11 },
      { info, fn: 'error.throwSyncPromise', counter: 12 },
    ]);
    t.is(result, 13);
  });

  test('Worker wraps ignored dependencies and logs when they throw', async (t) => {
    const recordedCalls: any[] = [];
    const thrownErrors: Error[] = [];
    const taskQueue = 'test-ignored-dependencies';

    const worker = await Worker.create<{ dependencies: IgnoredTestDependencies }>({
      ...defaultOptions,
      taskQueue,
      logger: new DefaultLogger('DEBUG', (level, message, meta) => {
        if (message === 'External dependency function threw an error') recordedCalls.push({ level, message, meta });
      }),
      dependencies: {
        syncIgnored: {
          syncImpl: {
            fn() {
              const err = new Error('syncIgnored.syncImpl');
              thrownErrors.push(err);
              throw err;
            },
            applyMode: ApplyMode.SYNC_IGNORED,
            arguments: 'copy',
          },
          asyncImpl: {
            async fn() {
              const err = new Error('syncIgnored.asyncImpl');
              thrownErrors.push(err);
              throw err;
            },
            applyMode: ApplyMode.SYNC_IGNORED,
            arguments: 'copy',
          },
        },
        asyncIgnored: {
          syncImpl: {
            fn() {
              const err = new Error('asyncIgnored.syncImpl');
              thrownErrors.push(err);
              throw err;
            },
            applyMode: ApplyMode.ASYNC_IGNORED,
          },
          asyncImpl: {
            async fn() {
              const err = new Error('asyncIgnored.asyncImpl');
              thrownErrors.push(err);
              throw err;
            },
            applyMode: ApplyMode.ASYNC_IGNORED,
          },
        },
      },
    });
    const p = worker.run();
    const conn = new WorkflowClient();
    const wf = conn.stub<{ main(): number }>('ignored-dependencies', { taskQueue });
    const runId = await wf.start();
    const result = await wf.result();
    worker.shutdown();
    await p;

    const info: WorkflowInfo = {
      namespace: 'default',
      taskQueue,
      workflowId: wf.workflowId,
      runId,
      filename: 'ignored-dependencies',
      isReplaying: false,
    };

    t.deepEqual(
      thrownErrors.map((err) => err.message),
      ['syncIgnored.syncImpl', 'syncIgnored.asyncImpl', 'asyncIgnored.syncImpl', 'asyncIgnored.asyncImpl']
    );
    t.deepEqual(
      recordedCalls,
      thrownErrors.map((error) => ({
        level: 'ERROR',
        message: 'External dependency function threw an error',
        meta: {
          error,
          workflowInfo: info,
        },
      }))
    );
    t.is(result, 4);
  });

  test.todo('Dependency functions are called during replay if callDuringReplay is set');
}
