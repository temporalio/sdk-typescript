import {
  Payload,
  PayloadConverter,
  FailureConverter,
  ProtoFailure,
  defaultPayloadConverter,
  defaultFailureConverter,
  SerializationContext,
} from '@temporalio/common';

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

export function withLabel<T>(existing: ContextTrace<unknown>, label: T): ContextTrace<T> {
  return { label, trace: existing.trace };
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
  withContext(context: SerializationContext): PayloadConverter {
    return new BoundPayloadConverter(context);
  }

  toPayload<T>(value: T): Payload {
    if (isContextTrace(value)) {
      value.trace.push(`payload.encode.free|${value.label}`);
    }
    return defaultPayloadConverter.toPayload(value);
  }

  fromPayload<T>(payload: Payload): T {
    const value = defaultPayloadConverter.fromPayload(payload);
    if (isContextTrace(value)) {
      value.trace.push(`payload.decode.free|${value.label}`);
    }
    return value as T;
  }
}

class BoundPayloadConverter implements PayloadConverter {
  constructor(private readonly context: SerializationContext) {}

  toPayload<T>(value: T): Payload {
    if (isContextTrace(value)) {
      value.trace.push(`payload.encode.bound|${value.label}|${ctxToTraceStr(this.context)}`);
    }
    return defaultPayloadConverter.toPayload(value);
  }

  fromPayload<T>(payload: Payload): T {
    const value = defaultPayloadConverter.fromPayload(payload);
    if (isContextTrace(value)) {
      value.trace.push(`payload.decode.bound|${value.label}|${ctxToTraceStr(this.context)}`);
    }
    return value as T;
  }
}

export class FreeFailureConverter implements FailureConverter {
  errorToFailure(err: unknown, payloadConverter: PayloadConverter): ProtoFailure {
    const failure = defaultFailureConverter.errorToFailure(err, payloadConverter);
    const existing = failure.message ?? '';
    failure.message = `failure.encode.free|${existing}`;
    return failure;
  }
  failureToError(err: ProtoFailure, payloadConverter: PayloadConverter): Error {
    const error = defaultFailureConverter.failureToError(err, payloadConverter);
    error.message = `failure.decode.free|${error.message}`;
    return error;
  }
  withContext?(context: SerializationContext): FailureConverter {
    return new BoundFailureConverter(context);
  }
}

class BoundFailureConverter implements FailureConverter {
  constructor(private readonly context: SerializationContext) {}
  errorToFailure(err: unknown, payloadConverter: PayloadConverter): ProtoFailure {
    const failure = defaultFailureConverter.errorToFailure(err, payloadConverter);
    const existing = failure.message ?? '';
    failure.message = `failure.encode.bound|${ctxToTraceStr(this.context)}|${existing}`;
    return failure;
  }
  failureToError(err: ProtoFailure, payloadConverter: PayloadConverter): Error {
    const error = defaultFailureConverter.failureToError(err, payloadConverter);
    error.message = `failure.decode.bound|${ctxToTraceStr(this.context)}|${error.message}`;
    return error;
  }
}

export const payloadConverter = new FreePayloadConverter();
export const failureConverter = new FreeFailureConverter();
