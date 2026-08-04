import test from 'ava';
import type { ExecutionContext } from 'ava';
import { helpers } from '@temporalio/test-helpers';
import { configurableHelpers } from './helpers-integration';

function taskQueueFor(title: string): string {
  return helpers({ title, context: { workflowBundle: {}, env: {} } } as ExecutionContext<any>).taskQueue;
}

test('shared helpers create unique task queues with a readable title prefix', (t) => {
  const first = taskQueueFor('My shared helper test');
  const second = taskQueueFor('My shared helper test');

  t.regex(first, /^my-shared-helper-test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  t.not(first, second);
});

test('shared helpers reuse a task queue for the same test environment', (t) => {
  const env = {};
  const context = { title: 'Stable helper test', context: { workflowBundle: {}, env } } as ExecutionContext<any>;

  t.is(helpers(context).taskQueue, helpers(context).taskQueue);
});

test('shared helpers isolate task queues for different environments in the same test', (t) => {
  const context = {
    title: 'Multi-environment helper test',
    context: { workflowBundle: {}, env: {} },
  } as ExecutionContext<any>;
  const firstEnv = {} as any;
  const secondEnv = {} as any;

  t.not(helpers(context, firstEnv).taskQueue, helpers(context, secondEnv).taskQueue);
});

test('configurable helpers reuse a task queue for the same test environment', (t) => {
  const env = {} as any;
  const context = { title: 'Configurable helper test', context: {} } as ExecutionContext<any>;

  t.is(configurableHelpers(context, {} as any, env).taskQueue, configurableHelpers(context, {} as any, env).taskQueue);
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
