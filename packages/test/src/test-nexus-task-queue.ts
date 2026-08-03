import test from 'ava';
import { helpers } from './helpers-integration';

function testContext(
  deleteNexusEndpoint: () => Promise<void>,
  createNexusEndpoint: (name: string, taskQueue: string) => Promise<{ id: string; version: number }> = async () => ({
    id: 'endpoint-id',
    version: 1,
  })
): {
  context: Parameters<typeof helpers>[0];
  cleanup: () => Promise<void>;
} {
  let cleanup: (() => Promise<void>) | undefined;
  const context = {
    title: 'Nexus endpoint cleanup',
    context: {
      env: {
        createNexusEndpoint,
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

test('Nexus endpoints route to the helper worker task queue', async (t) => {
  let routedTaskQueue: string | undefined;
  const { context } = testContext(
    async () => undefined,
    async (_name, taskQueue) => {
      routedTaskQueue = taskQueue;
      return { id: 'endpoint-id', version: 1 };
    }
  );

  const helper = helpers(context);
  await helper.registerNexusEndpoint();
  t.is(routedTaskQueue, helper.taskQueue);
});
