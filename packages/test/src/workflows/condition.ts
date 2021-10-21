/**
 * Tests the condition function resolves as eagerly as possible including during external dependency resolution.
 *
 * @module
 */
import { condition, sleep, CancellationScope, isCancellation } from '@temporalio/workflow';

export async function conditionWaiter(): Promise<void> {
  let x = 0;
  await Promise.all([
    sleep(1).then(() => (x = 1)),
    condition(() => x === 1).then(() => (x = 2)),
    condition(() => x === 2),
  ]);

  if (await condition('1s', () => x === 3)) {
    throw new Error('Condition returned true');
  }

  try {
    await CancellationScope.cancellable(async () => {
      const p = condition(() => x === 3);
      CancellationScope.current().cancel();
      await p;
    });
    throw new Error('CancellationScope did not throw');
  } catch (err) {
    if (!isCancellation(err)) {
      throw err;
    }
  }
}
