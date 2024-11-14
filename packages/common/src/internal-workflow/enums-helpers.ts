import { ValueError } from '../errors';
import { Exact, RemovePrefix, UnionToIntersection } from '../type-helpers';

/**
 * Create encoding and decoding functions to convert between the numeric `enum` types produced by our
 * Protobuf compiler and "const object of strings" enum values that we expose in our public APIs.
 *
 * ### Usage
 *
 * Newly introduced enums should follow the following pattern:
 *
 * ```ts
 *     type ParentClosePolicy = (typeof ParentClosePolicy)[keyof typeof ParentClosePolicy];
 *     const ParentClosePolicy = {
 *       TERMINATE: 'TERMINATE',
 *       ABANDON: 'ABANDON',
 *       REQUEST_CANCEL: 'REQUEST_CANCEL',
 *     } as const;
 *
 *     const [encodeParentClosePolicy, decodeParentClosePolicy] = //
 *       makeProtoEnumConverters<
 *         coresdk.child_workflow.ParentClosePolicy,
 *         typeof coresdk.child_workflow.ParentClosePolicy,
 *         keyof typeof coresdk.child_workflow.ParentClosePolicy,
 *         typeof ParentClosePolicy,
 *         'PARENT_CLOSE_POLICY_'  // This may be an empty string if the proto enum doesn't add a repeated prefix on values
 *       >(
 *         {
 *           [ParentClosePolicy.TERMINATE]: 1, // These numbers must match the ones in the proto enum
 *           [ParentClosePolicy.ABANDON]: 2,
 *           [ParentClosePolicy.REQUEST_CANCEL]: 3,
 *
 *           UNSPECIFIED: 0,
 *         } as const,
 *         'PARENT_CLOSE_POLICY_'
 *       );
 * ```
 *
 * `makeProtoEnumConverters` supports other usage patterns, but they are only meant for
 * backward compatibility with former enum definitions and should not be used for new enums.
 *
 * ### Context
 *
 * Temporal's Protobuf APIs define several `enum` types; our Protobuf compiler transforms these to
 * traditional (i.e. non-const) [TypeScript numeric `enum`s](https://www.typescriptlang.org/docs/handbook/enums.html#numeric-enums).
 *
 * For various reasons, this is far from ideal:
 *
 *  - Due to the dual nature of non-const TypeScript `enum`s (they are both a type and a value),
 *    it is not possible to refer to an enum value from code without a "real" import of the enum type
 *    (i.e. can't simply do `import type ...`). In Workflow code, such an import would result in
 *    loading our entire Protobuf definitions into the workflow sandbox, adding several megabytes to
 *    the per-workflow memory footprint, which is unacceptable; to avoid that, we need to maintain
 *    a mirror copy of each enum types used by in-workflow APIs, and export these from either
 *    `@temporalio/common` or `@temporalio/workflow`.
 *  - It is not desirable for users to need an explicit dependency on `@temporalio/proto` just to
 *    get access to these enum types; we therefore made it a common practice to reexport these enums
 *    from our public facing packages. However, experience demontrated that these reexports effectively
 *    resulted in poor and inconsistent documentation coverage compared to mirrored enums types.
 *  - Our Protobuf enum types tend to follow a verbose and redundant naming convention, which feels
 *    unatural and excessive according to most TypeScript style guides; e.g. instead of
 *    `workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE`,
 *    a TypeScript developer would generally expect to be able to write something similar to
 *    `workflowIdReusePolicy: 'REJECT_DUPLICATE'`.
 *  - Because of the way Protobuf works, many of our enum types contain an `UNSPECIFIED` value, which
 *    is used to explicitly identify a value that is unset. In TypeScript code, the `undefined` value
 *    already serves that purpose, and is definitely more idiomatic to TS developers, whereas these
 *    `UNSPECIFIED` values create noise and confusion in our APIs.
 *  - TypeScript editors generally do a very bad job at providing autocompletion that implies reaching
 *    for values of a TypeScript enum type, forcing developers to explicitly type in at least part
 *    of the name of the enum type before they can get autocompletion for its values. On the other
 *    hand, all TS editors immediately provide autocompletion for string union types.
 *  - The [TypeScript's official documentation](https://www.typescriptlang.org/docs/handbook/enums.html#objects-vs-enums)
 *    itself suggests that, in modern TypeScript, the use of `as const` objects may generally suffice
 *    and may be advantageous over the use of `enum` types.
 *
 * A const object of strings, combined with a union type of possible string values, provides a much
 * more idiomatic syntax and a better DX for TypeScript developers. This however requires a way to
 * convert back and forth between the `enum` values produced by the Protobuf compiler and the
 * equivalent string values.
 *
 * This helper dynamically creates these conversion functions for a given Protobuf enum type,
 * strongly building upon specific conventions that we have adopted in our Protobuf definitions.
 *
 * ### Validations
 *
 * The complex type signature of this helper is there to prevent most potential incoherencies
 * that could result from having to manually synchronize the const object of strings enum and the
 * conversion table with the proto enum, while not requiring a regular import on the Protobuf enum
 * itself (so it can be used safely for enums meant to be used from workflow code).
 *
 * In particular, failing any of the following invariants will result in build time errors:
 *
 * - For every key of the form `PREFIX_KEY: number` in the proto enum, excluding the `UNSPECIFIED` key:
 *   - There MUST be a corresponding `KEY: 'KEY'` entry in the const object of strings enum;
 *   - There MAY be a corresponding `PREFIX_KEY: 'KEY'` in the const object of strings enum
 *     (this is meant to preserve backward compatibility with the former syntax; such aliases should
 *     not be added for new enums and enum entries introduced going forward);
 *   - There MUST be a corresponding `KEY: number` in the mapping table.
 * - If the proto enum contains a `PREFIX_UNSPECIFIED` entry, then:
 *   - There MAY be a corresponding `PREFIX_UNSPECIFIED: undefined` and/or `UNSPECIFIED: undefined`
 *     entries in the const object of strings enum — this is meant to preserve backward compatibility
 *     with the former syntax; this alias should not be added for new enums introduced going forward;
 *   - There MUST be an `UNSPECIFIED: 0` in the mapping table.
 * - The const object of strings enum MUST NOT contain any other keys than the ones mandated or
 *   optionally allowed be the preceeding rules.
 * - The mapping table MUST NOT contain any other keys than the ones mandated above.
 *
 * These rules notably ensure that whenever a new value is added to an existing Proto enum, the code
 * will fail to compile until the corresponding entry is added on the const object of strings enum
 * and the mapping table.
 *
 * @internal
 */
