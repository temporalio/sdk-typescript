/**
 * Visits payloads for External Storage and applies payload transformations via
 * {@link ExternalStorageRunner}.
 *
 * @module
 */
import type { ConcurrencyLimit } from '../concurrency/limit';
import type { ExternalStorage, StorageDriverTargetInfo } from '../converter/extstore';
import { ExternalStorageRunner } from './external-storage-runner';
import type { ContextDeriver, VisitOptions } from './payload-visitor';

/**
 * The storage target in scope at a given payload site during a store walk. It starts at
 * {@link ExternalStorageStoreOptions.initialTarget} and {@link ExternalStorageStoreOptions.deriveContext}
 * may retarget it per message (e.g. a child-workflow command retargets its payloads at the child).
 */
type StoreTarget = StorageDriverTargetInfo | undefined;

/** @internal @experimental */
export interface ExternalStorageStoreOptions {
  /** Storage target before any message is entered (the initial enclosing workflow / activity). */
  initialTarget?: StorageDriverTargetInfo;
  /** Derives new storage target from the current message. */
  deriveContext?: ContextDeriver<StoreTarget>;
  /** Bounds concurrent transform calls across payload sites. Omit for sequential. */
  limit?: ConcurrencyLimit;
  /** Aborts the walk and every in-flight driver call. */
  abortSignal?: AbortSignal;
}

/**
 * @internal
 * @experimental
 */
export function extstoreStoreOptions(
  externalStorage: ExternalStorage,
  { initialTarget, deriveContext, limit, abortSignal }: ExternalStorageStoreOptions = {}
): VisitOptions<StoreTarget> {
  const runner = new ExternalStorageRunner(externalStorage);
  return {
    transformPayloads: (payloads, target, signal) => runner.store(payloads, { target, abortSignal: signal }),
    transformPayload: (payload, target, signal) =>
      runner.store([payload], { target, abortSignal: signal }).then((stored) => stored[0]!),
    deriveContext,
    initialContext: initialTarget,
    // Search attributes must keep their literal values so the server can index/search on them.
    skipSearchAttributes: true,
    limit,
    abortSignal,
  };
}

/**
 * @internal
 * @experimental
 */
export function extstoreRetrieveOptions(
  externalStorage: ExternalStorage,
  { limit, abortSignal }: { limit?: ConcurrencyLimit; abortSignal?: AbortSignal } = {}
): VisitOptions<void> {
  const runner = new ExternalStorageRunner(externalStorage);
  return {
    transformPayloads: (payloads, _context, signal) => runner.retrieve(payloads, { abortSignal: signal }),
    transformPayload: (payload, _context, signal) =>
      runner.retrieve([payload], { abortSignal: signal }).then((retrieved) => retrieved[0]!),
    skipSearchAttributes: true,
    limit,
    abortSignal,
  };
}
