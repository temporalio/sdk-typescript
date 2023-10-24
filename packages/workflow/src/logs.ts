import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { Sink, Sinks, proxySinks } from './sinks';
import { assertInWorkflowContext } from './internals';

export interface WorkflowLogger extends Sink {
  trace(message: string, attrs?: Record<string, unknown>): void;
  debug(message: string, attrs?: Record<string, unknown>): void;
  info(message: string, attrs?: Record<string, unknown>): void;
  warn(message: string, attrs?: Record<string, unknown>): void;
  error(message: string, attrs?: Record<string, unknown>): void;
}

/**
 * Sink interface for forwarding logs from the Workflow sandbox to the Worker
 */
export interface LoggerSinks extends Sinks {
  defaultWorkerLogger: WorkflowLogger;
}

const loggerSink = proxySinks<LoggerSinks>().defaultWorkerLogger;

/**
 * Symbol used by the SDK logger to extract a timestamp from log attributes.
 * Also defined in `worker/logger.ts` - intentionally not shared.
 */
const LogTimestamp = Symbol.for('log_timestamp');

/**
 * Default workflow logger.
 *
 * This logger is replay-aware and will omit log messages on workflow replay. Messages emitted by this logger are
 * funnelled through a sink that forwards them to the logger registered on {@link Runtime.logger}.
 *
 * Notice that since sinks are used to power this logger, any log attributes must be transferable via the
 * {@link https://nodejs.org/api/worker_threads.html#worker_threads_port_postmessage_value_transferlist | postMessage}
 * API.
 *
 * NOTE: Specifying a custom logger through {@link defaultSink} or by manually registering a sink named
 * `defaultWorkerLogger` has been deprecated. Please use {@link Runtime.logger} instead.
 */
export const log: WorkflowLogger = Object.fromEntries(
  (['trace', 'debug', 'info', 'warn', 'error'] as Array<keyof WorkflowLogger>).map((level) => {
    return [
      level,
      (message: string, attrs?: Record<string, unknown>) => {
        const activator = assertInWorkflowContext('Workflow.log(...) may only be used from workflow context.');
        const getLogAttributes = composeInterceptors(activator.interceptors.outbound, 'getLogAttributes', (a) => a);
        return loggerSink[level](message, {
          // Inject the call time in nanosecond resolution as expected by the worker logger.
          [LogTimestamp]: activator.getTimeOfDay(),
          ...getLogAttributes({}),
          ...attrs,
        });
      },
    ];
  })
) as any;
