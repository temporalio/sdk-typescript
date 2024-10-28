import {
  FixedSizeSlotSupplier,
  ResourceBasedTunerOptions,
  WorkerTuner as NativeWorkerTuner,
  SlotSupplier as NativeSlotSupplier,
} from '@temporalio/core-bridge';
import { Duration, msToNumber } from '@temporalio/common/lib/time';

export { FixedSizeSlotSupplier, ResourceBasedTunerOptions };

/**
 * Controls how slots for different task types will be handed out.
 *
 * @experimental
 */
export type WorkerTuner = ResourceBasedTuner | TunerHolder;

/**
 * This tuner allows for different slot suppliers for different slot types.
 *
 * @experimental
 */
export interface TunerHolder {
  workflowTaskSlotSupplier: SlotSupplier<WorkflowSlotInfo>;
  activityTaskSlotSupplier: SlotSupplier<ActivitySlotInfo>;
  localActivityTaskSlotSupplier: SlotSupplier<LocalActivitySlotInfo>;
}

/**
 * Controls how slots are handed out for a specific task type.
 *
 * For now, only {@link ResourceBasedSlotOptions} and {@link FixedSizeSlotSupplier} are supported,
 * but we may add support for custom tuners in the future.
 *
 * @experimental
 */
export type SlotSupplier<SI extends SlotInfo> =
  | ResourceBasedSlotsForType
  | FixedSizeSlotSupplier
  | CustomSlotSupplier<SI>;

/**
 * Resource based slot supplier options for a specific kind of slot.
 *
 * @experimental
 */
type ResourceBasedSlotsForType = ResourceBasedSlotOptions & {
  type: 'resource-based';
  tunerOptions: ResourceBasedTunerOptions;
};

/**
 * Options for a specific slot type within a {@link ResourceBasedSlotsForType}
 *
 * @experimental
 */
export interface ResourceBasedSlotOptions {
  /**
   * Amount of slots that will be issued regardless of any other checks.
   * Defaults to 2 for workflow tasks and 1 for activity tasks.
   */
  minimumSlots?: number;
  /**
   * Maximum amount of slots permitted
   * Defaults to 1000 for workflow tasks and 2000 for activity tasks.
   */
  maximumSlots?: number;
  /**
   * Minimum time we will wait (after passing the minimum slots number) between handing out new
   * slots. Defaults to 10ms for workflow tasks and 50ms for activity tasks.
   */
  rampThrottle?: Duration;
}

/**
 * This tuner attempts to maintain certain levels of resource usage when under load. You do not
 * need more than one instance of this when using it for multiple slot types.
 *
 * @experimental
 */
export interface ResourceBasedTuner {
  /**
   * Options for the tuner
   */
  tunerOptions: ResourceBasedTunerOptions;
  /**
   * Options for workflow task slots. Defaults to a minimum of 2 slots and a maximum of 1000 slots
   * with no ramp throttle
   */
  workflowTaskSlotOptions?: ResourceBasedSlotOptions;
  /**
   * Options for activity task slots. Defaults to a minimum of 1 slots and a maximum of 2000 slots
   * with 50ms ramp throttle
   */
  activityTaskSlotOptions?: ResourceBasedSlotOptions;
  /**
   * Options for local activity task slots. Defaults to a minimum of 1 slots and a maximum of 2000
   * slots with 50ms ramp throttle
   */
  localActivityTaskSlotOptions?: ResourceBasedSlotOptions;
}

export type SlotInfo = WorkflowSlotInfo | ActivitySlotInfo | LocalActivitySlotInfo;

export interface WorkflowSlotInfo {
  type: 'workflow';
  workflowId: string;
  runId: string;
}

export interface ActivitySlotInfo {
  type: 'activity';
  activityId: string;
}

export interface LocalActivitySlotInfo {
  type: 'local-activity';
  activityId: string;
}

export interface CustomSlotSupplier<SI extends SlotInfo> {
  type: 'custom';

