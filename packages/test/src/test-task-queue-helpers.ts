import test from 'ava';
import type { ExecutionContext } from 'ava';
import { helpers } from '@temporalio/test-helpers';

function taskQueueFor(title: string): string {
  return helpers({ title, context: { workflowBundle: {}, env: {} } } as ExecutionContext<any>).taskQueue;
}

test('shared helpers create unique task queues with a readable title prefix', (t) => {
  const first = taskQueueFor('My shared helper test');
  const second = taskQueueFor('My shared helper test');

  t.regex(first, /^my-shared-helper-test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  t.not(first, second);
});

test('shared helper task queues stay within the server length limit', (t) => {
  const taskQueue = taskQueueFor('a'.repeat(2_000));

  t.is(Buffer.byteLength(taskQueue), 1_000);
  t.regex(taskQueue, new RegExp(`^${'a'.repeat(963)}-[0-9a-f-]{36}$`));
});

test('shared helper task queues truncate on UTF-8 character boundaries', (t) => {
  const taskQueue = taskQueueFor('😀'.repeat(1_000));

  t.true(Buffer.byteLength(taskQueue) <= 1_000);
  t.false(taskQueue.includes('\uFFFD'));
  t.regex(taskQueue, /-[0-9a-f-]{36}$/);
});
