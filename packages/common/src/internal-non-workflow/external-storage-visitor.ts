/**
 * Visits payloads for External Storage and applies payload transformations via
 * {@link ExternalStorageRunner}.
 *
 * @module
 */
import type { coresdk } from '@temporalio/proto';

import type { ConcurrencyLimit } from '../concurrency/limit';
import type { ExternalStorage, StorageDriverTargetInfo } from '../converter/extstore';
import { ExternalStorageRunner } from './external-storage-runner';
import { visitWorkflowActivation, visitWorkflowActivationCompletion } from './payload-visitor';

/**
 * Offload every eligible payload in a `WorkflowActivationCompletion` to external storage,
 * replacing it in place with a reference payload.
 *
 * @internal
 * @experimental
 */
export function storeWorkflowActivationCompletion(
  externalStorage: ExternalStorage,
  completion: coresdk.workflow_completion.IWorkflowActivationCompletion,
  {
    target,
    limit,
    abortSignal,
  }: {
    /** Identity of the workflow / activity that produced the payloads, used for object naming. */
    target?: StorageDriverTargetInfo;
    /** Bounds concurrent transform calls across payload sites. Omit for sequential. */
    limit?: ConcurrencyLimit;
    /** Aborts the walk and every in-flight driver call. */
    abortSignal?: AbortSignal;
  } = {}
): Promise<void> {
  const runner = new ExternalStorageRunner(externalStorage);
  return visitWorkflowActivationCompletion(completion, {
    transformPayloads: (payloads, _context, signal) => runner.store(payloads, { target, abortSignal: signal }),
    transformPayload: (payload, _context, signal) =>
      runner.store([payload], { target, abortSignal: signal }).then((stored) => stored[0]!),
    limit,
    abortSignal,
  });
}

/**
 * Replace every reference payload in a `WorkflowActivation` with the payload bytes fetched
 * from external storage, in place.
 *
 * @internal
 * @experimental
 */
export function retrieveWorkflowActivation(
  externalStorage: ExternalStorage,
  activation: coresdk.workflow_activation.IWorkflowActivation,
  { limit, abortSignal }: { limit?: ConcurrencyLimit; abortSignal?: AbortSignal } = {}
): Promise<void> {
  const runner = new ExternalStorageRunner(externalStorage);
  return visitWorkflowActivation(activation, {
    transformPayloads: (payloads, _context, signal) => runner.retrieve(payloads, { abortSignal: signal }),
    transformPayload: (payload, _context, signal) =>
      runner.retrieve([payload], { abortSignal: signal }).then((retrieved) => retrieved[0]!),
    limit,
    abortSignal,
  });
}
