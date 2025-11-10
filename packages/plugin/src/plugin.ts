import type * as nexus from 'nexus-rpc';
import type { DataConverter } from '@temporalio/common';
import type {
  ClientInterceptors,
  ClientOptions,
  ClientPlugin,
  ConnectionPlugin,
  ConnectionOptions,
  WorkflowClientInterceptors,
  WorkflowClientInterceptor,
} from '@temporalio/client';
import type {
  BundlerPlugin,
  NativeConnectionPlugin,
  WorkerInterceptors,
  WorkerPlugin,
  WorkflowBundleOption,
  WorkerOptions,
  ReplayWorkerOptions,
  Worker,
  BundleOptions,
  NativeConnectionOptions,
  TLSConfig,
} from '@temporalio/worker';

/**
 * A parameter that can be either a direct value or a function that transforms an existing value.
 * @template T The type of the parameter
 *
 * @experimental Plugins is an experimental feature; APIs may change without notice.
 */
type PluginParameter<T> = T | ((p: T | undefined) => T);

/**
 * Configuration options for SimplePlugin.
 * Each option can be either a direct value or a function that transforms existing configuration.
 *
 * @experimental Plugins is an experimental feature; APIs may change without notice.
 */
export interface SimplePluginOptions {
  /** The name of the plugin */
  readonly name: string;
  /** TLS configuration for connections */
  readonly tls?: PluginParameter<TLSConfig | boolean | null>;
  /** API key for authentication */
  readonly apiKey?: PluginParameter<string>;
  /** Data converter for serialization/deserialization. When a value is provided, existing fields will override
   * those in the existing data converter. */
  readonly dataConverter?: PluginParameter<DataConverter>;
  /** Client-side interceptors. When a value is provided, interceptors will be appended */
  readonly clientInterceptors?: PluginParameter<ClientInterceptors>;
  /** Activities to register with the worker. When a value is provided, activities will be appended */
  readonly activities?: PluginParameter<object>;
  /** Nexus service handlers. When a value is provided, services will be appended */
  readonly nexusServices?: PluginParameter<nexus.ServiceHandler<any>[]>;
  /** Path to workflow files */
  readonly workflowsPath?: PluginParameter<string>;
  /** Workflow bundle configuration */
  readonly workflowBundle?: PluginParameter<WorkflowBundleOption>;
  /** Worker-side interceptors. When a value is provided, interceptors will be appended  */
  readonly workerInterceptors?: PluginParameter<WorkerInterceptors>;
  /** Context function to wrap worker execution */
  readonly runContext?: (next: () => Promise<void>) => Promise<void>;
}

/**
 * A unified plugin that implements multiple Temporal plugin interfaces.
 * Provides a simple way to configure clients, workers, bundlers, and connections
 * with consistent parameter resolution and merging strategies.
 *
 * @experimental Plugins is an experimental feature; APIs may change without notice.
 */
export class SimplePlugin
  implements WorkerPlugin, ClientPlugin, BundlerPlugin, ConnectionPlugin, NativeConnectionPlugin
{
  /** The name of the plugin */
  readonly name: string;

  /**
   * Creates a new SimplePlugin instance.
   * @param options Configuration options for the plugin
   */
  constructor(protected readonly options: SimplePluginOptions) {
    this.name = options.name;
  }

  /**
   * Configures client options by merging plugin parameters with existing options.
   * @param options The existing client options
   * @returns Modified client options with plugin configuration applied
   */
  configureClient(options: ClientOptions): ClientOptions {
    return {
      ...options,
      dataConverter: resolveDataConverter(options.dataConverter, this.options.dataConverter),
      interceptors: resolveClientInterceptors(options.interceptors, this.options.clientInterceptors),
    };
  }

  /**
   * Configures worker options by merging plugin parameters with existing options.
   * Activities and nexus services are appended, while other options are replaced.
   * @param options The existing worker options
   * @returns Modified worker options with plugin configuration applied
   */
  configureWorker(options: WorkerOptions): WorkerOptions {
    return {
      ...options,
      dataConverter: resolveDataConverter(options.dataConverter, this.options.dataConverter),
      activities: resolveAppendObjectParameter(options.activities, this.options.activities),
      nexusServices: resolveAppendParameter(options.nexusServices, this.options.nexusServices),
      workflowsPath: resolveParameter(options.workflowsPath, this.options.workflowsPath),
      workflowBundle: resolveParameter(options.workflowBundle, this.options.workflowBundle),
      interceptors: resolveWorkerInterceptors(options.interceptors, this.options.workerInterceptors),
    };
  }

  /**
   * Configures replay worker options by merging plugin parameters with existing options.
   * @param options The existing replay worker options
   * @returns Modified replay worker options with plugin configuration applied
   */
  configureReplayWorker(options: ReplayWorkerOptions): ReplayWorkerOptions {
    return {
      ...options,
      dataConverter: resolveDataConverter(options.dataConverter, this.options.dataConverter),
      workflowsPath: resolveParameter(options.workflowsPath, this.options.workflowsPath),
      workflowBundle: resolveParameter(options.workflowBundle, this.options.workflowBundle),
      interceptors: resolveWorkerInterceptors(options.interceptors, this.options.workerInterceptors),
    };
  }

  /**
   * Runs the worker, optionally wrapping execution in a custom context.
   * @param worker The worker instance to run
   * @param next Function to continue worker execution
   * @returns Promise that resolves when worker execution completes
   */
  runWorker(worker: Worker, next: (w: Worker) => Promise<void>): Promise<void> {
    if (this.options.runContext !== undefined) {
      return this.options.runContext(() => next(worker));
    }
    return next(worker);
  }

  /**
   * Configures bundler options by merging plugin parameters with existing options.
   * @param options The existing bundle options
   * @returns Modified bundle options with plugin configuration applied
   */
  configureBundler(options: BundleOptions): BundleOptions {
    return {
      ...options,
      workflowsPath: resolveRequiredParameter(options.workflowsPath, this.options.workflowsPath),
    };
  }

  /**
   * Configures connection options by merging plugin parameters with existing options.
   * Special handling for function-based API keys.
   * @param options The existing connection options
   * @returns Modified connection options with plugin configuration applied
   */
  configureConnection(options: ConnectionOptions): ConnectionOptions {
    const apiKey = typeof options.apiKey === 'function' ? options.apiKey : undefined;
    return {
      ...options,
      tls: resolveParameter(options.tls, this.options.tls),
      apiKey: apiKey ?? resolveParameter(options.apiKey as string | undefined, this.options.apiKey),
    };
  }

  /**
   * Configures native connection options by merging plugin parameters with existing options.
   * @param options The existing native connection options
   * @returns Modified native connection options with plugin configuration applied
   */
  configureNativeConnection(options: NativeConnectionOptions): NativeConnectionOptions {
    return {
      ...options,
      tls: resolveParameter(options.tls, this.options.tls),
      apiKey: resolveParameter(options.apiKey, this.options.apiKey),
    };
  }
}

