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

export type CheckConstEnum<
  PREFIX extends string,
  TS_KEYS_ALL extends string,
  TS_KEYS extends TS_KEYS_ALL,
  TS_TYPE extends { [k in TS_KEYS_ALL]: TS_KEYS },
  PROTO_KEYS extends `${PREFIX}${TS_KEYS}`,
  PROTO_TYPE extends { [k in `${PREFIX}${TS_KEYS}`]: number },
  TS_TO_PROTO_MAP extends { [k in TS_KEYS]: PROTO_TYPE[PROTO_KEYS] },
> = {
  // For every keys in the TS Const Object…
  [k in TS_KEYS_ALL]: {
    key: k;

    // The equivalent string value, according to the const obj definition (e.g. `'ALLOW_DUPLICATE'`)
    StringValue: TS_TYPE[k];

    // The equivalent string value, expected from removing prefix (e.g. `'ALLOW_DUPLICATE'`)
    StringValueExpected: k extends `${PREFIX}${infer kk}` ? kk : k;

    // The corresponding protobuf enum value name (e.g. `'WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE'`)
    ProtoEnumName: `${PREFIX}${TS_TYPE[k]}`;

    // The corresponding protobuf enum value number, according to conversion map (e.g. `2`)
    ProtoNumber: TS_TO_PROTO_MAP[TS_TYPE[k]];

    // The corresponding protobuf enum value number, according to the protobuf definition (e.g. `2`)
    ProtoNumberExpected: PROTO_TYPE[`${PREFIX}${TS_TYPE[k]}`];

    Issues: (k extends `${PREFIX}${infer kk}`
      ? TS_TYPE[k] extends kk
        ? {
            /*empty*/
          }
        : {
            name_mismatch: TS_TYPE[k];
            expected: kk;
            fail: true;
          }
      : TS_TYPE[k] extends k
        ? {
            /*empty*/
          }
        : {
            name_mismatch: TS_TYPE[k];
            expected: k;
            fail: true;
          }) &
      (TS_TO_PROTO_MAP[TS_TYPE[k]] extends PROTO_TYPE[`${PREFIX}${TS_TYPE[k]}`]
        ? PROTO_TYPE[`${PREFIX}${TS_TYPE[k]}`] extends TS_TO_PROTO_MAP[TS_TYPE[k]]
          ? {
              /*empty*/
            }
          : {
              value_mismatch: TS_TO_PROTO_MAP[TS_TYPE[k]];
              expected: PROTO_TYPE[`${PREFIX}${TS_TYPE[k]}`];
              fail: true;
            }
        : {
            value_mismatch: TS_TO_PROTO_MAP[TS_TYPE[k]];
            expected: PROTO_TYPE[`${PREFIX}${TS_TYPE[k]}`];
            fail: true;
          });
  };
}[TS_KEYS_ALL]['Issues'];

/** Verify that an type _Copy extends _Orig */
export function AssertType<_CHECK extends { fail?: never }>(): void {
  // noop, just type check
}

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

// Thanks MDN: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/freeze
export function deepFreeze<T>(object: T): T {
  // Retrieve the property names defined on object
  const propNames = Object.getOwnPropertyNames(object);

  // Freeze properties before freezing self
  for (const name of propNames) {
    const value = (object as any)[name];

    if (value && typeof value === 'object') {
      try {
        deepFreeze(value);
      } catch (err) {
        // This is okay, there are some typed arrays that cannot be frozen (encodingKeys)
      }
    } else if (typeof value === 'function') {
      Object.freeze(value);
    }
  }

  return Object.freeze(object);
}
