import { status as grpcStatus } from '@grpc/grpc-js';
import test from 'ava';
import { helpers } from './helpers-integration';

function testContext(deleteNexusEndpoint: () => Promise<void>): {
  context: Parameters<typeof helpers>[0];
  cleanup: () => Promise<void>;
} {
  let cleanup: (() => Promise<void>) | undefined;
  const context = {
    title: 'Nexus endpoint cleanup',
    context: {
      env: {
        createNexusEndpoint: async () => ({ id: 'endpoint-id', version: 1 }),
        deleteNexusEndpoint,
      },
      workflowBundle: {},
    },
    teardown(fn: () => Promise<void>) {
      cleanup = fn;
    },
  } as any;
  return {
    context,
    cleanup: async () => await cleanup!(),
  };
}

test('Nexus endpoint cleanup surfaces deletion failures', async (t) => {
  const failure = new Error('permission denied');
  const { context, cleanup } = testContext(async () => {
    throw failure;
  });

  await helpers(context).registerNexusEndpoint();
  t.is(await t.throwsAsync(cleanup()), failure);
});

test('Nexus endpoint cleanup tolerates an already-deleted endpoint', async (t) => {
  const notFound = Object.assign(new Error('endpoint not found'), {
    code: grpcStatus.NOT_FOUND,
    details: 'endpoint not found',
    metadata: {},
  });
  const { context, cleanup } = testContext(async () => {
    throw notFound;
  });

  await helpers(context).registerNexusEndpoint();
  await t.notThrowsAsync(cleanup());
});
