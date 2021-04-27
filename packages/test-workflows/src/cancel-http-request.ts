import { Context, CancellationError, cancel, sleep } from '@temporalio/workflow';
import { CancellableHTTPRequest } from '@interfaces';
import { cancellableFetch } from '@activities';
import { ResolvablePromise } from './resolvable-promise';

const fetch = Context.configure(cancellableFetch, {
  type: 'remote',
  startToCloseTimeout: '20s',
  heartbeatTimeout: '3s',
});

const activityStarted = new ResolvablePromise<void>();
const activityCancelled = new ResolvablePromise<void>();

const signals = {
  activityStarted() {
    activityStarted.resolve(undefined);
  },
  activityCancelled() {
    activityCancelled.resolve(undefined);
  },
};

async function main(url: string, waitForActivityCancelled: boolean): Promise<void> {
  const promise = fetch(url, true);
  await activityStarted;
  cancel(promise);
  try {
    await promise;
  } catch (err) {
    if (err instanceof CancellationError) {
      if (waitForActivityCancelled) {
        await Promise.race([
          activityCancelled,
          (async () => {
            await sleep(10000);
            throw new Error('Confirmation of activity cancellation never arrived');
          })(),
        ]);
      }
    }
    throw err;
  }
}

export const workflow: CancellableHTTPRequest = { main, signals };
