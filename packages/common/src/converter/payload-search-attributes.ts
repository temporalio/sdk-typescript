import { decode, encode } from '../encoding';
import { ValueError } from '../errors';
import { Payload } from '../interfaces';
import {
  TypedSearchAttributes,
  SearchAttributeType,
  SearchAttributes,
  isValidValueForType,
  TypedSearchAttributeValue,
  SearchAttributePair,
  SearchAttributeUpdatePair,
  TypedSearchAttributeUpdateValue,
} from '../search-attributes';
import { PayloadConverter, JsonPayloadConverter, mapFromPayloads, mapToPayloads } from './payload-converter';

/**
 * Converts Search Attribute values using JsonPayloadConverter
 */
export class SearchAttributePayloadConverter implements PayloadConverter {
  jsonConverter = new JsonPayloadConverter();
  validNonDateTypes = ['string', 'number', 'boolean'];

  public toPayload(values: unknown): Payload {
    if (!Array.isArray(values)) {
      throw new ValueError(`SearchAttribute value must be an array`);
    }

    if (values.length > 0) {
      const firstValue = values[0];
      const firstType = typeof firstValue;
      if (firstType === 'object') {
        for (const [idx, value] of values.entries()) {
          if (!(value instanceof Date)) {
            throw new ValueError(
              `SearchAttribute values must arrays of strings, numbers, booleans, or Dates. The value ${value} at index ${idx} is of type ${typeof value}`
            );
          }
        }
      } else {
        if (!this.validNonDateTypes.includes(firstType)) {
          throw new ValueError(`SearchAttribute array values must be: string | number | boolean | Date`);
        }

        for (const [idx, value] of values.entries()) {
          if (typeof value !== firstType) {
            throw new ValueError(
              `All SearchAttribute array values must be of the same type. The first value ${firstValue} of type ${firstType} doesn't match value ${value} of type ${typeof value} at index ${idx}`
            );
          }
        }
      }
    }

    // JSON.stringify takes care of converting Dates to ISO strings
    const ret = this.jsonConverter.toPayload(values);
    if (ret === undefined) {
      throw new ValueError('Could not convert search attributes to payloads');
    }
    return ret;
  }

  /**
   * Datetime Search Attribute values are converted to `Date`s
   */
  public fromPayload<T>(payload: Payload): T {
    if (payload.metadata == null) {
      throw new ValueError('Missing payload metadata');
    }

    const value = this.jsonConverter.fromPayload(payload);
    let arrayWrappedValue = Array.isArray(value) ? value : [value];
    const searchAttributeType = decode(payload.metadata.type);
    if (searchAttributeType === 'Datetime') {
      arrayWrappedValue = arrayWrappedValue.map((dateString) => new Date(dateString));
    }
    return arrayWrappedValue as unknown as T;
  }
}

export const searchAttributePayloadConverter = new SearchAttributePayloadConverter();

export class TypedSearchAttributePayloadConverter implements PayloadConverter {
  jsonConverter = new JsonPayloadConverter();

  public toPayload<T>(attr: T): Payload {
    if (!(attr instanceof TypedSearchAttributeValue || attr instanceof TypedSearchAttributeUpdateValue)) {
      throw new ValueError(
        `Expect input to be instance of TypedSearchAttributeValue or TypedSearchAttributeUpdateValue, got: ${JSON.stringify(
          attr
        )}`
      );
    }

    // We check for deletion as well as regular typed search attributes.
    if (attr.value !== null && !isValidValueForType(attr.type, attr.value)) {
      throw new ValueError(`Invalid search attribute value ${attr.value} for given type ${attr.type}`);
    }

    // For server search attributes to work properly, we cannot set the metadata
    // type when we set null
    if (attr.value === null) {
      const payload = this.jsonConverter.toPayload(attr.value);
      if (payload === undefined) {
        throw new ValueError('Could not convert typed search attribute to payload');
      }
      return payload;
    }

    // JSON.stringify takes care of converting Dates to ISO strings
    const payload = this.jsonConverter.toPayload(attr.value);
    if (payload === undefined) {
      throw new ValueError('Could not convert typed search attribute to payload');
    }

    // Note: this shouldn't be the case but the compiler complains without this check.
    if (payload.metadata == null) {
      throw new ValueError('Missing payload metadata');
    }
    // Add encoded type of search attribute to metatdata
    payload.metadata['type'] = encode(TypedSearchAttributes.toMetadataType(attr.type));
    return payload;
  }

