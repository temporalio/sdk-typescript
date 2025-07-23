import { ActivityCancellationDetails } from '@temporalio/common';
import * as activity from '@temporalio/activity';

export async function heartbeatCancellationDetailsActivity(
  catchErr: boolean
): Promise<ActivityCancellationDetails | undefined> {
  // Exit early if we've already run this activity.
  if (activity.activityInfo().heartbeatDetails === 'finally-complete') {
    return activity.cancellationDetails();
  }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      activity.heartbeat();
      await activity.sleep(300);
    } catch (err) {
      if (err instanceof activity.CancelledFailure && catchErr) {
        return activity.cancellationDetails();
      }
      activity.heartbeat('finally-complete');
      throw err;
    }
  }
}
