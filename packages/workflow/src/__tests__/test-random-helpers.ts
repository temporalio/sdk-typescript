import test from 'ava';
import { defaultPayloadConverter } from '@temporalio/common';
import type { UnsafeWorkflowInfo } from '../interfaces';
import { createUnsafeRandomSource } from '../random-helpers';

test('unsafe random source does not survive default JSON serialization', (t) => {
  const unsafe: UnsafeWorkflowInfo = {
    isReplaying: false,
    isReplayingHistoryEvents: false,
    now: Date.now,
    random: createUnsafeRandomSource(() => 0.5),
  };

  const payload = defaultPayloadConverter.toPayload({ unsafe });
  const converted = defaultPayloadConverter.fromPayload<{ unsafe: Record<string, unknown> }>(payload);

  t.deepEqual(converted.unsafe, {
    isReplaying: false,
    isReplayingHistoryEvents: false,
  });
  t.false('random' in converted.unsafe);
});
