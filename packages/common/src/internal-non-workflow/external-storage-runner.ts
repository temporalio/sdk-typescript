/**
 * Engine that drives External Storage `store` and `retrieve` operations.
 *
 * @module
 */
import { performance } from 'node:perf_hooks';

import { temporal } from '@temporalio/proto';

import { limit, type ConcurrencyLimit } from '../concurrency/limit';
import { StorageDriverClaim } from '../converter/extstore';
import type {
  ExternalStorage,
  StorageDriver,
  StorageDriverLimiter,
  StorageDriverRetrieveContext,
  StorageDriverSelectContext,
  StorageDriverStoreContext,
  StorageDriverTargetInfo,
} from '../converter/extstore';
import {
  ExternalStorageDriverError,
  ExternalStorageReferenceError,
  ExternalStorageUnregisteredDriverError,
} from '../errors';
import type { Logger } from '../logger';
import type { Payload } from '../interfaces';
import type { PayloadCache } from '../payload-cache';
import type { ExternalStorageMetricsAccumulator } from './external-storage-metrics';
import {
  decodeReferencePayload,
  encodeReferencePayload,
  externalStorageClaimCacheKey,
  isReferencePayload,
} from './extstore-helpers';

const PayloadProto = temporal.api.common.v1.Payload;

/**
 * The map that holds extstore operation limits for each {@link ExternalStorage} instance.
 * Each time an {@link ExternalStorageRunner} is created, it retrieves the limit from this
 * based on the `ExternalStorage` config it's passed.
 */
const driverOperationLimits = new WeakMap<ExternalStorage, ConcurrencyLimit>();

function driverOperationLimitFor(externalStorage: ExternalStorage): ConcurrencyLimit {
  let operationLimit = driverOperationLimits.get(externalStorage);
  if (operationLimit === undefined) {
    operationLimit = limit(externalStorage.concurrency.maxDriverOperations);
    driverOperationLimits.set(externalStorage, operationLimit);
  }
  return operationLimit;
}

/** @internal @experimental */
export interface ExternalStorageStoreOptions {
  /** Identity of the workflow or activity that produced the payloads. */
  target?: StorageDriverTargetInfo;
  /** Aborts the in-flight store operation. */
  abortSignal?: AbortSignal;
  /** Collects metrics for this store operation. */
  metrics?: ExternalStorageMetricsAccumulator;
}

/** @internal @experimental */
export interface ExternalStorageRetrieveOptions {
  /** Aborts the in-flight retrieve operation. */
  abortSignal?: AbortSignal;
  /** Collects metrics for this retrieve operation. */
  metrics?: ExternalStorageMetricsAccumulator;
}

interface RetrieveItem {
  index: number;
  driver: StorageDriver;
  claim: StorageDriverClaim;
  cacheKey: string;
  size: number;
}

interface CachedRetrieveItem {
  item: RetrieveItem;
  payload: Payload;
}

export interface ExternalStorageRunnerOptions {
  payloadCache?: PayloadCache;
  logger?: Logger;
}

/**
 * Drives External Storage operations against a configured {@link ExternalStorage}.
 *
 * @internal
 * @experimental
 */
export class ExternalStorageRunner {
  private readonly messageLimit: ConcurrencyLimit;
  private readonly driverOperationLimit: ConcurrencyLimit;
  private readonly payloadCache?: PayloadCache;
  private readonly logger?: Logger;

  constructor(
    private readonly externalStorage: ExternalStorage,
    { payloadCache, logger }: ExternalStorageRunnerOptions = {}
  ) {
    this.messageLimit = limit(externalStorage.concurrency.maxOperationsPerMessage);
    this.driverOperationLimit = driverOperationLimitFor(externalStorage);
    this.payloadCache = payloadCache;
    this.logger = logger;
  }

  /**
   * Builds the limiter handed to drivers which is used to cooperatively limit the total number
   * of concurrent extstore operations.
   */
  private makeLimiter<Item>(abortSignal: AbortSignal): { limiter: StorageDriverLimiter<Item>; used: () => boolean } {
    const { messageLimit, driverOperationLimit } = this;
    let used = false;
    const limiter: StorageDriverLimiter<Item> = {
      permit<T>(_item: Item, operation: () => Promise<T>): Promise<T> {
        used = true;
        return messageLimit(() =>
          driverOperationLimit(async () => {
            abortSignal.throwIfAborted();
            return await operation();
          })
        );
      },
    };
    return { limiter, used: () => used };
  }

