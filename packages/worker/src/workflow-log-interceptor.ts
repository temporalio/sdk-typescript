import {
  WorkflowInboundCallsInterceptor,
  WorkflowExecuteInput,
  Next,
  workflowInfo,
  WorkflowInfo,
  isCancellation,
  proxySinks,
  Sinks,
  WorkflowInterceptorsFactory,
} from '@temporalio/workflow';
import { untrackPromise } from '@temporalio/workflow/lib/stack-helpers';

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

/**
 * Returns a map of attributes to be set on log messages for a given Workflow
 */
export function workflowLogAttributes(info: WorkflowInfo): Record<string, unknown> {
  return {
    namespace: info.namespace,
    taskQueue: info.taskQueue,
    workflowId: info.workflowId,
    workflowRunId: info.runId,
    workflowType: info.workflowType,
  };
}

/** Logs Workflow execution starts and completions */
export class WorkflowInboundLogInterceptor implements WorkflowInboundCallsInterceptor {
  protected logAttributes(): Record<string, unknown> {
    return workflowLogAttributes(workflowInfo());
  }

  execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    const { defaultWorkerLogger: logger } = proxySinks<LoggerSinks>();

    logger.debug('Workflow started', this.logAttributes());
    const p = next(input).then(
      (res) => {
        logger.debug('Workflow completed', this.logAttributes());
        return res;
      },
      (error) => {
        // Avoid using instanceof checks in case the modules they're defined in loaded more than once,
        // e.g. by jest or when multiple versions are installed.
        if (typeof error === 'object' && error != null) {
          if (isCancellation(error)) {
            logger.debug('Workflow completed as cancelled', this.logAttributes());
            throw error;
          } else if (error.name === 'ContinueAsNew') {
            logger.debug('Workflow continued as new', this.logAttributes());
            throw error;
          }
        }
        logger.warn('Workflow failed', { error, ...this.logAttributes() });
        throw error;
      }
    );
    // Avoid showing this interceptor in stack trace query
    untrackPromise(p);
    return p;
  }
}

export const interceptors: WorkflowInterceptorsFactory = () => ({ inbound: [new WorkflowInboundLogInterceptor()] });
