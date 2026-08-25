/**
 * Deterministic coverage for `withTracingWorker`'s stall-retry branches, forced via the
 * injectable `stallTimeoutMs`/`maxBodyAttempts` knobs with hanging/throwing bodies.
 *
 * @module
 */

import anyTest, { type TestFn } from 'ava';

import { HarnessStallError, InMemoryRunCollector, useSharedEnv, withTracingWorker } from './helpers';

const test = anyTest as TestFn<unknown>;
useSharedEnv(test);

/** A body result that never settles, simulating the delivery stall. */
const hangForever = () => new Promise<never>(() => {});

test.serial('stall retry runs the body again on a fresh task queue and rolls back the collector', async (t) => {
  const collector = new InMemoryRunCollector();
  const queues: string[] = [];
  const result = await withTracingWorker({
    collector,
    activities: {},
    stallTimeoutMs: 1500,
    maxBodyAttempts: 3,
    body: async ({ taskQueue }) => {
      queues.push(taskQueue);
      if (queues.length === 1) {
        // Record something the stalled attempt would have emitted; rollback must discard it.
        await collector.createRun({ id: 'stalled-run', name: 'from_stalled_attempt' });
        return hangForever();
      }
      return 'recovered';
    },
  });
  t.is(result, 'recovered');
  t.is(queues.length, 2);
  t.not(queues[0], queues[1]);
  t.deepEqual(
    collector.records,
    [],
    'the stalled attempt’s partial emissions must not survive into the passing attempt'
  );
});

test.serial('exhausting the attempt budget fails with HarnessStallError in bounded time', async (t) => {
  const collector = new InMemoryRunCollector();
  let attempts = 0;
  const err = await t.throwsAsync(
    withTracingWorker({
      collector,
      activities: {},
      stallTimeoutMs: 1000,
      maxBodyAttempts: 2,
      body: async () => {
        attempts += 1;
        return hangForever();
      },
    }),
    { instanceOf: HarnessStallError }
  );
  t.is(attempts, 2);
  t.regex(err!.message, /attempt 2\/2/);
});

test.serial('non-stall failures propagate immediately without a retry', async (t) => {
  const collector = new InMemoryRunCollector();
  let attempts = 0;
  await t.throwsAsync(
    withTracingWorker({
      collector,
      activities: {},
      stallTimeoutMs: 5000,
      maxBodyAttempts: 3,
      body: async () => {
        attempts += 1;
        throw new Error('boom');
      },
    }),
    { message: 'boom' }
  );
  t.is(attempts, 1);
});
