/**
 * Activity implementations for the plugin test suite.
 *
 * @module
 */

import { ApplicationFailure, ApplicationFailureCategory } from '@temporalio/common';

/** A plain activity with no LangSmith instrumentation in its body. */
export async function simpleActivity(input: string): Promise<string> {
  return `did:${input}`;
}

/**
 * A plain activity with no `traceable` in its body — used by the tracing gate and
 * `addTemporalRuns: false` tests where any emitted run must come solely from the
 * plugin, never from user instrumentation.
 */
export async function plainActivity(input: string): Promise<string> {
  return `plain:${input}`;
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
