import { setWorkflowOptions } from '@temporalio/workflow';

setWorkflowOptions({ versioningBehavior: 'PINNED' }, continueAsNewWithVersionUpgrade);
// oxlint-disable-next-line typescript/no-unused-vars
export async function continueAsNewWithVersionUpgrade(attempt: number): Promise<string> {
  return 'v2.0';
}

setWorkflowOptions({ versioningBehavior: 'PINNED' }, continueAsNewWithRampingVersion);
// oxlint-disable-next-line typescript/no-unused-vars
export async function continueAsNewWithRampingVersion(attempt: number): Promise<string> {
  return 'v2.0';
}
