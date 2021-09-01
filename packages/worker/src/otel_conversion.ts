import { ReadableSpan, TimedEvent } from '@opentelemetry/tracing';
import { HrTime, Link, SpanAttributes, SpanContext, SpanKind, SpanStatus, SpanStatusCode } from '@opentelemetry/api';
import { Resource, ResourceAttributes } from '@opentelemetry/resources';
import { hrTimeDuration } from '@opentelemetry/core';
import { Event, KeyValue, KVValue, Link as CoreLink, SerializedSpan, SystemTime } from '@temporalio/core-bridge/otel';

export function convertRustSpan(span: SerializedSpan): ReadableSpan {
  const status: SpanStatus = {
    code: statusCode(span.status_code),
    message: span.status_message,
  };
  const startTime = time(span.start_time);
  const endTime = time(span.end_time);
  const duration: HrTime = endTime[1] === 0 ? [0, 0] : hrTimeDuration(startTime, endTime);
  return {
    attributes: attributes(span.attributes),
    duration,
    startTime,
    endTime,
    ended: span.end_time.nanos_since_epoch !== 0,
    events: span.events.queue?.map(event) || [],
    instrumentationLibrary: {
      name: 'temporal-sdk-core-exporter',
    },
    kind: kind(span.span_kind),
    links: span.links.queue?.map(link) || [],
    name: span.name,
    parentSpanId: id(span.parent_span_id),
    resource: resource(span.resource),
    spanContext(): SpanContext {
      return context(span.span_context);
    },
    status,
  };
}

function time(time: SystemTime): HrTime {
  return [time.secs_since_epoch, time.nanos_since_epoch];
}

function id(id: Long | number): string {
  // Hex repr for ids
  return id.toString(16);
}

function statusCode(code: string): SpanStatusCode {
  if (code === 'Ok') {
    return SpanStatusCode.OK;
  } else if (code === 'Error') {
    return SpanStatusCode.ERROR;
  }
  return SpanStatusCode.UNSET;
}

function attributes(attrs: SerializedSpan['attributes']): SpanAttributes {
  return kvMapping(attrs.map) as SpanAttributes;
}

function vecAttributes(attrs: KeyValue[]): SpanAttributes {
  const retme: SpanAttributes = {};
  for (const kv of attrs) {
    retme[kv.key] = kvVal(kv.value);
  }
  return retme;
}

function kind(kind: string): SpanKind {
  if (kind === 'Client') {
    return SpanKind.CLIENT;
  } else if (kind === 'Server') {
    return SpanKind.SERVER;
  } else if (kind === 'Consumer') {
    return SpanKind.CONSUMER;
  } else if (kind === 'Producer') {
    return SpanKind.PRODUCER;
  }
  return SpanKind.INTERNAL;
}

function context(ctx: SerializedSpan['span_context']): SpanContext {
  return {
    spanId: id(ctx.span_id),
    traceFlags: ctx.trace_flags,
    traceId: id(ctx.trace_id),
    isRemote: ctx.is_remote,
  };
}

function resource(resource: SerializedSpan['resource']): Resource {
  return {
    attributes: kvMapping(resource.attrs) as ResourceAttributes,
    merge(r: Resource | null): Resource {
      if (r !== null) {
        Object.assign(this.attributes, r.attributes);
      }
      return this;
    },
  };
}

function kvMapping(mapping: { [key: string]: KVValue }): any {
  const retme: { [key: string]: any } = {};
  Object.keys(mapping).map(function (key, _) {
    retme[key] = kvVal(mapping[key]);
  });
  return retme;
}

function kvVal(val: KVValue): string | number | boolean {
  if (val.I64 !== undefined) {
    return val.I64;
  } else if (val.F64 !== undefined) {
    return val.F64;
  } else if (val.Bool !== undefined) {
    return val.Bool;
  } else if (val.String !== undefined) {
    return val.String;
  } else if (val.Array !== undefined) {
    return JSON.stringify(val.Array);
  }
  return 'unparseable';
}

function event(event: Event): TimedEvent {
  return {
    attributes: vecAttributes(event.attributes),
    name: event.name,
    time: time(event.timestamp),
  };
}

function link(link: CoreLink): Link {
  return {
    attributes: vecAttributes(link.attributes),
    context: context(link.span_context),
  };
}
