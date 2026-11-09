import fs from 'node:fs';
import { mock } from 'node:test';
import test from 'ava';
import type { Context } from '@temporalio/activity';
import type { FlushableLogger, RuntimeOptions } from '../index';
import { ActivityInboundLogInterceptor } from '../activity-log-interceptor';
import { DefaultLogger, LogTimestamp } from '../logger';
import { Runtime } from '../runtime';
import { appendDefaultInterceptors } from '../worker-options';

test.afterEach.always(async () => {
  try {
    await Runtime._instance?.shutdown();
  } finally {
    Runtime.defaultOptions = {};
    delete Runtime.instantiator;
  }
});

for (const forward of [false, true]) {
  const telemetryOptions: RuntimeOptions['telemetryOptions'] = forward
    ? { logging: { forward: {}, filter: { core: 'ERROR', other: 'ERROR' } } }
    : undefined;
  const mode = forward ? 'forwarded' : 'direct';

  for (const flushable of [false, true]) {
    test.serial(`${mode} runtime logger ${flushable ? 'supports' : 'does not require'} a flush hook`, async (t) => {
      const messages: string[] = [];
      const flushes: Array<{ messages: string[]; receiver: unknown }> = [];
      let checkedFlushes = 0;
      const logger: FlushableLogger = new DefaultLogger('ERROR', ({ message }) => messages.push(message));
      if (flushable) {
        logger.flush = function () {
          flushes.push({ messages: [...messages], receiver: this });
        };
      }
      const assertFlushed = (expected: string[]) => {
        t.deepEqual(messages, expected);
        if (flushable) {
          t.true(flushes.length > checkedFlushes);
          t.deepEqual(flushes.at(-1)?.messages, expected);
          t.is(flushes.at(-1)?.receiver, logger);
        } else {
          t.deepEqual(flushes, []);
        }
        checkedFlushes = flushes.length;
      };
      const runtime = Runtime.install({ logger, telemetryOptions });

      runtime.logger.error('explicit');
      t.deepEqual(messages, forward ? [] : ['explicit']);
      runtime.flushLogs();
      assertFlushed(['explicit']);

      // An explicit request still invokes the hook when no new entries were buffered.
      runtime.flushLogs();
      assertFlushed(['explicit']);

      runtime.logger.error('shutdown');
      await runtime.shutdown();
      assertFlushed(['explicit', 'shutdown']);

      // Re-created runtimes use the same application logger, including its flush hook.
      const nextRuntime = Runtime.instance();
      nextRuntime.logger.error('re-created');
      await nextRuntime.shutdown();
      assertFlushed(['explicit', 'shutdown', 're-created']);
    });
  }

  test.serial(`${mode} runtime logger isolates logging and flush failures`, async (t) => {
    const stderr = mock.method(fs, 'writeSync', () => 0);
    t.teardown(() => stderr.mock.restore());
    const attempts: string[] = [];
    let failing = true;
    let flushCalls = 0;
    const logger: FlushableLogger = new DefaultLogger('TRACE', ({ message }) => {
      if (message.startsWith('attempt-')) {
        attempts.push(message);
        if (failing) throw new Error('logging failed');
      }
    });
    logger.flush = () => {
      flushCalls++;
      if (failing) throw new Error('flush failed');
    };
    const runtime = Runtime.install({ logger, telemetryOptions });

    t.notThrows(() => {
      runtime.logger.log('INFO', 'attempt-log');
      for (const method of ['trace', 'debug', 'info', 'warn', 'error'] as const) {
        runtime.logger[method](`attempt-${method}`);
      }
      runtime.flushLogs();
    });
    t.deepEqual(attempts, [
      'attempt-log',
      'attempt-trace',
      'attempt-debug',
      'attempt-info',
      'attempt-warn',
      'attempt-error',
    ]);
    t.true(flushCalls > 0);

    // Logger failures must not prevent later entries from being delivered.
    const firstFlushCalls = flushCalls;
    failing = false;
    runtime.logger.info('attempt-recovered');
    runtime.flushLogs();
    t.is(attempts.at(-1), 'attempt-recovered');
    t.true(flushCalls > firstFlushCalls);

    const secondFlushCalls = flushCalls;
    failing = true;
    await t.notThrowsAsync(runtime.shutdown());
    t.true(flushCalls > secondFlushCalls);
    t.is(Runtime._instance, undefined);
    await t.notThrowsAsync(runtime.shutdown());
  });

  test.serial(`${mode} runtime logger is recognized by deprecated logging interceptor APIs`, (t) => {
    const logger = new DefaultLogger('ERROR', () => undefined);
    const runtime = Runtime.install({ logger, telemetryOptions });

    for (const runtimeLogger of [logger, runtime.logger]) {
      const interceptors = {};
      // oxlint-disable-next-line typescript/no-deprecated
      t.is(appendDefaultInterceptors(interceptors, runtimeLogger), interceptors);

      const log = {} as Context['log'];
      const ctx = { log } as unknown as Context;
      new ActivityInboundLogInterceptor(ctx, runtimeLogger);
      t.is(ctx.log, log);
    }

    const otherLogger = new DefaultLogger('ERROR', () => undefined);
    // oxlint-disable-next-line typescript/no-deprecated
    t.not(appendDefaultInterceptors({}, otherLogger).activityInbound, undefined);
  });
}

test.serial('Forwarded logger failures do not escape the periodic flush', (t) => {
  const stderr = mock.method(fs, 'writeSync', () => 0);
  t.teardown(() => stderr.mock.restore());
  let attempts = 0;
  const logger = new DefaultLogger('ERROR', () => {
    attempts++;
    throw new Error('logging failed');
  });
  const interval = mock.method(globalThis, 'setInterval');
  t.teardown(() => interval.mock.restore());
  const runtime = Runtime.install({
    logger,
    telemetryOptions: { logging: { forward: {}, filter: { core: 'ERROR', other: 'ERROR' } } },
  });

  runtime.logger.error('periodic', { [LogTimestamp]: 0n });
  const callback = interval.mock.calls[0]!.arguments[0];
  t.is(typeof callback, 'function');
  if (typeof callback !== 'function') return;
  t.notThrows(() => callback());
  t.is(attempts, 1);
});

test.serial('RuntimeOptions accepts an inline logger with a flush hook', async (t) => {
  let flushCalls = 0;
  const runtime = Runtime.install({
    logger: {
      log: () => undefined,
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      flush: () => {
        flushCalls++;
      },
    },
  });

  runtime.flushLogs();
  t.true(flushCalls > 0);
  const previousFlushCalls = flushCalls;
  await runtime.shutdown();
  t.true(flushCalls > previousFlushCalls);
});

test.serial('The application owns its logger lifecycle', async (t) => {
  let closeCalls = 0;
  const logger = Object.assign(new DefaultLogger('ERROR', () => undefined), {
    flush: () => undefined,
    close: () => {
      closeCalls++;
    },
  });
  const runtime = Runtime.install({ logger });

  await runtime.shutdown();
  t.is(closeCalls, 0);
});
