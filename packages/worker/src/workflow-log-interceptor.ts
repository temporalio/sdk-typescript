import {
  Next,
  WorkflowExecuteInput,
  WorkflowInboundCallsInterceptor,
  WorkflowOutboundCallsInterceptor,
  WorkflowInterceptorsFactory,
  GetLogAttributesInput,
} from '@temporalio/workflow';

/** Logs workflow execution starts and completions, attaches log attributes to `workflow.log` calls  */
export class WorkflowLogInterceptor implements WorkflowInboundCallsInterceptor, WorkflowOutboundCallsInterceptor {
  getLogAttributes(
    input: GetLogAttributesInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'getLogAttributes'>
  ): Record<string, unknown> {
    return next(input);
  }

  execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    // Logging of workflow's life cycle events is now handled in `workflow/src/logs.ts`
    // This interceptor is now a noop in most cases, except for legacy support of some deprecated usage.
    return next(input);
  }
}

/** @deprecated use {@link WorkflowLogInterceptor} instead */
export const WorkflowInboundLogInterceptor = WorkflowLogInterceptor;

// ts-prune-ignore-next
export const interceptors: WorkflowInterceptorsFactory = () => {
  const interceptor = new WorkflowLogInterceptor();
  return { inbound: [interceptor], outbound: [interceptor] };
};
