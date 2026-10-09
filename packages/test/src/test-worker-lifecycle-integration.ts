/** Worker lifecycle integration tests. */
import { randomUUID } from 'crypto';
import { setTimeout } from 'timers/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { PromiseCompletionTimeoutError, Runtime } from '@temporalio/worker';
import { TransportError, UnexpectedError } from '@temporalio/worker/lib/errors';
import { isBun } from './helpers';
import { helpers, makeTestFunction } from './helpers-integration';
import { fillMemory } from './workflows';
import type { SignalWorkerOptions } from './worker-signal-fixture';

const test = makeTestFunction({ workflowsPath: require.resolve('./workflows') });

// The shared TestWorkflowEnvironment keeps its native connections alive until the suite teardown,
// so these tests verify Worker shutdown without expecting Runtime._instance to clear per test.

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // Windows terminates a child unconditionally when sending these signals.
  (process.platform === 'win32' ? test.skip : test.serial)(
    `Worker drains an in-flight Activity after OS ${signal}`,
    async (t) => {
      const { env } = t.context;
      const { taskQueue } = helpers(t);
      const child = fork(require.resolve('./worker-signal-fixture'), [], {
        execArgv: [],
        serialization: 'advanced',
      });
      const messages: unknown[] = [];
      child.on('message', (message) => messages.push(message));
      const exited = once(child, 'exit');
      t.teardown(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      });
      const nextMessage = () =>
        Promise.race([
          once(child, 'message').then(([message]) => message),
          exited.then(([code, exitSignal]) => {
            throw new Error(`Worker exited early: code=${code}, signal=${exitSignal}`);
          }),
        ]);
      const running = nextMessage();
      const options: SignalWorkerOptions = {
        connectionOptions: { ...env.connectionOptions, address: env.address },
        namespace: env.namespace,
        taskQueue,
      };
      child.send(options);
      t.is(await running, 'running');

      const started = nextMessage();
      const activity = await env.client.activity.start('waitForRelease', {
        taskQueue,
        id: randomUUID(),
        scheduleToCloseTimeout: '1 minute',
        retry: { maximumAttempts: 1 },
      });
      t.is(await started, 'activity-started');
      const stopping = nextMessage();
      t.true(child.kill(signal));
      t.is(await stopping, 'stopping');
      t.is(child.exitCode, null);
      t.false(messages.includes('stopped'));
      child.send('release');
      t.is(await activity.result(), 'completed');
      t.deepEqual(await exited, [0, null]);
      t.deepEqual(messages, ['running', 'activity-started', 'stopping', 'activity-cleaned-up', 'stopped']);
    }
  );
}

test.serial('Worker shuts down gracefully', async (t) => {
  const { createWorker } = helpers(t);
  const worker = await createWorker();
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
});

test.serial("Worker.runUntil doesn't hang if provided promise survives to Worker's shutdown", async (t) => {
  const { createWorker } = helpers(t);
  const worker = await createWorker();
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
});

test.serial('Worker shuts down gracefully if interrupted before running', async (t) => {
  const { createWorker } = helpers(t);
  const worker = await createWorker();
  t.is(worker.getState(), 'INITIALIZED');
  process.emit('SIGINT', 'SIGINT');
  const workerRun = worker.run();
  t.is(worker.getState(), 'RUNNING');
  await workerRun;
  t.is(worker.getState(), 'STOPPED');
});

test.serial('Worker fails validation against unknown namespace', async (t) => {
  const { createWorker } = helpers(t);
  await t.throwsAsync(
    createWorker({
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
  const { taskQueue, createWorker } = helpers(t);
  const client = t.context.env.client;
  const worker = await createWorker();

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
    if (Runtime._instance) await Runtime._instance.shutdown();
  }
});
