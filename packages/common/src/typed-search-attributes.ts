import type { temporal } from '@temporalio/proto';
import { makeProtoEnumConverters } from './internal-workflow';
import { SearchAttributeValueOrReadonly } from './interfaces';

// TODO(thomas): create `internal` package for internal types/helpers (hold off on this until the end)

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

export function defineSearchAttribute<T extends SearchAttributeType>(name: string, type: T): SearchAttributeKey<T> {
  return { name, type };
}

const [_encodeSearchAttributeIndexedValueType, _decodeSearchAttributeIndexedValueType] = makeProtoEnumConverters<
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

export function isTypedSearchAttribute(attr: unknown): attr is TypedSearchAttributeValue {
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
  return (
    typeof key === 'object' && 'name' in key && 'type' in key && isTypedSearchAttribute(value) && key.type === value[0]
  );
}

type TypedSearchAttribute<T extends SearchAttributeType> = [T, IndexedValueTypeMapping[T]];

// TODO(thomas): find a way where we don't have to export this (internal package or something)
export type TypedSearchAttributeValue = {
  [T in SearchAttributeType]: TypedSearchAttribute<T>;
}[SearchAttributeType];

export type TypedSearchAttributePair = {
  [T in SearchAttributeType]: [SearchAttributeKey<T>, TypedSearchAttribute<T>];
}[SearchAttributeType];

export type DeleteTypedSearchAttributePair = [SearchAttributeKey<SearchAttributeType>, undefined];

export interface ITypedSearchAttributes {
  getSearchAttribute<T extends SearchAttributeType>(key: SearchAttributeKey<T>): TypedSearchAttributeValue | undefined;
  getSearchAttributes(): TypedSearchAttributePair[];
  updateSearchAttribute(pair: TypedSearchAttributePair | DeleteTypedSearchAttributePair): void;
}

// TODO(thomas): maybe no export (internal package or something)
export class TypedSearchAttributes implements ITypedSearchAttributes {
  private searchAttributes: Record<string, TypedSearchAttributeValue> = {};

  constructor(initialAttributes?: Record<string, TypedSearchAttributeValue>) {
    if (initialAttributes === undefined) return;
    for (const [key, value] of Object.entries(initialAttributes)) {
      if (key in this.searchAttributes) {
        throw new Error(`Duplicate search attribute key: ${key}`);
      }
      // Filter out undefined entries.
      if (value === undefined) {
        continue;
      }
      this.searchAttributes[key] = value;
    }
  }

  getSearchAttribute<T extends SearchAttributeType>(key: SearchAttributeKey<T>): TypedSearchAttributeValue | undefined {
    const value = this.searchAttributes[key.name];
    if (value === undefined || !isTypedSearchAttribute(value)) {
      return undefined;
    }

    const [actualType, _] = value;
    return actualType === key.type ? value : undefined;
  }

  updateSearchAttribute(pair: TypedSearchAttributePair | DeleteTypedSearchAttributePair): void {
    const [key, value] = pair;
    if (value === undefined) {
      delete this.searchAttributes[key.name];
      return;
    }
    this.searchAttributes[key.name] = value;
  }

  getSearchAttributes(): TypedSearchAttributePair[] {
    const res: TypedSearchAttributePair[] = [];
    for (const [key, value] of Object.entries(this.searchAttributes)) {
      if (isTypedSearchAttribute(value)) {
        const attrKey = defineSearchAttribute(key, value[0]);
        // Note: need to type cast, compiler can't keep track that the type is correct due to the union type of the key.
        const pair = [attrKey, value];
        // Sanity check
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
    switch (typeof value) {
      case 'string':
        return defineSearchAttribute(key, SearchAttributeType.TEXT);
      case 'number':
        return defineSearchAttribute(
          key,
          Number.isInteger(value) ? SearchAttributeType.INT : SearchAttributeType.DOUBLE
        );
      case 'boolean':
        return defineSearchAttribute(key, SearchAttributeType.BOOL);
      case 'object':
        if (value instanceof Date) {
          return defineSearchAttribute(key, SearchAttributeType.DATETIME);
        }
        if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
          return defineSearchAttribute(key, SearchAttributeType.KEYWORD_LIST);
        }
        return;
      default:
        return;
    }
  }

  static pairsToMap(pairs: TypedSearchAttributePair[]): Record<string, TypedSearchAttributeValue> {
    const res: Record<string, TypedSearchAttributeValue> = {};
    for (const [key, value] of pairs) {
      res[key.name] = value;
    }
    return res;
  }

  static fromPairs(pairs: TypedSearchAttributePair[]): TypedSearchAttributes {
    return new TypedSearchAttributes(TypedSearchAttributes.pairsToMap(pairs));
  }
}
