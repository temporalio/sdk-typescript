import test from 'ava';

import { NativeConnection } from '@temporalio/worker';

test.serial('NativeConnection.create() throws meaningful error when passed invalid address', async (t) => {
  await t.throwsAsync(NativeConnection.create({ address: ':invalid' }), {
    instanceOf: TypeError,
    message: 'Invalid serverOptions.address',
  });
});

test.serial('NativeConnection.create() throws meaningful error when passed invalid clientCertPair', async (t) => {
  await t.throwsAsync(NativeConnection.create({ tls: { clientCertPair: {} as any } }), {
    instanceOf: TypeError,
    message: 'Invalid or missing serverOptions.tls.clientCertPair.crt',
  });
});
