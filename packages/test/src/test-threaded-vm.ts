/**
 * Unit tests for {@link WorkerThreadClient}'s handling of Workflow Worker Thread `error` events,
 * in particular its ability to detect out-of-memory (OOM) errors and log a more actionable
 * message pointing users at `maxCachedWorkflows` / `maxWorkflowThreadHeapMiB`.
 */
import { EventEmitter } from 'node:events';
import test from 'ava';
import type { LogEntry } from '@temporalio/worker';
import { DefaultLogger } from '@temporalio/worker';
import { WorkerThreadClient } from '@temporalio/worker/lib/workflow/threaded-vm';

/**
 * A minimal stand-in for a `node:worker_threads` `Worker`. `WorkerThreadClient` only ever
 * registers listeners on it (via `.on`) in its constructor, so a plain `EventEmitter` is
 * sufficient to drive its `error` handling logic without spinning up a real thread.
 */
class FakeWorkerThread extends EventEmitter {
  postMessage(..._args: unknown[]): void {
    // no-op: tests only exercise event handling, not actual message passing
  }
}

function createClient(): { logs: Array<Omit<LogEntry, 'timestampNanos'>>; workerThread: FakeWorkerThread } {
  const logs: Array<Omit<LogEntry, 'timestampNanos'>> = [];
  const logger = new DefaultLogger('TRACE', ({ level, message, meta }) => logs.push({ level, message, meta }));
  const workerThread = new FakeWorkerThread();
  void new WorkerThreadClient(workerThread as any, logger);
  return { logs, workerThread };
}

for (const message of [
  'JS heap out of memory',
  'Error [ERR_WORKER_OUT_OF_MEMORY]: Worker terminated due to reaching memory limit',
  'Allocation failed - JavaScript heap out of memory',
]) {
  test(`logs an actionable OOM message when the worker thread errors with "${message}"`, (t) => {
    const { logs, workerThread } = createClient();

    workerThread.emit('error', new Error(message));

    const errorLogs = logs.filter((l) => l.level === 'ERROR');
    t.is(errorLogs.length, 1);
    t.is(
      errorLogs[0].message,
      'Workflow Worker Thread ran out of memory. ' +
        'Consider reducing maxCachedWorkflows or setting maxWorkflowThreadHeapMiB.'
    );
  });
}

test('logs a generic failure message for non-OOM worker thread errors', (t) => {
  const { logs, workerThread } = createClient();

  workerThread.emit('error', new Error('some unrelated failure'));

  const errorLogs = logs.filter((l) => l.level === 'ERROR');
  t.is(errorLogs.length, 1);
  t.is(errorLogs[0].message, 'Workflow Worker Thread failed: Error: some unrelated failure');
});

test('worker thread errors reject pending completions after exit', async (t) => {
  const logger = new DefaultLogger('TRACE', () => void 0);
  const workerThread = new FakeWorkerThread();
  const client = new WorkerThreadClient(workerThread as any, logger);

  const sendPromise = client.send({ type: 'destroy' } as any);

  workerThread.emit('error', new Error('JS heap out of memory'));
  workerThread.emit('exit', 1);

  const err = await t.throwsAsync(sendPromise);
  t.regex((err as Error).message, /Workflow Worker Thread exited prematurely/);
});
