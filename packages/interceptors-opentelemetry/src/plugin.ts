import { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { Resource } from '@opentelemetry/resources';
import { SimplePlugin, SimpleClientPlugin, SimpleWorkerPlugin } from '@temporalio/plugin';
import { InjectedSinks, WorkerOptions } from '@temporalio/worker';
import { OpenTelemetryWorkflowClientInterceptor } from './client';
import {
  makeWorkflowExporter,
  OpenTelemetryActivityInboundInterceptor,
  OpenTelemetryActivityOutboundInterceptor,
} from './worker';
import { OpenTelemetrySinks } from './workflow';
import { OpenTelemetryWorkflowClientCallsInterceptor } from '.';

export interface OpenTelemetryWorkerPluginOptions {
  readonly resource: Resource;
  readonly traceExporter: SpanExporter;
}

export class OpenTelemetryClientPlugin extends SimpleClientPlugin {
  constructor() {
    super({
      name: 'OpenTelemetryClientPlugin',
      clientInterceptors: {
        workflow: [new OpenTelemetryWorkflowClientInterceptor()],
      },
    });
  }
}

export class OpenTelemetryWorkerPlugin extends SimpleWorkerPlugin {
  constructor(readonly otelOptions: OpenTelemetryWorkerPluginOptions) {
    super({
      name: 'OpenTelemetryClientPlugin',
      workerInterceptors: {
        client: {
          workflow: [new OpenTelemetryWorkflowClientCallsInterceptor()],
        },
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
