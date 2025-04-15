import { CancelledFailure, setHandler, condition, defineWorkflowWithOptions } from '@temporalio/workflow';
import { unblockSignal, versionQuery } from '../workflows';

defineWorkflowWithOptions({ versioningBehavior: 'auto-upgrade' }, deploymentVersioning);
export async function deploymentVersioning(): Promise<string> {
  let doFinish = false;
  setHandler(unblockSignal, () => void (doFinish = true));
  setHandler(versionQuery, () => 'v1');
  await condition(() => doFinish);
  return 'version-v1';
}

// Dynamic/default workflow handler
export default defineWorkflowWithOptions({ versioningBehavior: 'pinned' }, _default);
async function _default(): Promise<string> {
  return 'dynamic';
}