  // Note: type casting undefined values is not clear to caller.
  // We can't change the typing of the method to return undefined, it's not allowed by the interface.
  public fromPayload<T>(payload: Payload): T {
    if (payload.metadata == null) {
      throw new ValueError('Missing payload metadata');
    }

    // If no 'type' metadata field or no given value, we skip.
    if (payload.metadata.type == null) {
      return undefined as T;
    }
    const type = TypedSearchAttributes.toSearchAttributeType(decode(payload.metadata.type));
    // Unrecognized metadata type (sanity check).
    if (type === undefined) {
      return undefined as T;
    }

    let value = this.jsonConverter.fromPayload(payload);

    // Handle legacy values without KEYWORD_LIST type.
    if (type !== SearchAttributeType.KEYWORD_LIST && Array.isArray(value)) {
      // Cannot have an array with multiple values for non-KEYWORD_LIST type.
      if (value.length > 1) {
        return undefined as T;
      }
      // Unpack single value array.
      value = value[0];
    }
    if (type === SearchAttributeType.DATETIME && value) {
      value = new Date(value as string);
    }
    // Check if the value is a valid for the given type. If not, skip.
    if (!isValidValueForType(type, value)) {
      return undefined as T;
    }
    return new TypedSearchAttributeValue(type, value) as T;
  }
}

export const typedSearchAttributePayloadConverter = new TypedSearchAttributePayloadConverter();

// If both params are provided, conflicting keys will be overwritten by typedSearchAttributes.
export function encodeUnifiedSearchAttributes(
  searchAttributes?: SearchAttributes, // eslint-disable-line deprecation/deprecation
  typedSearchAttributes?: TypedSearchAttributes | SearchAttributeUpdatePair[]
): Record<string, Payload> {
  return {
    ...(searchAttributes ? mapToPayloads(searchAttributePayloadConverter, searchAttributes) : {}),
    ...(typedSearchAttributes
      ? mapToPayloads<string, TypedSearchAttributeUpdateValue<SearchAttributeType>>(
          typedSearchAttributePayloadConverter,
          Object.fromEntries(
            (Array.isArray(typedSearchAttributes) ? typedSearchAttributes : typedSearchAttributes.getAll()).map(
              (pair) => {
                return [pair.key.name, new TypedSearchAttributeUpdateValue(pair.key.type, pair.value)];
              }
            )
          )
        )
      : {}),
  };
}

// eslint-disable-next-line deprecation/deprecation
export function decodeSearchAttributes(indexedFields: Record<string, Payload> | undefined | null): SearchAttributes {
  if (!indexedFields) return {};
  return Object.fromEntries(
    // eslint-disable-next-line deprecation/deprecation
    Object.entries(mapFromPayloads(searchAttributePayloadConverter, indexedFields) as SearchAttributes).filter(
      ([_, v]) => v && v.length > 0
    ) // Filter out empty arrays returned by pre 1.18 servers
  );
}

export function decodeTypedSearchAttributes(
  indexedFields: Record<string, Payload> | undefined | null
): TypedSearchAttributes {
  return new TypedSearchAttributes(
    Object.entries(
      mapFromPayloads<string, TypedSearchAttributeValue<SearchAttributeType> | undefined>(
        typedSearchAttributePayloadConverter,
        indexedFields
      ) ?? {}
    ).reduce<SearchAttributePair[]>((acc, [k, attr]) => {
      // Filter out undefined values from converter.
      if (!attr) {
        return acc;
      }
      const key = { name: k, type: attr.type };
      // Ensure is valid pair.
      if (isValidValueForType(key.type, attr.value)) {
        acc.push({ key, value: attr.value } as SearchAttributePair);
      }
      return acc;
    }, [])
  );
}
