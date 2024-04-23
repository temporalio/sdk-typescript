import test from 'ava';
import { MockActivityEnvironment } from '@temporalio/testing';
import { CancelledFailure, Context } from '@temporalio/activity';

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
      env.cancel('test');
    }
  });
  await t.throwsAsync(
    env.run(async (x: number): Promise<number> => {
      Context.current().heartbeat(6);
      await Context.current().sleep(100);
      return x + 1;
    }, 3),
    {
      instanceOf: CancelledFailure,
      message: 'test',
    }
  );
});

test('MockActivityEnvironment injects provided info', async (t) => {
  const env = new MockActivityEnvironment({ attempt: 3 });
  const res = await env.run(async (x: number): Promise<number> => {
    return x + Context.current().info.attempt;
  }, 1);
  t.is(res, 4);
});
