import type { Payload } from '../interfaces';
import type { ConverterHint, TypeInfo } from '../type-info';
import type { PayloadConverter } from './payload-converter';
import type { SerializationContext } from './serialization-context';

/**
 * SDK-internal adapter that owns TypeInfo processing around a provided PayloadConverter.
 */
export class TypeInfoAwarePayloadConverter implements PayloadConverter {
  public constructor(private readonly payloadConverter: PayloadConverter) {}

  public toPayload<T>(value: T, context?: SerializationContext, hint?: ConverterHint): Payload {
    return this.payloadConverter.toPayload(value, context, hint);
  }

  public fromPayload<T>(payload: Payload, context?: SerializationContext, hint?: ConverterHint): T {
    return this.payloadConverter.fromPayload(payload, context, hint);
  }

  public validateConverterHint(hint: ConverterHint): boolean {
    return this.payloadConverter.validateConverterHint?.(hint) ?? false;
  }

  public toPayloadWithTypeInfo<T>(
    value: T,
    context: SerializationContext | undefined,
    typeInfo: TypeInfo<T> | undefined
  ): Payload {
    const transferValue = typeInfo?.transferTypeConverter
      ? typeInfo.transferTypeConverter.toTransferType(value)
      : value;
    return this.payloadConverter.toPayload(transferValue, context, typeInfo?.hint);
  }

  public fromPayloadWithTypeInfo<T>(
    payload: Payload,
    context: SerializationContext | undefined,
    typeInfo: TypeInfo | undefined
  ): T {
    const transferValue = this.payloadConverter.fromPayload<unknown>(payload, context, typeInfo?.hint);
    const value = typeInfo?.transferTypeConverter
      ? typeInfo.transferTypeConverter.fromTransferType(transferValue)
      : transferValue;
    return value as T;
  }
}

const typeInfoAwarePayloadConverters = new WeakMap<PayloadConverter, TypeInfoAwarePayloadConverter>();

export function getTypeInfoAwarePayloadConverter(payloadConverter: PayloadConverter): TypeInfoAwarePayloadConverter {
  if (payloadConverter instanceof TypeInfoAwarePayloadConverter) {
    return payloadConverter;
  }

  let typeInfoAwarePayloadConverter = typeInfoAwarePayloadConverters.get(payloadConverter);
  if (typeInfoAwarePayloadConverter === undefined) {
    typeInfoAwarePayloadConverter = new TypeInfoAwarePayloadConverter(payloadConverter);
    typeInfoAwarePayloadConverters.set(payloadConverter, typeInfoAwarePayloadConverter);
  }
  return typeInfoAwarePayloadConverter;
}