  /**
   * Warn a message if a driver completes an operation without taking a permit.
   */
  private warnIfLimiterUnused(driverName: string, used: boolean, operation: 'store' | 'retrieve'): void {
    if (used) return;
    this.logger?.warn(
      `Storage driver '${driverName}' completed a ${operation} without taking a permit from ` +
        `context.limiter. Its requests are not counted against ` +
        `ExternalStorage.concurrency.maxDriverOperations, so their number is unbounded.`,
      { driverName }
    );
  }

  private async cacheGet(key: string): Promise<Payload | undefined> {
    if (this.payloadCache === undefined) return undefined;
    try {
      return await this.payloadCache.get(key);
    } catch {
      return undefined;
    }
  }

  private cacheSet(key: string, payload: Payload): void {
    if (this.payloadCache === undefined) return;
    try {
      void this.payloadCache.set(key, payload).catch(() => {});
    } catch {
      // cache is best effort and shouldn't throw
    }
  }

  private async retrieveFromCache(
    items: RetrieveItem[]
  ): Promise<{ retrieved: CachedRetrieveItem[]; missing: RetrieveItem[] }> {
    const cachedPayloads = await Promise.all(items.map((item) => this.cacheGet(item.cacheKey)));
    const retrieved: CachedRetrieveItem[] = [];
    const missing: RetrieveItem[] = [];

    for (const [index, item] of items.entries()) {
      const cachedPayload = cachedPayloads[index];
      if (cachedPayload === undefined) {
        missing.push(item);
      } else {
        retrieved.push({ item, payload: cachedPayload });
      }
    }

    return { retrieved, missing };
  }

  /**
   * Replace each payload above the configured size threshold with a reference payload.
   * Payloads below the threshold (or that the selector keeps inline) pass through
   * unchanged. Order is preserved.
   */
  async store(payloads: Payload[], options: ExternalStorageStoreOptions = {}): Promise<Payload[]> {
    if (payloads.length === 0) return payloads;

    const { driverSelector, payloadSizeThreshold } = this.externalStorage;
    const { batchSignal, batchController } = makeBatchSignal(options.abortSignal);
    const selectCtx: StorageDriverSelectContext = { abortSignal: batchSignal, target: options.target };

    interface StoreItem {
      index: number;
      payload: Payload;
      size: number;
    }
    const driverGroups = new Map<string, { driver: StorageDriver; items: StoreItem[] }>();

    for (const [i, payload] of payloads.entries()) {
      const size = payloadProtoSize(payload);
      if (size < payloadSizeThreshold) continue;

      const selected = driverSelector(selectCtx, payload);
      if (selected === null) continue;
      if (this.externalStorage.getDriver(selected.name) !== selected) {
        throw new ExternalStorageUnregisteredDriverError(
          `Driver '${selected.name}' returned by driverSelector is not registered in ExternalStorage.drivers`
        );
      }

      let group = driverGroups.get(selected.name);
      if (group === undefined) {
        group = { driver: selected, items: [] };
        driverGroups.set(selected.name, group);
      }
      group.items.push({ index: i, payload, size });
    }

    if (driverGroups.size === 0) return payloads;

    const result = payloads.slice();
    const { metrics } = options;
    await runWithAbortOnFirstError(batchController, [...driverGroups.values()], async (group) => {
      const startMs = metrics ? performance.now() : 0;
      const { limiter, used } = this.makeLimiter<Payload>(batchSignal);
      const storeCtx: StorageDriverStoreContext = { abortSignal: batchSignal, target: options.target, limiter };
      let claims: StorageDriverClaim[];
      try {
        claims = await group.driver.store(
          storeCtx,
          group.items.map((it) => it.payload)
        );
      } catch (cause) {
        throw new ExternalStorageDriverError(`Storage driver '${group.driver.name}' failed to store payloads`, {
          cause,
        });
      }
      this.warnIfLimiterUnused(group.driver.name, used(), 'store');
      if (claims.length !== group.items.length) {
        throw new ExternalStorageReferenceError(
          `Driver '${group.driver.name}' returned ${claims.length} claims for ${group.items.length} payloads`
        );
      }
      for (const [j, claim] of claims.entries()) {
        const item = group.items[j]!;
        const referencePayload = encodeReferencePayload({
          driverName: group.driver.name,
          claim,
          sizeBytes: item.size,
        });
        result[item.index] = referencePayload;
        this.cacheSet(externalStorageClaimCacheKey(group.driver.name, claim.claimData), item.payload);
      }
      if (metrics) {
        const sizeBytes = group.items.reduce((sum, it) => sum + it.size, 0);
        metrics.record(group.driver.name, group.items.length, sizeBytes, startMs, performance.now());
      }
    });

    return result;
  }

