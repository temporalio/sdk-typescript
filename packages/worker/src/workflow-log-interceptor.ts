import {
  isCancellation,
  Next,
  WorkflowExecuteInput,
  WorkflowInboundCallsInterceptor,
  WorkflowInterceptorsFactory,
  WorkflowInfo,
  log,
  ContinueAsNew,
} from '@temporalio/workflow';
import { untrackPromise } from '@temporalio/workflow/lib/stack-helpers';

/**
 * Returns a map of attributes to be set on log messages for a given Workflow
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

/** Logs Workflow execution starts and completions */
export class WorkflowInboundLogInterceptor implements WorkflowInboundCallsInterceptor {
  execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    log.debug('Workflow started');
    const p = next(input).then(
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
          } else if (ContinueAsNew.is(error)) {
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
}

// ts-prune-ignore-next
export const interceptors: WorkflowInterceptorsFactory = () => ({ inbound: [new WorkflowInboundLogInterceptor()] });
