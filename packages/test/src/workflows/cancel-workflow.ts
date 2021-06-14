import { CancellationScope, CancelledError } from '@temporalio/workflow';
import { httpGet } from '@activities';

export async function main(url: string): Promise<string> {
  // By default timers and activities are automatically cancelled when the workflow is cancelled
  // and will throw the original CancelledError
  try {
    return await httpGet(url);
  } catch (e) {
    if (!(e instanceof CancelledError)) {
      throw e;
    }
    try {
      // Activity throws because Workflow has been cancelled
      return await httpGet(url);
    } catch (e) {
      if (!(e instanceof CancelledError)) {
        throw e;
      }
      // Activity is allowed to complete because it's in a non cancellable scope
      return await CancellationScope.nonCancellable(async () => httpGet(url));
    }
  }
}
