import fs from 'node:fs';
import { mock } from 'node:test';
import { inspect, stripVTControlCharacters } from 'node:util';
import type { ExecutionContext } from 'ava';
import test from 'ava';
import type { FlushableLogger, LogEntry } from '../logger';
import { DefaultLogger, LogTimestamp, NonThrowingLogger, hasColorSupport } from '../logger';
import { NativeLogCollector } from '../runtime-logger';

function captureStderr(t: ExecutionContext, error?: Error): Array<{ fd: number; message: string }> {
  const output: Array<{ fd: number; message: string }> = [];
  const write = mock.method(fs, 'writeSync', (fd: number, message: string) => {
    output.push({ fd, message: stripVTControlCharacters(message) });
    if (error) throw error;
    return Buffer.byteLength(message);
  });
  t.teardown(() => write.mock.restore());
  return output;
}

test('DefaultLogger logs messages according to configured level', (t) => {
  const logs: Array<Omit<LogEntry, 'timestampNanos'>> = [];
  const log = new DefaultLogger('WARN', ({ level, message, meta }) => logs.push({ level, message, meta }));
  log.debug('hey', { a: 1 });
  log.info('ho');
  log.warn('lets', { a: 1 });
  log.error('go');
  t.deepEqual(logs, [
    { level: 'WARN', message: 'lets', meta: { a: 1 } },
    { level: 'ERROR', message: 'go', meta: undefined },
  ]);
});

test('NativeLogCollector delivers entries before flushing the downstream logger', (t) => {
  const events: string[] = [];
  const downstream: FlushableLogger = new DefaultLogger('ERROR', ({ message }) => events.push(message));
  downstream.flush = () => {
    events.push('flush');
  };
  const collector = new NativeLogCollector(downstream);
  t.teardown(() => collector.close());

  collector.logger.error('first');
  collector.logger.error('second');
  t.deepEqual(events, []);

  collector.flush();
  t.deepEqual(events, ['first', 'second', 'flush']);

  // Flushing is non-destructive: the collector accepts and delivers later entries.
  collector.logger.error('third');
  collector.flush();
  t.deepEqual(events, ['first', 'second', 'flush', 'third', 'flush']);
});

test.serial('NativeLogCollector close flushes pending entries and stops its timer', (t) => {
  const events: string[] = [];
  const downstream: FlushableLogger = new DefaultLogger('ERROR', ({ message }) => events.push(message));
  downstream.flush = () => {
    events.push('flush');
  };
  const collector = new NativeLogCollector(downstream);
  const clearInterval = mock.method(globalThis, 'clearInterval');
  t.teardown(() => {
    clearInterval.mock.restore();
    collector.close();
  });

  collector.logger.error('pending');
  collector.close();
  t.is(clearInterval.mock.callCount(), 1);
  t.deepEqual(events, ['pending', 'flush']);
});

test("NativeLogCollector forwards messages without buffering after it's been closed", (t) => {
  const messages: string[] = [];
  const collector = new NativeLogCollector(new DefaultLogger('ERROR', ({ message }) => messages.push(message)));
  t.teardown(() => collector.close());
  const future = BigInt(Date.now() + 60_000) * 1_000_000n;
  const emitThroughCollector = (message: string, timestamp: bigint) => {
    collector.receive([
      JSON.stringify({
        message,
        timestamp: String(timestamp),
        level: 'ERROR',
        target: 'test',
        fields: {},
        spanContexts: [],
      }),
    ]);
  };
  const emitThroughLogger = (message: string, timestamp: bigint) => {
    collector.logger.error(message, { [LogTimestamp]: timestamp });
  };

  emitThroughCollector('native before close', future);
  emitThroughLogger('TypeScript before close', future + 1n);
  t.deepEqual(messages, []);
  collector.close();
  const expected = ['native before close', 'TypeScript before close'];
  t.deepEqual(messages, expected);

  // Older timestamps must not reorder late entries ahead of entries drained by close.
  emitThroughCollector('native after close', future - 1n);
  expected.push('native after close');
  t.deepEqual(messages, expected);
  emitThroughLogger('TypeScript after close', future - 2n);
  expected.push('TypeScript after close');
  t.deepEqual(messages, expected);

  emitThroughCollector('another native after close', future - 3n);
  expected.push('another native after close');
  t.deepEqual(messages, expected);
  emitThroughLogger('another TypeScript after close', future - 4n);
  expected.push('another TypeScript after close');
  t.deepEqual(messages, expected);
});

test.serial('NativeLogCollector stops buffering and clears its timer even if downstream flushing throws', (t) => {
  const messages: string[] = [];
  const error = new Error('flush failed');
  const downstream: FlushableLogger = new DefaultLogger('ERROR', ({ message }) => messages.push(message));
  downstream.flush = () => {
    throw error;
  };
  const collector = new NativeLogCollector(downstream);
  const clearInterval = mock.method(globalThis, 'clearInterval');
  t.teardown(() => {
    clearInterval.mock.restore();
    downstream.flush = undefined;
    collector.close();
  });

  collector.logger.error('before close', { [LogTimestamp]: 2n });
  t.throws(() => collector.close(), { is: error });
  t.is(clearInterval.mock.callCount(), 1);
  collector.logger.error('after close', { [LogTimestamp]: 1n });
  t.deepEqual(messages, ['before close', 'after close']);
});

