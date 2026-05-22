import { temporal } from '@temporalio/proto';
import Long from 'long';
import { decode, encode } from '../encoding';
import { ValueError } from '../errors';
import type { Payload } from '../interfaces';
import type { SerializationContext } from './serialization-context';
import { encodingKeys, encodingTypes, METADATA_ENCODING_KEY, METADATA_MESSAGE_TYPE_KEY } from './types';

const ExternalStorageReferenceProto = temporal.api.sdk.v1.ExternalStorageReference;
const PayloadProto = temporal.api.common.v1.Payload;

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
 * Context handed to {@link StorageDriver.store} (and to the selector).
 *
 * @experimental
 */
export interface StorageDriverStoreContext {
  /** Aborts the in-flight operation; siblings are cancelled on first error. */
  abortSignal?: AbortSignal;
  /** Identity of the workflow / activity that produced the payloads. */
  target?: SerializationContext;
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
 * Default {@link ExternalStorage.payloadSizeThreshold}: 256 KiB.
 *
 * @experimental
 */
export const DEFAULT_PAYLOAD_SIZE_THRESHOLD = 256 * 1024;

/**
 * Configuration for external storage. Holds the registered drivers, an
 * optional selector, and the size threshold above which payloads are
 * eligible for offloading.
 *
 * Mounted on {@link DataConverter.externalStorage}.
 *
 * @experimental
 */
export class ExternalStorage {
  readonly drivers: StorageDriver[];
  readonly driverSelector?: StorageDriverSelector;
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

  /** Look up a registered driver by name. Returns `undefined` if no driver with that name is registered. */
  getDriver(name: string): StorageDriver | undefined {
    return this.driversByName.get(name);
  }
}

// ============================================================================
// Wire format
// ============================================================================

/** @internal @experimental */
export const EXTSTORE_REFERENCE_MESSAGE_TYPE = 'temporal.api.sdk.v1.ExternalStorageReference';

/** @internal @experimental */
export const EXTSTORE_REFERENCE_ENCODING = encodingTypes.METADATA_ENCODING_PROTOBUF_JSON;

/** Pre-1.0 reference encoding. Read-only — never written by current implementations. @internal @experimental */
export const LEGACY_EXTSTORE_REFERENCE_ENCODING = 'json/external-storage-reference';

const EXTSTORE_REFERENCE_MESSAGE_TYPE_BYTES = encode(EXTSTORE_REFERENCE_MESSAGE_TYPE);

/** True if the payload is a v1 or legacy External Storage reference. @internal @experimental */
export function isReferencePayload(payload: Payload): boolean {
  if (payload.externalPayloads && payload.externalPayloads.length > 0) {
    return true;
  }
  const encodingValue = readMetadataString(payload, METADATA_ENCODING_KEY);
  if (encodingValue === EXTSTORE_REFERENCE_ENCODING) {
    return readMetadataString(payload, METADATA_MESSAGE_TYPE_KEY) === EXTSTORE_REFERENCE_MESSAGE_TYPE;
  }
  return encodingValue === LEGACY_EXTSTORE_REFERENCE_ENCODING;
}

/** Parsed contents of a reference payload. `sizeBytes` is `0` for legacy payloads. @internal @experimental */
export interface DecodedReferencePayload {
  driverName: string;
  claimData: Record<string, string>;
  sizeBytes: number;
}

/**
 * Decode a reference payload (v1 proto encoding or legacy JSON encoding). Throws
 * {@link ValueError} if the payload is not a reference or is malformed; callers
 * should gate on {@link isReferencePayload} first.
 *
 * @internal
 * @experimental
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(decode(payload.data));
  } catch (err) {
    throw new ValueError(`Reference payload data is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValueError('Reference payload data must be a JSON object');
  }

  const ref = ExternalStorageReferenceProto.fromObject(parsed as Record<string, unknown>);
  if (!ref.driverName) {
    throw new ValueError("Reference payload field 'driverName' must be a non-empty string");
  }
  return {
    driverName: ref.driverName,
    claimData: { ...ref.claimData },
    sizeBytes: readSizeBytes(payload),
  };
}

/** Encode a reference payload in the v1 wire format. @internal @experimental */
export function encodeReferencePayload({
  driverName,
  claim,
  sizeBytes,
}: {
  driverName: string;
  claim: StorageDriverClaim;
  sizeBytes: number;
}): Payload {
  const ref = ExternalStorageReferenceProto.create({ driverName, claimData: claim.claimData });
  return {
    metadata: {
      [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF_JSON,
      [METADATA_MESSAGE_TYPE_KEY]: EXTSTORE_REFERENCE_MESSAGE_TYPE_BYTES,
    },
    data: encode(JSON.stringify(ref.toJSON())),
    externalPayloads: [
      PayloadProto.ExternalPayloadDetails.create({ sizeBytes: Long.fromNumber(sizeBytes) }),
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

  const driverName = parsed.driver_name;
  if (typeof driverName !== 'string' || driverName.length === 0) {
    throw new ValueError("Legacy reference payload field 'driver_name' must be a non-empty string");
  }

  const rawClaimData = parsed.driver_claim?.claim_data ?? {};
  if (typeof rawClaimData !== 'object' || rawClaimData === null || Array.isArray(rawClaimData)) {
    throw new ValueError("Legacy reference payload field 'driver_claim.claim_data' must be an object");
  }
  const claimData: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawClaimData)) {
    if (typeof v !== 'string') {
      throw new ValueError(`Legacy reference payload field 'driver_claim.claim_data.${k}' must be a string`);
    }
    claimData[k] = v;
  }

  return { driverName, claimData, sizeBytes: 0 };
}
