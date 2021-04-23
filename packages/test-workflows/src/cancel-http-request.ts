import { Context, CancellationError, cancel, sleep } from '@temporalio/workflow';
import { cancellableFetch } from '@activities';

const fetch = Context.configure(cancellableFetch, {
  type: 'remote',
  startToCloseTimeout: '20s',
  heartbeatTimeout: '3s',
});

export async function main(): Promise<void> {
  const promise = fetch();
  // TODO: wait on signal from activity instead of sleeping
  await sleep(3000);
  cancel(promise);
  try {
    await promise;
  } catch (err) {
    if (err instanceof CancellationError) {
      await sleep(3000);
    }
    throw err;
  }
}
