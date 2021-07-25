/** Shorthand alias */
export type AnyFunc = (...args: any[]) => any;
/** A tuple without its last element */
export type OmitLast<T> = T extends [...infer REST, any] ? REST : never;
/** F with all arguments but the last */
export type OmitLastParam<F extends AnyFunc> = (...args: OmitLast<Parameters<F>>) => ReturnType<F>;

export type EnsurePromise<T> = T extends Promise<any> ? T : Promise<T>;

/// Takes a function type F and converts it to an async version if it isn't one already
export type AsyncOnly<F extends (...args: any[]) => any> = (...args: Parameters<F>) => EnsurePromise<ReturnType<F>>;
