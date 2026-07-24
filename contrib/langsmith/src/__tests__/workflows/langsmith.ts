/**
 * Workflow fixtures for the plugin test suite (the worker's `workflowsPath`).
 *
 * @module
 */

import { traceable } from 'langsmith/traceable';
import {
  ApplicationFailure,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  defineUpdate,
  proxyActivities,
  proxyLocalActivities,
  setHandler,
  sleep,
  startChild,
  uuid4,
  workflowInfo,
} from '@temporalio/workflow';
import { ApplicationFailureCategory } from '@temporalio/common';

import type * as activities from '../activities/langsmith';

const { simpleActivity, plainActivity, failingActivity, benignFailingActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 1 },
});

const { a, b, c } = proxyLocalActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 1 },
});

/** A native `traceable` invoked directly inside a workflow body. */
const workflowInnerCall = traceable(async (input: string): Promise<string> => `wf-llm:${input}`, {
  name: 'workflow_inner_call',
});

/** Single plain activity. */
export async function SimpleWorkflow(input: string): Promise<string> {
  return simpleActivity(input);
}

/** Calls native `traceable` directly in the workflow body. */
export async function WorkflowBodyTraceableWorkflow(input: string): Promise<string> {
  return workflowInnerCall(input);
}

/** Leaf `traceable` invoked by {@link parentTraceable} (nested-parenting fixture). */
const leafTraceable = traceable(async (input: string): Promise<string> => `leaf:${input}`, { name: 'leaf' });

/**
 * Awaits, THEN calls {@link leafTraceable} — so the child is created after the
 * parent's synchronous frame has unwound. Real async context still resolves the
 * parent; a synchronous context stack would have lost it and parented `leaf`
 * under the workflow run instead.
 */
const parentTraceable = traceable(
  async (input: string): Promise<string> => {
    await sleep(1);
    return leafTraceable(input);
  },
  { name: 'parent' }
);

/** A `traceable` awaiting another after an `await`: asserts nested-parenting via real async context. */
export async function NestedTraceableWorkflow(input: string): Promise<string> {
  return parentTraceable(input);
}

/** A `traceable` fanned out under {@link ConcurrentTraceableWorkflow}; awaits so branches interleave. */
const fanoutTraceable = traceable(
  async (input: string): Promise<string> => {
    await sleep(1);
    return `fan:${input}`;
  },
  { name: 'fanout' }
);

/** `Promise.all` fan-out of `traceable` calls: each concurrent branch parents under the workflow run. */
export async function ConcurrentTraceableWorkflow(input: string): Promise<string[]> {
  return Promise.all([fanoutTraceable(`${input}-a`), fanoutTraceable(`${input}-b`), fanoutTraceable(`${input}-c`)]);
}

/** An async-generator `traceable`: exercises LangSmith's `AsyncLocalStorage.snapshot()` streaming path. */
const streamingTraceable = traceable(
  async function* streaming(input: string): AsyncGenerator<string> {
    await sleep(1);
    yield `${input}-1`;
    await sleep(1);
    yield `${input}-2`;
    yield `${input}-3`;
  },
  { name: 'streaming' }
);

/** Drives an async-generator `traceable` to completion; the run must parent under the workflow run. */
export async function StreamingTraceableWorkflow(input: string): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of streamingTraceable(input)) {
    chunks.push(chunk);
  }
  return chunks;
}

/** No `traceable` anywhere. */
export async function PlainWorkflow(input: string): Promise<string> {
  return plainActivity(input);
}

export const mySignal = defineSignal<[string]>('my_signal');
export const completeSignal = defineSignal('complete');
export const myQuery = defineQuery<string>('my_query');
export const startSignal = defineSignal('startSignal');

/** Sets a query handler and a releasing signal, then waits. */
export async function HandlersWorkflow(): Promise<string> {
  let done = false;

  setHandler(myQuery, () => 'query-result');
  setHandler(completeSignal, () => {
    done = true;
  });

  await condition(() => done);
  return 'done';
}

/** Child target of {@link SignalChildWorkflow}; waits for a signal. */
export async function SignalReceiverWorkflow(): Promise<string> {
  let value = '';
  setHandler(mySignal, (v: string) => {
    value = v;
  });
  await condition(() => value !== '');
  return value;
}

/** Starts a child and signals it from the workflow body. */
export async function SignalChildWorkflow(input: string): Promise<string> {
  const child = await startChild(SignalReceiverWorkflow, {
    workflowId: `${workflowInfo().workflowId}-signal-child`,
  });
  await child.signal(mySignal, input);
  return child.result();
}

/** Start-with-signal ordering reproducer for async signal inbound interceptors. */
export async function SignalStartOrderingWorkflow(): Promise<string> {
  const order: string[] = [];
  order.push(await a());
  setHandler(startSignal, async () => {
    order.push(await b());
  });
  order.push(await c());
  return order.join('');
}

/** Calls an activity that fails with a non-benign error. */
export async function ErrorWorkflow(): Promise<void> {
  await failingActivity();
}

/** Calls an activity that fails with a BENIGN-category error. */
export async function BenignWorkflow(): Promise<void> {
  await benignFailingActivity();
}

/** Continues as new once, then returns. */
export async function ContinueAsNewWorkflow(iteration: number): Promise<number> {
  if (iteration === 0) {
    await continueAsNew<typeof ContinueAsNewWorkflow>(iteration + 1);
  }
  return iteration;
}

/** Continues as new, then runs a workflow-body `traceable` in the successor. */
export async function ContinueAsNewTraceableWorkflow(iteration: number): Promise<string> {
  if (iteration === 0) {
    await continueAsNew<typeof ContinueAsNewTraceableWorkflow>(iteration + 1);
  }
  return workflowInnerCall(`iter-${iteration}`);
}

export const readonlyUpdate = defineUpdate<string, [string]>('readonly_update');
export const releaseSignal = defineSignal('release');

/** Child target of {@link ReadonlyDeterminismWorkflow}. */
export async function ReadonlyDeterminismChildWorkflow(): Promise<void> {}

/** Draws `uuid4()` post-validator and embeds it in a child `workflowId`, so any PRNG perturbation surfaces on replay. */
export async function ReadonlyDeterminismWorkflow(): Promise<string> {
  let released = false;
  setHandler(readonlyUpdate, (value: string) => `updated:${value}`, {
    validator: (_value: string) => {
      throw new Error('always rejected');
    },
  });
  setHandler(releaseSignal, () => {
    released = true;
  });

  await condition(() => released);

  const id = uuid4();
  const child = await startChild(ReadonlyDeterminismChildWorkflow, {
    workflowId: `rod-child-${id}`,
  });
  await child.result();
  return id;
}

/** Fails directly with a BENIGN failure. */
export async function BenignWorkflowDirect(): Promise<void> {
  throw ApplicationFailure.create({
    message: 'benign-control',
    type: 'BenignStop',
    category: ApplicationFailureCategory.BENIGN,
    nonRetryable: true,
  });
}
