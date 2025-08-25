import { native } from '@temporalio/core-bridge';
import { Duration, msToNumber } from '@temporalio/common/lib/time';
import { Logger, WorkerDeploymentVersion } from '@temporalio/common';

/**
 * A worker tuner allows the customization of the performance characteristics of workers by
 * controlling how "slots" are handed out for different task types. In order to poll for and then
 * run tasks, a slot must first be reserved by the {@link SlotSupplier} returned by the tuner.
 *
 * @experimental Worker Tuner is an experimental feature and may be subject to change.
 */
export type WorkerTuner = ResourceBasedTuner | TunerHolder;

/**
 * This tuner allows for different slot suppliers for different slot types.
 *
 * @experimental Worker Tuner is an experimental feature and may be subject to change.
 */
export interface TunerHolder {
  workflowTaskSlotSupplier: SlotSupplier<WorkflowSlotInfo>;
  activityTaskSlotSupplier: SlotSupplier<ActivitySlotInfo>;
  localActivityTaskSlotSupplier: SlotSupplier<LocalActivitySlotInfo>;
  nexusTaskSlotSupplier: SlotSupplier<NexusSlotInfo>;
}

/**
 * Controls how slots are handed out for a specific task type.
 *
 * @experimental Worker Tuner is an experimental feature and may be subject to change.
 */
export type SlotSupplier<SI extends SlotInfo> =
  | ResourceBasedSlotsForType
  | FixedSizeSlotSupplier
  | CustomSlotSupplier<SI>;

// Resource Based //////////////////////////////////////////////////////////////////////////////////

/**
 * This tuner attempts to maintain certain levels of resource usage when under load. You do not
 * need more than one instance of this when using it for multiple slot types.
 *
 * @experimental Worker Tuner is an experimental feature and may be subject to change.
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
  /**
   * Options for Nexus task slots. Defaults to a minimum of 1 slots and a maximum of 2000
   * slots with 50ms ramp throttle
   */
  nexusTaskSlotOptions?: ResourceBasedSlotOptions;
}

/**
 * Options for a {@link ResourceBasedTuner} to control target resource usage
 *
 * @experimental Worker Tuner is an experimental feature and may be subject to change.
 */
export interface ResourceBasedTunerOptions {
  // A value between 0 and 1 that represents the target (system) memory usage. It's not recommended
  // to set this higher than 0.8, since how much memory a workflow may use is not predictable, and
  // you don't want to encounter OOM errors.
  targetMemoryUsage: number;
  // A value between 0 and 1 that represents the target (system) CPU usage. This can be set to 1.0
  // if desired, but it's recommended to leave some headroom for other processes.
  targetCpuUsage: number;
}

/**
 * Options for a specific slot type within a {@link ResourceBasedSlotsForType}
 *
 * @experimental Worker Tuner is an experimental feature and may be subject to change.
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
 * Resource based slot supplier options for a specific kind of slot.
 *
 * @experimental Worker Tuner is an experimental feature and may be subject to change.
 */
export type ResourceBasedSlotsForType = ResourceBasedSlotOptions & {
  type: 'resource-based';
  tunerOptions: ResourceBasedTunerOptions;
};

// Fixed Size //////////////////////////////////////////////////////////////////////////////////////

/**
 * A fixed-size slot supplier that will never issue more than a fixed number of slots.
 *
 * @experimental Worker Tuner is an experimental feature and may be subject to change.
 */
export interface FixedSizeSlotSupplier {
  type: 'fixed-size';
  // The maximum number of slots that can be issued
  numSlots: number;
}

/**
 * The interface can be implemented to provide custom slot supplier behavior.
 *
 * @experimental Worker Tuner is an experimental feature and may be subject to change.
 */
export interface CustomSlotSupplier<SI extends SlotInfo> {
  type: 'custom';

  /**
   * This function is called before polling for new tasks. Your implementation should return a permit
   * when a slot is available.
   *
   * Note: This function is called asynchronously from the Rust side. It should return a Promise that
   * resolves when a slot is available. You can use async/await or return a Promise directly.
   *
   * The only acceptable exception to throw is AbortError, any other exceptions thrown will be
   * logged and ignored.
   *
   * The value inside the returned promise should be an object, however other types will still count
   * as having issued a permit. Including undefined or null. Returning undefined or null does *not*
   * mean you have not issued a permit. Implementations are expected to block until a meaningful
   * permit can be issued.
   *
   * @param ctx The context for slot reservation.
   * @param abortSignal The SDK may decide to abort the reservation request if it's no longer
   *   needed. Implementations may clean up and then must reject the promise with AbortError.
   * @returns A promise that resolves to a permit to use the slot which may be populated with your own data.
   */
  reserveSlot(ctx: SlotReserveContext, abortSignal: AbortSignal): Promise<SlotPermit>;

