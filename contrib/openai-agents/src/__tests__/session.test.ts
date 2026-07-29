import test from 'ava';
import type { AgentInputItem } from '@openai/agents-core';
import { MemorySession } from '@openai/agents-core';
import { ApplicationFailure } from '@temporalio/common';
import { WorkflowSafeMemorySession } from '../workflow/session';
import { TemporalOpenAIRunner } from '../workflow/runner';

function userMessage(text: string): AgentInputItem {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  } as unknown as AgentInputItem;
}

test('WorkflowSafeMemorySession: round-trips add/get/pop/clear with explicit sessionId', async (t) => {
  const a = new WorkflowSafeMemorySession({ sessionId: 'sess-a' });
  t.is(await a.getSessionId(), 'sess-a');
  t.deepEqual(await a.getItems(), []);

  await a.addItems([userMessage('one'), userMessage('two'), userMessage('three')]);
  t.is((await a.getItems()).length, 3);
  t.is((await a.getItems(2)).length, 2);
  t.deepEqual(await a.getItems(0), []);

  const popped = await a.popItem();
  t.truthy(popped);
  t.is((await a.getItems()).length, 2);

  await a.clearSession();
  t.deepEqual(await a.getItems(), []);
});

test('WorkflowSafeMemorySession: throws clear error outside Workflow context with no sessionId', (t) => {
  t.throws(() => new WorkflowSafeMemorySession(), { message: /sessionId/ });
});

test('WorkflowSafeMemorySession: distinct instances do not share state', async (t) => {
  const a = new WorkflowSafeMemorySession({ sessionId: 'a' });
  const b = new WorkflowSafeMemorySession({ sessionId: 'b' });
  await a.addItems([userMessage('alpha')]);
  t.is((await a.getItems()).length, 1);
  t.is((await b.getItems()).length, 0);
});

test('TemporalOpenAIRunner.run: rejects upstream MemorySession with UnsafeSessionError', async (t) => {
  const runner = Object.create(TemporalOpenAIRunner.prototype) as TemporalOpenAIRunner;
  const err = await t.throwsAsync(
    runner.run({} as any, 'hello', { session: new MemorySession({ sessionId: 'leak' }) }),
    { instanceOf: ApplicationFailure }
  );
  t.is((err as ApplicationFailure).type, 'UnsafeSessionError');
  t.regex((err as ApplicationFailure).message, /WorkflowSafeMemorySession/);
});
