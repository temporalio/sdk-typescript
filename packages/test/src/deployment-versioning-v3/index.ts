import { setHandler, condition, setWorkflowOptions } from '@temporalio/workflow';
import { unblockSignal, versionQuery } from '../workflows';

setWorkflowOptions({ versioningBehavior: 'AUTO_UPGRADE' }, deploymentVersioning);
export async function deploymentVersioning(): Promise<string> {
  let doFinish = false;
  setHandler(unblockSignal, () => void (doFinish = true));
  setHandler(versionQuery, () => 'v3');
  await condition(() => doFinish);
  return 'version-v3';
}
