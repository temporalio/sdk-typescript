/**
 * "Before" version of a workflow used to reproduce an issue with SDK internal patch,
 * where the user modifies his code so that the SDK internal patch no longer gets generated.
 *
 * @module
 */
import { condition, sleep } from '@temporalio/workflow';

/**
 * Patches the workflow from ./patch-and-condition-pre-patch, adds a patched statement inside a condition.
 */
export async function sdkInternalPatch(): Promise<void> {
  await condition(() => false, 10);
  await sleep(10);
}
