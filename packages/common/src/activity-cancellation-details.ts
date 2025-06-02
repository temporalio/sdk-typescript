import type { coresdk } from '@temporalio/proto';

export interface ActivityCancellationDetailsHolder {
  details?: ActivityCancellationDetails;
}

/**
 * Provides the reasons for the activity's cancellation. Cancellation details are set once and do not change once set.
 */
export class ActivityCancellationDetails {
  readonly notFound: boolean;
  readonly cancelRequested: boolean;
  readonly paused: boolean;
  readonly timedOut: boolean;
  readonly workerShutdown: boolean;
  readonly reset: boolean;

  private constructor(
    notFound: boolean = false,
    cancelRequested: boolean = false,
    paused: boolean = false,
    timedOut: boolean = false,
    workerShutdown: boolean = false,
    reset: boolean = false
  ) {
    this.notFound = notFound;
    this.cancelRequested = cancelRequested;
    this.paused = paused;
    this.timedOut = timedOut;
    this.workerShutdown = workerShutdown;
    this.reset = reset;
  }

  static fromProto(
    proto: coresdk.activity_task.IActivityCancellationDetails | null | undefined
  ): ActivityCancellationDetails {
    if (proto == null) {
      return new ActivityCancellationDetails();
    }
    return new ActivityCancellationDetails(
      proto.isNotFound ?? false,
      proto.isCancelled ?? false,
      proto.isPaused ?? false,
      proto.isTimedOut ?? false,
      proto.isWorkerShutdown ?? false,
      proto.isReset ?? false
    );
  }
}