export function makeProtoEnumConverters<
  ProtoEnumValue extends number,
  ProtoEnum extends { [k in ProtoEnumKey]: ProtoEnumValue },
  ProtoEnumKey extends `${Prefix}${string}`,
  StringEnumTypeActual extends Exact<StringEnumType, StringEnumTypeActual>,
  Prefix extends string,
  //
  // Parameters after this point will be inferred; they're not meant not to be specified by developers
  Unspecified = ProtoEnumKey extends `${Prefix}UNSPECIFIED` ? 'UNSPECIFIED' : never,
  ShortStringEnumKey extends RemovePrefix<Prefix, ProtoEnumKey> = Exclude<
    RemovePrefix<Prefix, ProtoEnumKey>,
    Unspecified
  >,
  StringEnumType extends ProtoConstObjectOfStringsEnum<
    ShortStringEnumKey,
    Prefix,
    Unspecified
  > = ProtoConstObjectOfStringsEnum<ShortStringEnumKey, Prefix, Unspecified>,
  MapTable extends ProtoEnumToConstObjectOfStringMapTable<
    StringEnumType,
    ProtoEnumValue,
    ProtoEnum,
    ProtoEnumKey,
    Prefix,
    Unspecified,
    ShortStringEnumKey
  > = ProtoEnumToConstObjectOfStringMapTable<
    StringEnumType,
    ProtoEnumValue,
    ProtoEnum,
    ProtoEnumKey,
    Prefix,
    Unspecified,
    ShortStringEnumKey
  >,
