import * as otel from '@opentelemetry/api';
import { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { Resource } from '@opentelemetry/resources';
import { SimpleClientPlugin, SimpleWorkerPlugin } from '@temporalio/plugin';
import { InjectedSinks, ReplayWorkerOptions, WorkerOptions } from '@temporalio/worker';
import { InterceptorOptions, OpenTelemetryWorkflowClientInterceptor } from './client';
import {
  makeWorkflowExporter,
  OpenTelemetryActivityInboundInterceptor,
  OpenTelemetryActivityOutboundInterceptor,
} from './worker';
import { OpenTelemetrySinks } from './workflow';
import { OpenTelemetryWorkflowClientCallsInterceptor } from '.';

export interface OpenTelemetryClientPluginOptions extends InterceptorOptions {}

export class OpenTelemetryClientPlugin extends SimpleClientPlugin {
  constructor(readonly otelOptions?: OpenTelemetryClientPluginOptions) {
    super({
      name: 'OpenTelemetryClientPlugin',
      clientInterceptors: {
        workflow: [new OpenTelemetryWorkflowClientInterceptor(extractInterceptorOptions(otelOptions))],
      },
    });
  }
}

export interface OpenTelemetryWorkerPluginOptions extends InterceptorOptions {
  readonly resource: Resource;
  readonly traceExporter: SpanExporter;
}

export class OpenTelemetryWorkerPlugin extends SimpleWorkerPlugin {
  constructor(readonly otelOptions: OpenTelemetryWorkerPluginOptions) {
    const workflowInterceptorsPath = require.resolve('./workflow-interceptors');
    const interceptorOptions = extractInterceptorOptions(otelOptions);
    super({
      name: 'OpenTelemetryWorkerPlugin',
      workflowInterceptorModules: [workflowInterceptorsPath],
      workerInterceptors: {
        client: {
          workflow: [new OpenTelemetryWorkflowClientCallsInterceptor(interceptorOptions)],
        },
        workflowModules: [workflowInterceptorsPath],
        activity: [
          (ctx) => ({
            inbound: new OpenTelemetryActivityInboundInterceptor(ctx, interceptorOptions),
            outbound: new OpenTelemetryActivityOutboundInterceptor(ctx),
          }),
        ],
      },
    });
  }

  configureWorker(options: WorkerOptions): WorkerOptions {
    return super.configureWorker(this.injectSinks(options));
  }

  configureReplayWorker(options: ReplayWorkerOptions): ReplayWorkerOptions {
    return super.configureReplayWorker(this.injectSinks(options));
  }

  private injectSinks<T extends { sinks?: InjectedSinks<any> }>(options: T): T {
    const sinks: InjectedSinks<OpenTelemetrySinks> = {
      exporter: makeWorkflowExporter(this.otelOptions.traceExporter, this.otelOptions.resource),
    };
    return {
      ...options,
      sinks: {
        ...options.sinks,
        ...sinks,
      },
    };
  }
}

function extractInterceptorOptions(
  options?: OpenTelemetryWorkerPluginOptions | OpenTelemetryClientPluginOptions
): InterceptorOptions {
  return options?.tracer ? { tracer: options.tracer } : {};
}
