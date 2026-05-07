import { temporal } from '@temporalio/proto';
import Long from 'long';
import { decode, encode } from '../encoding';
import { ValueError } from '../errors';
import type { Payload } from '../interfaces';
import { encodingKeys, encodingTypes, METADATA_ENCODING_KEY, METADATA_MESSAGE_TYPE_KEY } from './types';

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
 * Identity of the workflow that produced the payload being stored.
 * Matches `StorageDriverWorkflowInfo` in the Python and Go SDKs.
 *
 * @experimental
 */
export interface StorageDriverWorkflowInfo {
  readonly kind: 'workflow';
  readonly namespace: string;
  readonly workflowId?: string;
  readonly runId?: string;
  readonly workflowType?: string;
}

/**
 * Identity of the activity that produced the payload being stored.
 * Used for standalone activities; workflow-bound activities use a
 * {@link StorageDriverWorkflowInfo} that names their parent workflow.
 * Matches `StorageDriverActivityInfo` in the Python and Go SDKs.
 *
 * @experimental
 */
export interface StorageDriverActivityInfo {
  readonly kind: 'activity';
  readonly namespace: string;
  readonly activityId?: string;
  readonly runId?: string;
  readonly activityType?: string;
}

/**
 * The entity that produced a payload — discriminated by `kind`. Matches
 * Go's `StorageDriverTargetInfo` marker interface; Python carries an
 * inline union with no separate name.
 *
 * @experimental
 */
export type StorageDriverTargetInfo = StorageDriverWorkflowInfo | StorageDriverActivityInfo;

/**
 * Context handed to {@link StorageDriver.store} (and to the selector).
 *
 * @experimental
 */
export interface StorageDriverStoreContext {
  /**
   * Aborts the in-flight store operation. The SDK populates this for
   * every batch and aborts siblings on first error. May be undefined
   * when a driver is invoked outside the SDK's pipeline (e.g. by tests
   * driving the driver directly).
   */
  abortSignal?: AbortSignal;
  /**
   * Identity of the workflow / activity that produced the payloads.
   * May be absent for client paths where identity isn't known at the
   * call site.
   */
  target?: StorageDriverTargetInfo;
}

/**
 * Context handed to {@link StorageDriver.retrieve}.
 *
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
 * payload, or returns `null` to keep the payload inline. Required when
 * more than one driver is registered.
 *
 * @experimental
 */
export type StorageDriverSelector = (
  context: StorageDriverStoreContext,
  payload: Payload
) => StorageDriver | null;

// ============================================================================
// Configuration
// ============================================================================

/**
 * Default {@link ExternalStorage.payloadSizeThreshold}: 256 KiB. Matches
 * Python and Go.
 *
 * @experimental
 */
export const DEFAULT_PAYLOAD_SIZE_THRESHOLD = 256 * 1024;

/**
 * Mounted on {@link DataConverter.externalStorage}. Holds the registered
 * drivers, an optional selector, and the size threshold above which
 * payloads are eligible for offloading.
 *
 * @experimental
 */
export class ExternalStorage {
  readonly drivers: StorageDriver[];
  readonly driverSelector?: StorageDriverSelector;
  readonly payloadSizeThreshold: number;
  /** Built at construction; used by the retrieve path and by selector validation. */
  readonly driversByName: ReadonlyMap<string, StorageDriver>;

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
    // TODO: use the new stable error codes here
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

    if (driversByName.size > 1 && driverSelector === undefined) {
      throw new ValueError(
        'ExternalStorage.driverSelector is required when more than one driver is registered'
      );
    }

    this.drivers = [...drivers];
    this.driverSelector = driverSelector;
    this.payloadSizeThreshold = payloadSizeThreshold;
    this.driversByName = driversByName;
  }
}

// ============================================================================
// Wire format
// ============================================================================

/**
 * `metadata.messageType` value identifying a reference payload.
 *
 * @internal
 */
export const EXTSTORE_REFERENCE_MESSAGE_TYPE = 'temporal.api.sdk.v1.ExternalStorageReference';

/**
 * `metadata.encoding` value for reference payloads.
 *
 * @internal
 */
export const EXTSTORE_REFERENCE_ENCODING = encodingTypes.METADATA_ENCODING_PROTOBUF_JSON;

/**
 * Legacy `metadata.encoding` value used by pre-1.0 prereleases. Read
 * only and never written by current implementations. Eventually will be
 * phased out.
 *
 * @internal
 */
export const LEGACY_EXTSTORE_REFERENCE_ENCODING = 'json/external-storage-reference';

const EXTSTORE_REFERENCE_MESSAGE_TYPE_BYTES = encode(EXTSTORE_REFERENCE_MESSAGE_TYPE);

/**
 * Returns true if the payload is a v1 or legacy External Storage reference.
 * 
 * @internal
 */
