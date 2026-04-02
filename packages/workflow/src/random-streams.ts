import { IllegalStateError } from '@temporalio/common';

import { assertInWorkflowContext } from './global-attributes';

/**
 * A deterministic PRNG stream scoped to the current Workflow execution.
 *
 * Step 1 note: this is a stub interface so acceptance tests can compile before
 * runtime support lands.
 */
export interface WorkflowRandomStream {
  random(): number;
  uuid4(): string;
  fill(bytes: Uint8Array): Uint8Array;
}

export function getRandomStream(_name: string): WorkflowRandomStream {
  assertInWorkflowContext('Workflow.getRandomStream(...) may only be used from workflow context.');
  throw new IllegalStateError('TODO: Workflow.getRandomStream(...) is not implemented yet');
}

export function withRandomStream<T>(_name: string, _fn: () => T): T {
  assertInWorkflowContext('Workflow.withRandomStream(...) may only be used from workflow context.');
  throw new IllegalStateError('TODO: Workflow.withRandomStream(...) is not implemented yet');
}
