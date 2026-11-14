import { workflowInfo, type WorkflowInterceptorsFactory } from '@temporalio/workflow';

const importedRunId = workflowInfo().runId;
let factories = 0;

export const interceptors: WorkflowInterceptorsFactory = () => {
  const factory = ++factories;
  return {
    inbound: [
      {
        async execute(input, next) {
          return `${await next(input)}|${importedRunId}|${factory}`;
        },
      },
    ],
    internals: [
      {
        dispose() {
          throw new Error('deliberate disposal failure');
        },
      },
    ],
  };
};
