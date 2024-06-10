export type SdkFlag = {
  get id(): number;
  get default(): boolean;
};

const flagsRegistry: Map<number, SdkFlag> = new Map();

export const SdkFlags = {} as const;

function defineFlag(id: number, def: boolean): SdkFlag {
  const flag = { id, default: def };
  flagsRegistry.set(id, flag);
  return flag;
}

export function assertValidFlag(id: number): void {
  if (!flagsRegistry.has(id)) throw new TypeError(`Unknown SDK flag: ${id}`);
}
