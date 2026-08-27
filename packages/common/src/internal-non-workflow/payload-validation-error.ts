import type { LoadedDataConverter } from '../converter/data-converter';
import type { SerializationContext } from '../converter/serialization-context';
import type { ApplicationFailure, ProtoFailure } from '../failure';
import {
  clonePayloadValidationErrorAsRetryable,
  payloadFreePayloadValidationFailure,
} from '../internal-workflow/payload-validation-error';
import { encodeErrorToFailure } from './codec-helpers';
import type { Encoded } from './codec-types';

/** @internal */
export async function encodePayloadValidationError(
  dataConverter: LoadedDataConverter,
  error: ApplicationFailure,
  context?: SerializationContext,
  retryable = false
): Promise<Encoded<ProtoFailure>> {
  const failure = retryable ? clonePayloadValidationErrorAsRetryable(error) : error;
  try {
    return (await encodeErrorToFailure(dataConverter, failure, context)) as Encoded<ProtoFailure>;
  } catch (_err) {
    return payloadFreePayloadValidationFailure(failure, !retryable) as Encoded<ProtoFailure>;
  }
}
