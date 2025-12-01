import { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { Resource } from '@opentelemetry/resources';
import { SimplePlugin } from '@temporalio/plugin';
import { InjectedSinks, WorkerOptions } from '@temporalio/worker';
import { OpenTelemetryWorkflowClientInterceptor } from './client';
import {
  makeWorkflowExporter,
  OpenTelemetryActivityInboundInterceptor,
  OpenTelemetryActivityOutboundInterceptor,
} from './worker';
import { OpenTelemetrySinks } from './workflow';

export interface OpenTelemetryPluginOptions {
  readonly resource: Resource;
  readonly traceExporter: SpanExporter;
}

export class OpenTelemetryPlugin extends SimplePlugin {
  constructor(readonly otelOptions: OpenTelemetryPluginOptions) {
    super({
      name: 'OpenTelemetryPlugin',
      clientInterceptors: {
        workflow: [new OpenTelemetryWorkflowClientInterceptor()],
      },
      workerInterceptors: {
        workflowModules: [require.resolve('./workflow-interceptors')],
        activity: [
          (ctx) => ({
            inbound: new OpenTelemetryActivityInboundInterceptor(ctx),
            outbound: new OpenTelemetryActivityOutboundInterceptor(ctx),
          }),
        ],
      },
    });
  }

  configureWorker(options: WorkerOptions): WorkerOptions {
    const sinks: InjectedSinks<OpenTelemetrySinks> = {
      exporter: makeWorkflowExporter(this.otelOptions.traceExporter, this.otelOptions.resource),
    };
    options.sinks = {
      ...options.sinks,
      ...sinks,
    };
    return super.configureWorker(options);
  }
}

