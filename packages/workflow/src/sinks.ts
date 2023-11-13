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

import { WorkflowInfo } from './interfaces';
import { assertInWorkflowContext } from './global-attributes';

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
  workflowInfo: WorkflowInfo;
}

/**
 * Get a reference to Sinks for exporting data out of the Workflow.
 *
 * These Sinks **must** be registered with the Worker in order for this
 * mechanism to work.
 *
 * @example
 * ```ts
 * import { proxySinks, Sinks } from '@temporalio/workflow';
 *
 * interface MySinks extends Sinks {
 *   logger: {
 *     info(message: string): void;
 *     error(message: string): void;
 *   };
 * }
 *
 * const { logger } = proxySinks<MyDependencies>();
 * logger.info('setting up');
 *
 * export function myWorkflow() {
 *   return {
 *     async execute() {
 *       logger.info("hey ho");
 *       logger.error("lets go");
 *     }
 *   };
 * }
 * ```
 */
export function proxySinks<T extends Sinks>(): T {
  return new Proxy(
    {},
    {
      get(_, ifaceName) {
        return new Proxy(
          {},
          {
            get(_, fnName) {
              return (...args: any[]) => {
                const activator = assertInWorkflowContext(
                  'Proxied sinks functions may only be used from a Workflow Execution.'
                );
                activator.sinkCalls.push({
                  ifaceName: ifaceName as string,
                  fnName: fnName as string,
                  // Sink function doesn't get called immediately. Make a clone of the sink's args, so that further mutations
                  // to these objects don't corrupt the args that the sink function will receive. Only available from node 17.
                  args: (globalThis as any).structuredClone ? (globalThis as any).structuredClone(args) : args,
                  // activator.info is internally copy-on-write. This ensure that any further mutations
                  // to the workflow state in the context of the present activation will not corrupt the
                  // workflowInfo state that gets passed when the sink function actually gets called.
                  workflowInfo: activator.info,
                });
              };
            },
          }
        );
      },
    }
  ) as any;
}
