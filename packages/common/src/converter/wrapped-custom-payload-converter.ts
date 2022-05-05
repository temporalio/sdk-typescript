import { hasOwnProperty, isRecord, ValueError } from '@temporalio/internal-workflow-common';
import { PayloadConverter } from './payload-converter';
import { Payload } from './types';

export class WrappedCustomPayloadConverter implements PayloadConverter {
  constructor(private readonly customPayloadConverter: PayloadConverter) {}

  public toPayload(value: unknown): Payload {
    const result = this.customPayloadConverter.toPayload(value);
    if (!isPayload(result)) {
      throw new ValueError(`Custom PayloadConverter must return a Payload`);
    }
    return result;
  }

  public fromPayload<T>(payload: Payload): T {
    return this.customPayloadConverter.fromPayload(payload);
  }
}

function isPayload(payload: unknown): boolean {
  return isRecord(payload) && (hasOwnProperty(payload, 'metadata') || hasOwnProperty(payload, 'data'));
}
