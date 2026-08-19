import type { WorkflowInterceptors } from '@temporalio/workflow';
import { workflowInfo } from '@temporalio/workflow';
import { workflowTypeInfo } from './models';

export const interceptors = (): WorkflowInterceptors => ({
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
    },
  ],
});
