/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
/**
 * Demonstrates how to clean up after cancellation.
 * Used in the documentation site.
 */
// @@@SNIPSTART typescript-handle-external-workflow-cancellation-while-activity-running
import { CancellationScope, proxyActivities, isCancellation } from '@temporalio/workflow';
import type * as activities from '../activities';

const { httpPostJSON, cleanup } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10m',
});

export async function handleExternalWorkflowCancellationWhileActivityRunning(url: string, data: any): Promise<void> {
  try {
    await httpPostJSON(url, data);
  } catch (err) {
    if (isCancellation(err)) {
      console.log('Workflow cancelled');
      // Cleanup logic must be in a nonCancellable scope
      // If we'd run cleanup outside of a nonCancellable scope it would've been cancelled
      // before being started because the Workflow's root scope is cancelled.
      await CancellationScope.nonCancellable(() => cleanup(url));
    }
    throw err; // <-- Fail the Workflow
  }
}
// @@@SNIPEND
