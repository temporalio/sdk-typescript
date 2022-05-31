import { IllegalStateError, ValueError } from '@temporalio/internal-workflow-common';
import { PayloadConverter } from './payload-converter';
import { JsonPayloadConverter } from './json-payload-converter';
import { Payload, str } from './types';

const jsonConverter = new JsonPayloadConverter();
const validNonDateTypes = ['string', 'number', 'boolean'];

/**
 * Converts Search Attribute values using JsonPayloadConverter
 */
export class SearchAttributePayloadConverter implements PayloadConverter {
  public toPayload(values: unknown): Payload {
    if (!(values instanceof Array)) {
      throw new ValueError(`SearchAttribute value must be an array`);
    }

    if (values.length > 0) {
      const firstValue = values[0];
      const firstType = typeof firstValue;
      if (firstType === 'object') {
        for (const value of values) {
          if (!(value instanceof Date)) {
            throw new ValueError(
              `SearchAttribute values must arrays of strings, numbers, booleans, or Dates. This value ${value} is a ${typeof value}.`
            );
          }
        }
      } else {
        if (!validNonDateTypes.includes(firstType)) {
          throw new ValueError(`SearchAttribute array values must be: string | number | boolean | Date`);
        }

        for (const value of values) {
          if (typeof value !== firstType) {
            throw new ValueError(
              `All SearchAttribute array values must be of the same type. The first value ${firstValue} of type ${firstType} doesn't match value ${value} of type ${typeof value}.`
            );
          }
        }
      }
    }

    // JSON.stringify takes care of converting Dates to ISO strings
    const ret = jsonConverter.toPayload(values);
    if (ret === undefined) {
      throw new IllegalStateError('Could not convert search attributes to payloads');
    }
    return ret;
  }

  /**
   * Datetime Search Attribute values are converted to `Date`s
   */
  public fromPayload<T>(payload: Payload): T {
    if (payload.metadata === undefined || payload.metadata === null) {
      throw new ValueError('Missing payload metadata');
    }

    const value = jsonConverter.fromPayload(payload);
    let arrayWrappedValue = value instanceof Array ? value : [value];

    const searchAttributeType = str(payload.metadata.type);
    if (searchAttributeType === 'Datetime') {
      arrayWrappedValue = arrayWrappedValue.map((dateString) => new Date(dateString));
    }
    return arrayWrappedValue as unknown as T;
  }
}
