import type * as nexus from 'nexus-rpc';
import type { DataConverter } from '@temporalio/common';
import type { native } from '@temporalio/core-bridge';
import  { ClientInterceptors, ClientOptions, ClientPlugin, ConnectionPlugin, ConnectionOptions,
  WorkflowClientInterceptors, WorkflowClientInterceptor
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
  TLSConfig
} from '@temporalio/worker';

type PluginParameter<T> = T | ((p: T | undefined) => T);

export interface SimplePluginOptions {
  readonly name: string;
  readonly tls?: PluginParameter<TLSConfig | boolean | null>;
  readonly apiKey?: PluginParameter<string | (() => string)>;
  readonly dataConverter?: PluginParameter<DataConverter>;
  readonly clientInterceptors?: PluginParameter<ClientInterceptors>;
  readonly clientOptions?: Omit<ClientOptions, 'dataConverter' | 'interceptors' | 'connection' | 'plugins'>;
  readonly activities?: PluginParameter<object>;
  readonly nexusServices?: PluginParameter<nexus.ServiceHandler<any>[]>;
  readonly workflowsPath?: PluginParameter<string>;
  readonly workflowBundle?: PluginParameter<WorkflowBundleOption>;
  readonly workerInterceptors?: PluginParameter<WorkerInterceptors>;
  readonly workerOptions?: Omit<WorkerOptions, 'dataConverter' | 'interceptors' | 'activities' | 'nexusServices' | 'workflowsPath' | 'workflowBundle' | 'connection' | 'plugins'>;
  readonly replayWorkerOptions?: Omit<ReplayWorkerOptions, 'dataConverter' | 'interceptors' | 'workflowsPath' | 'workflowBundle' | 'plugins'>;
  readonly bundleOptions?: Omit<BundleOptions, 'workflowsPath' | 'plugins'>;
  readonly connectionOptions?: Omit<ConnectionOptions, 'tls' | 'apiKey' | 'plugins'>;
  readonly nativeConnectionOptions?: Omit<NativeConnectionOptions, 'tls' | 'apiKey' | 'plugins'>;
  readonly runContext?: {
    before: () => Promise<void>;
    after: () => Promise<void>;
  };
}

export class SimplePlugin implements WorkerPlugin, ClientPlugin, BundlerPlugin, ConnectionPlugin, NativeConnectionPlugin {
  readonly name: string;

  constructor(protected readonly options: SimplePluginOptions) {
    this.name = options.name;
  }

  configureClient(config: ClientOptions): ClientOptions {
    return {
      ...config,
      ...this.options.clientOptions,
      dataConverter: resolveParameter(config.dataConverter, this.options.dataConverter),
      interceptors: resolveClientInterceptors(config.interceptors, this.options.clientInterceptors),
    };
  }

  configureWorker(config: WorkerOptions): WorkerOptions {
    return {
      ...config,
      ...this.options.workerOptions,
      dataConverter: resolveParameter(config.dataConverter, this.options.dataConverter),
      activities: resolveAppendObjectParameter(config.activities, this.options.activities),
      nexusServices: resolveAppendParameter(config.nexusServices, this.options.nexusServices),
      workflowsPath: resolveParameter(config.workflowsPath, this.options.workflowsPath),
      workflowBundle: resolveParameter(config.workflowBundle, this.options.workflowBundle),
      interceptors: resolveWorkerInterceptors(config.interceptors, this.options.workerInterceptors),
    };
  }

  configureReplayWorker(config: ReplayWorkerOptions): ReplayWorkerOptions {
    return {
      ...config,
      ...this.options.replayWorkerOptions,
      dataConverter: resolveParameter(config.dataConverter, this.options.dataConverter),
      workflowsPath: resolveParameter(config.workflowsPath, this.options.workflowsPath),
      workflowBundle: resolveParameter(config.workflowBundle, this.options.workflowBundle),
      interceptors: resolveWorkerInterceptors(config.interceptors, this.options.workerInterceptors),
    };
  }

