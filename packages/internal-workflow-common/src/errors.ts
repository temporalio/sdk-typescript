export class ValueError extends Error {
  public readonly name: string = 'ValueError';

  constructor(message: string | undefined, public readonly cause?: unknown) {
    super(message ?? undefined);
  }
}

export class PayloadConverterError extends ValueError {
  public readonly name: string = 'PayloadConverterError';
}

/**
 * Used in different parts of the project to signal that something unexpected has happened
 */
export class IllegalStateError extends Error {
  public readonly name: string = 'IllegalStateError';
}

/**
 * This exception is thrown in the following cases:
 *  - Workflow with the same WorkflowId is currently running
 *  - There is a closed workflow with the same ID and the {@link WorkflowOptions.workflowIdReusePolicy}
 *    is `WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE`
 *  - There is successfully closed workflow with the same ID and the {@link WorkflowOptions.workflowIdReusePolicy}
 *    is `WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE_FAILED_ONLY`
 *  - {@link Workflow.execute} is called *more than once* on a handle created through {@link createChildWorkflowHandle} and the
 *    {@link WorkflowOptions.workflowIdReusePolicy} is `WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE`
 */
export class WorkflowExecutionAlreadyStartedError extends Error {
  public readonly name: string = 'WorkflowExecutionAlreadyStartedError';

  constructor(message: string, public readonly workflowId: string, public readonly workflowType: string) {
    super(message);
  }
}

/**
 * Thrown when workflow with the given id is not known to the Temporal service.
 * It could be because:
 * - ID passed is incorrect
 * - Workflow execution is complete (for some calls e.g. terminate),
 * - workflow was purged from the service after reaching its retention limit.
 */
export class WorkflowNotFoundError extends Error {
  public readonly name: string = 'WorkflowNotFoundError';

  constructor(message: string, public readonly workflowId: string, public readonly runId: string | undefined) {
    super(message);
  }
}

/**
 * Get error message from an Error or string or return undefined
 */
export function errorMessage(err: unknown): string | undefined {
  if (typeof err === 'string') {
    return err;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return undefined;
}

interface ErrorWithCode {
  code: string;
}
/**
 * Get error code from an Error or return undefined
 */
export function errorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    (error as ErrorWithCode).code !== undefined &&
    typeof (error as ErrorWithCode).code === 'string'
  ) {
    return (error as ErrorWithCode).code;
  }

  return undefined;
}
