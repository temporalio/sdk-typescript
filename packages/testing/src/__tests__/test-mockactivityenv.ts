import test from 'ava';
import * as activity from '@temporalio/activity';
import { Runtime } from '@temporalio/worker';
import { MockActivityEnvironment } from '../index';

test("MockActivityEnvironment doesn't implicitly instantiate Runtime", async (t) => {
  t.is(Runtime._instance, undefined);
  const env = new MockActivityEnvironment();
  await env.run(async (): Promise<void> => {
    activity.log.info('log message from activity');
  });
  t.is(Runtime._instance, undefined);
});

test('MockActivityEnvironment can run a single activity', async (t) => {
  const env = new MockActivityEnvironment();
  const res = await env.run(async (x: number): Promise<number> => {
    return x + 1;
  }, 3);
  t.is(res, 4);
});

test('MockActivityEnvironment emits heartbeat events and can be cancelled', async (t) => {
  const env = new MockActivityEnvironment();
  env.on('heartbeat', (d: unknown) => {
    if (d === 6) {
      env.cancel('CANCELLED');
    }
  });
  await t.throwsAsync(
    env.run(async (x: number): Promise<number> => {
      activity.heartbeat(6);
      await activity.sleep(100);
      return x + 1;
    }, 3),
    {
      instanceOf: activity.CancelledFailure,
      message: 'CANCELLED',
    }
  );
});

test('MockActivityEnvironment injects provided info', async (t) => {
  const env = new MockActivityEnvironment({ attempt: 3 });
  const res = await env.run(async (x: number): Promise<number> => {
    return x + activity.activityInfo().attempt;
  }, 1);
  t.is(res, 4);
});

test('MockActivityEnvironment notifies activities of worker shutdown', async (t) => {
  const env = new MockActivityEnvironment();
  const res = await env.run(async (x: number): Promise<number> => {
    t.false(activity.workerShuttingDownSignal().aborted);
    setImmediate(() => env.notifyWorkerShuttingDown());
    // A worker shutdown notification is not a cancellation, so this activity is free to complete normally.
    await t.throwsAsync(activity.workerShuttingDown(), {
      instanceOf: activity.CancelledFailure,
      message: 'WORKER_SHUTDOWN',
    });
    t.true(activity.workerShuttingDownSignal().aborted);
    return x + 1;
  }, 3);
  t.is(res, 4);
});

test('Worker shutdown notification does not cancel the activity', async (t) => {
  const env = new MockActivityEnvironment();
  await env.run(async (): Promise<void> => {
    env.notifyWorkerShuttingDown();
    t.true(activity.workerShuttingDownSignal().aborted);
    // Cancellation is a distinct concern and must remain untouched.
    t.false(activity.cancellationSignal().aborted);
    t.is(activity.cancellationDetails(), undefined);
    await activity.sleep(1);
    t.pass();
  });
});

test('Worker shutdown notification is observable through Promise.race', async (t) => {
  const env = new MockActivityEnvironment();
  const res = await env.run(async (): Promise<string> => {
    setImmediate(() => env.notifyWorkerShuttingDown());
    // The idiomatic usage: bail out of long running work as soon as the worker starts going away.
    return await Promise.race([
      activity.sleep(30_000).then(() => 'completed'),
      activity.workerShuttingDown().catch(() => 'interrupted'),
    ]);
  });
  t.is(res, 'interrupted');
});

test('Worker shutdown notification is idempotent and applies to activities started afterwards', async (t) => {
  const env = new MockActivityEnvironment();
  env.notifyWorkerShuttingDown();
  env.notifyWorkerShuttingDown();
  await env.run(async (): Promise<void> => {
    t.true(activity.workerShuttingDownSignal().aborted);
    await t.throwsAsync(activity.workerShuttingDown(), {
      instanceOf: activity.CancelledFailure,
      message: 'WORKER_SHUTDOWN',
    });
  });
});
