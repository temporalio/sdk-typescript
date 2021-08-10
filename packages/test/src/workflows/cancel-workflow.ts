import { ActivityFailure, CancellationScope, CancelledFailure } from '@temporalio/workflow';
import { httpGet } from '@activities';

export async function main(url: string): Promise<string> {
  // By default timers and activities are automatically cancelled when the workflow is cancelled
  // and will throw the original CancelledFailure
  try {
    return await httpGet(url);
  } catch (e) {
    if (!(e instanceof ActivityFailure && e.cause instanceof CancelledFailure)) {
      throw e;
    }
    try {
      // Activity throws because Workflow has been cancelled
      return await httpGet(url);
    } catch (e) {
      if (!(e instanceof CancelledFailure)) {
        throw e;
      }
      // Activity is allowed to complete because it's in a non cancellable scope
      return await CancellationScope.nonCancellable(async () => httpGet(url));
    }
  }
}