test.serial('NonThrowingLogger preserves receivers and arguments when delegating', (t) => {
  const stderr = captureStderr(t);
  const downstream = {
    log: mock.fn(),
    trace: mock.fn(),
    debug: mock.fn(),
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    flush: mock.fn(),
  };
  const logger = new NonThrowingLogger(downstream);
  const meta = { key: 'value' };

  logger.log('INFO', 'generic', meta);
  logger.trace('trace', meta);
  logger.debug('debug', meta);
  logger.info('info', meta);
  logger.warn('warning', meta);
  logger.error('error', meta);
  logger.flush();

  const assertCall = (delegate: typeof downstream.log, args: unknown[]) => {
    t.is(delegate.mock.callCount(), 1);
    const call = delegate.mock.calls[0]!;
    t.is(call.this, downstream);
    t.deepEqual(call.arguments, args);
  };
  assertCall(downstream.log, ['INFO', 'generic', meta]);
  assertCall(downstream.trace, ['trace', meta]);
  assertCall(downstream.debug, ['debug', meta]);
  assertCall(downstream.info, ['info', meta]);
  assertCall(downstream.warn, ['warning', meta]);
  assertCall(downstream.error, ['error', meta]);
  assertCall(downstream.flush, []);
  t.deepEqual(stderr, []);
});

test.serial('NonThrowingLogger contains failures and falls back only for high-priority output', (t) => {
  const stderr = captureStderr(t);
  const fail = () => {
    throw new Error('logger failed');
  };
  const logger = new NonThrowingLogger({
    log: fail,
    trace: fail,
    debug: fail,
    info: fail,
    warn: fail,
    error: fail,
    flush: fail,
  });
  const meta = { key: 'value' };

  t.notThrows(() => {
    logger.log('INFO', 'generic', meta);
    logger.trace('trace', meta);
    logger.debug('debug', meta);
    logger.info('info', meta);
  });
  t.deepEqual(stderr, []);

  t.notThrows(() => {
    logger.warn('warning', meta);
    logger.error('error', meta);
    logger.flush();
  });
  t.deepEqual(
    stderr.map(({ fd }) => fd),
    [2, 2, 2]
  );
  t.true(stderr[0]!.message.includes('[WARN] warning'));
  t.true(stderr[0]!.message.includes("key: 'value'"));
  t.true(stderr[1]!.message.includes('[ERROR] error'));
  t.true(stderr[1]!.message.includes("key: 'value'"));
  t.true(stderr[2]!.message.includes('[ERROR] Failed to flush logs'));
});

for (const level of ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'] as const) {
  test.serial(`NonThrowingLogger stderr fallback for log(${level})`, (t) => {
    const stderr = captureStderr(t);
    const logger = new NonThrowingLogger(
      new DefaultLogger('TRACE', () => {
        throw new Error('logging failed');
      })
    );
    logger.log(level, 'original message', { key: 'value', [LogTimestamp]: 0n });

    if (level === 'WARN' || level === 'ERROR') {
      t.deepEqual(
        stderr.map(({ fd }) => fd),
        [2]
      );
      const message = stderr[0]!.message;
      t.true(message.includes('1970-01-01T00:00:00.000Z'));
      t.true(message.includes(`[${level}] original message`));
      t.true(message.includes("key: 'value'"));
      t.false(message.includes('log_timestamp'));
      t.true(message.endsWith('\n'));
    } else {
      t.deepEqual(stderr, []);
    }
  });
}

test.serial('NonThrowingLogger reports flush failures without calling the application logger again', (t) => {
  const stderr = captureStderr(t);
  let logCalls = 0;
  const downstream: FlushableLogger = new DefaultLogger('TRACE', () => {
    logCalls++;
  });
  downstream.flush = () => {
    throw new Error('flush failed');
  };

  new NonThrowingLogger(downstream).flush();
  t.is(logCalls, 0);
  t.deepEqual(
    stderr.map(({ fd }) => fd),
    [2]
  );
  t.true(stderr[0]!.message.includes('[ERROR] Failed to flush logs'));
  t.true(stderr[0]!.message.includes('flush failed'));
});

test.serial('NonThrowingLogger ignores stderr write failures', (t) => {
  const stderr = captureStderr(t, new Error('stderr unavailable'));
  const downstream: FlushableLogger = new DefaultLogger('TRACE', () => {
    throw new Error('logging failed');
  });
  downstream.flush = () => {
    throw new Error('flush failed');
  };
  const logger = new NonThrowingLogger(downstream);

  t.notThrows(() => {
    logger.log('WARN', 'generic');
    logger.warn('warning');
    logger.error('error');
    logger.flush();
  });
  t.deepEqual(
    stderr.map(({ fd }) => fd),
    [2, 2, 2, 2]
  );
});

test.serial('NonThrowingLogger ignores fallback metadata formatting failures', (t) => {
  const stderr = captureStderr(t);
  let formattingAttempts = 0;
  const downstream = new DefaultLogger('TRACE');
  downstream.log = () => {
    throw new Error('logging failed');
  };
  const logger = new NonThrowingLogger(downstream);
  const metadata = [
    {
      get value() {
        formattingAttempts++;
        throw new Error('getter failed');
      },
    },
    {
      key: 'value',
      [inspect.custom]() {
        formattingAttempts++;
        throw new Error('inspection failed');
      },
    },
  ];

  for (const meta of metadata) {
    t.notThrows(() => logger.log('ERROR', 'generic', meta));
    t.notThrows(() => logger.warn('warning', meta));
    t.notThrows(() => logger.error('error', meta));
  }
  t.is(formattingAttempts, 6);
  t.deepEqual(stderr, []);
});

test('NonThrowingLogger accepts a logger without a flush hook', (t) => {
  const logger = new NonThrowingLogger(new DefaultLogger());
  t.notThrows(() => logger.flush());
});

test('NonThrowingLogger preserves color support', (t) => {
  for (const colors of [false, true]) {
    const downstream = new DefaultLogger();
    Object.defineProperty(downstream, Symbol.for('logger_has_colors'), { value: colors });
    t.is(hasColorSupport(new NonThrowingLogger(downstream)), colors);
  }
});
