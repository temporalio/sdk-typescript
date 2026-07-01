/**
 * Activity implementations for the plugin test suite.
 *
 * @module
 */

import { ApplicationFailure, ApplicationFailureCategory } from '@temporalio/common';

export async function simpleActivity(input: string): Promise<string> {
  return `did:${input}`;
}

/** A plain activity with no `traceable` in its body. */
export async function plainActivity(input: string): Promise<string> {
  return `plain:${input}`;
}

export async function failingActivity(): Promise<never> {
  throw ApplicationFailure.create({ message: 'activity-failed', type: 'ApplicationError' });
}

/** Activity that fails with a BENIGN-category error. */
export async function benignFailingActivity(): Promise<never> {
  throw ApplicationFailure.create({
    message: 'benign-stop',
    type: 'BenignStop',
    category: ApplicationFailureCategory.BENIGN,
    nonRetryable: true,
  });
}
