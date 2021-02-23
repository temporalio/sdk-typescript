import { CancellationError, cancellationScope, cancel, sleep } from '@temporal-sdk/workflow';

function sleepAndLogCancellation(cancellationExpected: boolean) {
  return async () => {
    try {
      await sleep(3);
    } catch (e) {
      // We still want to know the workflow was cancelled
      if (e instanceof CancellationError) {
        console.log(`Scope cancelled ${cancellationExpected ? '👍' : '👎' }`);
      }
      throw e;
    }
  }
}

export async function main() {
  // First without cancellation
  await cancellationScope(sleepAndLogCancellation(false));

  // Test cancellation from workflow
  const scope1 = cancellationScope(sleepAndLogCancellation(true));
  const scope2 = cancellationScope(sleepAndLogCancellation(false));
  cancel(scope1);
  try {
    await scope1;
    console.log('Exception was not propagated 👎');
  } catch (e) {
    if (e instanceof CancellationError) {
      console.log('Exception was propagated 👍');
    }
  }
  await scope2;
  console.log('Scope 2 was not cancelled 👍');

  // Test workflow cancellation propagates
  try {
    await cancellationScope(sleepAndLogCancellation(true));
    console.log('Exception was not propagated 👎');
  } catch (e) {
    if (e instanceof CancellationError) {
      console.log('Exception was propagated 👍');
    }
  }

}
