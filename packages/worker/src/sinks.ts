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
 * Takes a {@link SinkFunction} and turns it into a type safe specification
 * consisting of the function implementation type and call configuration.
 *
 * `InjectedSinkFunction` consists of these attributes:
 *
 * - `fn` - type of the implementation function for sink function `F`
 * - `callDuringReplay` - whether or not `fn` will be called during Workflow
 *   replay - defaults to `false`
 */
export interface InjectedSinkFunction<F extends SinkFunction> {
  fn(info: WorkflowInfo, ...args: Parameters<F>): void | Promise<void>;
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
