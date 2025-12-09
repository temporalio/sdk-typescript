import * as otel from '@opentelemetry/api';
import * as tracing from '@opentelemetry/sdk-trace-base';
import { InstrumentationScope } from '@opentelemetry/core';
import { Sink, Sinks } from '@temporalio/workflow';

/**
 * Serializable version of the opentelemetry Span for cross isolate copying
 */
export interface SerializableSpan {
  readonly name: string;
  readonly kind: otel.SpanKind;
  readonly spanContext: otel.SpanContext;
  readonly parentSpanContext?: otel.SpanContext;
  readonly startTime: otel.HrTime;
  readonly endTime: otel.HrTime;
  readonly status: otel.SpanStatus;
  readonly attributes: otel.Attributes;
  readonly links: otel.Link[];
  readonly events: tracing.TimedEvent[];
  readonly duration: otel.HrTime;
  readonly ended: boolean;
  readonly droppedAttributesCount: number;
  readonly droppedLinksCount: number;
  readonly droppedEventsCount: number;
  // readonly resource: Resource;
  // eslint-disable-next-line deprecation/deprecation
  readonly instrumentationScope: InstrumentationScope;
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
   * Workflow is signalled
   */
  WORKFLOW_SIGNAL = 'SignalWorkflow',

  /**
   * Workflow is client calls signalWithStart
   */
  WORKFLOW_SIGNAL_WITH_START = 'SignalWithStartWorkflow',

  /**
   * Workflow is queried
   */
  WORKFLOW_QUERY = 'QueryWorkflow',

  /**
   * Workflow update is started by client
   */
  WORKFLOW_START_UPDATE = 'StartWorkflowUpdate',

  /**
   * Workflow is started with an update
   */
  WORKFLOW_UPDATE_WITH_START = 'UpdateWithStartWorkflow',

  /**
   * Workflow handles an incoming signal
   */
  WORKFLOW_HANDLE_SIGNAL = 'HandleSignal',

  /**
   * Workflow handles an incoming query
   */
  WORKFLOW_HANDLE_QUERY = 'HandleQuery',

  /**
   * Workflow handles an incoming update
   */
  WORKFLOW_HANDLE_UPDATE = 'HandleUpdate',

  /**
   * Workflow validates an incoming update
   */
  WORKFLOW_VALIDATE_UPDATE = 'ValidateUpdate',

  /**
   * Workflow is terminated
   */
  WORKFLOW_TERMINATE = 'TerminateWorkflow',

  /**
   * Workflow is cancelled
   */
  WORKFLOW_CANCEL = 'CancelWorkflow',

  /**
   * Workflow is described
   */
  WORKFLOW_DESCRIBE = 'DescribeWorkflow',

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
  /**
   * Nexus operation is started
   */
  NEXUS_OPERATION_START = 'StartNexusOperation',
}

export const SPAN_DELIMITER = ':';
