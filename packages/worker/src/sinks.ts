/**
 * Type definitions for the Worker end of the sinks mechanism.
 *
 * Sinks are a mechanism for exporting data from the Workflow isolate to the
 * Node.js environment, they are necessary because the Workflow has no way to
 * communicate with the outside World.
 *
 * Sinks are typically used for exporting logs, metrics and traces out from the
 * Workflow.
 *
 * Sink functions may not return values to the Workflow in order to prevent
 * breaking determinism.
 *
 * @module
 */

import { Sinks, Sink, SinkFunction, WorkflowInfo } from '@temporalio/workflow';

/**
 * Registration of a {@link SinkFunction}, including per-sink-function options.
 *
 * Sinks are a mechanism for exporting data out of the Workflow sandbox. They are typically used
 * to implement in-workflow observability mechanisms, such as logs, metrics and traces.
 *
 * To prevent non-determinism issues, sink functions may not have any observable side effect on the
 * execution of a workflow. In particular, sink functions may not return values to the workflow,
 * nor throw errors to the workflow (an exception thrown from a sink function simply get logged to
 * the {@link Runtime}'s logger).
 *
 * For similar reasons, sink functions are not executed immediately when a call is made from
 * workflow code. Instead, calls are buffered until the end of the workflow activation; they get
 * executed right before returning a completion response to Core SDK. Note that the time it takes to
 * execute sink functions delays sending a completion response to the server, and may therefore
 * induce Workflow Task Timeout errors. Sink functions should thus be kept as fast as possible.
 *
 * Sink functions are always invoked in the order that calls were maded in workflow code. However,
 * unless the `callSerially` option is set to `true`, async sink functions are not awaited
 * individually. Consequently, sink functions that internally perform async operations may end up
 * executing in parallel. If strict ordering of some sink function execution is required, consider
 * enabling the `callSerially` option on these functions. Note however that serializing sink
 * function calls may increase total execution time, and therefore increase the risk of Workflow
 * Task Timeout.
 *
 * By default, sink functions are called no matter if the activation completed normally or resulted
 * in an error being thrown. This generally is the expected behavior, notably when sinks are used
 * for logging and tracing. A sink may however opt out of being called if the activation ended in an
 * error, by setting the `callOnFailedActivations` option to `false`.
 */
export interface InjectedSinkFunction<F extends SinkFunction> {
  /**
   * The implementation function for sink function `F`
   */
  fn(info: WorkflowInfo, ...args: Parameters<F>): void | Promise<void>;

  /**
   * Whether or not `fn` will be called during Workflow replay. Defaults to `false`.
   */
  callDuringReplay?: boolean;

  /**
   * If set to `true`, execution calls to this sink function will be serialized, ensuring strict
   * ordering of this sink function execution with respect to any other sink function.
   *
   * More formally, any pending executions of sink functions prior to this one will be awaited for
   * completion before this one is executed, and completion of this sink function call will be
   * awaited for completion before any subsequent sink function call is executed.
   *
   * Note that serializing sink function calls may increase total execution time, and therefore
   * increase the risk of Workflow Task Timeout.
   *
   * Defaults to `false`.
   */
  callSerially?: boolean;

  /**
   * Wether this sink function should be called if the activation resulted in an error being thrown.
   *
   * Defaults to `true`.
   */
  callOnFailedActivations?: boolean;
}

/**
 * Converts a {@link Sink} from a mapping of name to function to a mapping of name to {@link InjectedSinkFunction}
 */
export type InjectedSink<T extends Sink> = {
  [P in keyof T]: InjectedSinkFunction<T[P]>;
};

/**
 * Converts a {@link Sinks} interface from a mapping of name to {@link Sink} to a mapping of name to {@link InjectedSink}.
 *
 * Used for type checking Sink injection against supplied type param `T`.
 */
export type InjectedSinks<T extends Sinks> = {
  [P in keyof T]: InjectedSink<T[P]>;
};
