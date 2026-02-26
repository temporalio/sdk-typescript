import {
  ActivitySerializationContext,
  DefaultFailureConverter,
  FailureConverter,
  Payload,
  PayloadConverter,
  ProtoFailure,
  SerializationContext,
  WorkflowSerializationContext,
  defaultPayloadConverter,
} from '@temporalio/common';

export interface Tracer {
  __tracer: string;
  trace: string[];
}

export function makeTracer(name: string): Tracer {
  return { __tracer: name, trace: [] };
}

export function isTracer(value: unknown): value is Tracer {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__tracer' in value &&
    typeof (value as any).__tracer === 'string' &&
    Array.isArray((value as any).trace)
  );
}

export function workflowContextTag(context: WorkflowSerializationContext): string {
  return `workflow:${context.namespace}:${context.workflowId}`;
}

export function activityContextTag(context: ActivitySerializationContext): string {
  return `activity:${context.namespace}:${context.workflowId ?? 'none'}:${context.activityId ?? 'none'}:${
    context.isLocal
  }`;
}

function contextTag(context: SerializationContext | undefined): string {
  if (context == null) {
    return 'none';
  }
  if ('isLocal' in context) {
    return activityContextTag(context);
  }
  return workflowContextTag(context);
}

function appendTraceStep(value: unknown, step: string): unknown {
  if (!isTracer(value)) {
    return value;
  }
  return {
    __tracer: value.__tracer,
    trace: [...value.trace, step],
  } satisfies Tracer;
}

class ContextAwarePayloadConverter implements PayloadConverter {
  constructor(private readonly context?: SerializationContext) {}

  toPayload(value: unknown): Payload {
    return defaultPayloadConverter.toPayload(appendTraceStep(value, `to:${contextTag(this.context)}`));
  }

  fromPayload<T>(payload: Payload): T {
    const decoded = defaultPayloadConverter.fromPayload(payload);
    return appendTraceStep(decoded, `from:${contextTag(this.context)}`) as T;
  }

  withContext(context: SerializationContext): PayloadConverter {
    if (this.context === context) {
      return this;
    }
    return new ContextAwarePayloadConverter(context);
  }
}

const defaultFailureConverter = new DefaultFailureConverter();

class ContextAwareFailureConverter implements FailureConverter {
  constructor(private readonly context?: SerializationContext) {}

  errorToFailure(err: unknown, payloadConverter: PayloadConverter): ProtoFailure {
    const failure = defaultFailureConverter.errorToFailure(err, payloadConverter);
    return { ...failure, message: `${failure.message ?? ''}|errorToFailure:${contextTag(this.context)}` };
  }

  failureToError(failure: ProtoFailure, payloadConverter: PayloadConverter): Error {
    const err = defaultFailureConverter.failureToError(failure, payloadConverter);
    err.message = `${err.message}|failureToError:${contextTag(this.context)}`;
    return err;
  }

  withContext(context: SerializationContext): FailureConverter {
    if (this.context === context) {
      return this;
    }
    return new ContextAwareFailureConverter(context);
  }
}

export const payloadConverter: PayloadConverter = new ContextAwarePayloadConverter();
export const failureConverter: FailureConverter = new ContextAwareFailureConverter();
