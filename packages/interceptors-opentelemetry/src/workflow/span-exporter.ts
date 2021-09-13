import * as tracing from '@opentelemetry/tracing';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import * as wf from '@temporalio/workflow';
import { OpenTelemetryDependencies, SerializableSpan } from './interfaces';

const { exporter } = wf.dependencies<OpenTelemetryDependencies>();

export class SpanExporter implements tracing.SpanExporter {
  public export(spans: tracing.ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    exporter.export(spans.map((span) => this.makeSerializable(span)));
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  public async shutdown(): Promise<void> {
    // Nothing to shut down
  }

  public makeSerializable(span: tracing.ReadableSpan): SerializableSpan {
    return {
      name: span.name,
      kind: span.kind,
      spanContext: span.spanContext(),
      parentSpanId: span.parentSpanId,
      startTime: span.startTime,
      endTime: span.endTime,
      status: span.status,
      attributes: span.attributes,
      links: span.links,
      events: span.events,
      duration: span.duration,
      ended: span.ended,
      instrumentationLibrary: span.instrumentationLibrary,
    };
  }
}