function resolveParameterWithResolution<T>(
  existing: T | undefined,
  parameter: PluginParameter<T> | undefined,
  resolve: (existing: T, param: T) => T
): T | undefined {
  if (parameter === undefined) {
    return existing;
  }
  if (typeof parameter === 'function') {
    // @ts-expect-error Can't infer that parameter is a function
    return parameter(existing);
  }
  if (existing === undefined) {
    return parameter;
  }
  return resolve(existing, parameter);
}

function resolveRequiredParameter<T>(existing: T, parameter?: PluginParameter<T>): T {
  return resolveParameterWithResolution(existing, parameter, (_existing, param) => param)!;
}

function resolveParameter<T>(existing?: T, parameter?: PluginParameter<T>): T | undefined {
  return resolveParameterWithResolution(existing as T, parameter, (_existing, param) => param);
}

function resolveAppendParameter<T>(existing?: T[], parameter?: PluginParameter<T[]>): T[] | undefined {
  if (parameter === undefined) {
    return existing;
  }
  return resolveParameterWithResolution(existing ?? ([] as T[]), parameter, (existing, param) =>
    existing.concat(param)
  );
}

function resolveAppendObjectParameter(existing?: object, parameter?: PluginParameter<object>): object | undefined {
  if (parameter === undefined) {
    return existing;
  }
  return resolveParameterWithResolution(existing ?? {}, parameter, (existing, param) => ({ ...existing, ...param }));
}

function resolveDataConverter(
  existing?: DataConverter,
  parameter?: PluginParameter<DataConverter>
): DataConverter | undefined {
  return resolveParameterWithResolution(existing, parameter, (existing, parameter) => ({
    ...existing,
    ...parameter,
  }));
}

function resolveClientInterceptors(
  existing?: ClientInterceptors,
  parameter?: PluginParameter<ClientInterceptors>
): ClientInterceptors | undefined {
  return resolveParameterWithResolution(existing, parameter, (existing, parameter) => ({
    workflow: tryConcat(
      modernWorkflowInterceptors(existing?.workflow),
      modernWorkflowInterceptors(parameter?.workflow)
    ),
    schedule: tryConcat(existing?.schedule, parameter?.schedule),
  }));
}

function resolveWorkerInterceptors(
  existing?: WorkerInterceptors,
  parameter?: PluginParameter<WorkerInterceptors>
): WorkerInterceptors | undefined {
  return resolveParameterWithResolution(existing, parameter, (existing, parameter) => ({
    client: resolveClientInterceptors(existing.client, parameter.client),
    activity: resolveAppendParameter(existing.activity, parameter.activity),
    nexus: resolveAppendParameter(existing.nexus, parameter.nexus),
    workflowModules: resolveAppendParameter(existing.workflowModules, parameter.workflowModules),
  }));
}

function modernWorkflowInterceptors(
  // eslint-disable-next-line deprecation/deprecation
  interceptors: WorkflowClientInterceptors | WorkflowClientInterceptor[] | undefined
): WorkflowClientInterceptor[] | undefined {
  if (interceptors === undefined || Array.isArray(interceptors)) {
    return interceptors;
  }
  throw new Error("Simple plugin doesn't support old style workflow client interceptors");
}

function tryConcat<T>(left: T[] | undefined, right: T[] | undefined): T[] | undefined {
  if (right === undefined) {
    return left;
  }
  if (left === undefined) {
    return right;
  }
  return left.concat(right);
}
