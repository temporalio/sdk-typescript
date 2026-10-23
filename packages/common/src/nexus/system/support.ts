import type { temporal } from '@temporalio/proto';
import type { Payload } from '../../interfaces';
import { currentSystemNexusPayloadConversion } from './user-payload-converter';

export {
  type SystemNexusDataConverter,
  currentSystemNexusPayloadConversion,
  withSystemNexusPayloadConversion,
} from './user-payload-converter';

/** Convert one application value to a protobuf payload. */
export function valueToPayload(value: unknown): Payload {
  const { converter, context } = currentSystemNexusPayloadConversion();
  return converter.toPayload(value, context);
}

/** Convert one protobuf payload to an application value. */
export function payloadToValue<T>(payload: Payload): T {
  const { converter, context } = currentSystemNexusPayloadConversion();
  return converter.fromPayload<T>(payload, context);
}

export function failureFromProto(proto: temporal.api.failure.v1.IFailure): Error {
  const { converter, failureConverter, context } = currentSystemNexusPayloadConversion();
  return failureConverter.failureToError(proto, converter, context);
}

export function failureToProto(failure: Error): temporal.api.failure.v1.IFailure {
  const { converter, failureConverter, context } = currentSystemNexusPayloadConversion();
  return failureConverter.errorToFailure(failure, converter, context);
}
