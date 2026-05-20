import type {
  Payload,
  PayloadCodec,
  PayloadConverter,
  FailureConverter,
  ProtoFailure,
  SerializationContext,
} from '@temporalio/common';
import { defaultPayloadConverter, defaultFailureConverter } from '@temporalio/common';

export interface ContextTrace<T> {
  label: T;
  trace: string[];
}

export function makeContextTrace<T>(label: T): ContextTrace<T> {
  return {
    label,
    trace: [],
  };
}

export function roundTripTrace(label: string, ctx: string): ContextTrace<string> {
  return {
    label,
    trace: [enc(label, ctx), dec(label, ctx)],
  };
}

export function withLabel<T>(existing: ContextTrace<unknown>, label: T): ContextTrace<T> {
  return { label, trace: existing.trace };
}

export function workflowCtx(workflowId: string): string {
  return `workflow.default.${workflowId}`;
}

export function activityCtx(workflowId: string, activityId = '1', isLocal = false): string {
  return `activity.default.${workflowId}.${activityId}.${isLocal}`;
}

export function enc(label: string, ctx: string): string {
  return `payload.encode.bound|${label}|${ctx}`;
}

export function dec(label: string, ctx: string): string {
  return `payload.decode.bound|${label}|${ctx}`;
}

export function encdec(label: string, ctx: string): string[] {
  return [enc(label, ctx), dec(label, ctx)];
}

function isContextTrace(maybeTrace: unknown): maybeTrace is ContextTrace<unknown> {
  return (
    typeof maybeTrace === 'object' &&
    maybeTrace !== null &&
    'label' in maybeTrace &&
    'trace' in maybeTrace &&
    Array.isArray(maybeTrace.trace)
  );
}

export function contextToTraceString(context: SerializationContext): string {
  const parts = [context.type, context.namespace];

  if (context.workflowId) parts.push(context.workflowId);

  if (context.type === 'activity') {
    if (context.activityId) parts.push(context.activityId);
    parts.push(String(context.isLocal));
  }

  return parts.join('.');
}

function tracePayload(
  payload: Payload,
  operation: 'codec.encode' | 'codec.decode',
  context?: SerializationContext
): Payload {
  const value = defaultPayloadConverter.fromPayload(payload, context);
  if (!isContextTrace(value)) {
    return payload;
  }

  value.trace.push(
    context ? `${operation}.bound|${value.label}|${contextToTraceString(context)}` : `${operation}.free|${value.label}`
  );
  return defaultPayloadConverter.toPayload(value, context);
}

export class FreePayloadConverter implements PayloadConverter {
  toPayload<T>(value: T, context?: SerializationContext): Payload {
    if (isContextTrace(value)) {
      value.trace.push(
        context
          ? `payload.encode.bound|${value.label}|${contextToTraceString(context)}`
          : `payload.encode.free|${value.label}`
      );
    }
    return defaultPayloadConverter.toPayload(value, context);
  }

  fromPayload<T>(payload: Payload, context?: SerializationContext): T {
    const value = defaultPayloadConverter.fromPayload(payload, context);
    if (isContextTrace(value)) {
      value.trace.push(
        context
          ? `payload.decode.bound|${value.label}|${contextToTraceString(context)}`
          : `payload.decode.free|${value.label}`
      );
    }
    return value as T;
  }
}

export class FreeFailureConverter implements FailureConverter {
  errorToFailure(err: unknown, payloadConverter: PayloadConverter, context?: SerializationContext): ProtoFailure {
    const failure = defaultFailureConverter.errorToFailure(err, payloadConverter, context);
    const existing = failure.message ?? '';
    failure.message = context
      ? `failure.encode.bound|${contextToTraceString(context)}|${existing}`
      : `failure.encode.free|${existing}`;
    return failure;
  }
  failureToError(err: ProtoFailure, payloadConverter: PayloadConverter, context?: SerializationContext): Error {
    const error = defaultFailureConverter.failureToError(err, payloadConverter, context);
    error.message = context
      ? `failure.decode.bound|${contextToTraceString(context)}|${error.message}`
      : `failure.decode.free|${error.message}`;
    return error;
  }
}

export const payloadConverter = new FreePayloadConverter();
export const failureConverter = new FreeFailureConverter();

export class FreePayloadCodec implements PayloadCodec {
  async encode(payloads: Payload[], context?: SerializationContext): Promise<Payload[]> {
    return payloads.map((payload) => tracePayload(payload, 'codec.encode', context));
  }

  async decode(payloads: Payload[], context?: SerializationContext): Promise<Payload[]> {
    return payloads.map((payload) => tracePayload(payload, 'codec.decode', context));
  }
}
