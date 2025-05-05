export type NonNullableObject<T> = { [P in keyof T]-?: NonNullable<T[P]> };

/** Shorthand alias */
export type AnyFunc = (...args: any[]) => any;

/** A tuple without its last element */
export type OmitLast<T> = T extends [...infer REST, any] ? REST : never;

/** F with all arguments but the last */
export type OmitLastParam<F extends AnyFunc> = (...args: OmitLast<Parameters<F>>) => ReturnType<F>;

export type OmitFirst<T> = T extends [any, ...infer REST] ? REST : never;

export type OmitFirstParam<T> = T extends (...args: any[]) => any
  ? (...args: OmitFirst<Parameters<T>>) => ReturnType<T>
  : never;

/** Require that T has at least one of the provided properties defined */
export type RequireAtLeastOne<T, Keys extends keyof T = keyof T> = Pick<T, Exclude<keyof T, Keys>> &
  {
    [K in Keys]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<Keys, K>>>;
  }[Keys];

/** Verify that an type _Copy extends _Orig */
export function checkExtends<_Orig, _Copy extends _Orig>(): void {
  // noop, just type check
}

export type Replace<Base, New> = Omit<Base, keyof New> & New;

// From https://github.com/sindresorhus/type-fest/blob/main/source/union-to-intersection.d.ts
// MIT or CC0-1.0 — It is meant to be copied into your codebase rather than being used as a dependency.
export type UnionToIntersection<Union> =
  // `extends unknown` is always going to be the case and is used to convert the `Union` into a
  // [distributive conditional type](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-8.html#distributive-conditional-types).
  (
    Union extends unknown
      ? // The union type is used as the only argument to a function since the union
        // of function arguments is an intersection.
        (distributedUnion: Union) => void
      : // This won't happen.
        never
  ) extends // Infer the `Intersection` type since TypeScript represents the positional
  // arguments of unions of functions as an intersection of the union.
  (mergedIntersection: infer Intersection) => void
    ? // The `& Union` is to allow indexing by the resulting type
      Intersection & Union
    : never;

type IsEqual<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

type Primitive = null | undefined | string | number | boolean | symbol | bigint;

type IsNull<T> = [T] extends [null] ? true : false;

type IsUnknown<T> = unknown extends T // `T` can be `unknown` or `any`
  ? IsNull<T> extends false // `any` can be `null`, but `unknown` can't be
    ? true
    : false
  : false;

type ObjectValue<T, K> = K extends keyof T
  ? T[K]
  : ToString<K> extends keyof T
    ? T[ToString<K>]
    : K extends `${infer NumberK extends number}`
      ? NumberK extends keyof T
        ? T[NumberK]
        : never
      : never;

type ToString<T> = T extends string | number ? `${T}` : never;

type KeysOfUnion<ObjectType> = ObjectType extends unknown ? keyof ObjectType : never;

type ArrayElement<T> = T extends readonly unknown[] ? T[0] : never;

type ExactObject<ParameterType, InputType> = {
  [Key in keyof ParameterType]: Exact<ParameterType[Key], ObjectValue<InputType, Key>>;
} & Record<Exclude<keyof InputType, KeysOfUnion<ParameterType>>, never>;

export type Exact<ParameterType, InputType> =
  // Before distributing, check if the two types are equal and if so, return the parameter type immediately
  IsEqual<ParameterType, InputType> extends true
    ? ParameterType
    : // If the parameter is a primitive, return it as is immediately to avoid it being converted to a complex type
      ParameterType extends Primitive
      ? ParameterType
      : // If the parameter is an unknown, return it as is immediately to avoid it being converted to a complex type
        IsUnknown<ParameterType> extends true
        ? unknown
        : // If the parameter is a Function, return it as is because this type is not capable of handling function, leave it to TypeScript
          // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
          ParameterType extends Function
          ? ParameterType
          : // Convert union of array to array of union: A[] & B[] => (A & B)[]
            ParameterType extends unknown[]
            ? Array<Exact<ArrayElement<ParameterType>, ArrayElement<InputType>>>
            : // In TypeScript, Array is a subtype of ReadonlyArray, so always test Array before ReadonlyArray.
              ParameterType extends readonly unknown[]
              ? ReadonlyArray<Exact<ArrayElement<ParameterType>, ArrayElement<InputType>>>
              : ExactObject<ParameterType, InputType>;
