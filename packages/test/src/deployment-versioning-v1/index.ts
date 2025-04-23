import { setHandler, condition, defineWorkflowWithOptions, workflowInfo } from '@temporalio/workflow';
import { unblockSignal, versionQuery } from '../workflows';

defineWorkflowWithOptions({ versioningBehavior: 'AUTO_UPGRADE' }, deploymentVersioning);
export async function deploymentVersioning(): Promise<string> {
  let doFinish = false;
  setHandler(unblockSignal, () => void (doFinish = true));
  setHandler(versionQuery, () => 'v1');
  await condition(() => doFinish);
  return 'version-v1';
}

// Dynamic/default workflow handler
export default defineWorkflowWithOptions({ versioningBehavior: 'PINNED' }, _default);
async function _default(): Promise<string> {
  return 'dynamic';
}

defineWorkflowWithOptions(() => {
  // Need to ensure accessing workflow context still works in here
  workflowInfo();
  return {
    versioningBehavior: 'PINNED',
  };
}, usesGetter);
export async function usesGetter(): Promise<string> {
  return 'usesGetter';
}
