import { ValueError } from '../errors';
import type { Payload } from '../interfaces';

/**
 * Reference returned from {@link StorageDriver.store}. `claimData` is an
 * opaque key/value map the driver uses to retrieve the payload later.
 *
 * @experimental
 */
export class StorageDriverClaim {
  constructor(readonly claimData: Record<string, string>) {}
}

/**
 * Workflow identity information passed to a storage driver.
 *
 * @experimental
 */
export interface StorageDriverWorkflowInfo {
  readonly kind: 'workflow';
  /** The namespace of the workflow execution. */
  readonly namespace: string;
  /** The workflow ID. */
  readonly id?: string;
  /** The workflow run ID, if available. */
  readonly runId?: string;
  /** The workflow type name, if available. */
  readonly type?: string;
}

/**
 * Activity identity information passed to a storage driver.
 *
 * @experimental
 */
export interface StorageDriverActivityInfo {
  readonly kind: 'activity';
  /** The namespace of the activity execution. */
  readonly namespace: string;
  /** The activity ID. */
  readonly id?: string;
  /** The activity run ID (only for standalone activities). */
  readonly runId?: string;
  /** The activity type name, if available. */
  readonly type?: string;
}

/**
 * Identity of the workflow or activity that produced the payloads being stored.
 *
 * @experimental
 */
export type StorageDriverTargetInfo = StorageDriverWorkflowInfo | StorageDriverActivityInfo;

/**
 * Bounds how many external storage operations all drivers managed by a single ExternalStorage
 * instance may have in flight at once. This limit is cooperative which means driver
 * implementations must use the provided context.limiter to acquire permits for each operation.
 *
 * This limit can be configured via {@link ExternalStorageConcurrency.maxDriverOperations}.
 *
 * n.b. taking permits from inside another permit can lead to deadlocks if the nesting exceeds
 * the configured concurrency limit. It is up to the driver to determine what a single "operation"
 * looks like.
 *
 * @experimental
 */
export interface StorageDriverLimiter<Item> {
  /** Runs `operation` once a permit for `item` is available, releasing the permit when it settles. */
  permit<T>(item: Item, operation: () => Promise<T>): Promise<T>;
}

/**
 * Context handed to {@link StorageDriver.store}.
 *
 * @experimental
 */
export interface StorageDriverStoreContext {
  /** Aborts the in-flight operation; siblings are cancelled on first error. */
  abortSignal?: AbortSignal;
  /** Identity of the workflow / activity that produced the payloads. */
  target?: StorageDriverTargetInfo;
  /** Drivers should wrap each store request in {@link StorageDriverLimiter.permit}. */
  limiter: StorageDriverLimiter<Payload>;
}

/**
 * Context handed to {@link StorageDriverSelector}.
 *
 * @experimental
 */
export interface StorageDriverSelectContext {
  /** Aborts the in-flight operation; siblings are cancelled on first error. */
  abortSignal?: AbortSignal;
  /** Identity of the workflow / activity that produced the payloads. */
  target?: StorageDriverTargetInfo;
}

/**
 * Context handed to {@link StorageDriver.retrieve}.
 *
 * @experimental
 */
export interface StorageDriverRetrieveContext {
  abortSignal?: AbortSignal;
  /** Drivers should wrap each retrieve request in {@link StorageDriverLimiter.permit}. */
  limiter: StorageDriverLimiter<StorageDriverClaim>;
}

/**
 * External storage backend driver.
 *
 * `name` is the per-instance routing key written into the wire format.
 * `type` is a stable cross-language driver-implementation identifier
 * reported via worker heartbeat (e.g. `"aws.s3driver"`).
 *
 * @experimental
 */
export interface StorageDriver {
  readonly name: string;
  readonly type: string;
  store(context: StorageDriverStoreContext, payloads: Payload[]): Promise<StorageDriverClaim[]>;
  retrieve(context: StorageDriverRetrieveContext, claims: StorageDriverClaim[]): Promise<Payload[]>;
}

/**
 * User-supplied function that picks the destination driver for a given
 * payload, or returns `null` to keep the payload inline.
 *
 * @experimental
 */
export type StorageDriverSelector = (context: StorageDriverSelectContext, payload: Payload) => StorageDriver | null;

// ============================================================================
// Configuration
// ============================================================================

/** Default {@link ExternalStorage.payloadSizeThreshold}: 256 KiB. */
const DEFAULT_PAYLOAD_SIZE_THRESHOLD = 256 * 1024;

