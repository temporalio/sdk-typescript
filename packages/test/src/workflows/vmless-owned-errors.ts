import {
  ApplicationFailure,
  CancellationScope,
  condition,
  defineSignal,
  defineUpdate,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow';
import { getActivator } from '@temporalio/workflow/internal';

export async function completionConversionFailure(): Promise<string> {
  return 'fail-payload';
}

export async function emptyRejectionFailure(): Promise<string> {
  return 'fail-payload-undefined';
}

export async function failureConversionFailure(): Promise<void> {
  throw ApplicationFailure.nonRetryable('convert-failure:workflow');
}

/** Inject a failure in the SDK's final bookkeeping, after removing the entry. */
function failCleanup(map: Map<unknown, unknown>, message: string): void {
  const original = map.delete;
  map.delete = function (key) {
    original.call(this, key);
    map.delete = original;
    throw new Error(message);
  };
}

export async function ownedHandlerErrors(): Promise<void> {
  setHandler(defineSignal<[string]>('fail'), async (mode) => {
    await Promise.resolve();
    if (mode === 'cleanup') {
      failCleanup(getActivator().inProgressSignals, 'signal cleanup failed');
      return;
    }
    if (mode === 'plain') throw new Error('signal handler failed');
    if (mode === 'application') throw ApplicationFailure.nonRetryable('signal application failure');
    throw ApplicationFailure.nonRetryable(`convert-failure:${mode}`);
  });
  setHandler(
    defineUpdate<string, [string]>('change'),
    async (mode) => {
      await Promise.resolve();
      if (mode === 'cleanup') {
        failCleanup(getActivator().inProgressUpdates, 'update cleanup failed');
        return 'done';
      }
      if (mode === 'complete') return 'fail-payload';
      if (mode === 'plain') throw new Error('update handler failed');
      if (mode === 'reject') throw ApplicationFailure.nonRetryable('update rejected');
      throw ApplicationFailure.nonRetryable(`convert-failure:${mode}`);
    },
    {
      validator(mode) {
        if (mode === 'validate') throw ApplicationFailure.nonRetryable('convert-failure:validate');
        if (mode === 'reject-validation') throw new Error('validation rejected');
      },
    }
  );
  await condition(() => false);
}

export async function caughtActivityFailure(): Promise<string> {
  const { echo } = proxyActivities<{ echo(value: string): Promise<string> }>({ startToCloseTimeout: '10s' });
  try {
    return await echo('test');
  } catch {
    return 'recovered';
  }
}

export async function caughtCancellation(): Promise<string> {
  const scope = new CancellationScope();
  const work = scope.run(() => sleep(1));
  scope.cancel();
  try {
    await work;
    throw new Error('Expected cancellation');
  } catch (error) {
    if (!isCancellation(error)) throw error;
    return 'cancelled';
  }
}
