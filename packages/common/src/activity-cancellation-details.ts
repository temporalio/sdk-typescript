import type { coresdk } from '@temporalio/proto';

// ts-prune-ignore-next
export interface ActivityCancellationDetailsHolder {
  details?: ActivityCancellationDetails;
}

export interface ActivityCancellationDetailsOptions {
  notFound?: boolean;
  cancelRequested?: boolean;
  paused?: boolean;
  timedOut?: boolean;
  workerShutdown?: boolean;
  reset?: boolean;
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

  public constructor(options: ActivityCancellationDetailsOptions = {}) {
    this.notFound = options.notFound ?? false;
    this.cancelRequested = options.cancelRequested ?? false;
    this.paused = options.paused ?? false;
    this.timedOut = options.timedOut ?? false;
    this.workerShutdown = options.workerShutdown ?? false;
    this.reset = options.reset ?? false;
  }

  static fromProto(
    proto: coresdk.activity_task.IActivityCancellationDetails | null | undefined
  ): ActivityCancellationDetails {
    if (proto == null) {
      return new ActivityCancellationDetails();
    }
    return new ActivityCancellationDetails({
      notFound: proto.isNotFound ?? false,
      cancelRequested: proto.isCancelled ?? false,
      paused: proto.isPaused ?? false,
      timedOut: proto.isTimedOut ?? false,
      workerShutdown: proto.isWorkerShutdown ?? false,
      reset: proto.isReset ?? false,
    });
  }
}
