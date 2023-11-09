import test from 'ava';
import { ActivityInboundLogInterceptor, DefaultLogger, LogEntry, Runtime } from '@temporalio/worker';
import { activityLogAttributes } from '@temporalio/worker/lib/activity';
import { MockActivityEnvironment, defaultActivityInfo } from '@temporalio/testing';
import { isCancellation } from '@temporalio/workflow';
import { isAbortError } from '@temporalio/common/lib/type-helpers';
import * as activity from '@temporalio/activity';
import { withZeroesHTTPServer } from './zeroes-http-server';
import { cancellableFetch } from './activities';

interface MyTestActivityContext extends activity.Context {
  logs: Array<LogEntry>;
}

test.before(() => {
  const mockLogger = new DefaultLogger('DEBUG', (entry) => {
    (activity.Context.current() as MyTestActivityContext).logs ??= [];
    (activity.Context.current() as MyTestActivityContext).logs.push(entry);
  });
  Runtime.install({
    logger: mockLogger,
  });
});

test("Activity Context logger defaults to Runtime's Logger", async (t) => {
  const env = new MockActivityEnvironment({});
  await env.run(async () => {
    activity.log.debug('log message from activity');
  });
  const logs = (env.context as MyTestActivityContext).logs;
  const entry = logs.find((x) => x.level === 'DEBUG' && x.message === 'log message from activity');
  t.not(entry, undefined);
});

test('Activity Worker logs when activity starts', async (t) => {
  const env = new MockActivityEnvironment({});
  await env.run(async () => {
    activity.log.debug('log message from activity');
  });
  const logs = (env.context as MyTestActivityContext).logs;
  const entry = logs.find((x) => x.level === 'DEBUG' && x.message === 'Activity started');
  t.not(entry, undefined);
  t.deepEqual(entry?.meta, activityLogAttributes(defaultActivityInfo));
});

test('Activity Worker logs warning when activity fails', async (t) => {
  const err = new Error('Failed for test');
  const env = new MockActivityEnvironment({});
  try {
    await env.run(async () => {
      throw err;
    });
  } catch (e) {
    if (e !== err) throw e;
  }
  const logs = (env.context as MyTestActivityContext).logs;
  console.log(logs);
  const entry = logs.find((entry) => entry.level === 'WARN' && entry.message === 'Activity failed');
  t.not(entry, undefined);
  const { durationMs, error, ...rest } = entry?.meta ?? {};
  t.true(Number.isInteger(durationMs));
  t.is(err, error);
  t.deepEqual(rest, activityLogAttributes(defaultActivityInfo));
});

test('Activity Worker logs when activity completes async', async (t) => {
  const env = new MockActivityEnvironment({});
  try {
    await env.run(async () => {
      throw new activity.CompleteAsyncError();
    });
  } catch (e) {
    if (!(e instanceof activity.CompleteAsyncError)) throw e;
  }
  const logs = (env.context as MyTestActivityContext).logs;
  const entry = logs.find((x) => x.level === 'DEBUG' && x.message === 'Activity will complete asynchronously');
  t.not(entry, undefined);
  const { durationMs, ...rest } = entry?.meta ?? {};
  t.true(Number.isInteger(durationMs));
  t.deepEqual(rest, activityLogAttributes(defaultActivityInfo));
});

test('Activity Worker logs when activity is cancelled with promise', async (t) => {
  const env = new MockActivityEnvironment({});
  env.on('heartbeat', () => env.cancel());
  try {
    await env.run(async () => {
      activity.Context.current().heartbeat();
      await activity.Context.current().cancelled;
    });
  } catch (e) {
    if (!isCancellation(e)) throw e;
  }
  const logs = (env.context as MyTestActivityContext).logs;
  const entry = logs.find((x) => x.level === 'DEBUG' && x.message === 'Activity completed as cancelled');
  t.not(entry, undefined);
  const { durationMs, ...rest } = entry?.meta ?? {};
  t.true(Number.isInteger(durationMs));
  t.deepEqual(rest, activityLogAttributes(defaultActivityInfo));
});

test('Activity Worker logs when activity is cancelled with signal', async (t) => {
  const env = new MockActivityEnvironment({});
  env.on('heartbeat', () => env.cancel());
  try {
    await env.run(async () => {
      await withZeroesHTTPServer(async (port) => {
        await cancellableFetch(`http:127.0.0.1:${port}`);
      });
    });
  } catch (e) {
    if (!isAbortError(e)) throw e;
  }
  const logs = (env.context as MyTestActivityContext).logs;
  const entry = logs.find((x) => x.level === 'DEBUG' && x.message === 'Activity completed as cancelled');
  t.not(entry, undefined);
  const { durationMs, ...rest } = entry?.meta ?? {};
  t.true(Number.isInteger(durationMs));
  t.deepEqual(rest, activityLogAttributes(defaultActivityInfo));
});

test('(Legacy) ActivityInboundLogInterceptor does not override Context.log by default', async (t) => {
  const env = new MockActivityEnvironment(
    {},
    {
      // eslint-disable-next-line deprecation/deprecation
      interceptors: [(ctx) => ({ inbound: [new ActivityInboundLogInterceptor(ctx)] })],
    }
  );
  await env.run(async () => {
    activity.log.debug('log message from activity');
  });
  const logs = (env.context as MyTestActivityContext).logs;
  const activityLogEntry = logs.find((entry) => entry.message === 'log message from activity');
  t.not(activityLogEntry, undefined);
  t.is(activityLogEntry?.level, 'DEBUG');
});

test('(Legacy) ActivityInboundLogInterceptor overrides Context.log if a logger is specified', async (t) => {
  const logs: LogEntry[] = [];
  const logger = new DefaultLogger('DEBUG', (entry) => {
    logs.push(entry);
  });
  const env = new MockActivityEnvironment(
    {},
    {
      // eslint-disable-next-line deprecation/deprecation
      interceptors: [(ctx) => ({ inbound: [new ActivityInboundLogInterceptor(ctx, logger)] })],
    }
  );
  await env.run(async () => {
    activity.log.debug('log message from activity');
  });
  const entry1 = logs.find((x) => x.level === 'DEBUG' && x.message === 'Activity started');
  t.not(entry1, undefined);
  const entry2 = logs.find((x) => x.level === 'DEBUG' && x.message === 'log message from activity');
  t.not(entry2, undefined);
});

test('(Legacy) ActivityInboundLogInterceptor overrides Context.log if class is extended', async (t) => {
  // eslint-disable-next-line deprecation/deprecation
  class CustomActivityInboundLogInterceptor extends ActivityInboundLogInterceptor {
    protected logAttributes(): Record<string, unknown> {
      const { namespace: _, ...rest } = super.logAttributes();
      return {
        ...rest,
        custom: 'attribute',
      };
    }
  }
  const env = new MockActivityEnvironment(
    {},
    {
      interceptors: [(ctx) => ({ inbound: [new CustomActivityInboundLogInterceptor(ctx)] })],
    }
  );
  await env.run(async () => {
    activity.log.debug('log message from activity');
  });
  const logs = (env.context as MyTestActivityContext).logs;
  const activityLogEntry = logs.find((entry) => entry.message === 'log message from activity');
  t.not(activityLogEntry, undefined);
  t.is(activityLogEntry?.level, 'DEBUG');
  t.is(activityLogEntry?.meta?.taskQueue, env.context.info.taskQueue);
  t.is(activityLogEntry?.meta?.custom, 'attribute');
  t.false('namespace' in (activityLogEntry?.meta ?? {}));
});
