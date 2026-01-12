import { condition } from '@temporalio/workflow';

/**
 * Workflow for reproducing the GH #1866
 *
 * When the bug is present:
 * 1. First condition times out
 * 2. finally block calls CancellationScope.current().cancel()
 * 3. With disabled storage, current() returns rootScope
 * 4. rootScope.cancel() is called, failing the workflow with "Workflow cancelled"
 *
 * Actual failure happens on the second `condition` where when creating the new
 * cancellation scope, we see that the parent/root scope is already cancelled.
 */
export async function conditionWithTimeoutAfterDisposal(): Promise<string> {
  const alwaysFalse = false;
  await condition(() => alwaysFalse, '500ms');
  await condition(() => alwaysFalse, '500ms');
  return 'done';
}
