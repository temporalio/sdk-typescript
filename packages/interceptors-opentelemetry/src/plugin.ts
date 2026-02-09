import { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Resource } from '@opentelemetry/resources';
import { SimplePlugin } from '@temporalio/plugin';
import { InjectedSinks, ReplayWorkerOptions, WorkerOptions } from '@temporalio/worker';
import { InterceptorOptions, OpenTelemetryWorkflowClientInterceptor } from './client';
import {
  makeWorkflowExporter,
  OpenTelemetryActivityInboundInterceptor,
  OpenTelemetryActivityOutboundInterceptor,
} from './worker';
import { OpenTelemetrySinks } from './workflow';

/**
 * Configuration options for {@link OpenTelemetryPlugin}.
 *
 * @experimental Plugins is an experimental feature; APIs may change without notice.
 */
export interface OpenTelemetryPluginOptions extends InterceptorOptions {
  /** OpenTelemetry resource attributes to attach to exported spans */
  readonly resource: Resource;
  /** Exporter used to send spans to a tracing backend */
  readonly spanProcessor: SpanProcessor;
}

/**
 * A plugin that adds OpenTelemetry tracing.
 *
 * Configures Client, Activity, and Workflow interceptors for trace propagation and injects
 * a span exporter sink for Workflow spans.
 *
 * @experimental Plugins is an experimental feature; APIs may change without notice.
 */
export class OpenTelemetryPlugin extends SimplePlugin {
  constructor(readonly otelOptions: OpenTelemetryPluginOptions) {
    const workflowInterceptorsPath = require.resolve('./workflow-interceptors');
    const interceptorOptions = otelOptions.tracer ? { tracer: otelOptions.tracer } : {};
    super({
      name: 'OpenTelemetryPlugin',
      clientInterceptors: {
        workflow: [new OpenTelemetryWorkflowClientInterceptor(interceptorOptions)],
      },
      workerInterceptors: {
        client: {
          workflow: [new OpenTelemetryWorkflowClientInterceptor(interceptorOptions)],
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
      exporter: makeWorkflowExporter(this.otelOptions.spanProcessor, this.otelOptions.resource),
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
