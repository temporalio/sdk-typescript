/**
 * Engine that drives External Storage `store` and `retrieve` operations.
 *
 * @module
 */
import { temporal } from '@temporalio/proto';

import { StorageDriverClaim } from '../converter/extstore';
import type {
  ExternalStorage,
  StorageDriver,
  StorageDriverRetrieveContext,
  StorageDriverStoreContext,
  StorageDriverTargetInfo,
} from '../converter/extstore';
import { ValueError } from '../errors';
import type { Payload } from '../interfaces';
import { decodeReferencePayload, encodeReferencePayload, isReferencePayload } from './extstore-helpers';

const PayloadProto = temporal.api.common.v1.Payload;

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
  constructor(private readonly externalStorage: ExternalStorage) {}

  /**
   * Replace each payload above the configured size threshold with a reference payload.
   * Payloads below the threshold (or that the selector keeps inline) pass through
   * unchanged. Order is preserved.
   */
  async store(payloads: Payload[], options: ExternalStoreOptions = {}): Promise<Payload[]> {
    if (payloads.length === 0) return payloads;

    const { driverSelector, payloadSizeThreshold } = this.externalStorage;
    const { batchSignal, batchController } = makeBatchSignal(options.abortSignal);
    const storeCtx: StorageDriverStoreContext = { abortSignal: batchSignal, target: options.target };

    interface StoreItem {
      index: number;
      payload: Payload;
      size: number;
    }
    const driverGroups = new Map<string, { driver: StorageDriver; items: StoreItem[] }>();

    for (const [i, payload] of payloads.entries()) {
      const size = payloadProtoSize(payload);
      if (size < payloadSizeThreshold) continue;

      const selected = driverSelector(storeCtx, payload);
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
    await runWithAbortOnFirstError(batchController, [...driverGroups.values()], async (group) => {
      const claims = await group.driver.store(
        storeCtx,
        group.items.map((it) => it.payload)
      );
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
    const retrieveCtx: StorageDriverRetrieveContext = { abortSignal: batchSignal };

    interface RetrieveItem {
      index: number;
      claim: StorageDriverClaim;
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
      group.items.push({ index: i, claim: new StorageDriverClaim(decoded.claimData) });
    }

    if (driverGroups.size === 0) return payloads;

    const result = payloads.slice();
    await runWithAbortOnFirstError(batchController, [...driverGroups.values()], async (group) => {
      const retrieved = await group.driver.retrieve(
        retrieveCtx,
        group.items.map((it) => it.claim)
      );
      if (retrieved.length !== group.items.length) {
        throw new ValueError(
          `Driver '${group.driver.name}' returned ${retrieved.length} payloads for ${group.items.length} claims`
        );
      }
      for (const [j, retrievedPayload] of retrieved.entries()) {
        const item = group.items[j]!;
        result[item.index] = retrievedPayload;
      }
    });

    return result;
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

function payloadProtoSize(payload: Payload): number {
  return PayloadProto.encode(payload).len;
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
