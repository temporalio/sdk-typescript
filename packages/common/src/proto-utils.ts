import { fromProto3JSON, toProto3JSON } from 'proto3-json-serializer';
import * as proto from '@temporalio/proto';
import { patchProtobufRoot } from '@temporalio/proto/lib/patch-protobuf-root';

export type History = proto.temporal.api.history.v1.IHistory;
export type Payload = proto.temporal.api.common.v1.IPayload;

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

// Cast to any because the generated proto module types are missing the lookupType method
const patched = patchProtobufRoot(proto) as any;
const historyType = patched.lookupType('temporal.api.history.v1.History');
const payloadType = patched.lookupType('temporal.api.common.v1.Payload');

/**
 * Convert a proto JSON representation of History to a valid History object
 */
export function historyFromJSON(history: unknown): History {
  function pascalCaseToConstantCase(s: string) {
    return s.replace(/[^\b][A-Z]/g, (m) => `${m[0]}_${m[1]}`).toUpperCase();
  }

  function fixEnumValue<O extends Record<string, any>>(obj: O, attr: keyof O, prefix: string) {
    return (
      obj[attr] && {
        [attr]: obj[attr].startsWith(prefix) ? obj[attr] : `${prefix}_${pascalCaseToConstantCase(obj[attr])}`,
      }
    );
  }

  // fromProto3JSON doesn't allow null values on 'bytes' fields. This turns out to be a problem for payloads.
  // Recursively descend on objects and array, and fix in-place any payload that has a null data field
  function fixPayloads<T>(e: T): T {
    function isPayload(p: any): p is JSONPayload {
      return p && typeof p === 'object' && 'metadata' in p && 'data' in p;
    }

    if (e && typeof e === 'object') {
      if (isPayload(e)) {
        if (e.data === null) {
          const { data: _data, ...rest } = e;
          return rest as T;
        }
        return e;
      }
      if (Array.isArray(e)) return e.map(fixPayloads) as T;
      return Object.fromEntries(Object.entries(e as object).map(([k, v]) => [k, fixPayloads(v)])) as T;
    }
    return e;
  }

  function fixHistoryEvent(e: Record<string, any>) {
    const type = Object.keys(e).find((k) => k.endsWith('EventAttributes'));
    if (!type) {
      throw new TypeError(`Missing attributes in history event: ${JSON.stringify(e)}`);
    }

    // Fix payloads with null data
    e = fixPayloads(e);

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
 * Convert an History object, e.g. as returned by `WorkflowClient.list().withHistory()`, to a JSON
 * string that adheres to the same norm as JSON history files produced by other Temporal tools.
 */
export function historyToJSON(history: History): string {
  const protoJson = toProto3JSON(proto.temporal.api.history.v1.History.fromObject(history) as any);
  return JSON.stringify(fixBuffers(protoJson), null, 2);
}

/**
 * toProto3JSON doesn't correctly handle some of our "bytes" fields, passing them untouched to the
 * output, after which JSON.stringify() would convert them to an array of numbers. As a workaround,
 * recursively walk the object and convert all Buffer instances to base64 strings. Note this only
 * works on proto3-json-serializer v2.0.0. v2.0.2 throws an error before we even get the chance
 * to fix the buffers. See https://github.com/googleapis/proto3-json-serializer-nodejs/issues/103.
 */
export function fixBuffers<T>(e: T): T {
  if (e && typeof e === 'object') {
    if (e instanceof Buffer) return e.toString('base64') as any;
    if (e instanceof Uint8Array) return Buffer.from(e).toString('base64') as any;
    if (Array.isArray(e)) return e.map(fixBuffers) as T;
    return Object.fromEntries(Object.entries(e as object).map(([k, v]) => [k, fixBuffers(v)])) as T;
  }
  return e;
}

/**
 * Convert from protobuf payload to JSON
 */
export function payloadToJSON(payload: Payload): JSONPayload {
  return fixBuffers(toProto3JSON(patched.temporal.api.common.v1.Payload.create(payload))) as any;
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
