import { randomUUID } from 'crypto';
import anyTest, { type TestFn } from 'ava';
import { Context as ActivityContext } from '@temporalio/activity';
import { ApplicationFailure, defaultPayloadConverter, toPayloads } from '@temporalio/common';
import type { Payload, PayloadCodec } from '@temporalio/common';
import { defaultOptions, isolateFreeWorker } from './mock-native-worker';

const test = anyTest as TestFn;

async function heartbeatThenFail(): Promise<never> {
  ActivityContext.current().heartbeat('some-details');
  throw ApplicationFailure.create({ message: 'activity failed as expected', nonRetryable: true });
}

class HangingPayloadCodec implements PayloadCodec {
  async encode(_payloads: Payload[]): Promise<Payload[]> {
    // Never resolves, e.g. a codec waiting on an unresponsive remote key service.
    return new Promise<Payload[]>(() => undefined);
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads;
  }
}

test('Failed Activity result is sent and Worker shuts down even if heartbeat encoding never finishes', async (t) => {
  const worker = isolateFreeWorker({
    ...defaultOptions,
    activities: { heartbeatThenFail },
    dataConverter: { payloadCodecs: [new HangingPayloadCodec()] },
  });
  const runPromise = worker.run();
  const start = Date.now();
  try {
    const taskToken = Buffer.from(randomUUID());
    const completion = await worker.native.runActivityTask({
      taskToken,
      start: {
        activityType: 'heartbeatThenFail',
        workflowExecution: { workflowId: 'wfid', runId: 'runId' },
        input: toPayloads(defaultPayloadConverter),
      },
    });
    // The failure is sent after the encode timeout instead of never being sent.
    t.truthy(completion.result?.failed);
    t.is(completion.result?.failed?.failure?.message, 'activity failed as expected');
    t.true(Date.now() - start < 10_000, 'Activity result was not delayed by more than the encode timeout');
  } finally {
    worker.shutdown();
    // Worker.shutdown() must finish even though the heartbeat encode never did.
    await runPromise;
  }
});

test('Failed Activity result still carries the failure when heartbeat encoding finishes normally', async (t) => {
  const worker = isolateFreeWorker({
    ...defaultOptions,
    activities: { heartbeatThenFail },
  });
  const runPromise = worker.run();
  try {
    const taskToken = Buffer.from(randomUUID());
    // Register the mock's heartbeat sink before the Activity heartbeats.
    const heartbeatPromise = worker.native.untilHeartbeat(taskToken);
    const completion = await worker.native.runActivityTask({
      taskToken,
      start: {
        activityType: 'heartbeatThenFail',
        workflowExecution: { workflowId: 'wfid', runId: 'runId' },
        input: toPayloads(defaultPayloadConverter),
      },
    });
    t.truthy(completion.result?.failed);
    t.is(completion.result?.failed?.failure?.message, 'activity failed as expected');
    // The heartbeat itself was still recorded normally.
    t.is(await heartbeatPromise, 'some-details');
  } finally {
    worker.shutdown();
    await runPromise;
  }
});
