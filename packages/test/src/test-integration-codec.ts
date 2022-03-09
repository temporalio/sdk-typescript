import { EncodedPayload, Payload, PayloadCodec } from '@temporalio/common';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { runIntegrationTests } from './integration-tests';

class TestPayloadCodec implements PayloadCodec {
  async encode(payloads: Payload[]): Promise<EncodedPayload[]> {
    return payloads.map((payload) => ({
      ...payload,
      ...(payload.data && { data: payload.data.map((byte) => byte + 1) }),
      encoded: true,
    }));
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => {
      if (payload.data) {
        payload.data = payload.data.map((byte) => byte - 1);
      }
      return payload;
    });
  }
}

if (RUN_INTEGRATION_TESTS) {
  runIntegrationTests(new TestPayloadCodec());
}
