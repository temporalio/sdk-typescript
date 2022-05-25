import { ValueError } from '@temporalio/internal-workflow-common';
import { PayloadConverter } from './payload-converter';
import { JsonPayloadConverter } from './json-payload-converter';
import { Payload, str } from './types';

const jsonConverter = new JsonPayloadConverter();

/**
 *
 */
export class SearchAttributePayloadConverter implements PayloadConverter {
  public toPayload(value: unknown): Payload | undefined {
    if (value instanceof Array && value.length > 0 && value[0] instanceof Date) {
      value = (value as Date[]).map((date) => date.toISOString());
    }

    return jsonConverter.toPayload(value);
  }

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
