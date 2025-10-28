import * as tracing from '@opentelemetry/sdk-trace-base';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { OpenTelemetrySinks, SerializableSpan } from './definitions';

import type * as WorkflowModule from '@temporalio/workflow';

// @temporalio/workflow is an optional peer dependency.
// It can be missing as long as the user isn't attempting to construct a workflow interceptor.
// If we start shipping ES modules alongside CJS, we will have to reconsider
// this dynamic import as `import` is async for ES modules.
let wf: typeof WorkflowModule | undefined;
let workflowModuleLoadError: any | undefined;
try {
  wf = require('@temporalio/workflow');
} catch (err) {
  // Capture the module not found error to rethrow if an interceptor is constructed
  workflowModuleLoadError = err;
}

const exporter = wf?.proxySinks<OpenTelemetrySinks>()?.exporter;

export class SpanExporter implements tracing.SpanExporter {
  public constructor() {
    if (workflowModuleLoadError) {
      throw workflowModuleLoadError;
    }
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
