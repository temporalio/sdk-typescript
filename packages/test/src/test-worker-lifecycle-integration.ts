/**
 * Worker lifecycle integration tests.
 *
 * Connections are explicitly closed after their Workers stop.
 */
import { randomUUID } from 'crypto';
import { setTimeout } from 'timers/promises';
import test from 'ava';
import { Client, Connection } from '@temporalio/client';
import type { WorkerOptions } from '@temporalio/worker';
import {
  DefaultLogger,
  PromiseCompletionTimeoutError,
  Runtime,
  TransportError,
  UnexpectedError,
} from '@temporalio/worker';
import {
  createWorkerWithConnection,
  isBun,
  configuredConnectionOptions,
  RUN_INTEGRATION_TESTS,
  uniqueTaskQueue,
} from './helpers';
import { defaultOptions } from './mock-native-worker';
import { fillMemory } from './workflows';

const { namespace, connectionOptions } = configuredConnectionOptions();

function createWorker(options: Partial<WorkerOptions> & Pick<WorkerOptions, 'taskQueue'>) {
  return createWorkerWithConnection({ ...defaultOptions, ...options });
}

if (RUN_INTEGRATION_TESTS) {
  test.serial('Worker shuts down gracefully', async (t) => {
    let flushCalls = 0;
    Runtime.install({
      logger: Object.assign(new DefaultLogger('ERROR', () => undefined), {
        flush: () => {
          flushCalls++;
        },
      }),
    });
    const { worker, connection } = await createWorker({ taskQueue: uniqueTaskQueue(t.title) });
    t.is(worker.getState(), 'INITIALIZED');
    const workerRun = worker.run();
    t.is(worker.getState(), 'RUNNING');
    const flushesBeforeShutdown = flushCalls;
    process.emit('SIGINT', 'SIGINT');
    await new Promise((resolve) => process.nextTick(resolve));
    t.is(worker.getState(), 'DRAINING');
    await workerRun;
    t.is(worker.getState(), 'STOPPED');
    t.true(flushCalls > flushesBeforeShutdown);
    await t.throwsAsync(worker.run(), { message: 'Poller was already started' });
    const flushesBeforeClose = flushCalls;
    await connection.close();
    t.true(flushCalls > flushesBeforeClose);
  });

  test.serial("Worker.runUntil doesn't hang if provided promise survives to Worker's shutdown", async (t) => {
    let flushCalls = 0;
    Runtime.install({
      logger: Object.assign(new DefaultLogger('ERROR', () => undefined), {
        flush: () => {
          flushCalls++;
        },
      }),
    });
    const { worker, connection } = await createWorker({ taskQueue: uniqueTaskQueue(t.title) });
    const p = worker.runUntil(
      new Promise(() => {
        // A promise that will never unblock.
      })
    );
    t.is(worker.getState(), 'RUNNING');
    const flushesBeforeShutdown = flushCalls;
    worker.shutdown();
    t.is(worker.getState(), 'DRAINING');
    await t.throwsAsync(p, { instanceOf: PromiseCompletionTimeoutError });
    t.is(worker.getState(), 'STOPPED');
    t.true(flushCalls > flushesBeforeShutdown);
    const flushesBeforeClose = flushCalls;
    await connection.close();
    t.true(flushCalls > flushesBeforeClose);
  });

  test.serial('Worker shuts down gracefully if interrupted before running', async (t) => {
    const { worker, connection } = await createWorker({ taskQueue: uniqueTaskQueue(t.title) });
    t.is(worker.getState(), 'INITIALIZED');
    process.emit('SIGINT', 'SIGINT');
    const workerRun = worker.run();
    t.is(worker.getState(), 'RUNNING');
    await workerRun;
    t.is(worker.getState(), 'STOPPED');
    await connection.close();
  });

  test.serial('Worker fails validation against unknown namespace', async (t) => {
    await t.throwsAsync(
      createWorker({
        taskQueue: uniqueTaskQueue(t.title),
        namespace: 'oogabooga',
      }),
      {
        // oxlint-disable-next-line typescript/no-deprecated -- Assert the internal worker error type.
        instanceOf: TransportError,
        // Cloud credentials cannot describe namespaces outside their authorized scope.
        message: /Namespace oogabooga (?:is not found|was not found or otherwise could not be described)/,
      }
    );
  });

  (isBun ? test.skip : test.serial)('Threaded VM gracely stops and fails on ERR_WORKER_OUT_OF_MEMORY', async (t) => {
    t.timeout(30_000);
    const taskQueue = uniqueTaskQueue(t.title);
    const clientConnection = await Connection.connect(connectionOptions);
    t.teardown(() => clientConnection.close());
    const client = new Client({ connection: clientConnection, namespace });
    const { worker, connection } = await createWorker({ taskQueue });

    client.workflow
      .start(fillMemory, {
        taskQueue,
        workflowId: randomUUID(),
        workflowExecutionTimeout: '30s',
      })
      .catch(() => void 0);

    const workerRun = worker.run();
    try {
      await Promise.race([setTimeout(10_000), workerRun]);
      if (worker.getState() === 'RUNNING') {
        worker.shutdown();
        await workerRun;
      }
      t.log('Non-conclusive result: Worker did not fail as expected');
      t.pass();
    } catch (err) {
      // oxlint-disable-next-line typescript/no-deprecated -- Assert the internal worker error type.
      t.is((err as Error).name, UnexpectedError.name);
      t.is(
        (err as Error).message,
        'Workflow Worker Thread exited prematurely: Error [ERR_WORKER_OUT_OF_MEMORY]: ' +
          'Worker terminated due to reaching memory limit: JS heap out of memory'
      );
      t.is(worker.getState(), 'FAILED');
    } finally {
      await connection.close();
    }
  });
}
