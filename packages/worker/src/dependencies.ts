/**
 * Type definitions for the Worker end of the external dependencies mechanism.
 *
 * External dependencies are functions injected into a Workflow isolate from the main Node.js isolate.
 * They are an advanced feature and should be used with care.
 *
 * @see proposal at https://github.com/temporalio/proposals/blob/master/node/logging-and-metrics-for-user-code.md
 *
 * @module
 */

import ivm from 'isolated-vm';
import {
  ApplyMode,
  ExternalDependencies,
  ExternalDependency,
  ExternalDependencyFunction,
  WorkflowInfo,
} from '@temporalio/workflow';

export { ApplyMode };

/** Return T if T is not a Promise otherwise extracts the type wrapped in T */
export type StripPromise<T> = T extends Promise<infer I> ? I : T;

/** Wraps a function's parameters to isolated VM references */
type RefParameters<T extends (...args: any) => any> = T extends (...args: infer P) => any
  ? { [I in keyof P]: ivm.Reference<P[I]> }
  : never;

/** Synchronous variant of injected dependency function - uses isolated-vm to inject into the isolate */
export type InjectedDependencyFunctionIvmVariant<F extends ExternalDependencyFunction, A extends ApplyMode, R> =
  | {
      arguments: 'copy';
      fn(info: WorkflowInfo, ...args: Parameters<F>): R;
      applyMode: A;
      callDuringReplay?: boolean;
    }
  | {
      arguments: 'reference';
      fn(info: WorkflowInfo, ...args: RefParameters<F>): R;
      applyMode: A;
      callDuringReplay?: boolean;
    };

/**
 * Takes a {@link ExternalDependencyFunction} and turns it into a type safe specification consisting of the function implementation type and call configuration.
 *
 * `InjectedDependencyFunction` consists of these attributes:
 *
 * - `fn` - type of the implementation function for dependency `F`
 * - `applyMode` - defines how `fn` is called from the Workflow isolate (@see {@link ApplyMode})
 * - `callDuringReplay` - whether or not `fn` will be called during Workflow replay - defaults to `false`
 * - `arguments` - configure how arguments are transferred between isolates
 *   - only relevant to `SYNC_*` {@link ApplyMode}s
 *   - (@see {@link https://github.com/laverdet/isolated-vm#transferoptions | isolated-vm docs})
 */
export type InjectedDependencyFunction<F extends ExternalDependencyFunction> = ReturnType<F> extends Promise<any>
  ? {
      fn(info: WorkflowInfo, ...args: Parameters<F>): ReturnType<F> | StripPromise<ReturnType<F>>;
      callDuringReplay?: boolean;
      applyMode: ApplyMode.ASYNC;
    }
  : ReturnType<F> extends void
  ?
      | {
          fn(info: WorkflowInfo, ...args: Parameters<F>): ReturnType<F> | Promise<ReturnType<F>>;
          applyMode: ApplyMode.ASYNC_IGNORED;
          callDuringReplay?: boolean;
        }
      | InjectedDependencyFunctionIvmVariant<F, ApplyMode.SYNC_IGNORED, ReturnType<F> | Promise<ReturnType<F>>>
      | InjectedDependencyFunctionIvmVariant<F, ApplyMode.SYNC, ReturnType<F>>
      | InjectedDependencyFunctionIvmVariant<F, ApplyMode.SYNC_PROMISE, Promise<ReturnType<F>>>
  :
      | InjectedDependencyFunctionIvmVariant<F, ApplyMode.SYNC, ReturnType<F>>
      | InjectedDependencyFunctionIvmVariant<F, ApplyMode.SYNC_PROMISE, Promise<ReturnType<F>>>;

/**
 * Turns a {@link ExternalDependency} from a mapping of name to function to a mapping of name to {@link InjectedDependencyFunction}
 */
export type InjectedDependency<T extends ExternalDependency> = {
  [P in keyof T]: InjectedDependencyFunction<T[P]>;
};

/**
 * Turns a {@link ExternalDependencies} interface from a mapping of name to {@link ExternalDependency} to a mapping of name to {@link InjectedDependency}.
 *
 * Used for type checking Workflow external dependency injection.
 */
export type InjectedDependencies<T extends ExternalDependencies> = {
  [P in keyof T]: InjectedDependency<T[P]>;
};

/**
 * Helper for extracting ivm.TransferOptionsBidirectional (when applicable) from an `InjectedDependencyFunction`.
 */
export function getIvmTransferOptions(
  fn: InjectedDependencyFunction<any>
): ivm.TransferOptionsBidirectional | undefined {
  const fnAsIvmVariant = fn as InjectedDependencyFunctionIvmVariant<any, any, any>;
  return fnAsIvmVariant.arguments ? { arguments: { [fnAsIvmVariant.arguments]: true } } : undefined;
}
