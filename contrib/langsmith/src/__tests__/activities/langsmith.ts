/**
 * Activity implementations for the plugin test suite.
 *
 * @module
 */

import { ApplicationFailure, ApplicationFailureCategory } from '@temporalio/common';

export async function simpleActivity(input: string): Promise<string> {
  return `did:${input}`;
}

export async function a(): Promise<string> {
  return 'a';
}

export async function b(): Promise<string> {
  return 'b';
}

export async function c(): Promise<string> {
  return 'c';
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
