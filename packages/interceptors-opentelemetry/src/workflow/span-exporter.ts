import type * as tracing from '@opentelemetry/sdk-trace-base';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import type { OpenTelemetrySinks, SerializableSpan } from './definitions';
import { ensureWorkflowModuleLoaded, getWorkflowModuleIfAvailable } from './workflow-module-loader';

const exporter = getWorkflowModuleIfAvailable()?.proxySinks<OpenTelemetrySinks>()?.exporter;

export class SpanExporter implements tracing.SpanExporter {
  public constructor() {
    ensureWorkflowModuleLoaded();
  }

  public export(spans: tracing.ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    exporter!.export(spans.map((span) => this.makeSerializable(span)));
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
      droppedAttributesCount: span.droppedAttributesCount,
      droppedEventsCount: span.droppedEventsCount,
      droppedLinksCount: span.droppedLinksCount,
      instrumentationLibrary: span.instrumentationLibrary,
    };
  }
}
