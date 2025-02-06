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

export function toMetadataType(type: SearchAttributeType): string {
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

export function toSearchAttributeType(type: string): SearchAttributeType | undefined {
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

function searchAttributeKey<T extends SearchAttributeType>(name: string, type: T): SearchAttributeKey<T> {
  return { name, type };
}

export function searchAttributePair<T extends SearchAttributeType>(name: string, type: T, value: IndexedValueTypeMapping[T]): TypedSearchAttributePair {
  const key = searchAttributeKey(name, type);
  const typedValue: TypedSearchAttributeValue<T> = [type, value];
  return [key, typedValue] as TypedSearchAttributePair;
}

export function searchAttributeUpdatePair<T extends SearchAttributeType>(name: string, type: T, value: IndexedValueTypeMapping[T] | null): TypedSearchAttributeUpdatePair {
  const key = searchAttributeKey(name, type);
  const typedValue: TypedSearchAttributeValue<T> | null = value === null ? value : [type, value];
  return [key, typedValue] as TypedSearchAttributeUpdatePair;
}

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

export type SearchAttributeKey<T extends SearchAttributeType> = {
  name: string;
  type: T;
};

type IndexedValueTypeMapping = {
  TEXT: string;
  KEYWORD: string;
  INT: number;
  DOUBLE: number;
  BOOL: boolean;
  DATETIME: Date;
  KEYWORD_LIST: string[];
};

function isTypedSearchAttributeKey(key: unknown): key is SearchAttributeKey<SearchAttributeType> {
  return (
    key !== null &&
    key !== undefined &&
    typeof key === 'object' &&
    'name' in key &&
    typeof key.name === 'string' &&
    'type' in key &&
    typeof key.type === 'string' &&
    key.type in SearchAttributeType
  );
}

export function isTypedSearchAttribute(attr: unknown): attr is TypedSearchAttribute {
  if (attr === undefined) return false;
  if (!Array.isArray(attr) || attr.length !== 2) {
    return false;
  }

  const [type, value] = attr;
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

export function isTypedSearchAttributePair(pair: unknown): pair is TypedSearchAttributePair {
  if (!Array.isArray(pair) || pair.length !== 2) {
    return false;
  }
  const [key, value] = pair;
  return isTypedSearchAttributeKey(key) && isTypedSearchAttribute(value) && key.type === value[0];
}

export function isTypedSearchAttributeUpdate(attr: unknown): attr is TypedSearchAttributeUpdate {
  // Null is a valid update to delete the attribute.
  if (attr === null) return true;
  // Otherwise, the attribute must be a valid TypedSearchAttributeValue.
  return isTypedSearchAttribute(attr);
}

export function isTypedSearchAttributeUpdatePair(pair: unknown): pair is TypedSearchAttributeUpdatePair {
  if (!Array.isArray(pair) || pair.length !== 2) {
    return false;
  }
  const [key, value] = pair;
  return (
    isTypedSearchAttributeKey(key) && isTypedSearchAttributeUpdate(value) && (value === null || key.type === value[0])
  );
}

type TypedSearchAttributeValue<T extends SearchAttributeType> = [T, IndexedValueTypeMapping[T]];

export type TypedSearchAttribute = {
  [T in SearchAttributeType]: TypedSearchAttributeValue<T>;
}[SearchAttributeType];

export type TypedSearchAttributePair = {
  [T in SearchAttributeType]: [SearchAttributeKey<T>, TypedSearchAttributeValue<T>];
}[SearchAttributeType];

export type TypedSearchAttributeUpdate = {
  [T in SearchAttributeType]: TypedSearchAttributeValue<T> | null;
}[SearchAttributeType];

export type TypedSearchAttributeUpdatePair = {
  [T in SearchAttributeType]: [SearchAttributeKey<T>, TypedSearchAttributeValue<T> | null];
}[SearchAttributeType];

export class TypedSearchAttributes {
  private searchAttributes: Record<string, TypedSearchAttribute> = {};

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

  getSearchAttribute<T extends SearchAttributeType>(key: SearchAttributeKey<T>): TypedSearchAttribute | undefined {
    const value = this.searchAttributes[key.name];
    if (!isTypedSearchAttribute(value)) {
      return undefined;
    }

    const [actualType, _] = value;
    return actualType === key.type ? value : undefined;
  }

  /** Returns a copy of the current TypedSearchAttributes instance with the updated attributes. */
  updateSearchAttributes(pairs: TypedSearchAttributeUpdatePair[]): TypedSearchAttributes {
    // Create a deep copy of the current state.
    const newAttributes: Record<string, TypedSearchAttribute> = JSON.parse(JSON.stringify(this.searchAttributes));
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

  getSearchAttributes(): TypedSearchAttributePair[] {
    const res: TypedSearchAttributePair[] = [];
    for (const [key, value] of Object.entries(this.searchAttributes)) {
      if (isTypedSearchAttribute(value)) {
        const attrKey = searchAttributeKey(key, value[0]);
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
        return searchAttributeKey(key, SearchAttributeType.TEXT);
      case 'number':
        return searchAttributeKey(
          key,
          Number.isInteger(val) ? SearchAttributeType.INT : SearchAttributeType.DOUBLE
        );
      case 'boolean':
        return searchAttributeKey(key, SearchAttributeType.BOOL);
      case 'object':
        if (val instanceof Date) {
          return searchAttributeKey(key, SearchAttributeType.DATETIME);
        }
        if (Array.isArray(val) && val.every((item) => typeof item === 'string')) {
          return searchAttributeKey(key, SearchAttributeType.KEYWORD_LIST);
        }
      default:
        return;
    }
  }
}
