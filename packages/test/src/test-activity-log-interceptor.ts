import test from 'ava';
import { ActivityInboundLogInterceptor, DefaultLogger, LogEntry, Runtime } from '@temporalio/worker';
import { activityLogAttributes } from '@temporalio/worker/lib/activity';
import { MockActivityEnvironment, defaultActivityInfo } from '@temporalio/testing';
import { isCancellation } from '@temporalio/workflow';
import * as activity from '@temporalio/activity';
import { SdkComponent } from '@temporalio/common';
import { withZeroesHTTPServer } from './zeroes-http-server';
import { cancellableFetch } from './activities';

interface MyTestActivityContext extends activity.Context {
  logs: Array<LogEntry>;
}

const mockLogger = new DefaultLogger('DEBUG', (entry) => {
  try {
    (activity.Context.current() as MyTestActivityContext).logs ??= [];
    (activity.Context.current() as MyTestActivityContext).logs.push(entry);
  } catch (e) {
    // Ignore messages produced from non activity context
    if ((e as Error).message !== 'Activity context not initialized') throw e;
  }
});
Runtime.install({
  logger: mockLogger,
});

test('Activity Context logger funnel through the parent Logger', async (t) => {
  const env = new MockActivityEnvironment({}, { logger: mockLogger });
  await env.run(async () => {
    activity.log.debug('log message from activity');
  });
  const logs = (env.context as MyTestActivityContext).logs;
  const entry = logs.find((x) => x.level === 'DEBUG' && x.message === 'log message from activity');
  t.not(entry, undefined);
  t.deepEqual(entry?.meta, { ...activityLogAttributes(defaultActivityInfo), sdkComponent: SdkComponent.activity });
});

test('Activity Worker logs when activity starts', async (t) => {
  const env = new MockActivityEnvironment({}, { logger: mockLogger });
  await env.run(async () => {
    activity.log.debug('log message from activity');
  });
  const logs = (env.context as MyTestActivityContext).logs;
  const entry = logs.find((x) => x.level === 'DEBUG' && x.message === 'Activity started');
  t.not(entry, undefined);
  t.deepEqual(entry?.meta, { ...activityLogAttributes(defaultActivityInfo), sdkComponent: SdkComponent.worker });
});

test('Activity Worker logs warning when activity fails', async (t) => {
  const err = new Error('Failed for test');
  const env = new MockActivityEnvironment({}, { logger: mockLogger });
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
  t.deepEqual(rest, { ...activityLogAttributes(defaultActivityInfo), sdkComponent: SdkComponent.worker });
});

test('Activity Worker logs when activity completes async', async (t) => {
  const env = new MockActivityEnvironment({}, { logger: mockLogger });
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
  t.deepEqual(rest, { ...activityLogAttributes(defaultActivityInfo), sdkComponent: SdkComponent.worker });
});

test('Activity Worker logs when activity is cancelled with promise', async (t) => {
  const env = new MockActivityEnvironment({}, { logger: mockLogger });
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
  t.deepEqual(rest, { ...activityLogAttributes(defaultActivityInfo), sdkComponent: SdkComponent.worker });
});

test('Activity Worker logs when activity is cancelled with signal', async (t) => {
  const env = new MockActivityEnvironment({}, { logger: mockLogger });
  env.on('heartbeat', () => env.cancel());
  try {
    await env.run(async () => {
      await withZeroesHTTPServer(async (port) => {
        await cancellableFetch(`http://127.0.0.1:${port}`);
      });
    });
  } catch (e) {
    if (!isCancellation(e)) throw e;
  }
  const logs = (env.context as MyTestActivityContext).logs;
  const entry = logs.find((x) => x.level === 'DEBUG' && x.message === 'Activity completed as cancelled');
  t.not(entry, undefined);
  const { durationMs, ...rest } = entry?.meta ?? {};
  t.true(Number.isInteger(durationMs));
  t.deepEqual(rest, { ...activityLogAttributes(defaultActivityInfo), sdkComponent: SdkComponent.worker });
});

test('(Legacy) ActivityInboundLogInterceptor does not override Context.log by default', async (t) => {
  const env = new MockActivityEnvironment(
    {},
    {
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      interceptors: [(ctx) => ({ inbound: new ActivityInboundLogInterceptor(ctx) })],
      logger: mockLogger,
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
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      interceptors: [(ctx) => ({ inbound: new ActivityInboundLogInterceptor(ctx, logger) })],
      logger: mockLogger,
    }
  );
  await env.run(async () => {
    activity.log.debug('log message from activity');
  });
  const entry = logs.find((x) => x.level === 'DEBUG' && x.message === 'log message from activity');
  t.not(entry, undefined);
});

test('(Legacy) ActivityInboundLogInterceptor overrides Context.log if class is extended', async (t) => {
  // eslint-disable-next-line @typescript-eslint/no-deprecated
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
      interceptors: [(ctx) => ({ inbound: new CustomActivityInboundLogInterceptor(ctx) })],
      logger: mockLogger,
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
