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
 * Signals that a requested operation can't be completed because it is illegal given the
 * current state of the object; e.g. trying to use a resource after it has been closed.
 */
@SymbolBasedInstanceOfError('IllegalStateError')
export class IllegalStateError extends Error {}

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
