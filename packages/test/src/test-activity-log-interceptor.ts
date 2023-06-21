import test from 'ava';
import {
  ActivityInboundLogInterceptor,
  activityLogAttributes,
  DefaultLogger,
  LogEntry,
  Runtime,
} from '@temporalio/worker';
import { MockActivityEnvironment, defaultActivityInfo } from '@temporalio/testing';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import * as activity from '@temporalio/activity';
import { withZeroesHTTPServer } from './zeroes-http-server';
import { cancellableFetch } from './activities/cancellable-fetch';

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

test("Activity Context's logger defaults to Runtime's Logger", async (t) => {
  const env = new MockActivityEnvironment();
  const logs: LogEntry[] = await env.run(async () => {
    const ctx = activity.Context.current();
    ctx.logger.debug('log message from activity');
    return (ctx as MyTestActivityContext).logs;
  });
  const activityLogEntry = logs.find((entry) => entry.message === 'log message from activity');
  t.not(activityLogEntry, undefined);
  t.is(activityLogEntry?.level, 'DEBUG');
});

test("Activity Log Interceptor dont override Context's logger by default", async (t) => {
  const env = new MockActivityEnvironment();
  const logs: LogEntry[] = await env.run(async () => {
    const ctx = activity.Context.current();
    const interceptor = new ActivityInboundLogInterceptor(ctx);
    const execute = composeInterceptors([interceptor], 'execute', async () => {
      ctx.logger.debug('log message from activity');
    });
    try {
      await execute({ args: [], headers: {} });
    } catch {
      // ignore
    }
    return (ctx as MyTestActivityContext).logs;
  });
  const activityLogEntry = logs.find((entry) => entry.message === 'log message from activity');
  t.not(activityLogEntry, undefined);
  t.is(activityLogEntry?.level, 'DEBUG');
});

async function runActivity(
  fn: activity.ActivityFunction,
  heartbeatCallback = (_env: MockActivityEnvironment) => {
    // not an empty body eslint
  }
): Promise<LogEntry[]> {
  const logs = Array<LogEntry>();
  const env = new MockActivityEnvironment();
  env.on('heartbeat', () => heartbeatCallback(env));
  await env.run(async () => {
    const ctx = activity.Context.current();
    const interceptor = new ActivityInboundLogInterceptor(
      ctx,
      new DefaultLogger('DEBUG', (entry) => {
        logs.push(entry);
      })
    );
    const execute = composeInterceptors([interceptor], 'execute', fn);
    try {
      await execute({ args: [], headers: {} });
    } catch {
      // ignore
    }
  });
  return logs;
}

test('ActivityInboundLogInterceptor overrides Context logger if specified', async (t) => {
  const logs = await runActivity(async () => {
    activity.Context.current().logger.debug('log message from activity');
  });
  t.is(logs.length, 3);
  const [_, midLog] = logs;
  t.is(midLog.level, 'DEBUG');
  t.is(midLog.message, 'log message from activity');
  t.deepEqual(midLog.meta, activityLogAttributes(defaultActivityInfo));
});

test('ActivityInboundLogInterceptor logs when activity starts', async (t) => {
  const logs = await runActivity(async () => {
    // not an empty body eslint
  });
  t.is(logs.length, 2);
  const [startLog] = logs;
  t.is(startLog.level, 'DEBUG');
  t.is(startLog.message, 'Activity started');
  t.deepEqual(startLog.meta, activityLogAttributes(defaultActivityInfo));
});

test('ActivityInboundLogInterceptor logs warning when activity fails', async (t) => {
  const err = new Error('Failed for test');
  const logs = await runActivity(async () => {
    throw err;
  });
  t.is(logs.length, 2);
  const [_, endLog] = logs;
  t.is(endLog.level, 'WARN');
  t.is(endLog.message, 'Activity failed');
  const { durationMs, error, ...rest } = endLog.meta ?? {};
  t.true(Number.isInteger(durationMs));
  t.is(err, error);
  t.deepEqual(rest, activityLogAttributes(defaultActivityInfo));
});

test('ActivityInboundLogInterceptor logs when activity completes async', async (t) => {
  const logs = await runActivity(async () => {
    throw new activity.CompleteAsyncError();
  });
  t.is(logs.length, 2);
  const [_, endLog] = logs;
  t.is(endLog.level, 'DEBUG');
  t.is(endLog.message, 'Activity will complete asynchronously');
  const { durationMs, ...rest } = endLog.meta ?? {};
  t.true(Number.isInteger(durationMs));
  t.deepEqual(rest, activityLogAttributes(defaultActivityInfo));
});

test('ActivityInboundLogInterceptor logs when activity is cancelled with promise', async (t) => {
  const logs = await runActivity(
    async () => {
      activity.Context.current().heartbeat();
      await activity.Context.current().cancelled;
    },
    (env) => {
      env.cancel();
    }
  );
  t.is(logs.length, 2);
  const [_, endLog] = logs;
  t.is(endLog.level, 'DEBUG');
  t.is(endLog.message, 'Activity completed as cancelled');
  const { durationMs, ...rest } = endLog.meta ?? {};
  t.true(Number.isInteger(durationMs));
  t.deepEqual(rest, activityLogAttributes(defaultActivityInfo));
});

test('ActivityInboundLogInterceptor logs when activity is cancelled with signal', async (t) => {
  const logs = await runActivity(
    async () => {
      await withZeroesHTTPServer(async (port) => {
        await cancellableFetch(`http:127.0.0.1:${port}`);
      });
    },
    (env) => {
      env.cancel();
    }
  );
  t.is(logs.length, 2);
  const [_, endLog] = logs;
  t.is(endLog.level, 'DEBUG');
  t.is(endLog.message, 'Activity completed as cancelled');
  const { durationMs, ...rest } = endLog.meta ?? {};
  t.true(Number.isInteger(durationMs));
  t.deepEqual(rest, activityLogAttributes(defaultActivityInfo));
});
