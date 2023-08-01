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
 * See {@link WorkerOptions.sinks} for more details.
 */
export interface InjectedSinkFunction<F extends SinkFunction> {
  /**
   * The implementation function for sink function `F`
   */
  fn(info: WorkflowInfo, ...args: Parameters<F>): void | Promise<void>;

  /**
   * Whether or not the function will be called during Workflow replay.
   *
   * Take note that setting `callDuringReplay` to `false` (or leaving it unset) doesn't guarantee
   * that the sink function will only ever run once for a particular Workflow execution at a
   * particular point of its history. In particular, calls to sink functions will be executed
   * even if the current workflow task ends up failling or timing out. In such situations, a call to
   * a sink function configured with `callDuringReplay: false` will be executed again, since
   * the workflow task is not being replayed (ie. retrying a workflow task is not the same as
   * replaying it).
   *
   * For use cases that require _at-most-once_ or _exactly-once_ guarantees, please consider using
   * a regular activity instead.
   *
   * Defaults to `false`.
   */
  callDuringReplay?: boolean;
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
