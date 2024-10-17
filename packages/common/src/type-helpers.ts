/** Shorthand alias */
export type AnyFunc = (...args: any[]) => any;
/** A tuple without its last element */
export type OmitLast<T> = T extends [...infer REST, any] ? REST : never;
/** F with all arguments but the last */
export type OmitLastParam<F extends AnyFunc> = (...args: OmitLast<Parameters<F>>) => ReturnType<F>;
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

// This implementation is based on https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/freeze.
// Note that there are limits to this approach, as traversing using getOwnPropertyXxx doesn't allow
// reaching variables defined using internal scopes. This implementation specifically look for and deal
// with the case of the Map or Set classes, but it is impossible to cover all potential cases.
export function deepFreeze<T>(object: T, visited = new WeakSet<any>(), path = 'root'): T {
  if (typeof object !== 'object' || object == null || Object.isFrozen(object) || visited.has(object)) return object;
  visited.add(object);

  if (object.constructor?.name === 'Map' || object instanceof Map) {
    const map = object as unknown as Map<any, any>;
    for (const [k, v] of map.entries()) {
      deepFreeze(k, visited, `${path}[key:${k}]`);
      deepFreeze(v, visited, `${path}[value:${k}]`);
    }
    map.set = frozenMapSet;
    map.delete = frozenMapDelete;
    map.clear = frozenMapClear;
  }

  if (object.constructor?.name === 'Set' || object instanceof Set) {
    const set = object as unknown as Set<any>;
    for (const v of set.values()) {
      deepFreeze(v, visited, `${path}.${v}`);
    }
    set.add = frozenSetAdd;
    set.delete = frozenSetDelete;
    set.clear = frozenSetClear;
  }

  // Retrieve the property names defined on object
  const propNames = Object.getOwnPropertyNames(object);

  // Freeze properties before freezing self
  for (const name of propNames) {
    const value = (object as any)[name];

    if (value && typeof value === 'object') {
      try {
        deepFreeze(value, visited, `${path}.${name}`);
      } catch (err) {
        if (typeof value !== 'object' || value.constructor.name !== 'Uint8Array') {
          console.log(`Failed to freeze ${path}.${name}`, err);
        }
        // This is okay, there are some typed arrays that cannot be frozen (encodingKeys)
      }
    } else if (typeof value === 'function') {
      Object.freeze(value);
    }
  }

  return Object.freeze(object);
}

function frozenMapSet(key: any, _value: any): Map<any, any> {
  throw `Can't add property ${key}, map is not extensible`;
}

function frozenMapDelete(key: any): boolean {
  throw `Can't delete property ${key}, map is frozen`;
}

function frozenMapClear() {
  throw "Can't clear map, map is frozen";
}

function frozenSetAdd(key: any): Set<any> {
  throw `Can't add key ${key}, set is not extensible`;
}

function frozenSetDelete(key: any): boolean {
  throw `Can't delete key ${key}, set is not extensible`;
}

function frozenSetClear() {
  throw "Can't clear set, set is frozen";
}
