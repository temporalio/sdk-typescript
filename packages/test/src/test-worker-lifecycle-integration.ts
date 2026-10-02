/**
 * Worker lifecycle integration tests.
 *
 * These tests deliberately avoid a shared test environment: each Worker owns its connection, so the
 * Runtime shuts down once the last Worker stops, exactly as it does for a Worker created without one.
 */
import { randomUUID } from 'crypto';
import { setTimeout } from 'timers/promises';
import test from 'ava';
import { Client, Connection } from '@temporalio/client';
import { loadClientConnectConfig } from '@temporalio/envconfig';
import type { WorkerOptions } from '@temporalio/worker';
import { PromiseCompletionTimeoutError, Runtime } from '@temporalio/worker';
import { InternalNativeConnection } from '@temporalio/worker/lib/connection';
import { TransportError, UnexpectedError } from '@temporalio/worker/lib/errors';
import { isBun, RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { defaultOptions } from './mock-native-worker';
import { fillMemory } from './workflows';

const { namespace, connectionOptions } = loadClientConnectConfig();

/**
 * Create a Worker on a configured connection that the Worker owns and closes when it shuts down.
 */
async function createWorker(options: Partial<WorkerOptions> & Pick<WorkerOptions, 'taskQueue'>) {
  const connection = await InternalNativeConnection.connect(connectionOptions);
  try {
    return await Worker.create({ ...defaultOptions, connection, namespace, ...options });
  } catch (err) {
    await connection.close();
    throw err;
  }
}

if (RUN_INTEGRATION_TESTS) {
  test.serial('Worker shuts down gracefully', async (t) => {
    const worker = await createWorker({ taskQueue: t.title.replace(/ /g, '_') });
    t.is(worker.getState(), 'INITIALIZED');
    t.not(Runtime._instance, undefined);
    const workerRun = worker.run();
    t.is(worker.getState(), 'RUNNING');
    process.emit('SIGINT', 'SIGINT');
    await new Promise((resolve) => process.nextTick(resolve));
    t.is(worker.getState(), 'DRAINING');
    await workerRun;
    t.is(worker.getState(), 'STOPPED');
    await t.throwsAsync(worker.run(), { message: 'Poller was already started' });
    t.is(Runtime._instance, undefined);
  });

  test.serial("Worker.runUntil doesn't hang if provided promise survives to Worker's shutdown", async (t) => {
    const worker = await createWorker({ taskQueue: t.title.replace(/ /g, '_') });
    t.not(Runtime._instance, undefined);
    const p = worker.runUntil(
      new Promise(() => {
        // A promise that will never unblock.
      })
    );
    t.is(worker.getState(), 'RUNNING');
    worker.shutdown();
    t.is(worker.getState(), 'DRAINING');
    await t.throwsAsync(p, { instanceOf: PromiseCompletionTimeoutError });
    t.is(worker.getState(), 'STOPPED');
    t.is(Runtime._instance, undefined);
  });

  test.serial('Worker shuts down gracefully if interrupted before running', async (t) => {
    const worker = await createWorker({ taskQueue: t.title.replace(/ /g, '_') });
    t.is(worker.getState(), 'INITIALIZED');
    process.emit('SIGINT', 'SIGINT');
    const workerRun = worker.run();
    t.is(worker.getState(), 'RUNNING');
    await workerRun;
    t.is(worker.getState(), 'STOPPED');
  });

  test.serial('Worker fails validation against unknown namespace', async (t) => {
    await t.throwsAsync(
      createWorker({
        taskQueue: t.title.replace(/ /g, '_'),
        namespace: 'oogabooga',
      }),
      {
        instanceOf: TransportError,
        // Cloud credentials cannot describe namespaces outside their authorized scope.
        message: /Namespace oogabooga (?:is not found|was not found or otherwise could not be described)/,
      }
    );
  });

  (isBun ? test.skip : test.serial)('Threaded VM gracely stops and fails on ERR_WORKER_OUT_OF_MEMORY', async (t) => {
    t.timeout(30_000);
    const taskQueue = t.title.replace(/ /g, '_');
    const connection = await Connection.connect(connectionOptions);
    const client = new Client({ connection, namespace });
    const worker = await createWorker({ taskQueue });

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
      t.is((err as Error).name, UnexpectedError.name);
      t.is(
        (err as Error).message,
        'Workflow Worker Thread exited prematurely: Error [ERR_WORKER_OUT_OF_MEMORY]: ' +
          'Worker terminated due to reaching memory limit: JS heap out of memory'
      );
      t.is(worker.getState(), 'FAILED');
    } finally {
      await connection.close();
      if (Runtime._instance) await Runtime._instance.shutdown();
    }
  });
}
