/**
 * Type definitions for the Workflow end of the external dependencies mechanism.
 *
 * External dependencies are functions injected into a Workflow isolate from the main Node.js isolate.
 * They are an advanced feature and should be used with care.
 *
 * @see proposal at https://github.com/temporalio/proposals/blob/master/node/logging-and-metrics-for-user-code.md
 *
 * @module
 */

/**
 * Any function signature can be used for dependency functions.
 *
 * Depending on the implementation's and transfer options,
 * when calling a dependency function, arguments and return value are transferred between the Workflow isolate and the Node.js isolate.
 * - `SYNC*` {@link ApplyMode} variants allow configuring how those are transferred between isolates
 * - `ASYNC*` {@link ApplyMode} variants always copy the arguments and return value
 */
export type ExternalDependencyFunction = (...args: any[]) => any;
/** A mapping of name to function, defines a single external dependency (e.g. logger) */
export type ExternalDependency = Record<string, ExternalDependencyFunction>;
/**
 * Workflow dependencies are a mapping of name to {@link ExternalDependency}
 */
export type ExternalDependencies = Record<string, ExternalDependency>;

/**
 * Controls how an external dependency function is executed.
 * - `ASYNC*` variants run at the end of an activation and do **not** block the isolate.
 * - `SYNC*` variants run during Workflow activation and block the isolate,
 *   they're passed into the isolate using an {@link https://github.com/laverdet/isolated-vm#referenceapplyreceiver-arguments-options-promise | isolated-vm Reference}
 *
 * The Worker will log if an error occurs in one of ignored variants.
 *
 * **NOTE: External dependencies are an advanced feature and should be used with caution**
 * - Do not return anything that can break Workflow execution determinism
 * - Synchronous variants should be used as a last resort and their execution time should be kept short to free up the Workflow thread
 */
export enum ApplyMode {
  /**
   * Injected function will be called at the end of an activation.
   * Isolate enqueues function to be called during activation and registers a callback to await its completion.
   * Use if exposing an async function to the isolate for which the result should be returned to the isolate.
   */
  ASYNC = 'async',
  /**
   * Injected function will be called at the end of an activation.
   * Isolate enqueues function to be called during activation and does **not** register a callback to await its completion.
   * This is the safest async `ApplyMode` because it can not break Workflow code determinism.
   * Can only be used when the injected function returns `void` and the implementation returns `void` or `Promise<void>`.
   */
  ASYNC_IGNORED = 'asyncIgnored',
  /**
   * Injected function is called synchronously, implementation must be a synchronous function.
   * Injection is done using an `isolated-vm` reference, function is called with `applySync`.
   */
  SYNC = 'applySync',
  /**
   * Injected function is called synchronously, implementation must return a promise.
   * Injection is done using an `isolated-vm` reference, function is called with `applySyncPromise`.
   */
  SYNC_PROMISE = 'applySyncPromise',
  /**
   * Injected function is called in the background not blocking the isolate.
   * Implementation can be either synchronous or asynchronous.
   * Injection is done using an `isolated-vm` reference, function is called with `applyIgnored`.
   *
   * This is the safest sync `ApplyMode` because it can not break Workflow code determinism.
   */
  SYNC_IGNORED = 'applyIgnored',
}

/**
 * Call information for async external dependencies
 */
export interface ExternalCall {
  ifaceName: string;
  fnName: string;
  args: any[];
  /** Optional in case applyMode is ASYNC_IGNORED */
  seq?: number;
}
