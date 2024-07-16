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
  NonCancellableScopesAreShieldedFromPropagation: defineFlag(1, false),
} as const;

function defineFlag(id: number, def: boolean): SdkFlag {
  const flag = { id, default: def };
  flagsRegistry.set(id, flag);
  return flag;
}

export function assertValidFlag(id: number): void {
  if (!flagsRegistry.has(id)) throw new TypeError(`Unknown SDK flag: ${id}`);
}
