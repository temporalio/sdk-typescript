/**
 * A worker tuner allows the customization of the performance characteristics of workers by
 * controlling how "slots" are handed out for different task types. In order to poll for and then
 * run tasks, a slot must first be reserved by the {@link SlotSupplier} returned by the tuner.
 *
 * @experimental
 */
export interface WorkerTuner {
  workflowTaskSlotSupplier: SlotSupplier;
  activityTaskSlotSupplier: SlotSupplier;
  localActivityTaskSlotSupplier: SlotSupplier;
}

/**
 * Controls how slots are handed out for a specific task type.
 *
 * For now, only {@link ResourceBasedSlotOptions} and {@link FixedSizeSlotSupplier} are supported,
 * but we may add support for custom tuners in the future.
 *
 * @experimental
 */
export type SlotSupplier = ResourceBasedSlotsForType | FixedSizeSlotSupplier;

/**
 * Options for a specific slot type within a {@link ResourceBasedSlotsForType}
 *
 * @experimental
 */
export interface ResourceBasedSlotOptions {
  // Amount of slots that will be issued regardless of any other checks
  minimumSlots: number;
  // Maximum amount of slots permitted
  maximumSlots: number;
  // Minimum time we will wait (after passing the minimum slots number) between handing out new
  // slots in milliseconds.
  rampThrottleMs: number;
}

/**
 * @experimental
 */
type ResourceBasedSlotsForType = ResourceBasedSlotOptions & {
  type: 'resource-based';
  tunerOptions: ResourceBasedTunerOptions;
};

/**
 * Options for a {@link ResourceBasedTuner} to control target resource usage
 *
 * @experimental
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
 * A fixed-size slot supplier that will never issue more than a fixed number of slots.
 *
 * @experimental
 */
export interface FixedSizeSlotSupplier {
  type: 'fixed-size';
  // The maximum number of slots that can be issued
  numSlots: number;
}