  /**
   * Replace each reference payload in `payloads` with the payload bytes returned by the
   * named driver. Non-reference payloads are passed through unchanged. Order is preserved.
   */
  async retrieve(payloads: Payload[], options: ExternalStorageRetrieveOptions = {}): Promise<Payload[]> {
    if (payloads.length === 0) return payloads;

    const { batchSignal, batchController } = makeBatchSignal(options.abortSignal);

    const payloadsToRetrieve: RetrieveItem[] = [];
    for (const [i, payload] of payloads.entries()) {
      if (!isReferencePayload(payload)) continue;
      let decoded: ReturnType<typeof decodeReferencePayload>;
      try {
        decoded = decodeReferencePayload(payload);
      } catch (cause) {
        throw new ExternalStorageReferenceError('Failed to decode external storage reference', { cause });
      }
      const driver = this.externalStorage.getDriver(decoded.driverName);
      if (driver === null) {
        throw new ExternalStorageUnregisteredDriverError(`No driver registered with name '${decoded.driverName}'`);
      }
      payloadsToRetrieve.push({
        index: i,
        driver,
        claim: new StorageDriverClaim(decoded.claimData),
        cacheKey: externalStorageClaimCacheKey(decoded.driverName, decoded.claimData),
        size: decoded.sizeBytes,
      });
    }

    if (payloadsToRetrieve.length === 0) return payloads;

    const result = payloads.slice();
    const { retrieved, missing } = await this.retrieveFromCache(payloadsToRetrieve);
    for (const { item, payload } of retrieved) {
      result[item.index] = payload;
    }

    if (missing.length === 0) return result;

    // get remaining payloads from the storage drivers
    const driverGroups = new Map<string, { driver: StorageDriver; items: RetrieveItem[] }>();
    for (const item of missing) {
      let group = driverGroups.get(item.driver.name);
      if (group === undefined) {
        group = { driver: item.driver, items: [] };
        driverGroups.set(item.driver.name, group);
      }
      group.items.push(item);
    }

    const { metrics } = options;
    await runWithAbortOnFirstError(batchController, [...driverGroups.values()], async (group) => {
      const startMs = metrics ? performance.now() : 0;
      const { limiter, used } = this.makeLimiter<StorageDriverClaim>(batchSignal);
      const retrieveCtx: StorageDriverRetrieveContext = { abortSignal: batchSignal, limiter };
      let retrieved: Payload[];
      try {
        retrieved = await group.driver.retrieve(
          retrieveCtx,
          group.items.map((it) => it.claim)
        );
      } catch (cause) {
        throw new ExternalStorageDriverError(`Storage driver '${group.driver.name}' failed to retrieve payloads`, {
          cause,
        });
      }
      this.warnIfLimiterUnused(group.driver.name, used(), 'retrieve');
      if (retrieved.length !== group.items.length) {
        throw new ExternalStorageReferenceError(
          `Driver '${group.driver.name}' returned ${retrieved.length} payloads for ${group.items.length} claims`
        );
      }

      for (const [j, retrievedPayload] of retrieved.entries()) {
        const item = group.items[j]!;
        result[item.index] = retrievedPayload;
        this.cacheSet(item.cacheKey, retrievedPayload);
      }
      if (metrics) {
        const sizeBytes = group.items.reduce((sum, it) => sum + it.size, 0);
        metrics.record(group.driver.name, group.items.length, sizeBytes, startMs, performance.now());
      }
    });

    return result;
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

function payloadProtoSize(payload: Payload): number {
  return PayloadProto.encode(payload).pos;
}

/**
 * Builds an internal controller composed with the caller's signal, so a failing
 * driver call can abort its siblings.
 */
function makeBatchSignal(abortSignal?: AbortSignal): { batchSignal: AbortSignal; batchController: AbortController } {
  const batchController = new AbortController();
  const batchSignal = abortSignal ? AbortSignal.any([batchController.signal, abortSignal]) : batchController.signal;
  return { batchSignal, batchController };
}

/**
 * Run `task(item)` for each item in parallel. As soon as any task rejects,
 * signal `controller.abort(reason)` so siblings can cancel mid-flight. Awaits
 * all tasks regardless of outcome and re-throws the first rejection.
 */
async function runWithAbortOnFirstError<T>(
  controller: AbortController,
  items: T[],
  task: (item: T) => Promise<void>
): Promise<void> {
  const promises = items.map(task);
  for (const p of promises) {
    p.catch((reason: unknown) => {
      if (!controller.signal.aborted) controller.abort(reason);
    });
  }
  const settled = await Promise.allSettled(promises);
  for (const outcome of settled) {
    if (outcome.status === 'rejected') throw outcome.reason;
  }
}
