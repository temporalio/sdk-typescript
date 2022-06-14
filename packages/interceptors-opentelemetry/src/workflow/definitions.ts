import * as otel from '@opentelemetry/api';
import * as tracing from '@opentelemetry/sdk-trace-base';
import { InstrumentationLibrary } from '@opentelemetry/core'; // eslint-disable deprecation/deprecation
import { Sink, Sinks } from '@temporalio/workflow';

/**
 * Serializable version of the opentelemetry Span for cross isolate copying
 */
export interface SerializableSpan {
  readonly name: string;
  readonly kind: otel.SpanKind;
  readonly spanContext: otel.SpanContext;
  readonly parentSpanId?: string;
  readonly startTime: otel.HrTime;
  readonly endTime: otel.HrTime;
  readonly status: otel.SpanStatus;
  readonly attributes: otel.SpanAttributes;
  readonly links: otel.Link[];
  readonly events: tracing.TimedEvent[];
  readonly duration: otel.HrTime;
  readonly ended: boolean;
  // readonly resource: Resource;
  readonly instrumentationLibrary: InstrumentationLibrary;
}

export interface OpenTelemetryWorkflowExporter extends Sink {
  export(span: SerializableSpan[]): void;
}

/**
 * Required external dependencies for Workflow interceptor to export spans
 */
export interface OpenTelemetrySinks extends Sinks {
  exporter: OpenTelemetryWorkflowExporter;
}

export enum SpanName {
  /**
   * Workflow is scheduled by a client
   */
  WORKFLOW_START = 'StartWorkflow',

  /**
   * Workflow is client calls signalWithStart
   */
  WORKFLOW_SIGNAL_WITH_START = 'SignalWithStartWorkflow',

  /**
   * Workflow run is executing
   */
  WORKFLOW_EXECUTE = 'RunWorkflow',
  /**
   * Child Workflow is started (by parent Workflow)
   */
  CHILD_WORKFLOW_START = 'StartChildWorkflow',
  /**
   * Activity is scheduled by a Workflow
   */
  ACTIVITY_START = 'StartActivity',
  /**
   * Activity is executing
   */
  ACTIVITY_EXECUTE = 'RunActivity',
  /**
   * Workflow is continuing as new
   */
  CONTINUE_AS_NEW = 'ContinueAsNew',
}

export const SPAN_DELIMITER = ':';
