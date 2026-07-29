import test from 'ava';
import type { Context } from '@temporalio/activity';
import { registerCancelShutdown } from '../worker/stateful-mcp-provider';

test('registerCancelShutdown: cancellation triggers dedicated-worker shutdown', async (t) => {
  let rejectCancelled!: (err: Error) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject;
  });
  const ctx = { cancelled } as unknown as Context;

  let shutdownCalls = 0;
  const dedicatedWorker = {
    shutdown: () => {
      shutdownCalls += 1;
    },
  };

  registerCancelShutdown(ctx, dedicatedWorker);

  t.is(shutdownCalls, 0);

  rejectCancelled(new Error('cancelled'));
  await new Promise((resolve) => setImmediate(resolve));

  t.is(shutdownCalls, 1);
});
