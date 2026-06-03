/**
 * Flush-on-shutdown hook.
 *
 * Observability plugins must drain any in-flight trace batches when the worker
 * stops, or traces emitted late in a run are lost. The plugin implements this in
 * its `runWorker` continuation: it always awaits the LangSmith client's
 * `awaitPendingTraceBatches()` (falling back to `flush()`) in a `finally`, so the
 * drain happens whether the worker run resolves or throws.
 *
 * These tests invoke the continuation directly with a fake worker + `next`,
 * which deterministically exercises the required hook without depending on the
 * exact worker run lifecycle.
 *
 * @module
 */

import test from 'ava';

import { LangSmithPlugin } from '../index';
import { InMemoryRunCollector } from './helpers';

type RunWorker = (worker: unknown, next: (worker: unknown) => Promise<void>) => Promise<void>;

test('flush-on-shutdown: drains pending trace batches after the worker run resolves', async (t) => {
  const collector = new InMemoryRunCollector();
  const plugin = new LangSmithPlugin({ client: collector.asClient() });
  const runWorker = (plugin as unknown as { runWorker: RunWorker }).runWorker.bind(plugin);

  let ran = false;
  await runWorker({}, async () => {
    ran = true;
  });

  t.is(ran, true);
  t.is(collector.flushCount, 1);
});

test('flush-on-shutdown: drains pending trace batches even when the worker run throws', async (t) => {
  const collector = new InMemoryRunCollector();
  const plugin = new LangSmithPlugin({ client: collector.asClient() });
  const runWorker = (plugin as unknown as { runWorker: RunWorker }).runWorker.bind(plugin);

  await t.throwsAsync(
    runWorker({}, async () => {
      throw new Error('boom');
    }),
    { message: 'boom' },
  );

  t.is(collector.flushCount, 1);
});
