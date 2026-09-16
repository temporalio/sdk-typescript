/**
 * Visits payloads for External Storage and applies payload transformations via
 * {@link ExternalStorageRunner}.
 *
 * @module
 */
import type { ConcurrencyLimit } from '../concurrency/limit';
import type { ExternalStorage, StorageDriverTargetInfo } from '../converter/extstore';
import { ExternalStorageNotConfiguredError } from '../errors';
import type { Payload } from '../interfaces';
import type { ExternalStorageMetricsAccumulator } from './external-storage-metrics';
import { ExternalStorageRunner } from './external-storage-runner';
import { isReferencePayload } from './extstore-helpers';
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
  /** Collects metrics of the store operations performed during the walk. */
  metrics?: ExternalStorageMetricsAccumulator;
}

/**
 * @internal
 * @experimental
 */
export function extstoreStoreOptions(
  externalStorage: ExternalStorage,
  { initialTarget, deriveContext, limit, abortSignal, metrics }: ExternalStorageStoreOptions = {}
): VisitOptions<StoreTarget> {
  const runner = new ExternalStorageRunner(externalStorage, metrics);
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

function extstoreRetrieveOptions(
  externalStorage: ExternalStorage,
  {
    limit,
    abortSignal,
    metrics,
  }: { limit?: ConcurrencyLimit; abortSignal?: AbortSignal; metrics?: ExternalStorageMetricsAccumulator } = {}
): VisitOptions<void> {
  const runner = new ExternalStorageRunner(externalStorage, metrics);
  return {
    transformPayloads: (payloads, _context, signal) => runner.retrieve(payloads, { abortSignal: signal }),
    transformPayload: (payload, _context, signal) =>
      runner.retrieve([payload], { abortSignal: signal }).then((retrieved) => retrieved[0]!),
    skipSearchAttributes: true,
    limit,
    abortSignal,
  };
}

/**
 * Detection-only inbound walk used when no {@link ExternalStorage} is configured: leaves every
 * payload untouched but throws {@link ExternalStorageNotConfiguredError} on the first reference
 * payload.
 */
function extstoreDetectReferencesOptions(): VisitOptions<void> {
  const assertNoReference = (payloads: Payload[]): Payload[] => {
    if (payloads.some(isReferencePayload)) {
      throw new ExternalStorageNotConfiguredError();
    }
    return payloads;
  };
  return {
    transformPayloads: (payloads) => Promise.resolve(assertNoReference(payloads)),
    transformPayload: (payload) => Promise.resolve(assertNoReference([payload])[0]!),
    skipSearchAttributes: true,
  };
}

/**
 * The inbound External Storage pass for a worker/client boundary: resolve reference payloads when
 * {@link ExternalStorage} is configured, otherwise fail loudly (via {@link extstoreDetectReferencesOptions})
 * because nothing can resolve them.
 *
 * @internal
 * @experimental
 */
export function extstoreInboundOptions(
  externalStorage: ExternalStorage | undefined,
  { metrics }: { metrics?: ExternalStorageMetricsAccumulator } = {}
): VisitOptions<void> {
  return externalStorage ? extstoreRetrieveOptions(externalStorage, { metrics }) : extstoreDetectReferencesOptions();
}
