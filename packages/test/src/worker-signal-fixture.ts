import assert from 'node:assert/strict';
import { Context } from '@temporalio/activity';
import type { NativeConnectionOptions } from '@temporalio/worker';
import { DefaultLogger, NativeConnection, Runtime, Worker } from '@temporalio/worker';

export interface SignalWorkerOptions {
  connectionOptions: NativeConnectionOptions;
  namespace?: string;
  taskQueue: string;
}

async function main({ connectionOptions, namespace, taskQueue }: SignalWorkerOptions): Promise<void> {
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const applicationListener = () => undefined;
  const listenerCounts = signals.map((signal) => {
    process.on(signal, applicationListener);
    return process.listenerCount(signal);
  });
  Runtime.install({
    logger: new DefaultLogger('INFO', (entry) => {
      if (entry.message === 'Worker state changed' && entry.meta?.state === 'STOPPING') {
        process.send!('stopping');
      }
    }),
  });
  const connection = await NativeConnection.connect(connectionOptions);
  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    shutdownGraceTime: '30s',
    shutdownForceTime: '45s',
    activities: {
      async waitForRelease() {
        try {
          const release = new Promise((resolve) => process.once('message', resolve));
          process.send!('activity-started');
          await release;
          assert.equal(Context.current().cancellationSignal.aborted, false);
          return 'completed';
        } finally {
          process.send!('activity-cleaned-up');
        }
      },
    },
  });
  const run = worker.run();
  process.send!('running');
  await run;
  assert.equal(worker.getState(), 'STOPPED');
  await connection.close();
  assert.equal(Runtime._instance, undefined);
  for (const [index, signal] of signals.entries()) {
    assert.equal(process.listenerCount(signal), listenerCounts[index]);
    assert.ok(process.listeners(signal).includes(applicationListener));
    process.off(signal, applicationListener);
  }
  process.send!('stopped');
  process.disconnect!();
}

process.once('message', (options: SignalWorkerOptions) => {
  main(options).catch((error) => {
    console.error(error);
    process.exit(1);
  });
});
