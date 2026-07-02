import type { Payload, SerializationContext, TypeHint } from '@temporalio/common';
import {
  BinaryPayloadConverter,
  CompositePayloadConverter,
  JsonPayloadConverter,
  UndefinedPayloadConverter,
} from '@temporalio/common';

interface MapperTypeHint<T = unknown> {
  toIntermediate(value: T): unknown;
  fromIntermediate(value: unknown): T;
}

function isMapperTypeHint(hint: unknown): hint is MapperTypeHint {
  return (
    typeof hint === 'object' &&
    hint !== null &&
    typeof (hint as any).toIntermediate === 'function' &&
    typeof (hint as any).fromIntermediate === 'function'
  );
}

class MapperJsonPayloadConverter extends JsonPayloadConverter {
  validateTypeHint(hint: TypeHint): boolean {
    return isMapperTypeHint(hint);
  }

  toPayload<T>(value: T, context?: SerializationContext, hint?: TypeHint): Payload | undefined {
    if (hint === undefined) return super.toPayload(value);
    if (!this.validateTypeHint(hint)) return undefined;

    const mapper = hint as MapperTypeHint;

    // Hint handles rich value -> JSON-safe intermediate.
    const intermediate = mapper.toIntermediate(value);

    // Existing JSON converter handles JSON-safe intermediate -> Payload.
    return super.toPayload(intermediate);
  }

  fromPayload<T>(payload: Payload, context?: SerializationContext, hint?: TypeHint): T {
    if (hint === undefined) return super.fromPayload<T>(payload);
    if (!this.validateTypeHint(hint)) throw new Error('Invalid mapper type hint');

    const mapper = hint as MapperTypeHint<T>;

    // Existing JSON converter handles Payload -> JSON-safe intermediate.
    const intermediate = super.fromPayload<unknown>(payload);

    // Hint handles JSON-safe intermediate -> rich value.
    return mapper.fromIntermediate(intermediate);
  }
}

export const payloadConverter = new CompositePayloadConverter(
  new UndefinedPayloadConverter(),
  new BinaryPayloadConverter(),
  new MapperJsonPayloadConverter()
);
