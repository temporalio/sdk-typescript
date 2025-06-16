import { temporal } from '@temporalio/proto';
import { PayloadConverter } from './converter/payload-converter';
import { LoadedDataConverter } from './converter/data-converter';
import { encodeOptionalToPayload, decodeOptionalSinglePayload, encodeOptionalSingle } from './internal-non-workflow';

/**
 * User metadata that can be attached to workflow commands.
 */
export interface UserMetadata {
  /** @experimental A fixed, single line summary of the command's purpose */
  staticSummary?: string;
  /** @experimental Fixed additional details about the command for longer-text description, can span multiple lines */
  staticDetails?: string;
}

export function userMetadataToPayload(
  payloadConverter: PayloadConverter,
  staticSummary: string | undefined,
  staticDetails: string | undefined
): temporal.api.sdk.v1.IUserMetadata | undefined {
  if (staticSummary == null && staticDetails == null) return undefined;

  const summary = encodeOptionalToPayload(payloadConverter, staticSummary);
  const details = encodeOptionalToPayload(payloadConverter, staticDetails);

  if (summary == null && details == null) return undefined;

  return { summary, details };
}

export async function encodeUserMetadata(
  dataConverter: LoadedDataConverter,
  staticSummary: string | undefined,
  staticDetails: string | undefined
): Promise<temporal.api.sdk.v1.IUserMetadata | undefined> {
  if (staticSummary == null && staticDetails == null) return undefined;

  const { payloadConverter, payloadCodecs } = dataConverter;
  const summary = await encodeOptionalSingle(
    payloadCodecs,
    await encodeOptionalToPayload(payloadConverter, staticSummary)
  );
  const details = await encodeOptionalSingle(
    payloadCodecs,
    await encodeOptionalToPayload(payloadConverter, staticDetails)
  );

  if (summary == null && details == null) return undefined;

  return { summary, details };
}

export async function decodeUserMetadata(
  dataConverter: LoadedDataConverter,
  metadata: temporal.api.sdk.v1.IUserMetadata | undefined | null
): Promise<UserMetadata> {
  const res = { staticSummary: undefined, staticDetails: undefined };
  if (metadata == null) return res;

  const staticSummary = (await decodeOptionalSinglePayload<string>(dataConverter, metadata.summary)) ?? undefined;
  const staticDetails = (await decodeOptionalSinglePayload<string>(dataConverter, metadata.details)) ?? undefined;

  if (staticSummary == null && staticDetails == null) return res;

  return { staticSummary, staticDetails };
}
