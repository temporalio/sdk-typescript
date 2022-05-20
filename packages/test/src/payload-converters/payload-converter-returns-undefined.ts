import { Payload, PayloadConverter, str, ValueError } from '@temporalio/common';

class TestPayloadConverter implements PayloadConverter {
  public toPayload(_value: unknown): Payload {
    return undefined as any;
  }

  public fromPayload<T>(content: Payload): T {
    if (content.data === undefined || content.data === null) {
      throw new ValueError('Got payload with no data');
    }
    return JSON.parse(str(content.data));
  }
}

export const payloadConverter = new TestPayloadConverter();
