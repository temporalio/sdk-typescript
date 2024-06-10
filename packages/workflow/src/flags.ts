export type SdkFlag = {
  get id(): number;
  get default(): boolean;
};

const flagsRegistry: Map<number, SdkFlag> = new Map();

export const SdkFlags = {
  /**
   * Until 1.10.2, cancellation of a non-cancellable scope would propagate to children scopes, which was incorrect.
   * See https://github.com/temporalio/sdk-typescript/issues/1423.
   *
   * @since Introduced in 1.10.2/1.10.3.
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
