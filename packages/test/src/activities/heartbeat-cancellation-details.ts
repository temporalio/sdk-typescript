import { ActivityCancellationDetails } from '@temporalio/common';
import * as activity from '@temporalio/activity';

export interface ActivityState {
  pause?: boolean;
  unpause?: boolean;
  reset?: boolean;
  shouldRetry?: boolean;
}

export async function heartbeatCancellationDetailsActivity(
  state: ActivityState
): Promise<ActivityCancellationDetails | undefined> {
  const info = activity.activityInfo();
  // Exit early if we've already run this activity.
  if (info.attempt > 1) {
    return activity.cancellationDetails();
  }

  // Otherwise, either pause or reset this activity (or both).
  const client = activity.getClient();
  const req = {
    namespace: client.options.namespace,
    execution: {
      workflowId: info.workflowExecution.workflowId,
      runId: info.workflowExecution.runId,
    },
    id: info.activityId,
  };
  // Pause AND reset the activity.
  if (state.pause && state.reset) {
    await Promise.all([client.workflowService.pauseActivity(req), client.workflowService.resetActivity(req)]);
    // Just pause.
  } else if (state.pause) {
    await client.workflowService.pauseActivity(req);
    // Just reset.
  } else if (state.reset) {
    await client.workflowService.resetActivity(req);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // Heartbeat to propagate cancellation signals from pause/reset.
      activity.heartbeat();
      await activity.sleep(300);
    } catch (err) {
      // If we encountered an unexpected, non-cancellation failure,
      // throw a non-retryable error to fail the activity.
      if (!(err instanceof activity.CancelledFailure)) {
        throw activity.ApplicationFailure.nonRetryable('Unexpected failure', 'Error', err);
      }
      // If we don't want the activity to retry, return the cancellation details immediately.
      if (!state.shouldRetry) {
        return activity.cancellationDetails();
      }
      // Unpause if requested (a paused activity with not retry).
      if (state.unpause) {
        await client.workflowService.unpauseActivity(req);
      }
      // Re-throw the cancellation to retry the activity
      throw err;
    }
  }
}
