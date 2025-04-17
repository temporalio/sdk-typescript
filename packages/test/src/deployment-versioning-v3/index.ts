import { setHandler, condition, defineWorkflowWithOptions } from '@temporalio/workflow';
import { unblockSignal, versionQuery } from '../workflows';

defineWorkflowWithOptions({ versioningBehavior: 'auto-upgrade' }, deploymentVersioning);
export async function deploymentVersioning(): Promise<string> {
  let doFinish = false;
  setHandler(unblockSignal, () => void (doFinish = true));
  setHandler(versionQuery, () => 'v3');
  await condition(() => doFinish);
  return 'version-v3';
}
