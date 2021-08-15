import { CancelledFailure, CancellationScope, sleep } from '@temporalio/workflow';

function sleepAndLogCancellation(cancellationExpected: boolean) {
  return async () => {
    try {
      await sleep(3);
    } catch (e) {
      // We still want to know the workflow was cancelled
      if (e instanceof CancelledFailure) {
        console.log(`Scope cancelled ${cancellationExpected ? '👍' : '👎'}`);
      }
      throw e;
    }
  };
}

export async function main(): Promise<void> {
  // First without cancellation
  await CancellationScope.cancellable(sleepAndLogCancellation(false));

  // Test cancellation from workflow
  const scope1 = new CancellationScope();
  const p1 = scope1.run(sleepAndLogCancellation(true));
  const scope2 = new CancellationScope();
  const p2 = scope2.run(sleepAndLogCancellation(false));
  scope1.cancel();
  try {
    await p1;
    console.log('Exception was not propagated 👎');
  } catch (e) {
    if (e instanceof CancelledFailure) {
      console.log('Exception was propagated 👍');
    }
  }
  await p2;
  console.log('Scope 2 was not cancelled 👍');

  // Test workflow cancellation propagates
  try {
    await CancellationScope.cancellable(sleepAndLogCancellation(true));
    console.log('Exception was not propagated 👎');
  } catch (e) {
    if (e instanceof CancelledFailure) {
      console.log('Exception was propagated 👍');
    }
  }
}
