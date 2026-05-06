import test from 'ava';
import type { LogEntry } from '@temporalio/worker';
import { DefaultLogger } from '@temporalio/worker';

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
