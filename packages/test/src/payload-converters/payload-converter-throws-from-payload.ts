import type { Payload, PayloadConverter } from '@temporalio/common';
import { encodingKeys, METADATA_ENCODING_KEY } from '@temporalio/common';
import { encode } from '@temporalio/common/lib/encoding';

class TestPayloadConverter implements PayloadConverter {
  public toPayload(value: unknown): Payload {
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_JSON,
      },
      data: encode(JSON.stringify(value)),
    };
  }

  public fromPayload<T>(_content: Payload): T {
    throw new Error('test fromPayload');
  }
}

export const payloadConverter = new TestPayloadConverter();
