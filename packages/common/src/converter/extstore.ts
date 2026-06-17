import { ValueError } from '../errors';
import type { Payload } from '../interfaces';

/**
 * Reference returned from {@link StorageDriver.store}. `claimData` is an
 * opaque key/value map the driver uses to retrieve the payload later.
 *
 * @internal
 * @experimental
 */
export class StorageDriverClaim {
  constructor(readonly claimData: Record<string, string>) {}
}

/**
 * Workflow identity information passed to a storage driver.
 *
 * @internal
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
 * @internal
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
 * @internal
 * @experimental
 */
export type StorageDriverTargetInfo = StorageDriverWorkflowInfo | StorageDriverActivityInfo;

/**
 * Context handed to {@link StorageDriver.store} (and to the selector).
 *
 * @internal
 * @experimental
 */
export interface StorageDriverStoreContext {
  /** Aborts the in-flight operation; siblings are cancelled on first error. */
  abortSignal?: AbortSignal;
  /** Identity of the workflow / activity that produced the payloads. */
  target?: StorageDriverTargetInfo;
}

/**
 * Context handed to {@link StorageDriver.retrieve}.
 *
 * @internal
 * @experimental
 */
export interface StorageDriverRetrieveContext {
  abortSignal?: AbortSignal;
}

/**
 * External storage backend driver.
 *
 * `name` is the per-instance routing key written into the wire format.
 * `type` is a stable cross-language driver-implementation identifier
 * reported via worker heartbeat (e.g. `"aws.s3driver"`).
 *
 * @internal
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
 * @internal
 * @experimental
 */
export type StorageDriverSelector = (context: StorageDriverStoreContext, payload: Payload) => StorageDriver | null;

// ============================================================================
// Configuration
// ============================================================================

/** Default {@link ExternalStorage.payloadSizeThreshold}: 256 KiB. */
const DEFAULT_PAYLOAD_SIZE_THRESHOLD = 256 * 1024;

/**
 * Configuration for external storage. Holds the registered drivers, an
 * optional selector, and the size threshold above which payloads are
 * eligible for offloading to external storage. A selector function is
 * required when more than one driver is registered.
 *
 * @internal
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
  private readonly driversByName: ReadonlyMap<string, StorageDriver>;

  constructor({
    drivers,
    driverSelector,
    payloadSizeThreshold = DEFAULT_PAYLOAD_SIZE_THRESHOLD,
  }: {
    drivers: StorageDriver[];
    driverSelector?: StorageDriverSelector;
    /** Omit for default (256 KiB). Set `0` to consider all payloads regardless of size. */
    payloadSizeThreshold?: number;
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

    this.drivers = [...drivers];
    this.driverSelector = driverSelector ?? (() => drivers[0] as StorageDriver);
    this.payloadSizeThreshold = payloadSizeThreshold;
    this.driversByName = driversByName;
  }

  /** Look up a registered driver by name. Returns `null` if no driver with that name is registered. */
  getDriver(name: string): StorageDriver | null {
    return this.driversByName.get(name) ?? null;
  }
}
