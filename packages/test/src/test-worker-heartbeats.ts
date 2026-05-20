import test from 'ava';
import { firstValueFrom, Subject } from 'rxjs';
import { randomUUID } from 'node:crypto';
import type { coresdk } from '@temporalio/proto';
import { Context } from '@temporalio/activity';
import type { PayloadCodec } from '@temporalio/common';
import { defaultPayloadConverter } from '@temporalio/common';
import type { Worker } from './mock-native-worker';
import { isolateFreeWorker } from './mock-native-worker';
import { contextToTraceString, makeContextTrace } from './payload-converters/serialization-context-converter';

async function runActivity(worker: Worker, callback?: (completion: coresdk.ActivityTaskCompletion) => void) {
  const taskToken = Buffer.from(randomUUID());
  await worker.runUntil(async () => {
    const completion = await worker.native.runActivityTask({
      taskToken,
      start: { activityType: 'rapidHeartbeater', workflowExecution: { workflowId: 'wfid', runId: 'runid' } },
    });
    callback?.(completion);
  });
}

test('Worker stores last heartbeat if flushing is in progress', async (t) => {
  const subj = new Subject<void>();

  const worker = isolateFreeWorker({
    taskQueue: 'unused',
    activities: {
      async rapidHeartbeater() {
        Context.current().heartbeat(1);
        // These details should be overriden by `3`
        Context.current().heartbeat(2);
        // This details should be flushed
        Context.current().heartbeat(3);
        // Prevent activity from completing
        await firstValueFrom(subj);
      },
    },
  });

  const heartbeatsSeen = Array<number>();
  worker.native.activityHeartbeatCallback = (_tt, details) => {
    heartbeatsSeen.push(details);
    if (heartbeatsSeen.length === 2) {
      subj.next();
    }
  };
  await runActivity(worker);
  t.deepEqual(heartbeatsSeen, [1, 3]);
});

test('Worker flushes last heartbeat if activity fails', async (t) => {
  const worker = isolateFreeWorker({
    taskQueue: 'unused',
    activities: {
      async rapidHeartbeater() {
        Context.current().heartbeat(1);
        // These details should be overriden by `3`
        Context.current().heartbeat(2);
        // This details should be flushed
        Context.current().heartbeat(3);
        // Fail
        throw new Error();
      },
    },
  });

  const heartbeatsSeen = Array<number>();
  worker.native.activityHeartbeatCallback = (_tt, details) => {
    heartbeatsSeen.push(details);
  };
  await runActivity(worker);
  t.deepEqual(heartbeatsSeen, [1, 3]);
});

test('Worker ignores last heartbeat if activity succeeds', async (t) => {
  const subj = new Subject<void>();

  const activityCompletePromise = firstValueFrom(subj);
  const worker = isolateFreeWorker({
    taskQueue: 'unused',
    dataConverter: {
      payloadCodecs: [
        {
          async encode(p) {
            // Don't complete encoding heartbeat details until activity has completed.
            // data will be undefined when this method gets the activity result for completion.
            if (p[0].data !== undefined) {
              await activityCompletePromise;
            }
            return p;
          },
          async decode(p) {
            return p;
          },
        },
      ],
    },
    activities: {
      async rapidHeartbeater() {
        Context.current().heartbeat(1);
        Context.current().heartbeat(2);
        Context.current().heartbeat(3);
      },
    },
  });

  const heartbeatsSeen = Array<number>();
  worker.native.activityHeartbeatCallback = (_tt, details) => {
    heartbeatsSeen.push(details);
  };
  await runActivity(worker, () => subj.next());
  t.deepEqual(heartbeatsSeen, [1]);
});

