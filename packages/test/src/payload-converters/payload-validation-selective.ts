import type { Payload, PayloadConverter, SerializationContext } from '@temporalio/common';
import { createPayloadValidationError, defaultPayloadConverter } from '@temporalio/common';

const failedEncodes = new Set<string>();

function isFirstWorkflowTask(): boolean {
  const activator = (globalThis as any).__TEMPORAL_ACTIVATOR__;
  return activator?.info?.historyLength <= 5;
}

export const payloadConverter: PayloadConverter = {
  toPayload(value: any, context?: SerializationContext): Payload {
    if (value?.__payloadValidation === 'encode-always') {
      throw createPayloadValidationError(value.details);
    }
    if (value?.__payloadValidation === 'encode-once' && !failedEncodes.has(value.id)) {
      failedEncodes.add(value.id);
      throw createPayloadValidationError({ field: value.id });
    }
    const workflowTaskOnceId =
      value?.__payloadValidation === 'workflow-task-once'
        ? value.id
        : typeof value === 'string' && value.startsWith('workflow-task-once:')
          ? value.slice('workflow-task-once:'.length)
          : undefined;
    if (workflowTaskOnceId !== undefined && isFirstWorkflowTask()) {
      throw createPayloadValidationError({ field: workflowTaskOnceId });
    }
    return defaultPayloadConverter.toPayload(value, context);
  },
  fromPayload<T>(payload: Payload, context?: SerializationContext): T {
    const value = defaultPayloadConverter.fromPayload<any>(payload, context);
    if (value?.__payloadValidation === 'decode') {
      throw createPayloadValidationError({ field: value.id });
    }
    return value;
  },
};
