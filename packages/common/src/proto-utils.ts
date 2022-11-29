import { fromProto3JSON, toProto3JSON } from 'proto3-json-serializer';
import * as proto from '@temporalio/proto';
import { patchProtobufRoot } from '@temporalio/proto/lib/patch-protobuf-root';

export type History = proto.temporal.api.history.v1.IHistory;
export type Payload = proto.temporal.api.common.v1.IPayload;

// Cast to any because the generated proto module types are missing the lookupType method
const patched = patchProtobufRoot(proto) as any;
const historyType = patched.lookupType('temporal.api.history.v1.History');
const payloadType = patched.lookupType('temporal.api.common.v1.Payload');

function pascalCaseToConstantCase(s: string) {
  return s.replace(/[^\b][A-Z]/g, (m) => `${m[0]}_${m[1]}`).toUpperCase();
}

function fixEnumValue<O extends Record<string, any>>(obj: O, attr: keyof O, prefix: string) {
  return (
    obj[attr] && {
      [attr]: `${prefix}_${pascalCaseToConstantCase(obj[attr])}`,
    }
  );
}

function fixHistoryEvent(e: Record<string, any>) {
  const type = Object.keys(e).find((k) => k.endsWith('EventAttributes'));
  if (!type) {
    throw new TypeError(`Missing attributes in history event: ${JSON.stringify(e)}`);
  }

  return {
    ...e,
    ...fixEnumValue(e, 'eventType', 'EVENT_TYPE'),
    [type]: {
      ...e[type],
      ...(e[type].taskQueue && {
        taskQueue: { ...e[type].taskQueue, ...fixEnumValue(e[type].taskQueue, 'kind', 'TASK_QUEUE_KIND') },
      }),
      ...fixEnumValue(e[type], 'parentClosePolicy', 'PARENT_CLOSE_POLICY'),
      ...fixEnumValue(e[type], 'workflowIdReusePolicy', 'WORKFLOW_ID_REUSE_POLICY'),
      ...fixEnumValue(e[type], 'initiator', 'CONTINUE_AS_NEW_INITIATOR'),
      ...fixEnumValue(e[type], 'retryState', 'RETRY_STATE'),
      ...(e[type].childWorkflowExecutionFailureInfo && {
        childWorkflowExecutionFailureInfo: {
          ...e[type].childWorkflowExecutionFailureInfo,
          ...fixEnumValue(e[type].childWorkflowExecutionFailureInfo, 'retryState', 'RETRY_STATE'),
        },
      }),
    },
  };
}

function fixHistory(h: Record<string, any>) {
  return {
    events: h.events.map(fixHistoryEvent),
  };
}

/**
 * Convert a proto JSON representation of History to a valid History object
 */
export function historyFromJSON(history: unknown): History {
  if (typeof history !== 'object' || history == null || !Array.isArray((history as any).events)) {
    throw new TypeError('Invalid history, expected an object with an array of events');
  }
  const loaded = fromProto3JSON(historyType, fixHistory(history));
  if (loaded === null) {
    throw new TypeError('Invalid history');
  }
  return loaded as any;
}

/**
 * JSON representation of Temporal's {@link Payload} protobuf object
 */
export interface JSONPayload {
  /**
   * Mapping of key to base64 encoded value
   */
  metadata?: Record<string, string> | null;
  /**
   * base64 encoded value
   */
  data?: string | null;
}

/**
 * Convert from protobuf payload to JSON
 */
export function payloadToJSON(payload: Payload): JSONPayload {
  return toProto3JSON(patched.temporal.api.common.v1.Payload.create(payload)) as any;
}

/**
 * Convert from JSON to protobuf payload
 */
export function JSONToPayload(json: JSONPayload): Payload {
  const loaded = fromProto3JSON(payloadType, json as any);
  if (loaded === null) {
    throw new TypeError('Invalid payload');
  }
  return loaded as any;
}