  /**
   * This function is called when trying to reserve slots for "eager" workflow and activity tasks.
   * Eager tasks are those which are returned as a result of completing a workflow task, rather than
   * from polling. Your implementation must not block, and if a slot is available, return a permit
   * to use that slot.
   *
   * @param ctx The context for slot reservation.
   * @returns Maybe a permit to use the slot which may be populated with your own data.
   */
  tryReserveSlot(ctx: SlotReserveContext): SlotPermit | null;

  /**
   * This function is called once a slot is actually being used to process some task, which may be
   * some time after the slot was reserved originally. For example, if there is no work for a
   * worker, a number of slots equal to the number of active pollers may already be reserved, but
   * none of them are being used yet. This call should be non-blocking.
   *
   * @param ctx The context for marking a slot as used.
   */
  markSlotUsed(ctx: SlotMarkUsedContext<SI>): void;

  /**
   * This function is called once a permit is no longer needed. This could be because the task has
   * finished, whether successfully or not, or because the slot was no longer needed (ex: the number
   * of active pollers decreased). This call should be non-blocking.
   *
   * @param ctx The context for releasing a slot.
   */
  releaseSlot(ctx: SlotReleaseContext<SI>): void;
}

export type SlotInfo = WorkflowSlotInfo | ActivitySlotInfo | LocalActivitySlotInfo | NexusSlotInfo;

export interface WorkflowSlotInfo {
  type: 'workflow';
  workflowType: string;
  isSticky: boolean;
}

export interface ActivitySlotInfo {
  type: 'activity';
  activityType: string;
}

export interface LocalActivitySlotInfo {
  type: 'local-activity';
  activityType: string;
}

export interface NexusSlotInfo {
  type: 'nexus';
  service: string;
  operation: string;
}

/**
 * A permit to use a slot.
 *
 * @experimental Worker Tuner is an experimental feature and may be subject to change.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SlotPermit {}

/**
 * Context for reserving a slot.
 *
 * @experimental Worker Tuner is an experimental feature and may be subject to change.
 */
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
   *
   * @deprecated Use {@link workerDeploymentVersion} instead.
   */
  workerBuildId: string;

  /**
   * The deployment version of the worker that is requesting the reservation
   *
   * @experimental Worker deployments are an experimental feature and may be subject to change.
   */
  workerDeploymentVersion?: WorkerDeploymentVersion;

  /**
   * True iff this is a reservation for a sticky poll for a workflow task
   */
  isSticky: boolean;
}

/**
 * Context for marking a slot as used.
 *
 * @experimental Worker Tuner is an experimental feature and may be subject to change.
 */
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
 * Context for releasing a slot.
 *
 * @experimental Worker Tuner is an experimental feature and may be subject to change.
 */
