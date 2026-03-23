import { setWorkflowOptions } from '@temporalio/workflow';

setWorkflowOptions({ versioningBehavior: 'PINNED' }, continueAsNewWithVersionUpgrade);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function continueAsNewWithVersionUpgrade(attempt: number): Promise<string> {
  return 'v2.0';
}
