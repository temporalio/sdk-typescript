import * as nexus from 'nexus-rpc';
import { ApplicationFailure } from '@temporalio/common';
import * as workflow from '@temporalio/workflow';

export type CancelTypeTestScenario = {
  operationName: 'startWorkflow' | 'startWorkflowFailCancel';
  cancellationType: workflow.NexusOperationCancellationType;
  targetCancellationBehavior: 'hang' | 'delay' | 'rethrow';
};
export const service = nexus.service('cancellation-test-service', {
  startWorkflow: nexus.operation<CancelTypeTestScenario, void>(),
  startWorkflowFailCancel: nexus.operation<CancelTypeTestScenario, void>(),
} as const);
export async function cancellationTestCallerWorkflow(
  endpoint: string,
  scenario: CancelTypeTestScenario
): Promise<void> {
  try {
    const client = workflow.createNexusServiceClient({ endpoint, service });
    await client.executeOperation(scenario.operationName, scenario, { cancellationType: scenario.cancellationType });
    throw ApplicationFailure.nonRetryable('Unexpected Success');
  } catch (err) {
    if (!workflow.isCancellation(err)) throw err;
  }
}
export async function cancellationTestTargetWorkflow(scenario: CancelTypeTestScenario): Promise<void> {
  try {
    await workflow.condition(() => false);
    throw workflow.ApplicationFailure.nonRetryable('Unreachable code');
  } catch (err) {
    if (scenario.targetCancellationBehavior === 'hang')
      await workflow.CancellationScope.nonCancellable(() => workflow.condition(() => false));
    else if (scenario.targetCancellationBehavior === 'delay') {
      await workflow.CancellationScope.nonCancellable(() => workflow.sleep(100));
      throw err;
    } else throw err;
  }
}
