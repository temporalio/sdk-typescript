import * as otel from '@opentelemetry/api';
import * as tracing from '@opentelemetry/sdk-trace-base';
import { InstrumentationLibrary } from '@opentelemetry/core';
import { ExternalDependency, ExternalDependencies } from '@temporalio/workflow';

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

export interface OpenTelemetryWorkflowExporter extends ExternalDependency {
  export(span: SerializableSpan[]): void;
}

/**
 * Required external dependencies for Workflow interceptor to export spans
 */
export interface OpenTelemetryDependencies extends ExternalDependencies {
  exporter: OpenTelemetryWorkflowExporter;
}

export enum SpanName {
  /**
   * Workflow is scheduled by a client
   */
  WORKFLOW_SCHEDULE = 'workflow.schedule',
  /**
   * Workflow run is executing
   */
  WORKFLOW_EXECUTE = 'workflow.execute',
  /**
   * Activity is scheduled by a Workflow
   */
  ACTIVITY_SCHEUDLE = 'activity.schedule',
  /**
   * Activity is executing
   */
  ACTIVITY_EXECUTE = 'activity.execute',
}
