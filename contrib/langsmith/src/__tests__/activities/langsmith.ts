/**
 * Activity implementations for the plugin test suite.
 *
 * Several activities embed LangSmith's *native* `traceable` in their body
 * (unchanged from how a user would write it outside Temporal) to prove the
 * plugin nests those runs under the Temporal-operation run with no code edits.
 *
 * @module
 */

import { ApplicationFailure, ApplicationFailureCategory } from '@temporalio/common';
import { traceable } from 'langsmith/traceable';

/** Leaf LLM-style run. */
const innerLlmCall = traceable(async (prompt: string): Promise<string> => `llm:${prompt}`, {
  name: 'inner_llm_call',
});

/** Intermediate chain run that wraps the leaf. */
const outerChain = traceable(async (prompt: string): Promise<string> => innerLlmCall(prompt), {
  name: 'outer_chain',
});

/** Activity body that traces one level deep: `traceable_activity` → `inner_llm_call`. */
const traceableActivityImpl = traceable(
  async (input: string): Promise<string> => innerLlmCall(input),
  { name: 'traceable_activity' },
);

/** Activity body that traces two levels: `nested_traceable_activity` → `outer_chain` → `inner_llm_call`. */
const nestedTraceableActivityImpl = traceable(
  async (input: string): Promise<string> => outerChain(input),
  { name: 'nested_traceable_activity' },
);

/** A plain activity with no LangSmith instrumentation in its body. */
export async function simpleActivity(input: string): Promise<string> {
  return `did:${input}`;
}

/**
 * A plain activity with no `traceable` in its body — used by the kill-switch and
 * `addTemporalRuns: false` tests where any emitted run must come solely from the
 * plugin, never from user instrumentation.
 */
export async function plainActivity(input: string): Promise<string> {
  return `plain:${input}`;
}

/** Activity whose body runs the `traceable_activity` chain. */
export async function traceableActivity(input: string): Promise<string> {
  return traceableActivityImpl(input);
}

/** Activity whose body runs the deeper `nested_traceable_activity` chain. */
export async function nestedTraceableActivity(input: string): Promise<string> {
  return nestedTraceableActivityImpl(input);
}

/** Activity that always fails with a non-benign application error. */
export async function failingActivity(): Promise<never> {
  throw ApplicationFailure.create({ message: 'activity-failed', type: 'ApplicationError' });
}

/** Activity that fails with a BENIGN-category error (expected, must not mark the run errored). */
export async function benignFailingActivity(): Promise<never> {
  throw ApplicationFailure.create({
    message: 'benign-stop',
    type: 'BenignStop',
    category: ApplicationFailureCategory.BENIGN,
    nonRetryable: true,
  });
}
