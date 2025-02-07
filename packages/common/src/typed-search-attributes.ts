import type { temporal } from '@temporalio/proto';
import { makeProtoEnumConverters } from './internal-workflow';
import { SearchAttributeValueOrReadonly } from './interfaces';

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
export const [encodeSearchAttributeIndexedValueType, _decodeSearchAttributeIndexedValueType] = makeProtoEnumConverters<
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

type IndexedValueTypeMapping = {
  TEXT: string;
  KEYWORD: string;
  INT: number;
  DOUBLE: number;
  BOOL: boolean;
  DATETIME: Date;
  KEYWORD_LIST: string[];
};

export type SearchAttributeKey<T extends SearchAttributeType> = {
  name: string;
  type: T;
};

function isSearchAttributeKey(key: unknown): key is SearchAttributeKey<SearchAttributeType> {
  return (
    key != null &&
    typeof key === 'object' &&
    'name' in key &&
    typeof key.name === 'string' &&
    'type' in key &&
    typeof key.type === 'string' &&
    key.type in SearchAttributeType
  );
}

type BaseTypedValue<T extends SearchAttributeType> = [T, IndexedValueTypeMapping[T]];

export type TypedSearchAttributeValue = {
  [T in SearchAttributeType]: BaseTypedValue<T>;
}[SearchAttributeType];

export function isTypedSearchAttributeValue(typedValue: unknown): typedValue is TypedSearchAttributeValue {
  if (typedValue == null) return false;
  if (!Array.isArray(typedValue) || typedValue.length !== 2) {
    return false;
  }

  const [type, value] = typedValue;
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

export type TypedSearchAttributePair = {
  [T in SearchAttributeType]: [SearchAttributeKey<T>, BaseTypedValue<T>];
}[SearchAttributeType];

export function isTypedSearchAttributePair(pair: unknown): pair is TypedSearchAttributePair {
  if (!Array.isArray(pair) || pair.length !== 2) {
    return false;
  }
  const [key, value] = pair;
  return isSearchAttributeKey(key) && isTypedSearchAttributeValue(value) && key.type === value[0];
}

export type TypedSearchAttributeUpdateValue = TypedSearchAttributeValue | null;

export function isTypedSearchAttributeUpdateValue(attr: unknown): attr is TypedSearchAttributeUpdateValue {
  return attr === null || isTypedSearchAttributeValue(attr);
}

export type TypedSearchAttributeUpdatePair = {
  [T in SearchAttributeType]: [SearchAttributeKey<T>, TypedSearchAttributeUpdateValue];
}[SearchAttributeType];

export function isTypedSearchAttributeUpdatePair(pair: unknown): pair is TypedSearchAttributeUpdatePair {
  if (!Array.isArray(pair) || pair.length !== 2) {
    return false;
  }
  const [key, value] = pair;
  return (
    isSearchAttributeKey(key) && isTypedSearchAttributeUpdateValue(value) && (value === null || key.type === value[0])
  );
}

export class TypedSearchAttributes {
  private searchAttributes: Record<string, TypedSearchAttributeValue> = {};

  constructor(initialAttributes?: TypedSearchAttributePair[]) {
    if (initialAttributes === undefined) return;
    for (const [key, value] of initialAttributes) {
      if (key.name in this.searchAttributes) {
        throw new Error(`Duplicate search attribute key: ${key.name}`);
      }
      // Filter out undefined entries.
      if (value === undefined) {
        continue;
      }
      this.searchAttributes[key.name] = value;
    }
  }

  getValue<T extends SearchAttributeType>(key: SearchAttributeKey<T>): TypedSearchAttributeValue | undefined {
    const value = this.searchAttributes[key.name];
    if (!isTypedSearchAttributeValue(value)) {
      return undefined;
    }

    const [actualType, _] = value;
    return actualType === key.type ? value : undefined;
  }

  /** Returns a copy of the current TypedSearchAttributes instance with the updated attributes. */
  updateAttributes(pairs: TypedSearchAttributeUpdatePair[]): TypedSearchAttributes {
    // Create a deep copy of the current state.
    const newAttributes: Record<string, TypedSearchAttributeValue> = JSON.parse(JSON.stringify(this.searchAttributes));
    // Apply updates.
    for (const [key, value] of pairs) {
      // Delete attribute.
      if (value === null) {
        delete newAttributes[key.name];
        continue;
      }
      // Add or update attribute.
      newAttributes[key.name] = value;
    }
    // Return new copy with the updated attributes.
    const typedSearchAttributes = new TypedSearchAttributes();
    for (const [key, value] of Object.entries(newAttributes)) {
      // Filter out undefined entries.
      if (value === undefined) {
        continue;
      }
      // Set date values to Date objects.
      if (value[0] === SearchAttributeType.DATETIME) {
        value[1] = new Date(value[1]);
      }
      typedSearchAttributes.searchAttributes[key] = value;
    }
    return typedSearchAttributes;
  }

  getAttributes(): TypedSearchAttributePair[] {
    const res: TypedSearchAttributePair[] = [];
    for (const [key, value] of Object.entries(this.searchAttributes)) {
      if (isTypedSearchAttributeValue(value)) {
        const attrKey = TypedSearchAttributes.createKey(key, value[0]);
        const pair = [attrKey, value];
        // Sanity check, should always be legal.
        if (isTypedSearchAttributePair(pair)) {
          res.push(pair);
        }
      }
    }
    return res;
  }

  static getKeyFromUntyped(
    key: string,
    value: SearchAttributeValueOrReadonly
  ): SearchAttributeKey<SearchAttributeType> | undefined {
    if (!value) {
      return;
    }

    // Unpack single-element arrays.
    const val = value.length === 1 ? value[0] : value;
    switch (typeof val) {
      case 'string':
        return TypedSearchAttributes.createKey(key, SearchAttributeType.TEXT);
      case 'number':
        return TypedSearchAttributes.createKey(
          key,
          Number.isInteger(val) ? SearchAttributeType.INT : SearchAttributeType.DOUBLE
        );
      case 'boolean':
        return TypedSearchAttributes.createKey(key, SearchAttributeType.BOOL);
      case 'object':
        if (val instanceof Date) {
          return TypedSearchAttributes.createKey(key, SearchAttributeType.DATETIME);
        }
        if (Array.isArray(val) && val.every((item) => typeof item === 'string')) {
          return TypedSearchAttributes.createKey(key, SearchAttributeType.KEYWORD_LIST);
        }
        return;
      default:
        return;
    }
  }

  static createKey<T extends SearchAttributeType>(name: string, type: T): SearchAttributeKey<T> {
    return { name, type };
  }

  static createAttribute<T extends SearchAttributeType>(
    name: string,
    type: T,
    value: IndexedValueTypeMapping[T]
  ): TypedSearchAttributePair {
    const key = TypedSearchAttributes.createKey(name, type);
    const typedValue: BaseTypedValue<T> = [type, value];
    return [key, typedValue] as TypedSearchAttributePair;
  }

  static createUpdateAttribute<T extends SearchAttributeType>(
    name: string,
    type: T,
    value: IndexedValueTypeMapping[T] | null
  ): TypedSearchAttributeUpdatePair {
    const key = TypedSearchAttributes.createKey(name, type);
    const typedValue: BaseTypedValue<T> | null = value === null ? value : [type, value];
    return [key, typedValue] as TypedSearchAttributeUpdatePair;
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
