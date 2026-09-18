import * as nexus from 'nexus-rpc';
import * as workflow from '@temporalio/workflow';

export const scheduleToStartService = nexus.service('nexus-schedule-to-start-timeout-test-service', {
  stallOp: nexus.operation<string, string>(),
});

export async function scheduleToStartTimeoutCallerWorkflow(endpoint: string): Promise<string> {
  const client = workflow.createNexusServiceClient({
    endpoint,
    service: scheduleToStartService,
  });
  return await client.executeOperation(scheduleToStartService.operations.stallOp, 'input', {
    scheduleToStartTimeout: '100ms',
  });
}

export const startToCloseService = nexus.service('nexus-start-to-close-timeout-test-service', {
  asyncOp: nexus.operation<string, string>(),
});

export async function startToCloseTimeoutCallerWorkflow(endpoint: string): Promise<string> {
  const client = workflow.createNexusServiceClient({
    endpoint,
    service: startToCloseService,
  });
  const handle = await client.startOperation(startToCloseService.operations.asyncOp, 'input', {
    startToCloseTimeout: '100ms',
  });
  return await handle.result();
}
