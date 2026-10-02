/** Builds payload visitor options backed by one {@link ExternalStorageRunner} per visit. @module */
import { unbounded } from '../concurrency/limit';
import type { ExternalStorage, StorageDriverTargetInfo } from '../converter/extstore';
import { ExternalStorageNotConfiguredError } from '../errors';
import type { Payload } from '../interfaces';
import type { Logger } from '../logger';
import type { PayloadCache } from '../payload-cache';
import type { ExternalStorageMetricsAccumulator } from './external-storage-metrics';
import { ExternalStorageRunner } from './external-storage-runner';
import { isReferencePayload } from './extstore-helpers';
import type { ContextDeriver, VisitOptions } from './payload-visitor';

/**
 * The storage target in scope at a given payload site during a store walk. It starts at
 * {@link ExternalStorageStoreVisitOptions.initialTarget} and {@link ExternalStorageStoreVisitOptions.deriveContext}
 * may retarget it per message (e.g. a child-workflow command retargets its payloads at the child).
 */
type StoreTarget = StorageDriverTargetInfo | undefined;

/** @internal @experimental */
export interface ExternalStorageStoreVisitOptions {
  /** External Storage configuration used to create the runner for this visit. */
  externalStorage: ExternalStorage;
  /** Storage target before any message is entered (the initial enclosing workflow / activity). */
  initialTarget?: StorageDriverTargetInfo;
  /** Derives new storage target from the current message. */
  deriveContext?: ContextDeriver<StoreTarget>;
  /** Aborts the walk and every in-flight driver call. */
  abortSignal?: AbortSignal;
  /** Collects metrics for store operations performed during the walk. */
  metrics?: ExternalStorageMetricsAccumulator;
  /** Cache shared across visits. */
  payloadCache?: PayloadCache;
  logger?: Logger;
}

/**
 * Creates one runner for a store visit. Stable dependencies such as `payloadCache` may be shared across visits.
 *
 * @internal
 * @experimental
 */
export function externalStorageStoreVisitOptions({
  externalStorage,
  initialTarget,
  deriveContext,
  abortSignal,
  metrics,
  payloadCache,
  logger,
}: ExternalStorageStoreVisitOptions): VisitOptions<StoreTarget> {
  const runner = new ExternalStorageRunner(externalStorage, { payloadCache, logger });
  return {
    transformPayloads: (payloads, target, signal) => runner.store(payloads, { target, abortSignal: signal, metrics }),
    transformPayload: (payload, target, signal) =>
      runner.store([payload], { target, abortSignal: signal, metrics }).then((stored) => stored[0]!),
    deriveContext,
    initialContext: initialTarget,
    // Search attributes must keep their literal values so the server can index/search on them.
    skipSearchAttributes: true,
    limit: unbounded(),
    abortSignal,
  };
}

/** @internal @experimental */
export interface ExternalStorageRetrieveVisitOptions {
  /** External Storage configuration, or `undefined` to reject reference payloads. */
  externalStorage: ExternalStorage | undefined;
  /** Aborts the walk and every in-flight driver call. */
  abortSignal?: AbortSignal;
  /** Collects metrics for retrieve operations performed during the walk. */
  metrics?: ExternalStorageMetricsAccumulator;
  /** Cache shared across visits. */
  payloadCache?: PayloadCache;
  logger?: Logger;
}

/**
 * Detection-only visit used when no External Storage runner is available: leaves every payload
 * untouched but throws {@link ExternalStorageNotConfiguredError} on the first reference payload.
 */
function externalStorageReferenceDetectionVisitOptions(): VisitOptions<void> {
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
 * Creates one runner for a retrieve visit. Stable dependencies such as `payloadCache` may be shared across visits.
 * When External Storage is not configured, returns options that reject reference payloads.
 *
 * @internal
 * @experimental
 */
export function externalStorageRetrieveVisitOptions({
  externalStorage,
  abortSignal,
  metrics,
  payloadCache,
  logger,
}: ExternalStorageRetrieveVisitOptions): VisitOptions<void> {
  if (externalStorage === undefined) return externalStorageReferenceDetectionVisitOptions();
  const runner = new ExternalStorageRunner(externalStorage, { payloadCache, logger });
  return {
    transformPayloads: (payloads, _context, signal) => runner.retrieve(payloads, { abortSignal: signal, metrics }),
    transformPayload: (payload, _context, signal) =>
      runner.retrieve([payload], { abortSignal: signal, metrics }).then((retrieved) => retrieved[0]!),
    skipSearchAttributes: true,
    limit: unbounded(),
    abortSignal,
  };
}
