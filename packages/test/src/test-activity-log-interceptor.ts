import test from 'ava';
import { ActivityInboundLogInterceptor, activityLogAttributes, DefaultLogger, LogEntry } from '@temporalio/worker';
import { MockActivityEnvironment, defaultActivityInfo } from '@temporalio/testing';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import * as activity from '@temporalio/activity';
import { withZeroesHTTPServer } from './zeroes-http-server';
import { cancellableFetch } from './activities/cancellable-fetch';

async function runActivity(
  fn: activity.ActivityFunction,
  heartbeatCallback = (_env: MockActivityEnvironment) => {
    // not an empty body eslint
  }
): Promise<[LogEntry, LogEntry]> {
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
  if (logs.length !== 2) {
    throw new Error('Expected exactly 2 log entries');
  }
  return logs as [LogEntry, LogEntry];
}

test('ActivityInboundLogInterceptor logs when activity starts', async (t) => {
  const [startLog] = await runActivity(async () => {
    // not an empty body eslint
  });
  t.is(startLog.level, 'DEBUG');
  t.is(startLog.message, 'Activity started');
  t.deepEqual(startLog.meta, activityLogAttributes(defaultActivityInfo));
});

test('ActivityInboundLogInterceptor logs warning when activity fails', async (t) => {
  const err = new Error('Failed for test');
  const [_, endLog] = await runActivity(async () => {
    throw err;
  });
  t.is(endLog.level, 'WARN');
  t.is(endLog.message, 'Activity failed');
  const { durationMs, error, ...rest } = endLog.meta ?? {};
  t.true(Number.isInteger(durationMs));
  t.is(err, error);
  t.deepEqual(rest, activityLogAttributes(defaultActivityInfo));
});

test('ActivityInboundLogInterceptor logs when activity completes async', async (t) => {
  const [_, endLog] = await runActivity(async () => {
    throw new activity.CompleteAsyncError();
  });
  t.is(endLog.level, 'DEBUG');
  t.is(endLog.message, 'Activity will complete asynchronously');
  const { durationMs, ...rest } = endLog.meta ?? {};
  t.true(Number.isInteger(durationMs));
  t.deepEqual(rest, activityLogAttributes(defaultActivityInfo));
});

test('ActivityInboundLogInterceptor logs when activity is cancelled with promise', async (t) => {
  const [_, endLog] = await runActivity(
    async () => {
      activity.Context.current().heartbeat();
      await activity.Context.current().cancelled;
    },
    (env) => {
      env.cancel();
    }
  );
  t.is(endLog.level, 'DEBUG');
  t.is(endLog.message, 'Activity completed as cancelled');
  const { durationMs, ...rest } = endLog.meta ?? {};
  t.true(Number.isInteger(durationMs));
  t.deepEqual(rest, activityLogAttributes(defaultActivityInfo));
});

test('ActivityInboundLogInterceptor logs when activity is cancelled with signal', async (t) => {
  const [_, endLog] = await runActivity(
    async () => {
      await withZeroesHTTPServer(async (port) => {
        await cancellableFetch(`http:127.0.0.1:${port}`);
      });
    },
    (env) => {
      env.cancel();
    }
  );
  t.is(endLog.level, 'DEBUG');
  t.is(endLog.message, 'Activity completed as cancelled');
  const { durationMs, ...rest } = endLog.meta ?? {};
  t.true(Number.isInteger(durationMs));
  t.deepEqual(rest, activityLogAttributes(defaultActivityInfo));
});
