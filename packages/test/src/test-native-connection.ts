import test from 'ava';

import { IllegalStateError, NativeConnection, Worker } from '@temporalio/worker';
import { RUN_INTEGRATION_TESTS } from './helpers';

test('NativeConnection.connect() throws meaningful error when passed invalid address', async (t) => {
  await t.throwsAsync(NativeConnection.connect({ address: ':invalid' }), {
    instanceOf: TypeError,
    message: 'Invalid serverOptions.address',
  });
});

test('NativeConnection.connect() throws meaningful error when passed invalid clientCertPair', async (t) => {
  await t.throwsAsync(NativeConnection.connect({ tls: { clientCertPair: {} as any } }), {
    instanceOf: TypeError,
    message: 'Invalid or missing serverOptions.tls.clientCertPair.crt',
  });
});

if (RUN_INTEGRATION_TESTS) {
  test('NativeConnection.close() throws when called a second time', async (t) => {
    const conn = await NativeConnection.connect();
    await conn.close();
    await t.throwsAsync(() => conn.close(), {
      instanceOf: IllegalStateError,
      message: 'Client already closed',
    });
  });

  test('NativeConnection.close() throws if being used by a Worker and succeeds if it has been shutdown', async (t) => {
    const connection = await NativeConnection.connect();
    const worker = await Worker.create({
      connection,
      taskQueue: 'default',
      activities: {
        async noop() {
          // empty placeholder
        },
      },
    });
    try {
      await t.throwsAsync(() => connection.close(), {
        instanceOf: IllegalStateError,
        message: 'Cannot close connection while Workers hold a reference to it',
      });
    } finally {
      const p = worker.run();
      worker.shutdown();
      await p;
      await connection.close();
    }
  });
}
