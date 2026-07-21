import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';

const { produceLargePayload } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

/**
 * Calls an activity that returns a payload of the given size, then returns only the
 * payload's length. Returning the length (rather than the buffer) keeps the Workflow
 * result small so it stays inline; the correct length also proves the offloaded
 * activity result was retrieved and reassembled correctly.
 */
export async function externalStorageOffload(sizeBytes: number): Promise<number> {
  const payload = await produceLargePayload(sizeBytes);
  return payload.length;
}
