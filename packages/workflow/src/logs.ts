import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { untrackPromise } from './stack-helpers';
import { Sink, Sinks, proxySinks } from './sinks';
import { assertInWorkflowContext } from './internals';
import { isCancellation } from './errors';
import { continueAsNew } from './workflow';
import { WorkflowInfo } from './interfaces';

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

export function executeWorkflowWithLifeCycle(fn: () => Promise<unknown>): Promise<unknown> {
  log.debug('Workflow started');
  const p = fn().then(
    (res) => {
      log.debug('Workflow completed');
      return res;
    },
    (error) => {
      // Avoid using instanceof checks in case the modules they're defined in loaded more than once,
      // e.g. by jest or when multiple versions are installed.
      if (typeof error === 'object' && error != null) {
        if (isCancellation(error)) {
          log.debug('Workflow completed as cancelled');
          throw error;
        } else if (error instanceof continueAsNew) {
          log.debug('Workflow continued as new');
          throw error;
        }
      }
      log.warn('Workflow failed', { error });
      throw error;
    }
  );
  // Avoid showing this interceptor in stack trace query
  untrackPromise(p);
  return p;
}

/**
 * Returns a map of attributes to be set _by default_ on log messages for a given Workflow.
 * Note that this function may be called from outside of the Workflow context (eg. by the worker itself).
 */
export function workflowLogAttributes(info: WorkflowInfo): Record<string, unknown> {
  return {
    namespace: info.namespace,
    taskQueue: info.taskQueue,
    workflowId: info.workflowId,
    runId: info.runId,
    workflowType: info.workflowType,
  };
}
