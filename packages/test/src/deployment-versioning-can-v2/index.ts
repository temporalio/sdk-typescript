import { setWorkflowOptions } from '@temporalio/workflow';

setWorkflowOptions({ versioningBehavior: 'PINNED' }, continueAsNewWithVersionUpgrade);
export async function continueAsNewWithVersionUpgrade(attempt: number): Promise<string> {
  console.log("WF2");
  return 'v2.0';
}
