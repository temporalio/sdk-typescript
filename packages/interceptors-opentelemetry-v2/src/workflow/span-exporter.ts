import * as tracing from '@opentelemetry/sdk-trace-base';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { OpenTelemetrySinks, SerializableSpan, SerializableSpanContext } from './definitions';
import { proxySinks } from './workflow-imports';

export class SpanExporter implements tracing.SpanExporter {
  private exporter?: OpenTelemetrySinks['exporter'];

  public export(spans: tracing.ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (!this.exporter) {
      this.exporter = proxySinks<OpenTelemetrySinks>().exporter;
    }
    this.exporter.export(spans.map((span) => this.makeSerializable(span)));
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  public async shutdown(): Promise<void> {
    // Nothing to shut down
  }

  public makeSerializable(span: tracing.ReadableSpan): SerializableSpan {
    const { traceState, ...restSpanContext } = span.spanContext();
    // Serialize traceState to a string because TraceState objects lose their
    // prototype methods when crossing the V8 isolate boundary.
    // See: https://github.com/temporalio/sdk-typescript/issues/1738
    const serializableSpanContext: SerializableSpanContext = {
      traceState: traceState?.serialize(),
      ...restSpanContext,
    };

    let serializableParentSpanContext: SerializableSpanContext | undefined;
    if (span.parentSpanContext) {
      const { traceState: parentTraceState, ...restParentSpanContext } = span.parentSpanContext;
      serializableParentSpanContext = {
        traceState: parentTraceState?.serialize(),
        ...restParentSpanContext,
      };
    }

    return {
      name: span.name,
      kind: span.kind,
      spanContext: serializableSpanContext,
      parentSpanContext: serializableParentSpanContext,
      startTime: span.startTime,
      endTime: span.endTime,
      status: span.status,
      attributes: span.attributes,
      links: span.links,
      events: span.events,
      duration: span.duration,
      ended: span.ended,
      droppedAttributesCount: span.droppedAttributesCount,
      droppedEventsCount: span.droppedEventsCount,
      droppedLinksCount: span.droppedLinksCount,
      instrumentationScope: span.instrumentationScope,
    };
  }
}
