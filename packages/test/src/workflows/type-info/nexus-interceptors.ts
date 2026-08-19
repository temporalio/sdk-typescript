import type { WorkflowInterceptors } from '@temporalio/workflow';
import { workflowInfo } from '@temporalio/workflow';
import { orderTypeInfo, receiptTypeInfo } from './models';

export const interceptors = (): WorkflowInterceptors => ({
  outbound: [
    {
      startNexusOperation(input, next) {
        if (workflowInfo().workflowType !== 'interceptorTypeInfoCaller') {
          return next(input);
        }
        return next({ ...input, inputType: orderTypeInfo, outputType: receiptTypeInfo });
      },
    },
  ],
});
