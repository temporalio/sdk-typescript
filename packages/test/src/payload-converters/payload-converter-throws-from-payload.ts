import { encodingKeys, METADATA_ENCODING_KEY, Payload, PayloadConverter, u8 } from '@temporalio/common';

class TestPayloadConverter implements PayloadConverter {
  public toPayload(value: unknown): Payload {
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_JSON,
      },
      data: u8(JSON.stringify(value)),
    };
  }

  public fromPayload<T>(content: Payload): T {
    throw new Error('test fromPayload');
  }
}

export const payloadConverter = new TestPayloadConverter();
