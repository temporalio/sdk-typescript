import { assertNotInWorkflowEnv as _assertNotInWorkflowEnv } from '@temporalio/internal-non-workflow-common';
import { ApplicationFailure } from '@temporalio/workflow';

export async function assertNotInWorkflowEnv(): Promise<void> {
  try {
    _assertNotInWorkflowEnv('testpkg');
  } catch (err) {
    throw new ApplicationFailure('assertion failed', 'type', true, [], err as Error);
  }
}
