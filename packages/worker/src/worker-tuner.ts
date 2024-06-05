import {
  FixedSizeSlotSupplier,
  ResourceBasedTunerOptions,
  WorkerTuner as NativeWorkerTuner,
  SlotSupplier as NativeSlotSupplier,
} from '@temporalio/core-bridge';
import { Duration, msToNumber } from '@temporalio/common/lib/time';

export type WorkerTuner = ResourceBasedTuner | TunerHolder;

type ResourceBasedSlotsForType = ResourceBasedSlotOptions & {
  type: 'resource-based';
  tunerOptions: ResourceBasedTunerOptions;
};

/**
 * @experimental
 *
 * Controls how slots are handed out for a specific task type.
 *
 * For now, only {@link ResourceBasedSlotOptions} and {@link FixedSizeSlotSupplier} are supported,
 * but we may add support for custom tuners in the future.
 */
export type SlotSupplier = ResourceBasedSlotsForType | FixedSizeSlotSupplier;

/**
 * @experimental
 *
 * Options for a specific slot type within a {@link ResourceBasedSlotsForType}
 */
export interface ResourceBasedSlotOptions {
  // Amount of slots that will be issued regardless of any other checks
  minimumSlots: number;
  // Maximum amount of slots permitted
  maximumSlots: number;
  // Minimum time we will wait (after passing the minimum slots number) between handing out new
  // slots
  rampThrottle: Duration;
}

/**
 * @experimental
 *
 * This tuner attempts to maintain certain levels of resource usage when under load. You do not
 * need more than one instance of this when using it for multiple slot types.
 */
export interface ResourceBasedTuner {
  // Options for the tuner
  tunerOptions: ResourceBasedTunerOptions;
  // Options for workflow task slots. Defaults to a minimum of 2 slots and a maximum of 1000 slots
  // with no ramp throttle
  workflowTaskSlotOptions?: ResourceBasedSlotOptions;
  // Options for activity task slots. Defaults to a minimum of 1 slots and a maximum of 2000 slots
  // with 50ms ramp throttle
  activityTaskSlotOptions?: ResourceBasedSlotOptions;
  // Options for local activity task slots. Defaults to a minimum of 1 slots and a maximum of 2000
  // slots with 50ms ramp throttle
  localActivityTaskSlotOptions?: ResourceBasedSlotOptions;
}

/**
 * @experimental
 *
 * This tuner allows for different slot suppliers for different slot types.
 */
export interface TunerHolder {
  workflowTaskSlotSupplier: SlotSupplier;
  activityTaskSlotSupplier: SlotSupplier;
  localActivityTaskSlotSupplier: SlotSupplier;
}

export function asNativeTuner(tuner: WorkerTuner): NativeWorkerTuner {
  if (isTunerHolder(tuner)) {
    return {
      workflowTaskSlotSupplier: convertRampThrottleIfNeeded(tuner.workflowTaskSlotSupplier),
      activityTaskSlotSupplier: convertRampThrottleIfNeeded(tuner.activityTaskSlotSupplier),
      localActivityTaskSlotSupplier: convertRampThrottleIfNeeded(tuner.localActivityTaskSlotSupplier),
    };
  } else if (isResourceBasedTuner(tuner)) {
    const wftSO = tuner.workflowTaskSlotOptions ?? {
      minimumSlots: 2,
      maximumSlots: 1000,
      rampThrottle: 0,
    };
    const atSO = tuner.activityTaskSlotOptions ?? {
      minimumSlots: 1,
      maximumSlots: 2000,
      rampThrottle: 50,
    };
    const latSO = tuner.localActivityTaskSlotOptions ?? {
      minimumSlots: 1,
      maximumSlots: 2000,
      rampThrottle: 50,
    };
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
const isResourceBased = (sup: SlotSupplier): sup is ResourceBasedSlotsForType =>
  Object.hasOwnProperty.call(sup, 'rampThrottle');

function convertRampThrottleIfNeeded(supplier: SlotSupplier): NativeSlotSupplier {
  if (isResourceBased(supplier)) {
    return {
      ...supplier,
      rampThrottleMs: msToNumber(supplier.rampThrottle),
    };
  }
  return supplier;
}
