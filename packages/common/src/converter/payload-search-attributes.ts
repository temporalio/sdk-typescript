import { decode, encode } from '../encoding';
import { ValueError } from '../errors';
import { Payload, SearchAttributes } from '../interfaces';
import {
  defineSearchAttribute,
  isTypedSearchAttribute,
  isTypedSearchAttributePair,
  toMetadataType,
  toSearchAttributeType,
  TypedSearchAttributePair,
  TypedSearchAttributes,
  TypedSearchAttribute,
  SearchAttributeType,
  isTypedSearchAttributeUpdate,
} from '../typed-search-attributes';
import {
  PayloadConverter,
  JsonPayloadConverter,
  mapFromPayloads,
  typedMapFromPayloads,
  mapToPayloads,
  typedMapToPayloads,
} from './payload-converter';

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

  public toPayload<T>(typedSearchAttribute: T): Payload {
    // We check for deletion as well as regular typed search attributes.
    if (!isTypedSearchAttributeUpdate(typedSearchAttribute)) {
      throw new ValueError('Invalid typed search attribute');
    }

    // For server search attributes to work properly, we cannot set the metadata
    // type when we set null
    // TODO(thomas): comment cribbed from Python SDK (not sure why this is the case)
    if (typedSearchAttribute === null) {
      const payload = this.jsonConverter.toPayload(typedSearchAttribute);
      if (payload === undefined) {
        throw new ValueError('Could not convert typed search attribute to payload');
      }
      return payload;
    }

    const type = typedSearchAttribute[0];
    let value = typedSearchAttribute[1];
    if (type === SearchAttributeType.DATETIME) {
      // Convert Date to ISO string
      value = (value as Date).toISOString();
    }

    const payload = this.jsonConverter.toPayload(value);
    if (payload === undefined) {
      throw new ValueError('Could not convert typed search attribute to payload');
    }
    // Note: this shouldn't be the case but the compiler complains without this check.
    if (payload.metadata == null) {
      throw new ValueError('Missing payload metadata');
    }
    // Add encoded type of search attribute to metatdata
    payload.metadata['type'] = encode(toMetadataType(type));
    return payload;
  }

  // TODO(thomas): type casting undefined values is not clear to caller.
  // We can't change the typing of the method to return undefined, it's not allowed by the interface.
  // Suggested usage: typedMapFromPayloads<string, TypedSearchAttributeValue | undefined>
  public fromPayload<T>(payload: Payload): T {
    if (payload.metadata == null) {
      throw new ValueError('Missing payload metadata');
    }

    let value = this.jsonConverter.fromPayload(payload);
    // If no 'type' metadata field or no given value, we skip.
    if (payload.metadata.type == undefined) {
      return undefined as T;
    }
    const type = toSearchAttributeType(decode(payload.metadata.type));
    // Unrecognized metadata type (sanity check).
    if (type === undefined) {
      return undefined as T;
    }
    if (type === SearchAttributeType.DATETIME) {
      value = new Date(value as string);
    }
    // Check if the value is a valid typed search attribute. If not, skip.
    if (!isTypedSearchAttribute([type, value])) {
      return undefined as T;
    }
    return [type, value] as T;
  }
}

export const typedSearchAttributePayloadConverter = new TypedSearchAttributePayloadConverter();

// If both params are provided, conflicting keys will be overwritten by typedSearchAttributes.
export function encodeUnifiedSearchAttributes(
  searchAttributes?: SearchAttributes,
  typedSearchAttributes?: TypedSearchAttributes | TypedSearchAttributePair[]
): Record<string, Payload> {
  return {
    ...(searchAttributes ? mapToPayloads(searchAttributePayloadConverter, searchAttributes) : {}),
    ...(typedSearchAttributes
      ? typedMapToPayloads<string, TypedSearchAttribute>(
          typedSearchAttributePayloadConverter,
          Object.fromEntries(
            (Array.isArray(typedSearchAttributes)
              ? typedSearchAttributes
              : typedSearchAttributes.getSearchAttributes()
            ).map(([k, v]) => [k.name, v])
          )
        )
      : {}),
  };
}

export function decodeSearchAttributes(indexedFields: Record<string, Payload> | undefined | null): SearchAttributes {
  if (!indexedFields) return {};
  return Object.fromEntries(
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
      typedMapFromPayloads<string, TypedSearchAttribute | undefined>(
        typedSearchAttributePayloadConverter,
        indexedFields
      ) ?? {}
    ).reduce<TypedSearchAttributePair[]>((acc, [k, v]) => {
      // Filter out undefined values from converter.
      if (!v) {
        return acc;
      }
      const pair = [defineSearchAttribute(k, v[0]), v];
      // Ensure is valid pair.
      if (isTypedSearchAttributePair(pair)) {
        acc.push(pair);
      }
      return acc;
    }, [])
  );
}
