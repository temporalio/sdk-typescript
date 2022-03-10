import { Payload, PayloadCodec } from '@temporalio/common';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { runIntegrationTests } from './integration-tests';

class TestPayloadCodec implements PayloadCodec {
  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => {
      if (payload.data) {
        payload.data = payload.data.map((byte) => byte + 1);
      }
      return payload;
    });
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
