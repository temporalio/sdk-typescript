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

/**
 * Controls how slots are handed out for a specific task type.
 *
 * For now, only {@link ResourceBasedSlotOptions} and {@link FixedSizeSlotSupplier} are supported,
 * but we may add support for custom tuners in the future.
 *
 * @experimental
 */
export type SlotSupplier = ResourceBasedSlotsForType | FixedSizeSlotSupplier | CustomSlotSupplier<any>;

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

/**
 * The interface can be implemented to provide custom slot supplier behavior.
 */
export interface CustomSlotSupplier<SI extends SlotInfo> {
  type: 'custom';

  /**
   * This function is called before polling for new tasks. Your implementation should block until a
   * slot is available then return a permit to use that slot.
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
   * @returns A permit to use the slot which may be populated with your own data.
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
