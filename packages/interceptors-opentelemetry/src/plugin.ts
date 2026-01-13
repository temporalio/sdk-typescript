import { SpanExporter } from '@opentelemetry/sdk-trace-base';
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

export type OpenTelemetryClientPluginOptions = InterceptorOptions;

/**
 * A client-side plugin that adds OpenTelemetry tracing to Workflow Client operations.
 *
 * Wraps client operations (start, signal, query, etc.) in OpenTelemetry spans and propagates
 * trace context to Workflows via headers.
 *
 * @experimental Plugins is an experimental feature; APIs may change without notice.
 */
export class OpenTelemetryClientPlugin extends SimplePlugin {
  constructor(readonly otelOptions?: OpenTelemetryClientPluginOptions) {
    super({
      name: 'OpenTelemetryClientPlugin',
      clientInterceptors: {
        workflow: [new OpenTelemetryWorkflowClientInterceptor(extractInterceptorOptions(otelOptions))],
      },
    });
  }
}

/**
 * Configuration options for {@link OpenTelemetryWorkerPlugin}.
 *
 * @experimental Plugins is an experimental feature; APIs may change without notice.
 */
export interface OpenTelemetryWorkerPluginOptions extends InterceptorOptions {
  /** OpenTelemetry resource attributes to attach to exported spans */
  readonly resource: Resource;
  /** Exporter used to send spans to a tracing backend */
  readonly traceExporter: SpanExporter;
}

/**
 * A worker-side plugin that adds OpenTelemetry tracing to Worker operations.
 *
 * Configures Activity and Workflow interceptors for trace propagation, and injects
 * a span exporter sink for Workflow spans. Handles both regular Workers and Replay Workers.
 *
 * @experimental Plugins is an experimental feature; APIs may change without notice.
 */
export class OpenTelemetryWorkerPlugin extends SimplePlugin {
  constructor(readonly otelOptions: OpenTelemetryWorkerPluginOptions) {
    const workflowInterceptorsPath = require.resolve('./workflow-interceptors');
    const interceptorOptions = extractInterceptorOptions(otelOptions);
    super({
      name: 'OpenTelemetryWorkerPlugin',
      workflowInterceptorModules: [workflowInterceptorsPath],
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