>(
  mapTable: MapTable,
  prefix: Prefix
): [
  (
    input: ShortStringEnumKey | `${Prefix}${ShortStringEnumKey}` | ProtoEnumValue | null | undefined
  ) => ProtoEnumValue | undefined, //
  (input: ProtoEnumValue | null | undefined) => ShortStringEnumKey | undefined, //
] {
  const reverseTable: Record<ProtoEnumValue, ShortStringEnumKey> = Object.fromEntries(
    Object.entries(mapTable).map(([k, v]) => [v, k])
  );
  const hasUnspecified = (mapTable as any)['UNSPECIFIED'] === 0 || (mapTable as any)[`${prefix}UNSPECIFIED`] === 0;

  function isShortStringEnumKeys(x: unknown): x is ShortStringEnumKey {
    return typeof x === 'string' && x in mapTable;
  }

  function isNumericEnumValue(x: unknown): x is ProtoEnum[keyof ProtoEnum] {
    return typeof x === 'number' && x in reverseTable;
  }

  function encode(
    input: ShortStringEnumKey | `${Prefix}${ShortStringEnumKey}` | ProtoEnumValue | null | undefined
  ): ProtoEnumValue | undefined {
    if (input == null) {
      return undefined;
    } else if (typeof input === 'string') {
      let shorten: string = input;
      if (shorten.startsWith(prefix)) {
        shorten = shorten.slice(prefix.length);
      }
      if (isShortStringEnumKeys(shorten)) {
        return mapTable[shorten];
      }
      throw new ValueError(`Invalid enum value: '${input}'`);
    } else if (typeof input === 'number') {
      return input;
    } else {
      throw new ValueError(`Invalid enum value: '${input}' of type ${typeof input}`);
    }
  }

  function decode(input: ProtoEnumValue | null | undefined): ShortStringEnumKey | undefined {
    if (input == null) {
      return undefined;
    } else if (typeof input === 'number') {
      if (hasUnspecified && input === 0) {
        return undefined;
      }

      if (isNumericEnumValue(input)) {
        return reverseTable[input];
      }

      // We got a proto enum value that we don't yet know about (i.e. it didn't exist when this code
      // was compiled). This is certainly a possibility, but given how our APIs evolve, this is is
      // unlikely to be a terribly bad thing by itself (we avoid adding new enum values in places
      // that would break backward compatibility with existing deployed code). Therefore, throwing
      // on "unexpected" values is likely to end up causing more problems than it might avoid,
      // especially given that the decoded value may actually never get read anwyay.
      //
      // Therefore, we instead cheat on type constraints and return a string of the form "unknown_23".
      // That somewhat mirrors the behavior we'd get with the pure numerical approach.
      return `unknown_${input}` as ShortStringEnumKey;
    }

    throw new ValueError(`Invalid proto enum value: '${input}' of type ${typeof input}`);
  }

  return [encode, decode] as const;
}

/**
 * Given the exploded parameters of a proto enum (i.e. short keys, prefix, and short key of the
 * unspecified value), make a type that _exactly_ corresponds to the const object of strings enum,
 * e.g. the type that the developer is expected to write.
 *
 * For example, for coresdk.child_workflow.ParentClosePolicy, this evaluates to:
 *
 * {
 *   TERMINATE: "TERMINATE";
 *   ABANDON: "ABANDON";
 *   REQUEST_CANCEL: "REQUEST_CANCEL";
 *
 *   PARENT_CLOSE_POLICY_TERMINATE?: "TERMINATE";
 *   PARENT_CLOSE_POLICY_ABANDON?: "ABANDON";
 *   PARENT_CLOSE_POLICY_REQUEST_CANCEL?: "REQUEST_CANCEL";
 *
 *   PARENT_CLOSE_POLICY_UNSPECIFIED?: undefined;
 * }
 */
type ProtoConstObjectOfStringsEnum<
  ShortStringEnumKey extends string,
  Prefix extends string,
  Unspecified, // e.g. 'UNSPECIFIED'
> = UnionToIntersection<
  | {
      // e.g.: "TERMINATE": "TERMINATE"
      readonly [k in ShortStringEnumKey]: k;
    }
  | {
      [k in ShortStringEnumKey]: Prefix extends ''
        ? object
        : {
            // e.g.: "PARENT_CLOSE_POLICY_TERMINATE"?: "TERMINATE"
            readonly [kk in `${Prefix}${k}`]?: k;
          };
    }[ShortStringEnumKey]
  | (Unspecified extends string
      ? {
          // e.g.: "PARENT_CLOSE_POLICY_UNSPECIFIED"?: undefined
          [k in `${Prefix}${Unspecified}`]?: undefined;
        }
      : object)
  | (Unspecified extends string
      ? {
          // e.g.: "UNSPECIFIED"?: undefined
          [k in `${Unspecified}`]?: undefined;
        }
      : object)
>;

/**
 * Given the exploded parameters of a proto enum (i.e. short keys, prefix, and short key of the
 * unspecified value), make a type that _exactly_ corresponds to the mapping table that the user is
 * expected to provide.
 *
 * For example, for coresdk.child_workflow.ParentClosePolicy, this evaluates to:
 *
 * {
 *  UNSPECIFIED: 0,
 *  TERMINATE: 1,
 *  ABANDON: 2,
 *  REQUEST_CANCEL: 3,
 * }
 */
type ProtoEnumToConstObjectOfStringMapTable<
  _StringEnum extends ProtoConstObjectOfStringsEnum<ShortStringEnumKey, Prefix, Unspecified>,
  ProtoEnumValue extends number,
  ProtoEnum extends { [k in ProtoEnumKey]: ProtoEnumValue },
  ProtoEnumKey extends `${Prefix}${string}`,
  Prefix extends string,
  Unspecified,
  ShortStringEnumKey extends RemovePrefix<Prefix, ProtoEnumKey>,
> = UnionToIntersection<
  {
    [k in ProtoEnumKey]: {
      [kk in RemovePrefix<Prefix, k>]: ProtoEnum[k] extends number ? ProtoEnum[k] : never;
    };
  }[ProtoEnumKey]
>;
