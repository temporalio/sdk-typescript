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
  setHandler,
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

/** No `traceable` anywhere. */
export async function PlainWorkflow(input: string): Promise<string> {
  return plainActivity(input);
}

export const mySignal = defineSignal<[string]>('my_signal');
export const completeSignal = defineSignal('complete');
export const myQuery = defineQuery<string>('my_query');

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
