import type { Payload, PayloadConverter, SerializationContext } from '@temporalio/common';
import { defaultPayloadConverter } from '@temporalio/common';
import { decode, encode } from '@temporalio/common/lib/encoding';

export const MANGLING_ENCODING = 'text/custom-mangled';
export const MANGLING_PREFIX = 'custom-converter-';

/**
 * A payload converter that mangles strings — they come out with a `text/custom-mangled` encoding
 * and a `custom-converter-` prefix instead of as a `json/plain` JSON string — and leaves every
 * other value to the default converter.
 *
 * Used to tell apart values that a worker converted with its own configured converter from values
 * the SDK deliberately converts with the default one.
 */
export class StringManglingPayloadConverter implements PayloadConverter {
  toPayload<T>(value: T, context?: SerializationContext): Payload {
    if (typeof value !== 'string') return defaultPayloadConverter.toPayload(value, context);
    return {
      metadata: { encoding: encode(MANGLING_ENCODING) },
      data: encode(`${MANGLING_PREFIX}${value}`),
    };
  }

  fromPayload<T>(payload: Payload, context?: SerializationContext): T {
    if (decode(payload.metadata?.encoding ?? new Uint8Array()) !== MANGLING_ENCODING) {
      return defaultPayloadConverter.fromPayload(payload, context);
    }
    return decode(payload.data ?? new Uint8Array()).slice(MANGLING_PREFIX.length) as T;
  }
}

export const payloadConverter = new StringManglingPayloadConverter();
