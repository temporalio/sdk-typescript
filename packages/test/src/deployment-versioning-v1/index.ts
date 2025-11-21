import { setHandler, condition, setWorkflowOptions, workflowInfo } from '@temporalio/workflow';
import { unblockSignal, versionQuery } from '../workflows';

setWorkflowOptions({ versioningBehavior: 'AUTO_UPGRADE' }, deploymentVersioning);
export async function deploymentVersioning(): Promise<string> {
  let doFinish = false;
  setHandler(unblockSignal, () => void (doFinish = true));
  setHandler(versionQuery, () => 'v1');
  await condition(() => doFinish);
  return 'version-v1';
}

// Dynamic/default workflow handler
setWorkflowOptions({ versioningBehavior: 'PINNED' }, module.exports.default);
export default async function (): Promise<string> {
  return 'dynamic';
}

setWorkflowOptions(() => {
  // Need to ensure accessing workflow context still works in here
  workflowInfo();
  return {
    versioningBehavior: 'PINNED',
  };
}, usesGetter);
export async function usesGetter(): Promise<string> {
  return 'usesGetter';
}
