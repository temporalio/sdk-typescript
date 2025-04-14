import { CancelledFailure, defineQuery, setHandler, condition, defineWorkflowWithOptions } from '@temporalio/workflow';
import { unblockSignal } from './definitions';

export const versionQuery = defineQuery<string>('version');

export const deploymentVersioningV1AutoUpgrade = defineWorkflowWithOptions(
  { versioningBehavior: 'auto-upgrade' },
  _deploymentVersioningV1AutoUpgrade
);
async function _deploymentVersioningV1AutoUpgrade(): Promise<string> {
  let doFinish = false;
  setHandler(unblockSignal, () => void (doFinish = true));
  setHandler(versionQuery, () => 'v1');
  await condition(() => doFinish);
  return 'version-v1';
}
