import type { temporal } from '@temporalio/proto';
import { makeProtoEnumConverters } from './internal-workflow';

/** @deprecated: Use {@link TypedSearchAttributes} instead */
export type SearchAttributeValueOrReadonly = SearchAttributeValue | Readonly<SearchAttributeValue> | undefined; // eslint-disable-line deprecation/deprecation
/** @deprecated: Use {@link TypedSearchAttributes} instead */
export type SearchAttributes = Record<string, SearchAttributeValueOrReadonly>; // eslint-disable-line deprecation/deprecation
/** @deprecated: Use {@link TypedSearchAttributes} instead */
export type SearchAttributeValue = string[] | number[] | boolean[] | Date[]; // eslint-disable-line deprecation/deprecation

export const SearchAttributeType = {
  TEXT: 'TEXT',
  KEYWORD: 'KEYWORD',
  INT: 'INT',
  DOUBLE: 'DOUBLE',
  BOOL: 'BOOL',
  DATETIME: 'DATETIME',
  KEYWORD_LIST: 'KEYWORD_LIST',
} as const;

export type SearchAttributeType = (typeof SearchAttributeType)[keyof typeof SearchAttributeType];

// Note: encodeSearchAttributeIndexedValueType exported for use in tests to register search attributes
// ts-prune-ignore-next
export const [encodeSearchAttributeIndexedValueType, _] = makeProtoEnumConverters<
  temporal.api.enums.v1.IndexedValueType,
  typeof temporal.api.enums.v1.IndexedValueType,
  keyof typeof temporal.api.enums.v1.IndexedValueType,
  typeof SearchAttributeType,
  'INDEXED_VALUE_TYPE_'
>(
  {
    [SearchAttributeType.TEXT]: 1,
    [SearchAttributeType.KEYWORD]: 2,
    [SearchAttributeType.INT]: 3,
    [SearchAttributeType.DOUBLE]: 4,
    [SearchAttributeType.BOOL]: 5,
    [SearchAttributeType.DATETIME]: 6,
    [SearchAttributeType.KEYWORD_LIST]: 7,
    UNSPECIFIED: 0,
  } as const,
  'INDEXED_VALUE_TYPE_'
);

interface IndexedValueTypeMapping {
  TEXT: string;
  KEYWORD: string;
  INT: number;
  DOUBLE: number;
  BOOL: boolean;
  DATETIME: Date;
  KEYWORD_LIST: string[];
}

export function isValidValueForType<T extends SearchAttributeType>(
  type: T,
  value: unknown
): value is IndexedValueTypeMapping[T] {
  switch (type) {
    case SearchAttributeType.TEXT:
    case SearchAttributeType.KEYWORD:
      return typeof value === 'string';
    case SearchAttributeType.INT:
      return Number.isInteger(value);
    case SearchAttributeType.DOUBLE:
      return typeof value === 'number';
    case SearchAttributeType.BOOL:
      return typeof value === 'boolean';
    case SearchAttributeType.DATETIME:
      return value instanceof Date;
    case SearchAttributeType.KEYWORD_LIST:
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
    default:
      return false;
  }
}

export interface SearchAttributeKey<T extends SearchAttributeType> {
  name: string;
  type: T;
}

export function defineSearchAttributeKey<T extends SearchAttributeType>(name: string, type: T): SearchAttributeKey<T> {
  return { name, type };
}

class BaseSearchAttributeValue<T extends SearchAttributeType, V = IndexedValueTypeMapping[T]> {
  private readonly _type: T;
  private readonly _value: V;

  constructor(type: T, value: V) {
    this._type = type;
    this._value = value;
  }

  get type(): T {
    return this._type;
  }

  get value(): V {
    return this._value;
  }
}

// Internal type for class private data.
// Exported for use in payload conversion.
export class TypedSearchAttributeValue<T extends SearchAttributeType> extends BaseSearchAttributeValue<T> {}
// ts-prune-ignore-next
export class TypedSearchAttributeUpdateValue<T extends SearchAttributeType> extends BaseSearchAttributeValue<
  T,
  IndexedValueTypeMapping[T] | null
> {}

export type SearchAttributePair = {
  [T in SearchAttributeType]: { key: SearchAttributeKey<T>; value: IndexedValueTypeMapping[T] };
}[SearchAttributeType];

export type SearchAttributeUpdatePair = {
  [T in SearchAttributeType]: { key: SearchAttributeKey<T>; value: IndexedValueTypeMapping[T] | null };
}[SearchAttributeType];

export class TypedSearchAttributes {
  private searchAttributes: Record<string, TypedSearchAttributeValue<SearchAttributeType>> = {};

  constructor(initialAttributes?: SearchAttributePair[]) {
    if (initialAttributes === undefined) return;
    for (const pair of initialAttributes) {
      if (pair.key.name in this.searchAttributes) {
        throw new Error(`Duplicate search attribute key: ${pair.key.name}`);
      }
      this.searchAttributes[pair.key.name] = new TypedSearchAttributeValue(pair.key.type, pair.value);
    }
  }

