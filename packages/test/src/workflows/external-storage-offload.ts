import { executeChild, proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';

// Allow a few attempts so the driver-failure tests can assert that a driver failure is
// retried rather than being fatal; success-path tests all pass on the first attempt anyway.
const { produceLargePayload, producePatternedPayload, consumeLargePayload } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10s',
  scheduleToCloseTimeout: '30s',
  retry: { maximumAttempts: 3, initialInterval: '100ms' },
});

// Heartbeat-details recovery requires a retry; allow a little headroom in case the first attempt's
// heartbeat isn't flushed before it fails.
const { heartbeatThenReturnDetailsLength } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10s',
  retry: { maximumAttempts: 5, initialInterval: '100ms' },
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

/**
 * Generates a large payload in Workflow code and passes it as an *argument* to an activity,
 * exercising offload of the activity input on the outbound command and retrieval on the
 * inbound activity task. Returns the length the activity observed.
 */
export async function externalStorageActivityInputOffload(sizeBytes: number): Promise<number> {
  return await consumeLargePayload(new Uint8Array(sizeBytes));
}

/**
 * Retrieves a patterned payload from an activity and verifies every byte survived the
 * store/retrieve round-trip intact. Returns `true` iff the bytes match `i % 256`.
 */
export async function externalStorageByteFidelity(sizeBytes: number): Promise<boolean> {
  const payload = await producePatternedPayload(sizeBytes);
  if (payload.length !== sizeBytes) return false;
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] !== i % 256) return false;
  }
  return true;
}

/**
 * Runs an activity that heartbeats a large details payload on its first attempt (offloaded),
 * fails, and on retry reads the recovered heartbeat details (retrieved). Returns the length
 * the retried attempt observed.
 */
export async function externalStorageHeartbeatDetailsOffload(sizeBytes: number): Promise<number> {
  return await heartbeatThenReturnDetailsLength(sizeBytes);
}

/**
 * Child workflow that echoes back the (large) payload it receives, so its input is offloaded on
 * the parent's outbound command and its result is offloaded on the child's completion.
 */
export async function externalStorageChildEcho(payload: Uint8Array): Promise<Uint8Array> {
  return payload;
}

/**
 * Parent workflow that starts a child with a large argument and reads back the child's large
 * result, exercising offload/retrieval in both directions between two Workflows on the same
 * Worker. Returns the length of the payload round-tripped through the child.
 */
export async function externalStorageParentChildOffload(sizeBytes: number): Promise<number> {
  const result = await executeChild(externalStorageChildEcho, { args: [new Uint8Array(sizeBytes)] });
  return result.length;
}
