import { inWorkflowEnv } from '@temporalio/common';
import { IllegalStateError } from '@temporalio/internal-workflow-common';

export function assertNotInWorkflowEnv(callingPackage: string): void {
  if (inWorkflowEnv()) {
    throw new IllegalStateError(
      `Importing from '@temporalio/${callingPackage}' in Workflow code is not supported. Workflow code should only import from '@temporalio/workflow' and '@temporalio/common'. For more information: https://docs.temporal.io/docs/typescript/determinism/`
    );
  }
}