export interface SlotReleaseContext<SI extends SlotInfo> {
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

////////////////////////////////////////////////////////////////////////////////////////////////////

export function asNativeTuner(tuner: WorkerTuner, logger: Logger): native.WorkerTunerOptions {
  if (isTunerHolder(tuner)) {
    let tunerOptions = undefined;
    const retme = {
      workflowTaskSlotSupplier: nativeifySupplier(tuner.workflowTaskSlotSupplier, 'workflow', logger),
      activityTaskSlotSupplier: nativeifySupplier(tuner.activityTaskSlotSupplier, 'activity', logger),
      localActivityTaskSlotSupplier: nativeifySupplier(tuner.localActivityTaskSlotSupplier, 'activity', logger),
      nexusTaskSlotSupplier: nativeifySupplier(tuner.nexusTaskSlotSupplier, 'nexus', logger),
    };
    for (const supplier of [
      retme.workflowTaskSlotSupplier,
      retme.activityTaskSlotSupplier,
      retme.localActivityTaskSlotSupplier,
    ]) {
      if (isResourceBased(supplier)) {
        if (tunerOptions !== undefined) {
          if (
            tunerOptions.targetCpuUsage !== supplier.tunerOptions.targetCpuUsage ||
            tunerOptions.targetMemoryUsage !== supplier.tunerOptions.targetMemoryUsage
          ) {
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
    const nexusSO = addResourceBasedSlotDefaults(tuner.nexusTaskSlotOptions ?? {}, 'nexus');
    return {
      workflowTaskSlotSupplier: {
        type: 'resource-based',
        tunerOptions: tuner.tunerOptions,
        ...wftSO,
        rampThrottle: msToNumber(wftSO.rampThrottle),
      },
      activityTaskSlotSupplier: {
        type: 'resource-based',
        tunerOptions: tuner.tunerOptions,
        ...atSO,
        rampThrottle: msToNumber(atSO.rampThrottle),
      },
      localActivityTaskSlotSupplier: {
        type: 'resource-based',
        tunerOptions: tuner.tunerOptions,
        ...latSO,
        rampThrottle: msToNumber(latSO.rampThrottle),
      },
      nexusTaskSlotSupplier: {
        type: 'resource-based',
        tunerOptions: tuner.tunerOptions,
        ...nexusSO,
        rampThrottle: msToNumber(nexusSO.rampThrottle),
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
const isResourceBased = (sup: SlotSupplier<any> | native.SlotSupplierOptions): sup is ResourceBasedSlotsForType =>
  sup.type === 'resource-based';
const isCustom = (sup: SlotSupplier<any> | native.SlotSupplierOptions): sup is CustomSlotSupplier<any> =>
  sup.type === 'custom';

type ResourceKind = 'activity' | 'workflow' | 'nexus';

////////////////////////////////////////////////////////////////////////////////////////////////////

function nativeifySupplier<SI extends SlotInfo>(
  supplier: SlotSupplier<SI>,
  kind: ResourceKind,
  logger: Logger
): native.SlotSupplierOptions {
  if (isResourceBased(supplier)) {
    const tunerOptions = supplier.tunerOptions;
    const defaulted = addResourceBasedSlotDefaults(supplier, kind);
    return {
      type: 'resource-based',
      minimumSlots: defaulted.minimumSlots,
      maximumSlots: defaulted.maximumSlots,
      rampThrottle: msToNumber(defaulted.rampThrottle),
      tunerOptions: {
        targetMemoryUsage: tunerOptions.targetMemoryUsage,
        targetCpuUsage: tunerOptions.targetCpuUsage,
      },
    };
  }

  if (isCustom(supplier)) {
    return new NativeifiedCustomSlotSupplier(supplier, logger);
  }

  return {
    type: 'fixed-size',
    numSlots: supplier.numSlots,
  };
}

function addResourceBasedSlotDefaults(
  slotOptions: ResourceBasedSlotOptions,
  kind: ResourceKind
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

class NativeifiedCustomSlotSupplier<SI extends SlotInfo> implements native.CustomSlotSupplierOptions<SI> {
  readonly type = 'custom';

  constructor(
    private readonly supplier: CustomSlotSupplier<SI>,
    private readonly logger: Logger
  ) {
    this.reserveSlot = this.reserveSlot.bind(this);
    this.tryReserveSlot = this.tryReserveSlot.bind(this);
    this.markSlotUsed = this.markSlotUsed.bind(this);
    this.releaseSlot = this.releaseSlot.bind(this);
  }

  async reserveSlot(ctx: native.SlotReserveContext, abortSignal: AbortSignal): Promise<SlotPermit> {
    if (ctx.slotType === 'nexus') {
      throw new Error('nexus not yet supported in slot suppliers');
    }
    try {
      const result = await this.supplier.reserveSlot(
        {
          slotType: ctx.slotType,
          taskQueue: ctx.taskQueue,
          workerIdentity: ctx.workerIdentity,
          workerBuildId: ctx.workerDeploymentVersion?.buildId ?? '',
          workerDeploymentVersion: ctx.workerDeploymentVersion ?? undefined,
          isSticky: ctx.isSticky,
        },
        abortSignal
      );
      return result;
    } catch (error) {
      if (abortSignal.aborted && error !== abortSignal.reason) {
        this.logger.error('Error in custom slot supplier `reserveSlot`', { error });
      }
      throw error;
    }
  }

  tryReserveSlot(ctx: native.SlotReserveContext): SlotPermit | null {
    if (ctx.slotType === 'nexus') {
      throw new Error('nexus not yet supported in slot suppliers');
    }
    try {
      const result = this.supplier.tryReserveSlot({
        slotType: ctx.slotType,
        taskQueue: ctx.taskQueue,
        workerIdentity: ctx.workerIdentity,
        workerBuildId: ctx.workerDeploymentVersion?.buildId ?? '',
        workerDeploymentVersion: ctx.workerDeploymentVersion ?? undefined,
        isSticky: ctx.isSticky,
      });
      return result ?? null;
    } catch (error) {
      this.logger.error(`Error in custom slot supplier tryReserveSlot`, { error });
      return null;
    }
  }

  markSlotUsed(ctx: native.SlotMarkUsedContext<SI>): void {
    try {
      this.supplier.markSlotUsed({
        slotInfo: ctx.slotInfo,
        permit: ctx.permit,
      });
    } catch (error) {
      this.logger.error(`Error in custom slot supplier markSlotUsed`, { error });
    }
  }

  releaseSlot(ctx: native.SlotReleaseContext<SI>): void {
    try {
      this.supplier.releaseSlot({
        slotInfo: ctx.slotInfo ?? undefined,
        permit: ctx.permit,
      });
    } catch (error) {
      this.logger.error(`Error in custom slot supplier releaseSlot`, { error });
    }
  }
}
