import { Context, CancellationError, cancel, sleep } from '@temporalio/workflow';
import { CancellableHTTPRequest } from '@interfaces';
import { cancellableFetch } from '@activities';

const fetch = Context.configure(cancellableFetch, {
  type: 'remote',
  startToCloseTimeout: '20s',
  heartbeatTimeout: '3s',
});

async function main(url: string, completeOnActivityCancellation = false): Promise<void> {
  const promise = fetch(url);
  // TODO: wait on signal from activity instead of sleeping
  await sleep(3000);
  cancel(promise);
  try {
    await promise;
  } catch (err) {
    if (err instanceof CancellationError) {
      if (!completeOnActivityCancellation) {
        // TODO: wait on signal from activity instead of sleeping
        await sleep(3000);
      }
    }
    throw err;
  }
}

export const workflow: CancellableHTTPRequest = { main };
