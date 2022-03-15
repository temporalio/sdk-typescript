import test from 'ava';
import { Subject, firstValueFrom } from 'rxjs';
import { v4 as uuid4 } from 'uuid';
import { Context } from '@temporalio/activity';
import { isolateFreeWorker, Worker } from './mock-native-worker';
import { coresdk } from '@temporalio/proto';

async function runActivity(worker: Worker, callback?: (completion: coresdk.ActivityTaskCompletion) => void) {
  const taskToken = Buffer.from(uuid4());
  const p = worker.run();
  const completion = await worker.native.runActivityTask({ taskToken, start: { activityType: 'rapidHeartbeater' } });
  callback?.(completion);
  worker.shutdown();
  await p;
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
      payloadCodec: {
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
  const codecErr = new Error('Refuse to encode data for test');

  const worker = isolateFreeWorker({
    taskQueue: 'unused',
    dataConverter: {
      payloadCodec: {
        async encode(p) {
          // Fail to encode heartbeat details.
          // data will be undefined when this method gets the activity result for completion.
          if (p[0].data !== undefined) {
            throw codecErr;
          }
          return p;
        },
        async decode(p) {
          return p;
        },
      },
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
    t.is(completion.result?.failed?.failure?.message, codecErr.toString());
  });
  t.deepEqual(heartbeatsSeen, []);
});
