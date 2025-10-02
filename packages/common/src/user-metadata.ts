import type { temporal } from '@temporalio/proto';
import { convertOptionalToPayload, PayloadConverter } from './converter/payload-converter';

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

  const summary = convertOptionalToPayload(payloadConverter, staticSummary);
  const details = convertOptionalToPayload(payloadConverter, staticDetails);

  if (summary == null && details == null) return undefined;

  return { summary, details };
}
