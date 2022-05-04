/**
 * Workflow used in integration-test:
 * 'Runtime does not issue cancellations for activities and timers that throw during validation'
 * @module
 */
import * as wf from '@temporalio/workflow';

const { someActivity } = wf.proxyActivities({
  startToCloseTimeout: '1 minute',
});

const { someLocalActivity } = wf.proxyLocalActivities({
  startToCloseTimeout: '1 minute',
});

/**
 * Cancel scopes for activities and timers that failed validation and result in
 * no command generated.
 *
 * Used to test that the SDK doesn't issue the cancellation command without
 * scheduling first.
 */
export async function cancelScopeOnFailedValidation(): Promise<void> {
  await wf.CancellationScope.cancellable(async () => {
    try {
      await someActivity(1n as any);
      throw new Error('Expected an error but none was thrown');
    } catch (err) {
      if (wf.isCancellation(err)) {
        throw err;
      } else {
        wf.CancellationScope.current().cancel();
      }
    }
  });
  await wf.CancellationScope.cancellable(async () => {
    try {
      await someLocalActivity(1n as any);
      throw new Error('Expected an error but none was thrown');
    } catch (err) {
      if (wf.isCancellation(err)) {
        throw err;
      } else {
        wf.CancellationScope.current().cancel();
      }
    }
  });
  await wf.CancellationScope.cancellable(async () => {
    try {
      await wf.sleep(NaN);
      throw new Error('Expected an error but none was thrown');
    } catch (err) {
      if (wf.isCancellation(err)) {
        throw err;
      } else {
        wf.CancellationScope.current().cancel();
      }
    }
  });
}
