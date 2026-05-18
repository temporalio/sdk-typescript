import type {
  Payload,
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

function ctxToTraceStr(context: SerializationContext): string {
  const parts = [context.type, context.namespace];

  if (context.workflowId) parts.push(context.workflowId);

  if (context.type === 'activity') {
    if (context.activityId) parts.push(context.activityId);
    parts.push(String(context.isLocal));
  }

  return parts.join('.');
}

export class FreePayloadConverter implements PayloadConverter {
  toPayload<T>(value: T, context?: SerializationContext): Payload {
    if (isContextTrace(value)) {
      value.trace.push(
        context ? `payload.encode.bound|${value.label}|${ctxToTraceStr(context)}` : `payload.encode.free|${value.label}`
      );
    }
    return defaultPayloadConverter.toPayload(value, context);
  }

  fromPayload<T>(payload: Payload, context?: SerializationContext): T {
    const value = defaultPayloadConverter.fromPayload(payload, context);
    if (isContextTrace(value)) {
      value.trace.push(
        context ? `payload.decode.bound|${value.label}|${ctxToTraceStr(context)}` : `payload.decode.free|${value.label}`
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
      ? `failure.encode.bound|${ctxToTraceStr(context)}|${existing}`
      : `failure.encode.free|${existing}`;
    return failure;
  }
  failureToError(err: ProtoFailure, payloadConverter: PayloadConverter, context?: SerializationContext): Error {
    const error = defaultFailureConverter.failureToError(err, payloadConverter, context);
    error.message = context
      ? `failure.decode.bound|${ctxToTraceStr(context)}|${error.message}`
      : `failure.decode.free|${error.message}`;
    return error;
  }
}

export const payloadConverter = new FreePayloadConverter();
export const failureConverter = new FreeFailureConverter();
