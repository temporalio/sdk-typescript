import {
  ActivitySlotInfo,
  CustomSlotSupplier,
  FixedSizeSlotSupplier,
  LocalActivitySlotInfo,
  ResourceBasedTunerOptions,
  SlotInfo,
  SlotMarkUsedContext,
  SlotPermit,
  SlotReleaseContext,
  SlotReserveContext,
  SlotSupplier as NativeSlotSupplier,
  WorkerTuner as NativeWorkerTuner,
  WorkflowSlotInfo,
} from '@temporalio/core-bridge';
import { Duration, msToNumber } from '@temporalio/common/lib/time';
import { Logger } from '@temporalio/common';

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

export function asNativeTuner(tuner: WorkerTuner, logger: Logger): NativeWorkerTuner {
  if (isTunerHolder(tuner)) {
    let tunerOptions = undefined;
    const retme = {
      workflowTaskSlotSupplier: nativeifySupplier(tuner.workflowTaskSlotSupplier, 'workflow', logger),
      activityTaskSlotSupplier: nativeifySupplier(tuner.activityTaskSlotSupplier, 'activity', logger),
      localActivityTaskSlotSupplier: nativeifySupplier(tuner.localActivityTaskSlotSupplier, 'activity', logger),
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
const isCustom = (sup: SlotSupplier<any> | NativeSlotSupplier): sup is CustomSlotSupplier<any> => sup.type === 'custom';

type ActOrWorkflow = 'activity' | 'workflow';
const abortString = '__ABORTED_BY_CORE__';

class ErrorLoggingSlotSupplier<SI extends SlotInfo> implements CustomSlotSupplier<SI> {
  readonly type = 'custom';

  constructor(
    private readonly supplier: CustomSlotSupplier<SI>,
    private readonly logger: Logger
  ) {}

  async reserveSlot(ctx: SlotReserveContext, registerAbort: any): Promise<SlotPermit> {
    const abortController = new AbortController();
    registerAbort(() => abortController.abort(abortString));
    return await this.supplier.reserveSlot(ctx, abortController.signal).catch((err) => {
      if (err !== abortString) {
        this.logger.error('Error in custom slot supplier `reserveSlot`', err);
      }
      throw err;
    });
  }

  tryReserveSlot(ctx: SlotReserveContext): SlotPermit | null {
    try {
      return this.supplier.tryReserveSlot(ctx);
    } catch (err: any) {
      this.logger.error('Error in custom slot supplier `tryReserveSlot`', err);
    }
    return null;
  }

  markSlotUsed(ctx: SlotMarkUsedContext<SI>): void {
    try {
      this.supplier.markSlotUsed(ctx);
    } catch (err: any) {
      this.logger.error('Error in custom slot supplier `markSlotUsed`', err);
    }
  }

  releaseSlot(ctx: SlotReleaseContext<SI>): void {
    try {
      this.supplier.releaseSlot(ctx);
    } catch (err: any) {
      this.logger.error('Error in custom slot supplier `releaseSlot`', err);
    }
  }
}

function nativeifySupplier<SI extends SlotInfo>(
  supplier: SlotSupplier<SI>,
  kind: ActOrWorkflow,
  logger: Logger
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
  if (isCustom(supplier)) {
    return new ErrorLoggingSlotSupplier(supplier, logger);
  }

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
