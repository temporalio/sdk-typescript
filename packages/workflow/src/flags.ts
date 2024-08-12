export type SdkFlag = {
  get id(): number;
  get default(): boolean;
};

const flagsRegistry: Map<number, SdkFlag> = new Map();

export const SdkFlags = {
  /**
   * This flag gates multiple fixes related to cancellation scopes and timers introduced in 1.10.2/1.11.0:
   * - Cancellation of a non-cancellable scope no longer propagates to children scopes
   *   (see https://github.com/temporalio/sdk-typescript/issues/1423).
   * - CancellationScope.withTimeout(fn) now cancel the timer if `fn` completes before expiration
   *   of the timeout, similar to how `condition(fn, timeout)` works.
   * - Timers created using setTimeout can now be intercepted.
   *
   * @since Introduced in 1.10.2/1.11.0.
   */
  NonCancellableScopesAreShieldedFromPropagation: defineFlag(1, true),

  /**
   * Prior to 1.11.0, when processing a Workflow activation, the SDK would execute `notifyHasPatch`
   * and `signalWorkflow` jobs in distinct phases, before other types of jobs. The primary reason
   * behind that multi-phase algorithm was to avoid the possibility that a Workflow execution might
   * complete before all incoming signals have been dispatched (at least to the point that the
   * _synchronous_ part of the handler function has been executed).
   *
   * This flag replaces that multi-phase algorithm with a simpler one where jobs are simply sorted as
   * `(signals and updates) -> others`, but without processing them as distinct batches (i.e. without
   * leaving/reentering the VM context between each group, which automatically triggers the execution
   * of all outstanding microtasks). That single-phase approach resolves a number of quirks of the
   * former algorithm, and yet still satisfies to the original requirement of ensuring that every
   * `signalWorkflow` jobs - and now `doUpdate` jobs as well - have been given a proper chance to
   * execute before the Workflow main function might completes.
   *
   * @since Introduced in 1.11.0. This change is not rollback-safe.
   */
  ProcessWorkflowActivationJobsAsSingleBatch: defineFlag(2, true),
} as const;

function defineFlag(id: number, def: boolean): SdkFlag {
  const flag = { id, default: def };
  flagsRegistry.set(id, flag);
  return flag;
}

export function assertValidFlag(id: number): void {
  if (!flagsRegistry.has(id)) throw new TypeError(`Unknown SDK flag: ${id}`);
}
