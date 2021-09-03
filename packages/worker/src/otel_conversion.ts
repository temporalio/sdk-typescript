import { ReadableSpan, TimedEvent } from '@opentelemetry/tracing';
import { HrTime, Link, SpanAttributes, SpanContext, SpanKind, SpanStatus, SpanStatusCode } from '@opentelemetry/api';
import { Resource, ResourceAttributes } from '@opentelemetry/resources';
import { hrTimeDuration } from '@opentelemetry/core';
import { Event, KeyValue, KVValue, Link as CoreLink, SerializedSpan, SystemTime } from '@temporalio/core-bridge/otel';
import {
  AggregatorKind,
  MetricKind,
  MetricRecord,
  Point,
  Sum,
  SumAggregator,
  SumAggregatorType,
} from '@opentelemetry/metrics';
import { opentelemetry } from '@temporalio/proto/lib/coresdk';
import { AggregationTemporality, Labels, ValueType } from '@opentelemetry/api-metrics';
import IMetric = opentelemetry.proto.metrics.v1.IMetric;
import IInstrumentationLibrary = opentelemetry.proto.common.v1.IInstrumentationLibrary;
import ProtoAggregationTemporality = opentelemetry.proto.metrics.v1.AggregationTemporality;
import IStringKeyValue = opentelemetry.proto.common.v1.IStringKeyValue;
import IResource = opentelemetry.proto.resource.v1.IResource;
import IKeyValue = opentelemetry.proto.common.v1.IKeyValue;
import IAnyValue = opentelemetry.proto.common.v1.IAnyValue;
import NumberDataPoint = opentelemetry.proto.metrics.v1.NumberDataPoint;
import Long from "long";
import util from "util";

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

class FixedSumAgg implements SumAggregatorType {
  kind: AggregatorKind.SUM = AggregatorKind.SUM;
  val: number;
  time: HrTime;

  constructor(val: number, time: HrTime) {
    this.val = val;
    this.time = time;
  }

  toPoint(): Point<Sum> {
    return {
      value: this.val,
      timestamp: this.time
    }
  }

  update(_: number): void {}
}

export function convertRustMetric(metric: IMetric, il: IInstrumentationLibrary, rsc: IResource): MetricRecord {
  // TODO: How do I type this part better?
  let record: any = {
    descriptor: {
      description: metric.description || '',
      name: metric.name || '',
      unit: metric.unit || '',
    },
  };

  // AKA attributes, labels deprecated
  // There just seems to be a fundamental incompatibility going this direction, where the protos
  // can have more than one data point, each with it's own set of labels, where a MetricRecord
  // has only one set of labels.
  let labels: Labels = {};

  if (metric.sum != null) {
    if (metric.sum.isMonotonic) {
      record.descriptor.metricKind = MetricKind.SUM_OBSERVER;
    } else {
      record.descriptor.metricKind = MetricKind.UP_DOWN_SUM_OBSERVER;
    }
    record.descriptor.valueType = ValueType.DOUBLE;
    record.aggregationTemporality = protoAgTemporailty(metric.sum.aggregationTemporality);
    const mdp = (metric.sum.dataPoints || []).map((ndp) => new NumberDataPoint(ndp));
    console.log(util.inspect(mdp, false, null, true ))
    const agg = new FixedSumAgg(mdp[0].asInt?.toNumber() || 0, nanoLongToHrTime(mdp[0].timeUnixNano));
    record.aggregator = agg;
  } else if (metric.intSum != null) {
    if (metric.intSum.isMonotonic) {
      record.descriptor.metricKind = MetricKind.SUM_OBSERVER;
    } else {
      record.descriptor.metricKind = MetricKind.UP_DOWN_SUM_OBSERVER;
    }
    record.descriptor.valueType = ValueType.INT;
    record.aggregationTemporality = protoAgTemporailty(metric.intSum.aggregationTemporality);
  } else if (metric.gauge != null) {
    record.descriptor.metricKind = MetricKind.UP_DOWN_COUNTER;
    record.descriptor.valueType = ValueType.DOUBLE;
    record.aggregator.kind = AggregatorKind.LAST_VALUE;
  } else if (metric.intGauge != null) {
    record.descriptor.metricKind = MetricKind.UP_DOWN_COUNTER;
    record.descriptor.valueType = ValueType.INT;
    record.aggregator.kind = AggregatorKind.LAST_VALUE;
  } else if (metric.intHistogram != null) {
    record.descriptor.metricKind = MetricKind.VALUE_OBSERVER;
    record.descriptor.valueType = ValueType.INT;
    record.aggregator.kind = AggregatorKind.HISTOGRAM;
  } else if (metric.histogram != null) {
    record.descriptor.metricKind = MetricKind.VALUE_OBSERVER;
    record.descriptor.valueType = ValueType.DOUBLE;
    record.aggregator.kind = AggregatorKind.HISTOGRAM;
  } else if (metric.summary != null) {
    record.descriptor.metricKind = MetricKind.VALUE_RECORDER;
    record.descriptor.valueType = ValueType.DOUBLE;
    record.aggregator.kind = AggregatorKind.HISTOGRAM;
  }

  return {
    aggregationTemporality: AggregationTemporality.AGGREGATION_TEMPORALITY_UNSPECIFIED,
    instrumentationLibrary: { name: 'temporal-sdk-core-exporter' },
    resource: protoResource(rsc),
    labels: labels,
    ...record,
  };
}

