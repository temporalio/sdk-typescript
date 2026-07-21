import { IllegalStateError, TypedSearchAttributes, type SearchAttributePair } from '@temporalio/common';
import type { WorkflowInfo } from '@temporalio/workflow';
import { createUnsafeRandomSource } from '@temporalio/workflow/lib/random-helpers';
import type { PatchActivationCallback, PatchActivationInput } from '../worker-options';

// ts-prune-ignore-next (used by the workflow Worker thread entry point)
export const PATCH_ACTIVATION_CALLBACK_BUFFER_SIZE = 64 * 1024;
export const PATCH_ACTIVATION_CALLBACK_HEADER_SIZE = 3 * Int32Array.BYTES_PER_ELEMENT;

export const enum PatchActivationCallbackStatus {
  Pending = 0,
  True = 1,
  False = 2,
  Error = 3,
}

export type WorkflowPatchActivationCallback = (workflowInfo: WorkflowInfo, patchId: string) => boolean;

export type PatchActivationWorkflowInfoSnapshot = Omit<WorkflowInfo, 'typedSearchAttributes' | 'unsafe'> & {
  typedSearchAttributes: SearchAttributePair[];
  unsafe: Pick<WorkflowInfo['unsafe'], 'isReplaying' | 'isReplayingHistoryEvents'>;
};

export function makePatchActivationWorkflowInfoSnapshot(
  workflowInfo: WorkflowInfo
): PatchActivationWorkflowInfoSnapshot {
  const snapshot: PatchActivationWorkflowInfoSnapshot = {
    ...workflowInfo,
    unsafe: {
      isReplaying: workflowInfo.unsafe.isReplaying,
      isReplayingHistoryEvents: workflowInfo.unsafe.isReplayingHistoryEvents,
    },
    // Structured cloning strips class prototypes, so preserve the public representation and
    // reconstruct TypedSearchAttributes when the Worker-side callback input is created.
    typedSearchAttributes: workflowInfo.typedSearchAttributes.toJSON(),
  };
  return structuredClone(snapshot);
}

function makePatchActivationInput(
  workflowInfo: PatchActivationWorkflowInfoSnapshot,
  patchId: string
): PatchActivationInput {
  const info = Object.freeze({
    ...workflowInfo,
    typedSearchAttributes: new TypedSearchAttributes(workflowInfo.typedSearchAttributes),
    unsafe: Object.freeze({
      ...workflowInfo.unsafe,
      now: Date.now,
      random: Object.freeze(createUnsafeRandomSource(Math.random)),
    }),
  }) as WorkflowInfo;
  return Object.freeze({ workflowInfo: info, patchId });
}

export function invokePatchActivationCallbackWithSnapshot(
  callback: PatchActivationCallback,
  workflowInfo: PatchActivationWorkflowInfoSnapshot,
  patchId: string
): boolean {
  const result = callback(makePatchActivationInput(workflowInfo, patchId));
  if (typeof result !== 'boolean') {
    throw new TypeError(`patchActivationCallback must return a boolean, got ${typeof result}`);
  }
  return result;
}

export function invokePatchActivationCallback(
  callback: PatchActivationCallback,
  workflowInfo: WorkflowInfo,
  patchId: string
): boolean {
  return invokePatchActivationCallbackWithSnapshot(
    callback,
    makePatchActivationWorkflowInfoSnapshot(workflowInfo),
    patchId
  );
}

function getHeader(resultBuffer: SharedArrayBuffer): Int32Array {
  return new Int32Array(resultBuffer, 0, 3);
}

export function writePatchActivationCallbackResult(resultBuffer: SharedArrayBuffer, result: boolean): void {
  Atomics.store(
    getHeader(resultBuffer),
    1,
    result ? PatchActivationCallbackStatus.True : PatchActivationCallbackStatus.False
  );
}

export function writePatchActivationCallbackError(resultBuffer: SharedArrayBuffer, error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const encoded = new TextEncoder().encode(message);
  const output = new Uint8Array(resultBuffer, PATCH_ACTIVATION_CALLBACK_HEADER_SIZE);
  const length = Math.min(encoded.length, output.length);
  output.set(encoded.subarray(0, length));
  const header = getHeader(resultBuffer);
  Atomics.store(header, 2, length);
  Atomics.store(header, 1, PatchActivationCallbackStatus.Error);
}

export function completePatchActivationCallback(resultBuffer: SharedArrayBuffer): void {
  const header = getHeader(resultBuffer);
  Atomics.store(header, 0, 1);
  Atomics.notify(header, 0);
}

// ts-prune-ignore-next (used by the workflow Worker thread entry point)
export function waitForPatchActivationCallbackResult(resultBuffer: SharedArrayBuffer): boolean {
  const header = getHeader(resultBuffer);
  Atomics.wait(header, 0, PatchActivationCallbackStatus.Pending);
  const status = Atomics.load(header, 1);
  if (status === PatchActivationCallbackStatus.True) return true;
  if (status === PatchActivationCallbackStatus.False) return false;
  if (status === PatchActivationCallbackStatus.Error) {
    const length = Atomics.load(header, 2);
    const bytes = new Uint8Array(resultBuffer, PATCH_ACTIVATION_CALLBACK_HEADER_SIZE, length);
    throw new Error(new TextDecoder().decode(bytes));
  }
  throw new IllegalStateError(`Invalid patch activation callback response status: ${status}`);
}
