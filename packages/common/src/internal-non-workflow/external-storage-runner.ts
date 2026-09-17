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
import { ValueError } from '../errors';
import type { Logger } from '../logger';
import type { Payload } from '../interfaces';
import type { ExternalStorageMetricsAccumulator } from './external-storage-metrics';
import { decodeReferencePayload, encodeReferencePayload, isReferencePayload } from './extstore-helpers';

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
export interface ExternalStoreOptions {
  /** Identity of the workflow or activity that produced the payloads. */
  target?: StorageDriverTargetInfo;
  /** Aborts the in-flight store operation. */
  abortSignal?: AbortSignal;
}

/** @internal @experimental */
export interface ExternalRetrieveOptions {
  /** Aborts the in-flight retrieve operation. */
  abortSignal?: AbortSignal;
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

  constructor(
    private readonly externalStorage: ExternalStorage,
    private readonly metrics?: ExternalStorageMetricsAccumulator,
    private readonly logger?: Logger
  ) {
    this.messageLimit = limit(externalStorage.concurrency.maxOperationsPerMessage);
    this.driverOperationLimit = driverOperationLimitFor(externalStorage);
  }

  /**
   * Builds the limiter handed to drivers which is used to cooperatively limit the total number
   * of concurrent extstore operations.
   */
  private makeLimiter(abortSignal: AbortSignal): { limiter: StorageDriverLimiter; used: () => boolean } {
    const { messageLimit, driverOperationLimit } = this;
    let used = false;
    const limiter: StorageDriverLimiter = {
      permit<T>(operation: () => Promise<T>): Promise<T> {
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

  /**
   * Replace each payload above the configured size threshold with a reference payload.
   * Payloads below the threshold (or that the selector keeps inline) pass through
   * unchanged. Order is preserved.
   */
  async store(payloads: Payload[], options: ExternalStoreOptions = {}): Promise<Payload[]> {
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
        throw new ValueError(
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
    const { metrics } = this;
    await runWithAbortOnFirstError(batchController, [...driverGroups.values()], async (group) => {
      const startMs = metrics ? performance.now() : 0;
      const { limiter, used } = this.makeLimiter(batchSignal);
      const storeCtx: StorageDriverStoreContext = { abortSignal: batchSignal, target: options.target, limiter };
      const claims = await group.driver.store(
        storeCtx,
        group.items.map((it) => it.payload)
      );
      this.warnIfLimiterUnused(group.driver.name, used(), 'store');
      if (claims.length !== group.items.length) {
        throw new ValueError(
          `Driver '${group.driver.name}' returned ${claims.length} claims for ${group.items.length} payloads`
        );
      }
      for (const [j, claim] of claims.entries()) {
        const item = group.items[j]!;
        result[item.index] = encodeReferencePayload({
          driverName: group.driver.name,
          claim,
          sizeBytes: item.size,
        });
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
  async retrieve(payloads: Payload[], options: ExternalRetrieveOptions = {}): Promise<Payload[]> {
    if (payloads.length === 0) return payloads;

    const { batchSignal, batchController } = makeBatchSignal(options.abortSignal);

    interface RetrieveItem {
      index: number;
      claim: StorageDriverClaim;
      size: number;
    }
    const driverGroups = new Map<string, { driver: StorageDriver; items: RetrieveItem[] }>();

    for (const [i, payload] of payloads.entries()) {
      if (!isReferencePayload(payload)) continue;
      const decoded = decodeReferencePayload(payload);
      const driver = this.externalStorage.getDriver(decoded.driverName);
      if (driver === null) {
        throw new ValueError(`No driver registered with name '${decoded.driverName}'`);
      }
      let group = driverGroups.get(decoded.driverName);
      if (group === undefined) {
        group = { driver, items: [] };
        driverGroups.set(decoded.driverName, group);
      }
      group.items.push({ index: i, claim: new StorageDriverClaim(decoded.claimData), size: decoded.sizeBytes });
    }

    if (driverGroups.size === 0) return payloads;

    const result = payloads.slice();
    const { metrics } = this;
    await runWithAbortOnFirstError(batchController, [...driverGroups.values()], async (group) => {
      const startMs = metrics ? performance.now() : 0;
      const { limiter, used } = this.makeLimiter(batchSignal);
      const retrieveCtx: StorageDriverRetrieveContext = { abortSignal: batchSignal, limiter };
      const retrieved = await group.driver.retrieve(
        retrieveCtx,
        group.items.map((it) => it.claim)
      );
      this.warnIfLimiterUnused(group.driver.name, used(), 'retrieve');
      if (retrieved.length !== group.items.length) {
        throw new ValueError(
          `Driver '${group.driver.name}' returned ${retrieved.length} payloads for ${group.items.length} claims`
        );
      }
      for (const [j, retrievedPayload] of retrieved.entries()) {
        const item = group.items[j]!;
        result[item.index] = retrievedPayload;
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
