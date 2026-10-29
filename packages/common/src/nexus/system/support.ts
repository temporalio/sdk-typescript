import type { temporal } from '@temporalio/proto';
import type { Payload } from '../../interfaces';
import type { TypeInfo } from '../../type-info';
import { fromPayloadWithTypeInfo, toPayloadWithTypeInfo } from '../../converter/payload-converter';
import { currentSystemNexusPayloadConversion } from './user-payload-converter';

export {
  type SystemNexusDataConverter,
  currentSystemNexusPayloadConversion,
  withSystemNexusPayloadConversion,
} from './user-payload-converter';

/** Convert one application value to a protobuf payload. */
export function valueToPayload<T>(value: T, typeInfo?: TypeInfo<T, any>): Payload {
  const { converter, context } = currentSystemNexusPayloadConversion();
  return toPayloadWithTypeInfo(converter, value, context, typeInfo);
}

/** Convert one protobuf payload to an application value. */
export function payloadToValue<T>(payload: Payload, typeInfo?: TypeInfo<T, any>): T {
  const { converter, context } = currentSystemNexusPayloadConversion();
  return fromPayloadWithTypeInfo(converter, payload, context, typeInfo);
}

export function failureFromProto(proto: temporal.api.failure.v1.IFailure): Error {
  const { converter, failureConverter, context } = currentSystemNexusPayloadConversion();
  return failureConverter.failureToError(proto, converter, context);
}

export function failureToProto(failure: Error): temporal.api.failure.v1.IFailure {
  const { converter, failureConverter, context } = currentSystemNexusPayloadConversion();
  return failureConverter.errorToFailure(failure, converter, context);
}
