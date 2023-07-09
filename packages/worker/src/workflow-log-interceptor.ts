import {
  isCancellation,
  Next,
  WorkflowExecuteInput,
  WorkflowInboundCallsInterceptor,
  WorkflowOutboundCallsInterceptor,
  workflowInfo,
  WorkflowInfo,
  WorkflowInterceptorsFactory,
  log,
  ContinueAsNew,
  GetLogAttributesInput,
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

/** Logs workflow execution starts and completions, attaches log attributes to `workflow.log` calls  */
export class WorkflowLogInterceptor implements WorkflowInboundCallsInterceptor, WorkflowOutboundCallsInterceptor {
  getLogAttributes(
    input: GetLogAttributesInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'getLogAttributes'>
  ): Record<string, unknown> {
    return next({ ...input, ...workflowLogAttributes(workflowInfo()) });
  }

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
          } else if (error instanceof ContinueAsNew) {
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

/** @deprecated use {@link WorkflowLogInterceptor} instead */
export const WorkflowInboundLogInterceptor = WorkflowLogInterceptor;

// ts-prune-ignore-next
export const interceptors: WorkflowInterceptorsFactory = () => {
  const interceptor = new WorkflowLogInterceptor();
  return { inbound: [interceptor], outbound: [interceptor] };
};
