import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { SdkComponent } from '@temporalio/common';
import { untrackPromise } from './stack-helpers';
import { type Sink, type Sinks, proxySinks } from './sinks';
import { isCancellation } from './errors';
import { WorkflowInfo, ContinueAsNew } from './interfaces';
import { assertInWorkflowContext } from './global-attributes';
import { currentUpdateInfo, inWorkflowContext } from './workflow';

export interface WorkflowLogger extends Sink {
  trace(message: string, attrs?: Record<string, unknown>): void;
  debug(message: string, attrs?: Record<string, unknown>): void;
  info(message: string, attrs?: Record<string, unknown>): void;
  warn(message: string, attrs?: Record<string, unknown>): void;
  error(message: string, attrs?: Record<string, unknown>): void;
}

/**
 * Sink interface for forwarding logs from the Workflow sandbox to the Worker
 *
 * @deprecated Do not use LoggerSinks directly. To log from Workflow code, use the `log` object
 *             exported by the `@temporalio/workflow` package. To capture log messages emitted
 *             by Workflow code, set the {@link Runtime.logger} property.
 */
export interface LoggerSinksDeprecated extends Sinks {
  /**
   * @deprecated Do not use LoggerSinks directly. To log from Workflow code, use the `log` object
   *             exported by the `@temporalio/workflow` package. To capture log messages emitted
   *             by Workflow code, set the {@link Runtime.logger} property.
   */
  defaultWorkerLogger: WorkflowLogger;
}

/**
 * Sink interface for forwarding logs from the Workflow sandbox to the Worker
 */
export interface LoggerSinksInternal extends Sinks {
  __temporal_logger: WorkflowLogger;
}

const loggerSink = proxySinks<LoggerSinksInternal>().__temporal_logger;

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
 * Attributes from the current Workflow Execution context are automatically included as metadata on every log
 * entries. An extra `sdkComponent` metadata attribute is also added, with value `workflow`; this can be used for
 * fine-grained filtering of log entries further downstream.
 *
 * To customize log attributes, register a {@link WorkflowOutboundCallsInterceptor} that intercepts the
 * `getLogAttributes()` method.
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
          sdkComponent: SdkComponent.workflow,
          ...getLogAttributes(workflowLogAttributes(activator.info)),
          ...attrs,
        });
      },
    ];
  })
) as any;

export function executeWithLifecycleLogging(fn: () => Promise<unknown>): Promise<unknown> {
  log.debug('Workflow started', { sdkComponent: SdkComponent.worker });
  const p = fn().then(
    (res) => {
      log.debug('Workflow completed', { sdkComponent: SdkComponent.worker });
      return res;
    },
    (error) => {
      // Avoid using instanceof checks in case the modules they're defined in loaded more than once,
      // e.g. by jest or when multiple versions are installed.
      if (typeof error === 'object' && error != null) {
        if (isCancellation(error)) {
          log.debug('Workflow completed as cancelled', { sdkComponent: SdkComponent.worker });
          throw error;
        } else if (error instanceof ContinueAsNew) {
          log.debug('Workflow continued as new', { sdkComponent: SdkComponent.worker });
          throw error;
        }
      }
      log.warn('Workflow failed', { error, sdkComponent: SdkComponent.worker });
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
  const attributes: { [key: string]: string } = {
    namespace: info.namespace,
    taskQueue: info.taskQueue,
    workflowId: info.workflowId,
    runId: info.runId,
    workflowType: info.workflowType,
  };
  if (inWorkflowContext()) {
    const updateInfo = currentUpdateInfo();
    if (updateInfo) {
      // Add update info if it exists
      attributes['updateId'] = updateInfo.id;
      attributes['updateName'] = updateInfo.name;
    }
  }
  return attributes;
}