  /**
   * This function is called before polling for new tasks. Your implementation should block until a
   * slot is available then return a permit to use that slot.
   *
   * // TODO: How to handle cancellation? AbortController? CancelToken?
   *
   * @param ctx The context for slot reservation.
   * @returns A permit to use the slot which may be populated with your own data.
   */
  reserveSlot(ctx: SlotReserveContext): Promise<SlotPermit>;

  /**
   * This function is called when trying to reserve slots for "eager" workflow and activity tasks.
   * Eager tasks are those which are returned as a result of completing a workflow task, rather than
   * from polling. Your implementation must not block, and If a slot is available, return a permit
   * to use that slot.
   *
   * @param ctx The context for slot reservation.
   * @returns Maybe a permit to use the slot which may be populated with your own data.
   */
  tryReserveSlot(ctx: SlotReserveContext): SlotPermit | undefined;

  /**
   * This function is called once a slot is actually being used to process some task, which may be
   * some time after the slot was reserved originally. For example, if there is no work for a
   * worker, a number of slots equal to the number of active pollers may already be reserved, but
   * none of them are being used yet. This call should be non-blocking.
   *
   * @param ctx The context for marking a slot as used.
   */
  markSlotUsed(slot: SlotMarkUsedContext<SI>): void;

  /**
   * This function is called once a permit is no longer needed. This could be because the task has
   * finished, whether successfully or not, or because the slot was no longer needed (ex: the number
   * of active pollers decreased). This call should be non-blocking.
   *
   * @param ctx The context for releasing a slot.
   */
  releaseSlot(slot: SlotReleaseContext<SI>): void;
}

export interface SlotPermit {}

export interface SlotReserveContext {
  /**
   * The type of slot trying to be reserved
   */
  slotType: SlotInfo['type'];
  /**
   * The name of the task queue for which this reservation request is associated
   */
  taskQueue: string;
  /**
   * The identity of the worker that is requesting the reservation
   */
  workerIdentity: string;
  /**
   * The build id of the worker that is requesting the reservation
   */
  workerBuildId: string;
  /**
   * True iff this is a reservation for a sticky poll for a workflow task
   */
  isSticky: boolean;

  /**
   * Returns the number of currently outstanding slot permits, whether used or un-used.
   */
  numIssuedSlots(): number;
}

export interface SlotMarkUsedContext<SI extends SlotInfo> {
  /**
   * Info about the task that will be using the slot
   */
  slotInfo: SI;
  /**
   * The permit that was issued when the slot was reserved
   */
  permit: SlotPermit;
}

/**
 * The reason a slot is being released
 */
export type SlotReleaseReason = TaskCompleteReason | WillRetryReason | NeverUsedReason | ErrorReason;

/**
 * The task completed (whether successfully or not)
 */
export interface TaskCompleteReason {
  reason: 'task-complete';
}

/**
 * The task failed but will be retried
 */
export interface WillRetryReason {
  reason: 'will-retry';
}

/**
 * The slot was never used
 */
export interface NeverUsedReason {
  reason: 'never-used';
}

/**
 * Some error was encountered before the slot could be used
 */
export interface ErrorReason {
  reason: 'error';
  error: Error;
}

export interface SlotReleaseContext<SI extends SlotInfo> {
  /**
   * The reason the slot is being released
   */
  reason: SlotReleaseReason;
  /**
   * Info about the task that used this slot, if any. A slot may be released without being used in
   * the event a poll times out.
   */
  slotInfo?: SI;
  /**
   * The permit that was issued when the slot was reserved
   */
  permit: SlotPermit;
}