test('Activity gets cancelled if heartbeat fails', async (t) => {
  const worker = isolateFreeWorker({
    taskQueue: 'unused',
    dataConverter: {
      payloadCodecs: [
        {
          async encode(p) {
            // Fail to encode heartbeat details.
            // data will be undefined when this method gets the activity result for completion.
            if (p[0].data !== undefined) {
              throw new Error('Refuse to encode data for test');
            }
            return p;
          },
          async decode(p) {
            return p;
          },
        },
      ],
    },
    activities: {
      async rapidHeartbeater() {
        Context.current().heartbeat(1);
        await Context.current().cancelled;
      },
    },
  });

  const heartbeatsSeen = Array<number>();
  worker.native.activityHeartbeatCallback = (_tt, details) => {
    heartbeatsSeen.push(details);
  };
  await runActivity(worker, (completion) => {
    t.is(completion.result?.failed?.failure?.message, 'HEARTBEAT_DETAILS_CONVERSION_FAILED');
  });
  t.deepEqual(heartbeatsSeen, []);
});

test('No heartbeat is emitted with rogue activity', async (t) => {
  const subj = new Subject<void>();
  let cx: Context | undefined = undefined;

  const worker = isolateFreeWorker({
    taskQueue: 'unused',
    activities: {
      async rapidHeartbeater() {
        cx = Context.current();
        Context.current().heartbeat(1);
      },
    },
  });

  const heartbeatsSeen = Array<number>();
  worker.native.activityHeartbeatCallback = (_tt, details) => {
    heartbeatsSeen.push(details);
  };
  await runActivity(worker, () => {
    subj.next();
    t.truthy(cx);
    cx?.heartbeat(2);
  });
  t.deepEqual(heartbeatsSeen, [1]);
});

test('activity start heartbeat-details decode failure is encoded with activity serialization context', async (t) => {
  const converterPath = require.resolve('./payload-converters/serialization-context-converter');

  const worker = isolateFreeWorker({
    namespace: 'worker-test',
    taskQueue: 'unused',
    dataConverter: {
      payloadConverterPath: converterPath,
      failureConverterPath: converterPath,
    },
    activities: {
      async rapidHeartbeater() {
        throw new Error('should not execute');
      },
    },
  });

  await worker.runUntil(async () => {
    const completion = await worker.native.runActivityTask({
      taskToken: Buffer.from(randomUUID()),
      start: {
        activityType: 'rapidHeartbeater',
        activityId: 'act-1',
        workflowExecution: { workflowId: 'wfid', runId: 'runid' },
        heartbeatDetails: [{} as any],
      },
    });

    t.is(
      completion.result?.failed?.failure?.message,
      'failure.encode.bound|activity.worker-test.wfid.act-1.false|Failed to parse heartbeat details for activity act-1: Unknown encoding: '
    );
  });
});

test('activity start heartbeat-details codec decode failure is encoded with activity serialization context', async (t) => {
  const heartbeatDetailsFailingCodec: PayloadCodec = {
    async encode(payloads) {
      return payloads;
    },

    async decode(payloads, context) {
      const value = defaultPayloadConverter.fromPayload<{ label?: string }>(payloads[0]!);
      if (value.label === 'heartbeat-details') {
        const ctx = context ? contextToTraceString(context) : 'free';
        throw new Error(`codec.decode.bound|${ctx}|heartbeat-details`);
      }
      return payloads;
    },
  };

  const worker = isolateFreeWorker({
    namespace: 'worker-test',
    taskQueue: 'unused',
    dataConverter: {
      payloadCodecs: [heartbeatDetailsFailingCodec],
    },
    activities: {
      async rapidHeartbeater() {
        throw new Error('should not execute');
      },
    },
  });

  await worker.runUntil(async () => {
    const completion = await worker.native.runActivityTask({
      taskToken: Buffer.from(randomUUID()),
      start: {
        activityType: 'rapidHeartbeater',
        activityId: 'act-1',
        workflowExecution: { workflowId: 'wfid', runId: 'runid' },
        heartbeatDetails: [defaultPayloadConverter.toPayload(makeContextTrace('heartbeat-details'))],
      },
    });

    t.is(
      completion.result?.failed?.failure?.message,
      'Failed to parse heartbeat details for activity act-1: codec.decode.bound|activity.worker-test.wfid.act-1.false|heartbeat-details'
    );
  });
});
