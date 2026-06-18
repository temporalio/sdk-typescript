/**
 * The client interceptor captures each call's args from the SDK's real input shape
 * (`input.options.args` for start, `input.signalArgs`, `input.args`).
 *
 * @module
 */

import test from 'ava';
import type { WorkflowClientInterceptor } from '@temporalio/client';

import { createClientInterceptor } from '../client-interceptor';
import { InMemoryRunCollector } from './helpers';

process.env.LANGSMITH_TRACING = 'true';
// Keep langsmith callbacks synchronous so emission completes within the test.
process.env.LANGCHAIN_CALLBACKS_BACKGROUND = 'false';

function interceptor(collector: InMemoryRunCollector): WorkflowClientInterceptor {
  return createClientInterceptor({ client: collector.asClient(), addTemporalRuns: true });
}

const baseInput = { headers: {} };

test.serial('startWithDetails marker captures args from input.options.args', async (t) => {
  const collector = new InMemoryRunCollector();
  const i = interceptor(collector);
  await i.startWithDetails!({ ...baseInput, workflowType: 'W', options: { args: ['a', 1] } } as never, async () => ({
    runId: 'run-id',
    eagerlyStarted: false,
  }));
  t.deepEqual(collector.byName('StartWorkflow:W')?.inputs?.args, ['a', 1]);
});

test.serial('signalWithStart marker captures args from input.signalArgs', async (t) => {
  const collector = new InMemoryRunCollector();
  const i = interceptor(collector);
  await i.signalWithStart!(
    { ...baseInput, workflowType: 'W', signalName: 's', signalArgs: ['sig'], options: { args: [] } } as never,
    async () => 'run-id'
  );
  t.deepEqual(collector.byName('SignalWithStartWorkflow:W')?.inputs?.args, ['sig']);
});

test.serial('startUpdate marker captures args from input.args and names from input.updateName', async (t) => {
  const collector = new InMemoryRunCollector();
  const i = interceptor(collector);
  await i.startUpdate!({ ...baseInput, updateName: 'u', args: ['upd'] } as never, async () => ({
    updateId: 'id',
    workflowRunId: 'r',
  }));
  t.deepEqual(collector.byName('StartWorkflowUpdate:u')?.inputs?.args, ['upd']);
});
