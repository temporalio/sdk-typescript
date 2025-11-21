import {
  Next,
  WorkflowExecuteInput,
  WorkflowInboundCallsInterceptor,
  WorkflowOutboundCallsInterceptor,
  WorkflowInterceptorsFactory,
  GetLogAttributesInput,
} from '@temporalio/workflow';

/**
 * This interceptor used to be meant to log Workflow execution starts and completions, and attaches log attributes to
 * `workflow.log` calls. It is now deprecated and behaves as a noop in all cases. It is only kept arround to avoid
 * breaking code out there that was previously refering to it.
 *
 * @deprecated `WorkflowLogInterceptor` is deprecated. Workflow lifecycle events are now automatically logged
 *             by the SDK. To customize workflow log attributes, simply register a custom `WorkflowInterceptors` that
 *             intercepts the `outbound.getLogAttributes()` method.
 */
export class WorkflowLogInterceptor implements WorkflowInboundCallsInterceptor, WorkflowOutboundCallsInterceptor {
  getLogAttributes(
    input: GetLogAttributesInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'getLogAttributes'>
  ): Record<string, unknown> {
    return next(input);
  }

  execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    // Logging of workflow's lifecycle events is now handled in `workflow/src/logs.ts`
    return next(input);
  }
}

/**
 * @deprecated `WorkflowInboundLogInterceptor` is deprecated. Workflow lifecycle events are now automatically logged
 *             by the SDK. To customize workflow log attributes, simply register a custom `WorkflowInterceptors` that
 *             intercepts the `outbound.getLogAttributes()` method.
 */
// eslint-disable-next-line deprecation/deprecation
export const WorkflowInboundLogInterceptor = WorkflowLogInterceptor;

// ts-prune-ignore-next
export const interceptors: WorkflowInterceptorsFactory = () => {
  // eslint-disable-next-line deprecation/deprecation
  const interceptor = new WorkflowLogInterceptor();
  return { inbound: [interceptor], outbound: [interceptor] };
};
