import type { Payload, PayloadConverter } from '@temporalio/common';
import { ValueError } from '@temporalio/common';
import { decode } from '@temporalio/common/lib/encoding';

class TestPayloadConverter implements PayloadConverter {
  public toPayload(_value: unknown): Payload {
    return undefined as any;
  }

  public fromPayload<T>(content: Payload): T {
    if (content.data === undefined || content.data === null) {
      throw new ValueError('Got payload with no data');
    }
    return JSON.parse(decode(content.data));
  }
}

export const payloadConverter = new TestPayloadConverter();
