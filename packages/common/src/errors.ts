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

/**
 * Throw this error from an Activity in order to make the Worker forget about this Activity.
 *
 * The Activity can then be completed asynchronously (from anywhere—usually outside the Worker) using
 * the Client's activity handle.
 *
 * @example
 *
 * ```ts
 *import { CompleteAsyncError } from '@temporalio/activity';
 *
 *export async function myActivity(): Promise<never> {
 *  // ...
 *  throw new CompleteAsyncError();
 *}
 * ```
 */
@SymbolBasedInstanceOfError('CompleteAsyncError')
export class CompleteAsyncError extends Error {}

// TODO: Get some consensus on these extstorage errors. The idea is that we can
// have stable error codes across all the SDKs to allow users to reliably analyze them. 
// For now, they are just drafts.

/**
 * Thrown when an inbound payload is detected as an external-storage reference
 * but the worker/client has no `ExternalStorage` configured to resolve it.
 *
 * Code: `TMPRL1105`
 *
 * @experimental
 */
@SymbolBasedInstanceOfError('ExternalStorageNotConfiguredError')
export class ExternalStorageNotConfiguredError extends Error {
  constructor(message: string) {
    super(`[TMPRL1105] ${message}`);
  }
}

/**
 * Thrown when an inbound reference payload names a driver that is not
 * registered with the configured `ExternalStorage`.
 *
 * Code: `TMPRL1106`
 *
 * @experimental
 */
@SymbolBasedInstanceOfError('ExternalStorageDriverNotFoundError')
export class ExternalStorageDriverNotFoundError extends Error {
  constructor(
    message: string,
    public readonly driverName: string
  ) {
    super(`[TMPRL1106] ${message}`);
  }
}

/**
 * Thrown when a driver's `store()` or `retrieve()` raises. Wraps the
 * underlying error in `cause` (network, auth, rate-limit, S3 5xx, etc).
 *
 * Code: `TMPRL1107`
 *
 * @experimental
 */
@SymbolBasedInstanceOfError('ExternalStorageDriverOperationFailedError')
export class ExternalStorageDriverOperationFailedError extends Error {
  constructor(
    message: string,
    public readonly driverName: string,
    public readonly operation: 'store' | 'retrieve',
    public readonly cause: unknown
  ) {
    super(`[TMPRL1107] ${message}`);
  }
}

/**
 * Thrown when a driver returns a different number of claims/payloads than
 * it was given (e.g. 5 payloads in, 4 claims out). Indicates a driver bug.
 * No retries should be attempted.
 *
 * Code: `TMPRL1108`
 *
 * @experimental
 */
@SymbolBasedInstanceOfError('ExternalStorageDriverArityMismatchError')
export class ExternalStorageDriverArityMismatchError extends Error {
  constructor(
    message: string,
    public readonly driverName: string,
    public readonly operation: 'store' | 'retrieve',
    public readonly expected: number,
    public readonly actual: number
  ) {
    super(`[TMPRL1108] ${message}`);
  }
}

/**
 * Thrown when a `StorageDriverSelector` returns a driver that is not in
 * the configured drivers list. User error in selector implementation.
 * No retries should be attempted.
 *
 * Code: `TMPRL1109`
 *
 * @experimental
 */
@SymbolBasedInstanceOfError('ExternalStorageSelectorInvalidDriverError')
export class ExternalStorageSelectorInvalidDriverError extends Error {
  constructor(
    message: string,
    public readonly driverName: string
  ) {
    super(`[TMPRL1109] ${message}`);
  }
}

/**
 * Thrown when retrieved bytes fail integrity verification (e.g. SHA-256
 * mismatch in the S3 driver, or recorded `size_bytes` does not match the
 * size of the retrieved payload). Possible data corruption or tampering. 
 * No retries should be attempted.
 *
 * Code: `TMPRL1110`
 *
 * @experimental
 */
@SymbolBasedInstanceOfError('ExternalStorageIntegrityCheckFailedError')
export class ExternalStorageIntegrityCheckFailedError extends Error {
  constructor(
    message: string,
    public readonly driverName: string
  ) {
    super(`[TMPRL1110] ${message}`);
  }
}
