/**
 * Engine that drives External Storage `store` and `retrieve` operations.
 *
 * @module
 */
import { temporal } from '@temporalio/proto';

import {
  ExternalStorage,
  StorageDriver,
  StorageDriverClaim,
  StorageDriverRetrieveContext,
  StorageDriverStoreContext,
  decodeReferencePayload,
  encodeReferencePayload,
  isReferencePayload,
} from '../converter/extstore';
import type { SerializationContext } from '../converter/serialization-context';
import {
  ExternalStorageDriverArityMismatchError,
  ExternalStorageDriverNotFoundError,
  ExternalStorageDriverOperationFailedError,
  ExternalStorageIntegrityCheckFailedError,
  ExternalStorageNotConfiguredError,
  ExternalStorageSelectorInvalidDriverError,
} from '../errors';
import type { Payload } from '../interfaces';

const PayloadProto = temporal.api.common.v1.Payload;

/** @internal @experimental */
export interface ExternalStoreOptions {
  /** When `undefined` the runner is a no-op (payloads pass through unchanged). */
  externalStorage?: ExternalStorage;

  /** Identity forwarded to the selector and each driver via `StorageDriverStoreContext.target`. */
  context?: SerializationContext;

  payloads: Payload[];

  /** Composed via `AbortSignal.any` with an internal controller so a failing driver call aborts siblings. */
  abortSignal?: AbortSignal;
}

/** @internal @experimental */
export interface ExternalRetrieveOptions {
  /** When `undefined` and any reference payload is encountered, the runner raises `TMPRL1105`. */
  externalStorage?: ExternalStorage;
  payloads: Payload[];
  abortSignal?: AbortSignal;
}

/**
 * Replace each payload above the configured size threshold with a reference payload.
 *
 * @internal
 * @experimental
 */
export async function runExternalStore({
  externalStorage,
  context,
  payloads,
  abortSignal,
}: ExternalStoreOptions): Promise<Payload[]> {
  if (payloads.length === 0 || externalStorage === undefined) return payloads;

  const { drivers, driverSelector, driversByName, payloadSizeThreshold } = externalStorage;
  const fallbackDriver: StorageDriver | undefined =
    drivers.length === 1 && driverSelector === undefined ? drivers[0] : undefined;

  const batchController = new AbortController();
  const batchSignal = abortSignal
    ? AbortSignal.any([batchController.signal, abortSignal])
    : batchController.signal;

  const storeCtx: StorageDriverStoreContext = { abortSignal: batchSignal, target: context };

  interface StoreItem {
    index: number;
    payload: Payload;
    size: number;
  }
  const driverGroups = new Map<string, { driver: StorageDriver; items: StoreItem[] }>();

  for (const [i, payload] of payloads.entries()) {
    const size = payloadProtoSize(payload);
    if (size < payloadSizeThreshold) continue;

    let selected: StorageDriver | null;
    if (fallbackDriver !== undefined) {
      selected = fallbackDriver;
    } else if (driverSelector !== undefined) {
      selected = driverSelector(storeCtx, payload);
    } else {
      // Unreachable: ExternalStorage validates a selector is present when multiple drivers exist.
      continue;
    }

    if (selected === null) continue;
    if (driversByName.get(selected.name) !== selected) {
      throw new ExternalStorageSelectorInvalidDriverError(
        `Driver '${selected.name}' returned by driverSelector is not registered in ExternalStorage.drivers`,
        selected.name
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
    const claims = await callDriver(group.driver, 'store', () =>
      group.driver.store(
        storeCtx,
        group.items.map((it) => it.payload)
      )
    );
    if (claims.length !== group.items.length) {
      throw new ExternalStorageDriverArityMismatchError(
        `Driver '${group.driver.name}' returned ${claims.length} claims for ${group.items.length} payloads`,
        group.driver.name,
        'store',
        group.items.length,
        claims.length
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
 *
 * @internal
 * @experimental
 */
export async function runExternalRetrieve({
  externalStorage,
  payloads,
  abortSignal,
}: ExternalRetrieveOptions): Promise<Payload[]> {
  if (payloads.length === 0) return payloads;
  if (!payloads.some(isReferencePayload)) return payloads;

  if (externalStorage === undefined) {
    throw new ExternalStorageNotConfiguredError(
      'Inbound payload is an external-storage reference but no ExternalStorage is configured to resolve it'
    );
  }

  const { driversByName } = externalStorage;

  const batchController = new AbortController();
  const batchSignal = abortSignal
    ? AbortSignal.any([batchController.signal, abortSignal])
    : batchController.signal;

  const retrieveCtx: StorageDriverRetrieveContext = { abortSignal: batchSignal };

  interface RetrieveItem {
    index: number;
    claim: StorageDriverClaim;
    /** `0` for legacy references that pre-date the size_bytes field. */
    expectedSize: number;
  }
  const driverGroups = new Map<string, { driver: StorageDriver; items: RetrieveItem[] }>();

  for (const [i, payload] of payloads.entries()) {
    if (!isReferencePayload(payload)) continue;
    const decoded = decodeReferencePayload(payload);
    const driver = driversByName.get(decoded.driverName);
    if (driver === undefined) {
      throw new ExternalStorageDriverNotFoundError(
        `No driver registered with name '${decoded.driverName}'`,
        decoded.driverName
      );
    }
    let group = driverGroups.get(decoded.driverName);
    if (group === undefined) {
      group = { driver, items: [] };
      driverGroups.set(decoded.driverName, group);
    }
    group.items.push({
      index: i,
      claim: new StorageDriverClaim(decoded.claimData),
      expectedSize: decoded.sizeBytes,
    });
  }

  const result = payloads.slice();
  await runWithAbortOnFirstError(batchController, [...driverGroups.values()], async (group) => {
    const retrieved = await callDriver(group.driver, 'retrieve', () =>
      group.driver.retrieve(
        retrieveCtx,
        group.items.map((it) => it.claim)
      )
    );
    if (retrieved.length !== group.items.length) {
      throw new ExternalStorageDriverArityMismatchError(
        `Driver '${group.driver.name}' returned ${retrieved.length} payloads for ${group.items.length} claims`,
        group.driver.name,
        'retrieve',
        group.items.length,
        retrieved.length
      );
    }
    for (const [j, retrievedPayload] of retrieved.entries()) {
      const item = group.items[j]!;
      if (item.expectedSize > 0) {
        const actual = payloadProtoSize(retrievedPayload);
        if (actual !== item.expectedSize) {
          throw new ExternalStorageIntegrityCheckFailedError(
            `Driver '${group.driver.name}' returned ${actual} bytes for a reference recorded as ${item.expectedSize} bytes`,
            group.driver.name
          );
        }
      }
      result[item.index] = retrievedPayload;
    }
  });

  return result;
}

// ============================================================================
// Internal helpers
// ============================================================================

function payloadProtoSize(payload: Payload): number {
  return PayloadProto.encode(payload).finish().length;
}

/** Invoke a driver call, wrapping non-Temporal errors as `ExternalStorageDriverOperationFailedError`. */
async function callDriver<T>(
  driver: StorageDriver,
  operation: 'store' | 'retrieve',
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    if (cause instanceof ExternalStorageDriverOperationFailedError) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ExternalStorageDriverOperationFailedError(
      `Driver '${driver.name}' ${operation} failed: ${message}`,
      driver.name,
      operation,
      cause
    );
  }
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
