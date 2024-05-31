import { ResourceBasedSlotOptions, ResourceBasedTunerOptions, SlotSupplier } from '@temporalio/core-bridge';

export type WorkerTuner = ResourceBasedTuner | TunerHolder;

export const isResourceBasedTuner = (tuner: WorkerTuner): tuner is ResourceBasedTuner =>
  tuner.hasOwnProperty('tunerOptions');
export const isTunerHolder = (tuner: WorkerTuner): tuner is TunerHolder =>
  tuner.hasOwnProperty('workflowTaskSlotSupplier');

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