function time(time: SystemTime): HrTime {
  return [time.secs_since_epoch, time.nanos_since_epoch];
}

const NANOSECOND_DIGITS = 9;
const SECOND_TO_NANOSECONDS = Math.pow(10, NANOSECOND_DIGITS);
function nanoLongToHrTime(nanos: Long): HrTime {
  // From upstream:
  // export function hrTimeToNanoseconds(hrTime: api.HrTime): number {
  //   return hrTime[0] * SECOND_TO_NANOSECONDS + hrTime[1];
  // }

  // IE: Hr time first element is the nanoseconds portion of the time, and the second element is
  //   the remaining time in seconds;
  const secondsPortion = nanos.divide(SECOND_TO_NANOSECONDS);
  const nanoPortion = nanos.sub(secondsPortion.mul(SECOND_TO_NANOSECONDS));
  return [secondsPortion.toNumber(), nanoPortion.toNumber()];
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
      if (r != null) {
        Object.assign(this.attributes, r.attributes);
      }
      return this;
    },
  };
}

function protoResource(resource: IResource | null | undefined): Resource {
  return {
    attributes: protoKvArrToResourceAttribs(resource?.attributes || []),
    merge(r: Resource | null): Resource {
      if (r != null) {
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

function protoAgTemporailty(agtemp: ProtoAggregationTemporality | null | undefined): AggregationTemporality {
  if (agtemp === ProtoAggregationTemporality.AGGREGATION_TEMPORALITY_DELTA) {
    return AggregationTemporality.AGGREGATION_TEMPORALITY_DELTA;
  } else if (agtemp === ProtoAggregationTemporality.AGGREGATION_TEMPORALITY_CUMULATIVE) {
    return AggregationTemporality.AGGREGATION_TEMPORALITY_CUMULATIVE;
  }
  return AggregationTemporality.AGGREGATION_TEMPORALITY_UNSPECIFIED;
}

function protoToLabels(labels: IStringKeyValue[]): Labels {
  const retme: { [key: string]: string } = {};
  for (const kv of labels) {
    if (kv.key && kv.value) {
      retme[kv.key] = kv.value;
    }
  }
  return retme;
}

function protoKvArrToResourceAttribs(kvArr: IKeyValue[]): ResourceAttributes {
  const retme: ResourceAttributes = {};
  for (const kv of kvArr) {
    const asval = protoAnyValToNSB(kv.value);
    if (kv.key && asval != null) {
      retme[kv.key] = asval;
    }
  }
  return retme;
}

function protoAnyValToNSB(val: IAnyValue | null | undefined): string | number | boolean | null {
  if (val == null) {
    return null;
  }
  if (val.boolValue != null) {
    return val.boolValue;
  } else if (val.stringValue != null) {
    return val.stringValue;
  } else if (val.intValue != null) {
    return val.intValue.toNumber();
  } else if (val.doubleValue != null) {
    return val.doubleValue;
  }
  // These values can't be handled properly
  return null;
}