export function isReferencePayload(payload: Payload): boolean {
  if (payload.externalPayloads && payload.externalPayloads.length > 0) {
    return true;
  }
  const encodingValue = readMetadataString(payload, METADATA_ENCODING_KEY);
  if (encodingValue === EXTSTORE_REFERENCE_ENCODING) {
    const messageType = readMetadataString(payload, METADATA_MESSAGE_TYPE_KEY);
    if (messageType === EXTSTORE_REFERENCE_MESSAGE_TYPE) {
      return true;
    }
  } 
  if (encodingValue === LEGACY_EXTSTORE_REFERENCE_ENCODING) {
    return true;
  }
  return false;
}

/**
 * Parsed contents of a reference payload. `sizeBytes` is `0` for legacy payloads.
 *
 * @internal
 */
export interface DecodedReferencePayload {
  driverName: string;
  claimData: Record<string, string>;
  sizeBytes: number;
}

/**
 * Decode a reference payload (v1 proto encoding or legacy JSON
 * encoding). Throws {@link ValueError} if the payload is not a
 * reference or is malformed; callers should gate on
 * {@link isReferencePayload} first.
 *
 * @internal
 */
export function decodeReferencePayload(payload: Payload): DecodedReferencePayload {
  const encodingValue = readMetadataString(payload, METADATA_ENCODING_KEY);

  if (encodingValue === LEGACY_EXTSTORE_REFERENCE_ENCODING) {
    return decodeLegacyReferencePayload(payload);
  }

  if (encodingValue !== EXTSTORE_REFERENCE_ENCODING) {
    throw new ValueError(
      `Reference payload has unexpected encoding '${encodingValue ?? '<missing>'}'; expected '${EXTSTORE_REFERENCE_ENCODING}' or '${LEGACY_EXTSTORE_REFERENCE_ENCODING}'`
    );
  }

  const messageType = readMetadataString(payload, METADATA_MESSAGE_TYPE_KEY);
  if (messageType !== EXTSTORE_REFERENCE_MESSAGE_TYPE) {
    throw new ValueError(
      `Reference payload has unexpected messageType '${messageType ?? '<missing>'}'; expected '${EXTSTORE_REFERENCE_MESSAGE_TYPE}'`
    );
  }

  if (!payload.data) {
    throw new ValueError('Reference payload is missing data');
  }

  let parsed: { driverName?: unknown; claimData?: unknown };
  try {
    parsed = JSON.parse(decode(payload.data)) as typeof parsed;
  } catch (err) {
    throw new ValueError(`Reference payload data is not valid JSON: ${(err as Error).message}`);
  }

  return {
    driverName: assertNonEmptyString(parsed.driverName, 'driverName'),
    claimData: assertStringMap(parsed.claimData ?? {}, 'claimData'),
    sizeBytes: readSizeBytes(payload),
  };
}

/**
 * Encode a reference payload in the v1 wire format.
 *
 * @internal
 */
export function encodeReferencePayload({
  driverName,
  claim,
  sizeBytes,
}: {
  driverName: string;
  claim: StorageDriverClaim;
  sizeBytes: number;
}): Payload {
  const protoJson = JSON.stringify({ driverName, claimData: claim.claimData });
  return {
    metadata: {
      [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF_JSON,
      [METADATA_MESSAGE_TYPE_KEY]: EXTSTORE_REFERENCE_MESSAGE_TYPE_BYTES,
    },
    data: encode(protoJson),
    externalPayloads: [
      temporal.api.common.v1.Payload.ExternalPayloadDetails.create({
        sizeBytes: Long.fromNumber(sizeBytes),
      }),
    ],
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

function readMetadataString(payload: Payload, key: string): string | undefined {
  const raw = payload.metadata?.[key];
  if (!raw) return undefined;
  return decode(raw);
}

function readSizeBytes(payload: Payload): number {
  const details = payload.externalPayloads?.[0];
  if (!details?.sizeBytes) return 0;
  return Long.isLong(details.sizeBytes) ? details.sizeBytes.toNumber() : Number(details.sizeBytes);
}

function decodeLegacyReferencePayload(payload: Payload): DecodedReferencePayload {
  if (!payload.data) {
    throw new ValueError('Legacy reference payload is missing data');
  }
  // Legacy shape: { driver_name, driver_claim: { claim_data } }.
  let parsed: { driver_name?: unknown; driver_claim?: { claim_data?: unknown } };
  try {
    parsed = JSON.parse(decode(payload.data)) as typeof parsed;
  } catch (err) {
    throw new ValueError(`Legacy reference payload data is not valid JSON: ${(err as Error).message}`);
  }
  return {
    driverName: assertNonEmptyString(parsed.driver_name, 'driver_name'),
    claimData: assertStringMap(parsed.driver_claim?.claim_data ?? {}, 'driver_claim.claim_data'),
    // Legacy payloads do not record size
    sizeBytes: 0,
  };
}

function assertNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValueError(`Reference payload field '${fieldName}' must be a non-empty string`);
  }
  return value;
}

function assertStringMap(value: unknown, fieldName: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValueError(`Reference payload field '${fieldName}' must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') {
      throw new ValueError(`Reference payload field '${fieldName}.${k}' must be a string`);
    }
    out[k] = v;
  }
  return out;
}
