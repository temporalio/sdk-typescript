/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
// @@@SNIPSTART nodejs-handle-external-workflow-cancellation-while-activity-running
import { CancelledError, CancellationScope } from '@temporalio/workflow';
import { httpPostJSON, cleanup } from '@activities';

export async function main(url: string, data: any): Promise<void> {
  try {
    await httpPostJSON(url, data);
  } catch (err) {
    if (err instanceof CancelledError) {
      console.log('Workflow cancelled');
      // Cleanup logic goes in a nonCancellable scope
      // If we'd run cleanup outside of a nonCancellable scope it would've been cancelled
      // before being started because the Workflow's root scope is cancelled.
      await CancellationScope.nonCancellable(() => cleanup(url));
    }
    throw err; // <-- Fail the Workflow
  }
}
// @@@SNIPEND
