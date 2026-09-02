import test from 'ava';
import type { LoadedDataConverter, PayloadCodec, PayloadConverter } from '@temporalio/common';
import {
  ApplicationFailure,
  createPayloadValidationError,
  defaultFailureConverter,
  defaultPayloadConverter,
  noopMetricMeter,
} from '@temporalio/common';
import { Activity } from '@temporalio/worker/lib/activity';
import { DefaultLogger } from '@temporalio/worker';
import { defaultActivityInfo } from '@temporalio/testing';

const activityContext = {
  type: 'activity' as const,
  namespace: 'default',
  workflowId: 'workflow-id',
  activityId: 'activity-id',
  isLocal: false,
};

function makeActivity(
  dataConverter: LoadedDataConverter,
  fn: () => Promise<unknown> = async () => ({ reject: true })
): Activity {
  return new Activity(
    defaultActivityInfo,
    fn,
    dataConverter,
    activityContext,
    undefined,
    () => undefined,
    undefined,
    new DefaultLogger('ERROR'),
    noopMetricMeter,
    []
  );
}

test('handler-thrown PayloadValidationError remains non-retryable', async (t) => {
  const original = createPayloadValidationError({ field: 'handler' });
  const result = await makeActivity(
    {
      payloadConverter: defaultPayloadConverter,
      payloadCodecs: [],
      failureConverter: defaultFailureConverter,
    },
    async () => {
      throw original;
    }
  ).run({ args: [], headers: {} });
  const decoded = defaultFailureConverter.failureToError(result.failed!.failure!, defaultPayloadConverter);

  t.true(decoded instanceof ApplicationFailure);
  t.true((decoded as ApplicationFailure).nonRetryable);
});

for (const kind of ['payload converter', 'payload codec'] as const) {
  test(`automatic Activity ${kind} output clones PayloadValidationError as retryable`, async (t) => {
    const original = createPayloadValidationError({ field: 'invalid' });
    let payloadConverter: PayloadConverter = defaultPayloadConverter;
    let payloadCodecs: PayloadCodec[] = [];
    if (kind === 'payload converter') {
      payloadConverter = {
        toPayload(value, context) {
          if ((value as any)?.reject === true) throw original;
          return defaultPayloadConverter.toPayload(value, context);
        },
        fromPayload(payload, context) {
          return defaultPayloadConverter.fromPayload(payload, context);
        },
      };
    } else {
      payloadCodecs = [
        {
          async encode(payloads) {
            if (payloads.some((payload) => defaultPayloadConverter.fromPayload<any>(payload)?.reject === true)) {
              throw original;
            }
            return payloads;
          },
          async decode(payloads) {
            return payloads;
          },
        },
      ];
    }

    const result = await makeActivity({
      payloadConverter,
      payloadCodecs,
      failureConverter: defaultFailureConverter,
    }).run({
      args: [],
      headers: {},
    });
    const decoded = defaultFailureConverter.failureToError(result.failed!.failure!, defaultPayloadConverter);

    t.true(decoded instanceof ApplicationFailure);
    t.is((decoded as ApplicationFailure).type, 'PayloadValidationError');
    t.false((decoded as ApplicationFailure).nonRetryable);
    t.deepEqual((decoded as ApplicationFailure).details, [{ field: 'invalid' }]);
    t.true(original.nonRetryable);
  });
}
