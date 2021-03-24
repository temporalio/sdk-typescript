import test from 'ava';
import { DefaultLogger } from '@temporalio/worker';

test('DefaultLogger logs messages according to configured level', (t) => {
  const logs: any[] = [];
  const log = new DefaultLogger('WARNING', (...args) => logs.push(args));
  log.debug('hey', { a: 1 });
  log.info('ho');
  log.warn('lets', { a: 1 });
  log.error('go');
  t.deepEqual(logs, [
    ['WARNING', 'lets', { a: 1 }],
    ['ERROR', 'go', undefined],
  ]);
});
