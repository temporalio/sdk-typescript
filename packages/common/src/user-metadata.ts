import type { temporal } from '@temporalio/proto';
import type { PayloadConverter } from './converter/payload-converter';
import { convertOptionalToPayload } from './converter/payload-converter';
import type { SerializationContext } from './converter/serialization-context';

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
  staticDetails: string | undefined,
  context?: SerializationContext
): temporal.api.sdk.v1.IUserMetadata | undefined {
  if (staticSummary == null && staticDetails == null) return undefined;

  const summary = convertOptionalToPayload(payloadConverter, staticSummary, context);
  const details = convertOptionalToPayload(payloadConverter, staticDetails, context);

  if (summary == null && details == null) return undefined;

  return { summary, details };
}
