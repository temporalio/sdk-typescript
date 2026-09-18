import * as nexus from 'nexus-rpc';
import * as workflow from '@temporalio/workflow';

export const temporalOpService = nexus.service('temporalOperationService', {
  asyncOp: nexus.operation<string, string>(),
  syncOp: nexus.operation<string, string>(),
  doubleStartOp: nexus.operation<string, void>(),
  retryAfterFailedStartOp: nexus.operation<string, string>(),
  echoActivity: nexus.operation<string, string>(),
  failingActivity: nexus.operation<string, void>(),
  blockingActivity: nexus.operation<string, void>(),
});
export const temporalCancelOpService = nexus.service('temporalCancelOperationService', {
  blockingOp: nexus.operation<string, void>(),
});
export async function temporalAsyncOpCaller(endpoint: string): Promise<string> {
  return await workflow
    .createNexusServiceClient({ endpoint, service: temporalOpService })
    .executeOperation('asyncOp', 'hello');
}
export async function temporalAsyncOpInputCaller(endpoint: string, input: string): Promise<string> {
  return await workflow
    .createNexusServiceClient({ endpoint, service: temporalOpService })
    .executeOperation('asyncOp', input, { scheduleToCloseTimeout: '10s' });
}
export async function temporalSyncOpCaller(endpoint: string): Promise<string> {
  return await workflow
    .createNexusServiceClient({ endpoint, service: temporalOpService })
    .executeOperation('syncOp', 'hello');
}
export async function temporalDoubleStartOpCaller(endpoint: string): Promise<void> {
  return await workflow
    .createNexusServiceClient({ endpoint, service: temporalOpService })
    .executeOperation('doubleStartOp', 'hello');
}
export async function temporalRetryAfterFailedStartOpCaller(endpoint: string, workflowId: string): Promise<string> {
  return await workflow
    .createNexusServiceClient({ endpoint, service: temporalOpService })
    .executeOperation('retryAfterFailedStartOp', workflowId);
}
export async function temporalActivityOpCaller(endpoint: string, activityId: string): Promise<string> {
  return await workflow
    .createNexusServiceClient({ endpoint, service: temporalOpService })
    .executeOperation('echoActivity', activityId);
}
export async function temporalBlockingActivityOpCaller(endpoint: string, activityId: string): Promise<void> {
  await workflow
    .createNexusServiceClient({ endpoint, service: temporalOpService })
    .executeOperation('blockingActivity', activityId, { scheduleToCloseTimeout: '10s' });
}
export async function temporalDefaultCancelWorkflowCaller(endpoint: string, targetWorkflowId: string): Promise<void> {
  await workflow
    .createNexusServiceClient({ endpoint, service: temporalCancelOpService })
    .executeOperation('blockingOp', targetWorkflowId, { cancellationType: 'WAIT_CANCELLATION_COMPLETED' });
}
export async function echoWorkflow(input: string): Promise<string> {
  return input;
}
export async function blockingTargetWorkflow(): Promise<void> {
  await workflow.condition(() => false);
}