/** Default {@link ExternalStorageConcurrency.maxDriverOperations}. */
const DEFAULT_MAX_DRIVER_OPERATIONS = 64;

/** Default {@link ExternalStorageConcurrency.maxOperationsPerMessage}. */
const DEFAULT_MAX_OPERATIONS_PER_MESSAGE = 8;

/**
 * Limits on concurrent external storage operations.
 *
 * @experimental
 */
export interface ExternalStorageConcurrency {
  /**
   * Maximum requests in flight at once across every driver registered on this
   * {@link ExternalStorage} instance.
   *
   * Enforced through the {@link StorageDriverLimiter} handed to each driver.
   *
   * Share one instance between workers and clients for a single process-wide budget, or give each
   * its own instance for independent budgets. Defaults to 64.
   */
  maxDriverOperations?: number;
  /**
   * Maximum requests in flight at once on behalf of a single message (e.g. a workflow task
   * activation, an activity task, a client request, or a nexus operation).
   *
   * Every message gets its own budget of this size. This caps what any one message can take of
   * the shared {@link maxDriverOperations} pool and keeps a message carrying many large payloads
   * from starving the others. Defaults to 8.
   */
  maxOperationsPerMessage?: number;
}

function validateOperationCount(name: string, value: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ValueError(`ExternalStorage.concurrency.${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

/**
 * Configuration for external storage. Holds the registered drivers, an
 * optional selector, and the size threshold above which payloads are
 * eligible for offloading to external storage. A selector function is
 * required when more than one driver is registered.
 *
 * @experimental
 */
export class ExternalStorage {
  readonly drivers: StorageDriver[];
  /**
   * Selects the destination driver for each payload, or returns `null` to keep
   * the payload inline.
   */
  readonly driverSelector: StorageDriverSelector;
  readonly payloadSizeThreshold: number;
  readonly concurrency: Required<ExternalStorageConcurrency>;
  private readonly driversByName: ReadonlyMap<string, StorageDriver>;

  constructor({
    drivers,
    driverSelector,
    payloadSizeThreshold = DEFAULT_PAYLOAD_SIZE_THRESHOLD,
    concurrency = {},
  }: {
    drivers: StorageDriver[];
    driverSelector?: StorageDriverSelector;
    /** Omit for default (256 KiB). Set `0` to consider all payloads regardless of size. */
    payloadSizeThreshold?: number;
    /** Omit for defaults (100 instance-wide, 10 per message). */
    concurrency?: ExternalStorageConcurrency;
  }) {
    if (!Array.isArray(drivers) || drivers.length === 0) {
      throw new ValueError('ExternalStorage requires at least one driver');
    }
    if (
      typeof payloadSizeThreshold !== 'number' ||
      !Number.isFinite(payloadSizeThreshold) ||
      payloadSizeThreshold < 0
    ) {
      throw new ValueError(
        `ExternalStorage.payloadSizeThreshold must be a non-negative finite number, got ${String(payloadSizeThreshold)}`
      );
    }

    const driversByName = new Map<string, StorageDriver>();
    for (const driver of drivers) {
      if (typeof driver?.name !== 'string' || driver.name.length === 0) {
        throw new ValueError("Storage driver 'name' must be a non-empty string");
      }
      if (driversByName.has(driver.name)) {
        throw new ValueError(`Duplicate storage driver name: '${driver.name}'`);
      }
      driversByName.set(driver.name, driver);
    }

    if (driverSelector === undefined && driversByName.size > 1) {
      throw new ValueError('ExternalStorage.driverSelector is required when more than one driver is registered');
    }

    const maxDriverOperations = validateOperationCount(
      'maxDriverOperations',
      concurrency.maxDriverOperations ?? DEFAULT_MAX_DRIVER_OPERATIONS
    );
    const maxOperationsPerMessage = validateOperationCount(
      'maxOperationsPerMessage',
      concurrency.maxOperationsPerMessage ?? DEFAULT_MAX_OPERATIONS_PER_MESSAGE
    );

    this.drivers = [...drivers];
    this.driverSelector = driverSelector ?? (() => drivers[0] as StorageDriver);
    this.payloadSizeThreshold = payloadSizeThreshold;
    this.concurrency = { maxDriverOperations, maxOperationsPerMessage };
    this.driversByName = driversByName;
  }

  /** Look up a registered driver by name. Returns `null` if no driver with that name is registered. */
  getDriver(name: string): StorageDriver | null {
    return this.driversByName.get(name) ?? null;
  }
}
