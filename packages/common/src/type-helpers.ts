/** Shorthand alias */
export type AnyFunc = (...args: any[]) => any;
/** A tuple without its last element */
export type OmitLast<T> = T extends [...infer REST, any] ? REST : never;
/** F with all arguments but the last */
export type OmitLastParam<F extends AnyFunc> = (...args: OmitLast<Parameters<F>>) => ReturnType<F>;

export type Replace<Base, New> = Omit<Base, keyof New> & New;

export type MakeOptional<Base, Keys extends keyof Base> = Omit<Base, Keys> & Partial<Pick<Base, Keys>>;
