import test from 'ava';
import { MockActivityEnvironment } from '@temporalio/testing';
import * as activity from '@temporalio/activity';
import { Runtime } from '@temporalio/worker';

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
