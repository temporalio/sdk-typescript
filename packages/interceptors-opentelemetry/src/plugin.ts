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
export interface OpenTelemetryWorkerPluginOptions extends InterceptorOptions, OpenTelemetryInterceptorOptions {
  /** OpenTelemetry resource attributes to attach to exported spans */
  readonly resource: Resource;
  /** Exporter used to send spans to a tracing backend */
  readonly traceExporter: SpanExporter;
}

/**
 * Toggle options for disabling individual OpenTelemetry interceptors.
 */
interface OpenTelemetryInterceptorOptions {
  /**
   * Whether to register the {@link OpenTelemetryWorkflowClientInterceptor}.
   * @default true
   */
  openTelemetryWorkflowClientInterceptor?: boolean;
  /**
   * Whether to register the {@link OpenTelemetryActivityInboundInterceptor}.
   * @default true
   */
  openTelemetryActivityInboundInterceptor?: boolean;
  /**
   * Whether to register the {@link OpenTelemetryActivityOutboundInterceptor}.
   * @default true
   */
  openTelemetryActivityOutboundInterceptor?: boolean;
  /**
   * Whether to register the {@link OpenTelemetryInboundInterceptor}.
   * @default true
   */
  openTelemetryInboundInterceptor?: boolean;
  /**
   * Whether to register the {@link OpenTelemetryOutboundInterceptor}.
   * @default true
   */
  openTelemetryOutboundInterceptor?: boolean;
  /**
   * Whether to register the {@link OpenTelemetryInternalsInterceptor}.
   * @default true
   */
  openTelemetryInternalsInterceptor?: boolean;
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
    const workflowInterceptorModule = getWorkflowInterceptorModule(otelOptions);
    const workflowInterceptorModules =
      workflowInterceptorModule !== null
        ? [require.resolve(`./workflow-interceptors/${workflowInterceptorModule}`)]
        : [];
    const interceptorOptions = extractInterceptorOptions(otelOptions);
    super({
      name: 'OpenTelemetryWorkerPlugin',
      workflowInterceptorModules,
      workerInterceptors: {
        client: {
          workflow: isInterceptorEnabled(otelOptions.openTelemetryWorkflowClientInterceptor)
            ? [new OpenTelemetryWorkflowClientInterceptor(interceptorOptions)]
            : [],
        },
        workflowModules: workflowInterceptorModules,
        activity: [
          (ctx) => ({
            inbound: isInterceptorEnabled(otelOptions.openTelemetryActivityInboundInterceptor)
              ? new OpenTelemetryActivityInboundInterceptor(ctx, interceptorOptions)
              : undefined,
            outbound: isInterceptorEnabled(otelOptions.openTelemetryActivityOutboundInterceptor)
              ? new OpenTelemetryActivityOutboundInterceptor(ctx)
              : undefined,
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

function isInterceptorEnabled(toggle: boolean | undefined): boolean {
  return toggle !== false;
}

type WorkflowInterceptorModule =
  | 'inbound'
  | 'outbound'
  | 'internals'
  | 'inbound-outbound'
  | 'inbound-internals'
  | 'outbound-internals'
  | 'inbound-outbound-internals';

/**
 * Returns the workflow interceptor module name based on the enabled toggles.
 * Returns `null` if all workflow interceptors are disabled.
 */
function getWorkflowInterceptorModule(toggles: OpenTelemetryInterceptorOptions): WorkflowInterceptorModule | null {
  const inbound = isInterceptorEnabled(toggles.openTelemetryInboundInterceptor);
  const outbound = isInterceptorEnabled(toggles.openTelemetryOutboundInterceptor);
  const internals = isInterceptorEnabled(toggles.openTelemetryInternalsInterceptor);

  if (inbound && outbound && internals) return 'inbound-outbound-internals';
  if (inbound && outbound) return 'inbound-outbound';
  if (inbound && internals) return 'inbound-internals';
  if (outbound && internals) return 'outbound-internals';
  if (inbound) return 'inbound';
  if (outbound) return 'outbound';
  if (internals) return 'internals';
  return null;
}
