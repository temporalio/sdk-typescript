import * as workflow from '@temporalio/workflow';
import type * as activities from '../activities';

const { throwMaybeBenign } = workflow.proxyActivities<typeof activities>({
  startToCloseTimeout: '5s',
  retry: { maximumAttempts: 3, backoffCoefficient: 1, initialInterval: 500 },
});

export async function throwMaybeBenignErr(): Promise<void> {
  await throwMaybeBenign();
}
