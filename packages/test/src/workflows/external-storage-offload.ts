import {
  condition,
  defineQuery,
  defineSignal,
  executeChild,
  makeContinueAsNewFunc,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
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
 * Parent workflow that starts a child with a large argument and reads back the child's large
 * result, exercising offload/retrieval in both directions between two Workflows on the same
 * Worker. Returns the length of the payload round-tripped through the child.
 */
export async function externalStorageParentChildOffload(sizeBytes: number): Promise<number> {
  const result = await executeChild(externalStorageEcho, { args: [new Uint8Array(sizeBytes)] });
  return result.length;
}

/**
 * Returns its argument unchanged. Used directly (a large arg/result round-trips through the client
 * boundary) and as the child in {@link externalStorageParentChildOffload}.
 */
export async function externalStorageEcho(data: Uint8Array): Promise<Uint8Array> {
  return data;
}

/**
 * Continues-as-new into a *different* workflow type ({@link externalStorageContinueAsNewTarget}),
 * passing a large argument. Exercises offload of the ContinueAsNew arguments on the source
 * workflow's completion. Those arguments belong to the new run, so they must be keyed under the
 * new workflow type (the command's `workflowType`), not the source's.
 */
export async function externalStorageContinueAsNewSource(sizeBytes: number): Promise<number> {
  const continueAsTarget = makeContinueAsNewFunc<typeof externalStorageContinueAsNewTarget>({
    workflowType: 'externalStorageContinueAsNewTarget',
  });
  return await continueAsTarget(new Uint8Array(sizeBytes).fill(4));
}

/** Target of {@link externalStorageContinueAsNewSource}'s continue-as-new; returns its argument's length. */
export async function externalStorageContinueAsNewTarget(data: Uint8Array): Promise<number> {
  return data.length;
}

export const getBlobQuery = defineQuery<Uint8Array>('getBlob');
export const finishSignal = defineSignal('finish');

/**
 * Serves a large blob (built from the given size) via a query, and stays open until signalled.
 * Lets a client exercise the query retrieve path against an offloaded query result.
 */
export async function externalStorageQueryable(sizeBytes: number): Promise<void> {
  const blob = new Uint8Array(sizeBytes).fill(7);
  setHandler(getBlobQuery, () => blob);
  let finished = false;
  setHandler(finishSignal, () => {
    finished = true;
  });
  await condition(() => finished);
}
