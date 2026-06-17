import Long from 'long';
import * as proto from '@temporalio/proto';
import { decode } from '../encoding';
import { ValueError } from '../errors';
import type { Payload } from '../interfaces';
import { ProtobufJsonPayloadConverter } from '../converter/protobuf-payload-converters';
import { encodingTypes, METADATA_ENCODING_KEY, METADATA_MESSAGE_TYPE_KEY } from '../converter/types';
import type { StorageDriverClaim } from '../converter/extstore';

const ExternalStorageReferenceProto = proto.temporal.api.sdk.v1.ExternalStorageReference;
const PayloadProto = proto.temporal.api.common.v1.Payload;
const storageReferenceConverter = new ProtobufJsonPayloadConverter(proto);

const EXTSTORE_REFERENCE_MESSAGE_TYPE = 'temporal.api.sdk.v1.ExternalStorageReference';
const EXTSTORE_REFERENCE_ENCODING = encodingTypes.METADATA_ENCODING_PROTOBUF_JSON;

/**
 * True if the payload is an External Storage reference:
 * `temporal.api.sdk.v1.ExternalStorageReference`.
 *
 * @internal
 * @experimental
 */
export function isReferencePayload(payload: Payload): boolean {
  const encodingValue = readMetadataString(payload, METADATA_ENCODING_KEY);
  if (encodingValue === EXTSTORE_REFERENCE_ENCODING) {
    return readMetadataString(payload, METADATA_MESSAGE_TYPE_KEY) === EXTSTORE_REFERENCE_MESSAGE_TYPE;
  }
  return false;
}

/**
 * Parsed contents of a reference payload.
 *
 * @internal
 * @experimental
 */
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
  const ref = storageReferenceConverter.fromPayload<proto.temporal.api.sdk.v1.IExternalStorageReference>(payload);
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

/**
 * Encode a reference payload to wire format.
 *
 * @internal
 * @experimental
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
  const ref = ExternalStorageReferenceProto.create({ driverName, claimData: claim.claimData });
  const payload = storageReferenceConverter.toPayload(ref);
  if (payload === undefined) {
    // TODO: use the new stable error codes here
    throw new ValueError('Failed to serialize ExternalStorageReference');
  }
  return {
    ...payload,
    externalPayloads: [PayloadProto.ExternalPayloadDetails.create({ sizeBytes: Long.fromNumber(sizeBytes) })],
  };
}

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