  get<T extends SearchAttributeType>(key: SearchAttributeKey<T>): IndexedValueTypeMapping[T] | undefined {
    const attr = this.searchAttributes[key.name];
    // Key not found or type mismatch.
    if (attr === undefined || !isValidValueForType(key.type, attr.value)) {
      return undefined;
    }
    return attr.value;
  }

  /** Returns a deep copy of the given TypedSearchAttributes instance */
  copy(): TypedSearchAttributes {
    const state: Record<string, TypedSearchAttributeValue<SearchAttributeType>> = {};

    for (const [key, attr] of Object.entries(this.searchAttributes)) {
      // Create a new instance with the same properties
      let value = attr.value;
      // For non-primitive types, create a deep copy
      if (attr.value instanceof Date) {
        value = new Date(attr.value);
      } else if (Array.isArray(attr.value)) {
        value = [...attr.value];
      }
      state[key] = new TypedSearchAttributeValue(attr.type, value);
    }

    // Create return value with manually assigned state.
    const res = new TypedSearchAttributes();
    res.searchAttributes = state;
    return res;
  }

  /**
   * @hidden
   * Return JSON representation of this class as SearchAttributePair[]
   * Default toJSON method is not used because it's JSON representation includes private state.
   */
  toJSON(): SearchAttributePair[] {
    return this.getAll();
  }

  /** Returns a copy of the current TypedSearchAttributes instance with the updated attributes. */
  updateCopy(updates: SearchAttributeUpdatePair[]): TypedSearchAttributes {
    // Create a deep copy of the current instance.
    const res = this.copy();
    // Apply updates.
    res.update(updates);
    return res;
  }

  // Performs direct mutation on the current instance.
  private update(updates: SearchAttributeUpdatePair[]) {
    // Apply updates.
    for (const pair of updates) {
      // Delete attribute.
      if (pair.value === null) {
        // Delete only if the update matches a key and type.
        const attrVal = this.searchAttributes[pair.key.name];
        if (attrVal && attrVal.type === pair.key.type) {
          delete this.searchAttributes[pair.key.name];
        }
        continue;
      }
      // Add or update attribute.
      this.searchAttributes[pair.key.name] = new TypedSearchAttributeValue(pair.key.type, pair.value);
    }
  }

  getAll(): SearchAttributePair[] {
    const res: SearchAttributePair[] = [];
    for (const [key, attr] of Object.entries(this.searchAttributes)) {
      const attrKey = { name: key, type: attr.type };
      // Sanity check, should always be legal.
      if (isValidValueForType(attrKey.type, attr.value)) {
        res.push({ key: attrKey, value: attr.value } as SearchAttributePair);
      }
    }
    return res;
  }

  static getKeyFromUntyped(
    key: string,
    value: SearchAttributeValueOrReadonly // eslint-disable-line deprecation/deprecation
  ): SearchAttributeKey<SearchAttributeType> | undefined {
    if (value == null) {
      return;
    }

    // Unpack single-element arrays.
    const val = value.length === 1 ? value[0] : value;
    switch (typeof val) {
      case 'string':
        // Check if val is an ISO string, if so, return a DATETIME key.
        if (!isNaN(Date.parse(val)) && Date.parse(val) === new Date(val).getTime()) {
          return { name: key, type: SearchAttributeType.DATETIME };
        }
        return { name: key, type: SearchAttributeType.TEXT };
      case 'number':
        return {
          name: key,
          type: Number.isInteger(val) ? SearchAttributeType.INT : SearchAttributeType.DOUBLE,
        };
      case 'boolean':
        return { name: key, type: SearchAttributeType.BOOL };
      case 'object':
        if (val instanceof Date) {
          return { name: key, type: SearchAttributeType.DATETIME };
        }
        if (Array.isArray(val) && val.every((item) => typeof item === 'string')) {
          return { name: key, type: SearchAttributeType.KEYWORD_LIST };
        }
        return;
      default:
        return;
    }
  }

  static toMetadataType(type: SearchAttributeType): string {
    switch (type) {
      case SearchAttributeType.TEXT:
        return 'Text';
      case SearchAttributeType.KEYWORD:
        return 'Keyword';
      case SearchAttributeType.INT:
        return 'Int';
      case SearchAttributeType.DOUBLE:
        return 'Double';
      case SearchAttributeType.BOOL:
        return 'Bool';
      case SearchAttributeType.DATETIME:
        return 'Datetime';
      case SearchAttributeType.KEYWORD_LIST:
        return 'KeywordList';
      default:
        throw new Error(`Unknown search attribute type: ${type}`);
    }
  }

  static toSearchAttributeType(type: string): SearchAttributeType | undefined {
    switch (type) {
      case 'Text':
        return SearchAttributeType.TEXT;
      case 'Keyword':
        return SearchAttributeType.KEYWORD;
      case 'Int':
        return SearchAttributeType.INT;
      case 'Double':
        return SearchAttributeType.DOUBLE;
      case 'Bool':
        return SearchAttributeType.BOOL;
      case 'Datetime':
        return SearchAttributeType.DATETIME;
      case 'KeywordList':
        return SearchAttributeType.KEYWORD_LIST;
      default:
        return;
    }
  }
}