  async runWorker(worker: Worker, next: (w: Worker) => Promise<void>): Promise<void> {
    if (this.options.runContext !== undefined) {
      await this.options.runContext.before();
    }
    const result = await next(worker);
    if (this.options.runContext !== undefined) {
      await this.options.runContext.after();
    }
    return result;
  }

  configureBundler(config: BundleOptions): BundleOptions {
    return {
      ...config,
      ...this.options.bundleOptions,
      workflowsPath: resolveRequiredParameter(config.workflowsPath, this.options.workflowsPath),
    };
  }

  configureConnection(config: ConnectionOptions): ConnectionOptions {
    return {
      ...config,
      ...this.options.connectionOptions,
      tls: resolveParameter(config.tls, this.options.tls),
      apiKey: resolveParameter(config.apiKey, this.options.apiKey),
    };
  }

  configureNativeConnection(options: NativeConnectionOptions): NativeConnectionOptions {
    const resolvedApiKey = resolveParameter(options.apiKey, this.options.apiKey);
    if (typeof resolvedApiKey === 'function') {
      throw new TypeError('NativeConnectionOptions does not support apiKey as a function');
    }
    return {
      ...options,
      ...this.options.nativeConnectionOptions,
      tls: resolveParameter(options.tls, this.options.tls),
      apiKey: resolvedApiKey,
    };
  }

  connectNative(next: () => Promise<native.Client>): Promise<native.Client> {
    return next();
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
    return parameter
  }
  return resolve(existing, parameter);
}

function resolveRequiredParameter<T>(existing: T, parameter?: PluginParameter<T>): T {
  return resolveParameterWithResolution(existing, parameter, (_existing, param) => param)!;
}

function resolveParameter<T>(existing?: T, parameter?: PluginParameter<T>): T | undefined {
  if (parameter === undefined) {
    return existing;
  }
  return resolveParameterWithResolution(existing as T, parameter, (_existing, param) => param);
}

function resolveAppendParameter<T>(existing?: T[], parameter?: PluginParameter<T[]>): T[] | undefined {
  if (parameter === undefined) {
    return existing;
  }
  return resolveParameterWithResolution(existing ?? [] as T[], parameter, (existing, param) => existing.concat(param));
}

function resolveAppendObjectParameter(existing?: object, parameter?: PluginParameter<object>): object | undefined {
  if (parameter === undefined) {
    return existing;
  }
  return resolveParameterWithResolution(existing ?? {}, parameter, (existing, param) => ({ ...existing, ...param }));
}

function resolveClientInterceptors(existing?: ClientInterceptors, parameter?: PluginParameter<ClientInterceptors>): ClientInterceptors | undefined{
  return resolveParameterWithResolution(existing, parameter, (existing, parameter) => ({
    workflow: tryConcat(modernWorkflowInterceptors(existing?.workflow), modernWorkflowInterceptors(parameter?.workflow)),
    schedule: tryConcat(existing?.schedule, parameter?.schedule),
  }));
}

function resolveWorkerInterceptors(existing?: WorkerInterceptors, parameter?: PluginParameter<WorkerInterceptors>): WorkerInterceptors | undefined{
  return resolveParameterWithResolution(existing, parameter, (existing, parameter) => ({
    client: resolveClientInterceptors(existing.client, parameter.client),
    activity: resolveAppendParameter(existing.activity, parameter.activity),
    nexus: resolveAppendParameter(existing.nexus, parameter.nexus),
    workflowModules: resolveAppendParameter(existing.workflowModules, parameter.workflowModules),
  }));
}

function modernWorkflowInterceptors(interceptors: WorkflowClientInterceptors | WorkflowClientInterceptor[] | undefined): WorkflowClientInterceptor[] | undefined {
  if (interceptors === undefined || Array.isArray(interceptors)) {
    return interceptors;
  }
  throw new Error("Simple plugin doesn't support old style workflow client interceptors");
}

function tryConcat<T>(left: T[] | undefined, right: T[] | undefined): T[] | undefined {
  if (right === undefined) {
    return left
  }
  if (left === undefined) {
    return right
  }
  return left.concat(right)
}