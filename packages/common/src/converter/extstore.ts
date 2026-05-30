import Long from 'long';
import * as proto from '@temporalio/proto';
import { patchProtobufRoot } from '@temporalio/proto/lib/patch-protobuf-root';
import { decode } from '../encoding';
import { ValueError } from '../errors';
import type { Payload } from '../interfaces';
import type { SerializationContext } from './serialization-context';
import { ProtobufJsonPayloadConverter } from './protobuf-payload-converters';
import { encodingTypes, METADATA_ENCODING_KEY, METADATA_MESSAGE_TYPE_KEY } from './types';

const ExternalStorageReferenceProto = proto.temporal.api.sdk.v1.ExternalStorageReference;
const PayloadProto = proto.temporal.api.common.v1.Payload;
const claimConverter = new ProtobufJsonPayloadConverter(patchProtobufRoot(proto));

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
 * Context handed to {@link StorageDriver.store} (and to the selector).
 *
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

/**
 * Build a {@link StorageDriverTarget} from a codec-layer {@link SerializationContext}.
 * Bridges the codec pipeline (which threads `SerializationContext`) into the storage
 * driver API (which expects the narrower, extstore-specific target shape).
 *
 * @internal
 * @experimental
 */
export function storageTargetFromContext(ctx: SerializationContext | undefined): StorageDriverTarget | undefined {
  if (!ctx) return undefined;
  return ctx.type === 'workflow'
    ? { kind: 'workflow', namespace: ctx.namespace, id: ctx.workflowId }
    : { kind: 'activity', namespace: ctx.namespace, id: ctx.activityId };
}

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

    if (driverSelector === undefined && driversByName.size > 1) {
      // TODO: use the new stable error codes here
      throw new ValueError('ExternalStorage.driverSelector is required when more than one driver is registered');
    }

    this.drivers = [...drivers];
    this.driverSelector = driverSelector ?? (() => drivers[0] as StorageDriver);
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
const EXTSTORE_REFERENCE_MESSAGE_TYPE = 'temporal.api.sdk.v1.ExternalStorageReference';

/** @internal @experimental */
const EXTSTORE_REFERENCE_ENCODING = encodingTypes.METADATA_ENCODING_PROTOBUF_JSON;

const EXTSTORE_REFERENCE_MESSAGE_TYPE_BYTES = encode(EXTSTORE_REFERENCE_MESSAGE_TYPE);

/** 
 * True if the payload is a External Storage reference:
 * temporal.api.sdk.v1.ExternalStorageReference
 * 
 * @internal @experimental 
 * */
export function isReferencePayload(payload: Payload): boolean {
  if (payload.externalPayloads && payload.externalPayloads.length > 0) {
    return true;
  }
  const encodingValue = readMetadataString(payload, METADATA_ENCODING_KEY);
  if (encodingValue === EXTSTORE_REFERENCE_ENCODING) {
    return readMetadataString(payload, METADATA_MESSAGE_TYPE_KEY) === EXTSTORE_REFERENCE_MESSAGE_TYPE;
  }
  return false;
}

/** Parsed contents of a reference payload. `sizeBytes` is `0` for legacy payloads. @internal @experimental */
export interface DecodedReferencePayload {
  driverName: string;
  claimData: Record<string, string>;
  sizeBytes: number;
}

/**
 * Decode a reference payload from the wire format {@link ExternalStorageReference}. 
 * Throws {@link ValueError} if the payload is not a reference or is malformed. 
 * Callers should gate on {@link isReferencePayload} first.
 *
 * @internal
 * @experimental
 */
export function decodeReferencePayload(payload: Payload): DecodedReferencePayload {
  const ref = claimConverter.fromPayload<proto.temporal.api.sdk.v1.IExternalStorageReference>(payload);
  if (!ref.driverName) {
    // TODO: use the new stable error codes here
    throw new ValueError("Reference payload field 'driverName' must be a non-empty string");
  }
  return {
    driverName: ref.driverName,
    claimData: { ...ref.claimData },
    sizeBytes: readSizeBytes(payload),
  };
}

/** Encode a reference payload to wire format. @internal @experimental */
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
  const payload = claimConverter.toPayload(ref);
  if (payload === undefined) {
    // TODO: use the new stable error codes here
    throw new ValueError('Failed to serialize ExternalStorageReference');
  }
  return {
    ...payload,
    externalPayloads: [PayloadProto.ExternalPayloadDetails.create({ sizeBytes: Long.fromNumber(sizeBytes) })],
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