// End of borrow from  https://github.com/sindresorhus/type-fest/blob/main/source/union-to-intersection.d.ts

export type RemovePrefix<Prefix extends string, Keys extends string> = {
  [k in Keys]: k extends `${Prefix}${infer Suffix}` ? Suffix : never;
}[Keys];

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

export function isError(error: unknown): error is Error {
  return (
    isRecord(error) &&
    typeof error.name === 'string' &&
    typeof error.message === 'string' &&
    (error.stack == null || typeof error.stack === 'string')
  );
}

export function isAbortError(error: unknown): error is Error & { name: 'AbortError' } {
  return isError(error) && error.name === 'AbortError';
}

/**
 * Get `error.message` (or `undefined` if not present)
 */
export function errorMessage(error: unknown): string | undefined {
  if (isError(error)) {
    return error.message;
  } else if (typeof error === 'string') {
    return error;
  }
  return undefined;
}

interface ErrorWithCode {
  code: string;
}

function isErrorWithCode(error: unknown): error is ErrorWithCode {
  return isRecord(error) && typeof error.code === 'string';
}

/**
 * Get `error.code` (or `undefined` if not present)
 */
export function errorCode(error: unknown): string | undefined {
  if (isErrorWithCode(error)) {
    return error.code;
  }

  return undefined;
}

/**
 * Asserts that some type is the never type
 */
export function assertNever(msg: string, x: never): never {
  throw new TypeError(msg + ': ' + x);
}

export type Class<E extends Error> = {
  new (...args: any[]): E;
  prototype: E;
};

/**
 * A decorator to be used on error classes. It adds the 'name' property AND provides a custom
 * 'instanceof' handler that works correctly across execution contexts.
 *
 * ### Details ###
 *
 * According to the EcmaScript's spec, the default behavior of JavaScript's `x instanceof Y` operator is to walk up the
 * prototype chain of object 'x', checking if any constructor in that hierarchy is _exactly the same object_ as the
 * constructor function 'Y'.
 *
 * Unfortunately, it happens in various situations that different constructor function objects get created for what
 * appears to be the very same class. This leads to surprising behavior where `instanceof` returns false though it is
 * known that the object is indeed an instance of that class. One particular case where this happens is when constructor
 * 'Y' belongs to a different realm than the constuctor with which 'x' was instantiated. Another case is when two copies
 * of the same library gets loaded in the same realm.
 *
 * In practice, this tends to cause issues when crossing the workflow-sandboxing boundary (since Node's vm module
 * really creates new execution realms), as well as when running tests using Jest (see https://github.com/jestjs/jest/issues/2549
 * for some details on that one).
 *
 * This function injects a custom 'instanceof' handler into the prototype of 'clazz', which is both cross-realm safe and
 * cross-copies-of-the-same-lib safe. It works by adding a special symbol property to the prototype of 'clazz', and then
 * checking for the presence of that symbol.
 */
export function SymbolBasedInstanceOfError<E extends Error>(markerName: string): (clazz: Class<E>) => void {
  return (clazz: Class<E>): void => {
    const marker = Symbol.for(`__temporal_is${markerName}`);

    Object.defineProperty(clazz.prototype, 'name', { value: markerName, enumerable: true });
    Object.defineProperty(clazz.prototype, marker, { value: true, enumerable: false });
    Object.defineProperty(clazz, Symbol.hasInstance, {
      // eslint-disable-next-line object-shorthand
      value: function (this: any, error: object): boolean {
        if (this === clazz) {
          return isRecord(error) && (error as any)[marker] === true;
        } else {
          // 'this' must be a _subclass_ of clazz that doesn't redefined [Symbol.hasInstance], so that it inherited
          // from clazz's [Symbol.hasInstance]. If we don't handle this particular situation, then
          // `x instanceof SubclassOfParent` would return true for any instance of 'Parent', which is clearly wrong.
          //
          // Ideally, it'd be preferable to avoid this case entirely, by making sure that all subclasses of 'clazz'
          // redefine [Symbol.hasInstance], but we can't enforce that. We therefore fallback to the default instanceof
          // behavior (which is NOT cross-realm safe).
          return this.prototype.isPrototypeOf(error); // eslint-disable-line no-prototype-builtins
        }
      },
    });
  };
}
