/** Shorthand alias */
export type AnyFunc = (...args: any[]) => any;
/** A tuple without its last element */
export type OmitLast<T> = T extends [...infer REST, any] ? REST : never;
/** F with all arguments but the last */
export type OmitLastParam<F extends AnyFunc> = (...args: OmitLast<Parameters<F>>) => ReturnType<F>;

/** Verify that an type _Copy extends _Orig */
export function checkExtends<_Orig, _Copy extends _Orig>(): void {
  // noop, just type check
}

export type Replace<Base, New> = Omit<Base, keyof New> & New;

export type MakeOptional<Base, Keys extends keyof Base> = Omit<Base, Keys> & Partial<Pick<Base, Keys>>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function hasOwnProperty<X extends Record<string, unknown>, Y extends PropertyKey>(
  record: X,
  prop: Y
): record is X & Record<Y, unknown> {
  return prop in record;
}

export function hasOwnProperties<X extends Record<string, unknown>, Y extends PropertyKey>(
  record: X,
  props: Y[]
): record is X & Record<Y, unknown> {
  return props.every((prop) => prop in record);
}
