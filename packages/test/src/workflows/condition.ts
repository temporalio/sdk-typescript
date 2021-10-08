/**
 * Tests the condition function resolves as eagerly as possible including during external dependency resolution.
 *
 * @module
 */
import {
  condition,
  sleep,
  dependencies,
  ExternalDependencies,
  CancellationScope,
  isCancellation,
} from '@temporalio/workflow';
import { Empty } from '../interfaces';

interface Deps extends ExternalDependencies {
  unblock: {
    me(): Promise<3>;
  };
}

const { unblock } = dependencies<Deps>();

export const conditionWaiter: Empty = () => ({
  async execute() {
    let x = 0;
    await Promise.all([
      sleep(1).then(() => (x = 1)),
      condition(() => x === 1).then(() => (x = 2)),
      condition(() => x === 2)
        .then(() => unblock.me())
        .then((v) => (x = v) /* v should be 3 */),
      condition(() => x === 3),
    ]);

    if (await condition('1s', () => x === 4)) {
      throw new Error('Condition returned true');
    }

    try {
      await CancellationScope.cancellable(async () => {
        const p = condition(() => x === 4);
        CancellationScope.current().cancel();
        await p;
      });
      throw new Error('CancellationScope did not throw');
    } catch (err) {
      if (!isCancellation(err)) {
        throw err;
      }
    }
  },
});
