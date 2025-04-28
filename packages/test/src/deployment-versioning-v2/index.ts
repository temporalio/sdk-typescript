import { setHandler, condition, setWorkflowOptions } from '@temporalio/workflow';
import { unblockSignal, versionQuery } from '../workflows';

setWorkflowOptions({ versioningBehavior: 'PINNED' }, deploymentVersioning);
export async function deploymentVersioning(): Promise<string> {
  let doFinish = false;
  setHandler(unblockSignal, () => void (doFinish = true));
  setHandler(versionQuery, () => 'v2');
  await condition(() => doFinish);
  return 'version-v2';
}