export function asNativeTuner(tuner: WorkerTuner): NativeWorkerTuner {
  if (isTunerHolder(tuner)) {
    let tunerOptions = undefined;
    const retme = {
      workflowTaskSlotSupplier: fixupResourceBasedOptions(tuner.workflowTaskSlotSupplier, 'workflow'),
      activityTaskSlotSupplier: fixupResourceBasedOptions(tuner.activityTaskSlotSupplier, 'activity'),
      localActivityTaskSlotSupplier: fixupResourceBasedOptions(tuner.localActivityTaskSlotSupplier, 'activity'),
    };
    for (const supplier of [
      retme.workflowTaskSlotSupplier,
      retme.activityTaskSlotSupplier,
      retme.localActivityTaskSlotSupplier,
    ]) {
      if (isResourceBased(supplier)) {
        if (tunerOptions !== undefined) {
          if (tunerOptions !== supplier.tunerOptions) {
            throw new TypeError('Cannot construct worker tuner with multiple different tuner options');
          }
        } else {
          tunerOptions = supplier.tunerOptions;
        }
      }
    }
    return retme;
  } else if (isResourceBasedTuner(tuner)) {
    const wftSO = addResourceBasedSlotDefaults(tuner.workflowTaskSlotOptions ?? {}, 'workflow');
    const atSO = addResourceBasedSlotDefaults(tuner.activityTaskSlotOptions ?? {}, 'activity');
    const latSO = addResourceBasedSlotDefaults(tuner.localActivityTaskSlotOptions ?? {}, 'activity');
    return {
      workflowTaskSlotSupplier: {
        type: 'resource-based',
        tunerOptions: tuner.tunerOptions,
        ...wftSO,
        rampThrottleMs: msToNumber(wftSO.rampThrottle),
      },
      activityTaskSlotSupplier: {
        type: 'resource-based',
        tunerOptions: tuner.tunerOptions,
        ...atSO,
        rampThrottleMs: msToNumber(atSO.rampThrottle),
      },
      localActivityTaskSlotSupplier: {
        type: 'resource-based',
        tunerOptions: tuner.tunerOptions,
        ...latSO,
        rampThrottleMs: msToNumber(latSO.rampThrottle),
      },
    };
  } else {
    throw new TypeError('Invalid worker tuner configuration');
  }
}

const isResourceBasedTuner = (tuner: WorkerTuner): tuner is ResourceBasedTuner =>
  Object.hasOwnProperty.call(tuner, 'tunerOptions');
const isTunerHolder = (tuner: WorkerTuner): tuner is TunerHolder =>
  Object.hasOwnProperty.call(tuner, 'workflowTaskSlotSupplier');
const isResourceBased = (sup: SlotSupplier<any> | NativeSlotSupplier): sup is ResourceBasedSlotsForType =>
  sup.type === 'resource-based';

type ActOrWorkflow = 'activity' | 'workflow';

function fixupResourceBasedOptions<SI extends SlotInfo>(
  supplier: SlotSupplier<SI>,
  kind: ActOrWorkflow
): NativeSlotSupplier {
  if (isResourceBased(supplier)) {
    const tunerOptions = supplier.tunerOptions;
    const defaulted = addResourceBasedSlotDefaults(supplier, kind);
    return {
      ...defaulted,
      type: 'resource-based',
      tunerOptions,
      rampThrottleMs: msToNumber(defaulted.rampThrottle),
    };
  }
  // TODO: If user setup callbacks etc
  return supplier;
}

function addResourceBasedSlotDefaults(
  slotOptions: ResourceBasedSlotOptions,
  kind: ActOrWorkflow
): Required<ResourceBasedSlotOptions> {
  if (kind === 'workflow') {
    return {
      minimumSlots: slotOptions.minimumSlots ?? 2,
      maximumSlots: slotOptions.maximumSlots ?? 1000,
      rampThrottle: slotOptions.rampThrottle ?? 10,
    };
  } else {
    return {
      minimumSlots: slotOptions.minimumSlots ?? 1,
      maximumSlots: slotOptions.maximumSlots ?? 2000,
      rampThrottle: slotOptions.rampThrottle ?? 50,
    };
  }
}
