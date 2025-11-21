import { setHandler, condition } from '@temporalio/workflow';
import { unblockSignal, versionQuery } from '../workflows';

export async function deploymentVersioning(): Promise<string> {
  let doFinish = false;
  setHandler(unblockSignal, () => void (doFinish = true));
  setHandler(versionQuery, () => 'v1');
  await condition(() => doFinish);
  return 'version-v1';
}

export default async function (): Promise<string> {
  return 'dynamic';
}
