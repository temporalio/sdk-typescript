import test from 'ava';
import * as nexus from 'nexus-rpc';
import { createPayloadValidationError, defaultDataConverter, defaultPayloadConverter } from '@temporalio/common';
import { coerceToHandlerError, encodeNexusResult } from '@temporalio/worker/lib/nexus/conversions';

test('encodeNexusResult makes converter PayloadValidationError output retryable INTERNAL', async (t) => {
  const cause = createPayloadValidationError({ field: 'invalid' });
  const handlerError = await t.throwsAsync(
    encodeNexusResult(
      {
        ...defaultDataConverter,
        payloadConverter: {
          toPayload() {
            throw cause;
          },
          fromPayload(payload, context) {
            return defaultPayloadConverter.fromPayload(payload, context);
          },
        },
      },
      'output'
    ),
    { instanceOf: nexus.HandlerError }
  );

  t.is(handlerError?.type, 'INTERNAL');
  t.true(handlerError?.retryable);
  t.is(handlerError?.cause, cause);
});

test('handler-thrown PayloadValidationError keeps ordinary non-retryable handler behavior', (t) => {
  const cause = createPayloadValidationError({ field: 'handler' });
  const handlerError = coerceToHandlerError(cause);

  t.is(handlerError.type, 'INTERNAL');
  t.false(handlerError.retryable);
  t.is(handlerError.cause, cause);
});
