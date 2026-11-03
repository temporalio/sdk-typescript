import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Resource } from '@opentelemetry/resources';
import type { ClientInterceptors, ClientOptions } from '@temporalio/client';
import { type Headers, PayloadConverterError } from '@temporalio/common';
import { encode } from '@temporalio/common/internal/internal-non-workflow';
import { SimplePlugin } from '@temporalio/plugin';
import type { InjectedSinks, ReplayWorkerOptions, WorkerOptions } from '@temporalio/worker';
import type { InterceptorOptions } from './client';
import { OpenTelemetryWorkflowClientInterceptor } from './client';
import {
  makeWorkflowExporter,
  OpenTelemetryActivityInboundInterceptor,
  OpenTelemetryActivityOutboundInterceptor,
  OpenTelemetryNexusInboundInterceptor,
  OpenTelemetryNexusOutboundInterceptor,
} from './worker';
import type { OpenTelemetrySinks } from './workflow';
import { TRACE_HEADER } from './instrumentation';

/**
 * Configuration options for {@link OpenTelemetryPlugin}.
 *
 * @experimental Plugins is an experimental feature; APIs may change without notice.
 */
export interface OpenTelemetryPluginOptions extends InterceptorOptions {
  /**
   * Encode only this plugin's client tracing headers with the client's configured payload codecs.
   * Defaults to false. Register after plugins that configure the data converter.
   * Workflow header processing is controlled independently by WorkerOptions.codecHeaders.
   */
  readonly encodeClientHeaders?: boolean;
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
      workerInterceptors: {
        workflowModules: [workflowInterceptorsPath],
        activity: [
          (ctx) => ({
            inbound: new OpenTelemetryActivityInboundInterceptor(ctx, interceptorOptions),
            outbound: new OpenTelemetryActivityOutboundInterceptor(ctx),
          }),
        ],
        nexus: [
          (ctx) => ({
            inbound: new OpenTelemetryNexusInboundInterceptor(ctx, interceptorOptions),
            outbound: new OpenTelemetryNexusOutboundInterceptor(ctx),
          }),
        ],
      },
    });
  }

  configureClient(options: ClientOptions): ClientOptions {
    const configured = super.configureClient(options);
    return { ...configured, interceptors: this.clientInterceptors(configured, configured.interceptors) };
  }

  configureWorker(options: WorkerOptions): WorkerOptions {
    const configured = super.configureWorker(this.injectSinks(options));
    return {
      ...configured,
      interceptors: {
        ...configured.interceptors,
        client: this.clientInterceptors(configured, configured.interceptors?.client),
      },
    };
  }

  configureReplayWorker(options: ReplayWorkerOptions): ReplayWorkerOptions {
    return super.configureReplayWorker(this.injectSinks(options));
  }

  private clientInterceptors(
    options: Pick<ClientOptions, 'namespace' | 'dataConverter'>,
    existing?: ClientInterceptors
  ): ClientInterceptors {
    const workflow = existing?.workflow;
    if (workflow !== undefined && !Array.isArray(workflow)) {
      throw new Error("Simple plugin doesn't support old style workflow client interceptors");
    }
    const codecs = this.otelOptions.encodeClientHeaders ? options.dataConverter?.payloadCodecs ?? [] : [];
    const namespace = options.namespace ?? 'default';
    const interceptor = new (class extends OpenTelemetryWorkflowClientInterceptor {
      protected async headersWithContext(headers: Headers, workflowId: string): Promise<Headers> {
        const result = await super.headersWithContext(headers, workflowId);
        if (codecs.length === 0) return result;
        const encoded = await encode(codecs, [result[TRACE_HEADER]!], { type: 'workflow', namespace, workflowId });
        if (encoded.length !== 1) {
          throw new PayloadConverterError(
            `Tracing header codec must return exactly one payload, got ${encoded.length}`
          );
        }
        result[TRACE_HEADER] = encoded[0]!;
        return result;
      }
    })({ tracer: this.otelOptions.tracer });
    return { ...existing, workflow: [...(workflow ?? []), interceptor] };
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
