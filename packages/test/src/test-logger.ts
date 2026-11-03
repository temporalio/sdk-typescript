import test from 'ava';
import type { LogEntry } from '@temporalio/worker';
import { DefaultLogger } from '@temporalio/worker';
import { NativeLogCollector } from '@temporalio/worker/internal';

interface FakeInterval {
  id: number;
  fn: () => void;
  intervalMs: number;
  cleared: boolean;
}

class ControlledClock {
  readonly intervals: FakeInterval[] = [];
  private nextId = 1;
  private readonly originalSetInterval = globalThis.setInterval;
  private readonly originalClearInterval = globalThis.clearInterval;

  install(): void {
    (globalThis as any).setInterval = (fn: () => void, ms: number) => {
      const interval: FakeInterval = { id: this.nextId++, fn, intervalMs: ms, cleared: false };
      this.intervals.push(interval);
      return {
        unref: () => interval,
        ...interval,
      } as any;
    };
    (globalThis as any).clearInterval = (timer: any) => {
      if (!timer) return;
      const id = typeof timer === 'object' && 'id' in timer ? timer.id : timer;
      for (const item of this.intervals) {
        if (item.id === id || item === timer) {
          item.cleared = true;
        }
      }
    };
  }

  uninstall(): void {
    globalThis.setInterval = this.originalSetInterval;
    globalThis.clearInterval = this.originalClearInterval;
  }

  advance(ticks = 1): void {
    for (let i = 0; i < ticks; i++) {
      for (const item of this.intervals) {
        if (!item.cleared) {
          item.fn();
        }
      }
    }
  }

  hasActiveIntervals(): boolean {
    return this.intervals.some((item) => !item.cleared);
  }
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

test.serial('NativeLogCollector: clears flush timer when downstream flush throws (Test A)', (t) => {
  const clock = new ControlledClock();
  clock.install();
  t.teardown(() => clock.uninstall());

  const sentinelError = new Error('SENTINEL_DOWNSTREAM_FLUSH_FAILURE');
  let flushCalls = 0;
  const downstreamLogs: string[] = [];

  const downstream = Object.assign(
    new DefaultLogger('INFO', (entry) => {
      downstreamLogs.push(entry.message);
    }),
    {
      flush: () => {
        flushCalls++;
        throw sentinelError;
      },
    }
  );

  const collector = new NativeLogCollector(downstream);
  t.is(clock.intervals.length, 1, 'collector schedules periodic flush interval');
  t.true(clock.hasActiveIntervals(), 'timer is active prior to close');

  collector.logger.info('message before throwing flush');

  // Verify the failure is observable according to the established contract
  const thrown = t.throws(() => collector.close(), { is: sentinelError });
  t.is(thrown, sentinelError);

  // Verify the collector-owned flush timer is cleared even after failure
  t.false(clock.hasActiveIntervals(), 'collector-owned flush timer must be cleared after close failure');
  t.true(clock.intervals[0]?.cleared, 'periodic flush interval must be marked cleared');

  // Advance controlled fake clock beyond several timer intervals
  t.is(flushCalls, 1);
  clock.advance(5);

  // Verify no further periodic flush calls occur after close
  t.is(flushCalls, 1, 'no further flush calls occur after close on timer ticks');
  t.deepEqual(downstreamLogs, ['message before throwing flush']);
});

test.serial('NativeLogCollector: delivers buffered logs and clears timer on normal flush (Test B)', (t) => {
  const clock = new ControlledClock();
  clock.install();
  t.teardown(() => clock.uninstall());

  let flushCalls = 0;
  const downstreamLogs: string[] = [];

  const downstream = Object.assign(
    new DefaultLogger('INFO', (entry) => {
      downstreamLogs.push(entry.message);
    }),
    {
      flush: () => {
        flushCalls++;
      },
    }
  );

  const collector = new NativeLogCollector(downstream);
  t.true(clock.hasActiveIntervals(), 'timer is active upon construction');

  collector.logger.info('buffered 1');
  collector.logger.info('buffered 2');

  // Verify manual flush flushes buffer and delegates to downstream
  collector.flush();
  t.is(flushCalls, 1, 'downstream flush is called on manual flush');
  t.deepEqual(downstreamLogs, ['buffered 1', 'buffered 2']);
  t.true(clock.hasActiveIntervals(), 'timer remains active after manual flush');

  // Normal close clears timer
  collector.close();
  t.is(flushCalls, 2, 'downstream flush is called again on close');
  t.false(clock.hasActiveIntervals(), 'timer is cleared on close');

  // Advancing clock triggers no further calls
  clock.advance(5);
  t.is(flushCalls, 2);
});
