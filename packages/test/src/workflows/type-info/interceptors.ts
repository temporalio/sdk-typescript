import type { WorkflowInterceptors } from '@temporalio/workflow';
import { workflowInfo } from '@temporalio/workflow';
import { workflowTypeInfo } from './models';

export const interceptors = (): WorkflowInterceptors => ({
  inbound: [
    {
      handleQuery(input, next) {
        if (workflowInfo().workflowType !== 'queryTarget' || input.queryName !== 'order-alias') {
          return next(input);
        }
        return next({ ...input, queryName: 'order' });
      },
    },
  ],
  outbound: [
    {
      continueAsNew(input, next) {
        if (workflowInfo().workflowType !== 'continueAsNewWithInterceptorTypeInfo') {
          return next(input);
        }
        return next({
          ...input,
          options: {
            ...input.options,
            typeInfo: { inputTypes: workflowTypeInfo.inputTypes },
          },
        });
      },
      scheduleActivity(input, next) {
        if (workflowInfo().workflowType !== 'workflowWithInterceptorTypedActivity') {
          return next(input);
        }
        return next({ ...input, typeInfo: workflowTypeInfo });
      },
      scheduleLocalActivity(input, next) {
        if (workflowInfo().workflowType !== 'workflowWithInterceptorTypedLocalActivity') {
          return next(input);
        }
        return next({ ...input, typeInfo: workflowTypeInfo });
      },
    },
  ],
});
