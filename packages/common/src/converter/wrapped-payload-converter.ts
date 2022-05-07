import { hasOwnProperty, isRecord, ValueError } from '@temporalio/internal-workflow-common';
import { PayloadConverter } from './payload-converter';
import { Payload } from './types';

export class WrappedPayloadConverter implements PayloadConverter {
  constructor(private readonly payloadConverter: PayloadConverter) {}

  public toPayload(value: unknown): Payload {
    const result = this.payloadConverter.toPayload(value);
    if (!isPayload(result)) {
      throw new ValueError(
        `The Payload Converter method ${
          Object.getPrototypeOf(this.payloadConverter).constructor.name
        }.toPayload must return a Payload. Received \`${result}\` of type \`${typeof result}\` when trying to convert \`${value}\` of type \`${typeof value}\`.`
      );
    }
    return result;
  }

  public fromPayload<T>(payload: Payload): T {
    return this.payloadConverter.fromPayload(payload);
  }
}

function isPayload(payload: unknown): boolean {
  return isRecord(payload) && (hasOwnProperty(payload, 'metadata') || hasOwnProperty(payload, 'data'));
}
