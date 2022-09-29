/**
 * Type definitions for the Workflow end of the sinks mechanism.
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

/**
 * Any function signature can be used for Sink functions as long as the return type is `void`.
 *
 * When calling a Sink function, arguments are copied from the Workflow isolate to the Node.js environment using
 * {@link https://nodejs.org/api/worker_threads.html#worker_threads_port_postmessage_value_transferlist | postMessage}.

 * This constrains the argument types to primitives (excluding Symbols).
 */
export type SinkFunction = (...args: any[]) => void;

/** A mapping of name to function, defines a single sink (e.g. logger) */
export type Sink = Record<string, SinkFunction>;
/**
 * Workflow Sink are a mapping of name to {@link Sink}
 */
export type Sinks = Record<string, Sink>;

/**
 * Call information for a Sink
 */
export interface SinkCall {
  ifaceName: string;
  fnName: string;
  args: any[];
}

/**
 * Sink interface for forwarding logs from the Workflow sandbox to the Worker
 */
export interface LoggerSinks extends Sinks {
  defaultWorkerLogger: {
    trace(message: string, attrs: Record<string, unknown>): void;
    debug(message: string, attrs: Record<string, unknown>): void;
    info(message: string, attrs: Record<string, unknown>): void;
    warn(message: string, attrs: Record<string, unknown>): void;
    error(message: string, attrs: Record<string, unknown>): void;
  };
}
