import { TemporalFailure } from './failure';
import { SymbolBasedInstanceOfError } from './type-helpers';

/**
 * Thrown from code that receives a value that is unexpected or that it's unable to handle.
 */
@SymbolBasedInstanceOfError('ValueError')
export class ValueError extends Error {
  constructor(
    message: string | undefined,
    public readonly cause?: unknown
  ) {
    super(message ?? undefined);
  }
}

/**
 * Thrown when a Payload Converter is misconfigured.
 */
@SymbolBasedInstanceOfError('PayloadConverterError')
export class PayloadConverterError extends ValueError {}

/**
 * Used in different parts of the SDK to note that something unexpected has happened.
 */
@SymbolBasedInstanceOfError('IllegalStateError')
export class IllegalStateError extends Error {}

/**
 * This exception is thrown in the following cases:
 *  - Workflow with the same Workflow Id is currently running
 *  - There is a closed Workflow with the same Workflow Id and the {@link WorkflowOptions.workflowIdReusePolicy}
 *    is `WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE`
 *  - There is closed Workflow in the `Completed` state with the same Workflow Id and the {@link WorkflowOptions.workflowIdReusePolicy}
 *    is `WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE_FAILED_ONLY`
 */
@SymbolBasedInstanceOfError('WorkflowExecutionAlreadyStartedError')
export class WorkflowExecutionAlreadyStartedError extends TemporalFailure {
  constructor(
    message: string,
    public readonly workflowId: string,
    public readonly workflowType: string
  ) {
    super(message);
  }
}

/**
 * Thrown when a Workflow with the given Id is not known to Temporal Server.
 * It could be because:
 * - Id passed is incorrect
 * - Workflow is closed (for some calls, e.g. `terminate`)
 * - Workflow was deleted from the Server after reaching its retention limit
 */
@SymbolBasedInstanceOfError('WorkflowNotFoundError')
export class WorkflowNotFoundError extends Error {
  constructor(
    message: string,
    public readonly workflowId: string,
    public readonly runId: string | undefined
  ) {
    super(message);
  }
}

/**
 * Thrown when the specified namespace is not known to Temporal Server.
 */
@SymbolBasedInstanceOfError('NamespaceNotFoundError')
export class NamespaceNotFoundError extends Error {
  constructor(public readonly namespace: string) {
    super(`Namespace not found: '${namespace}'`);
  }
}
