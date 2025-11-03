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

type PluginParameter<T> = T | ((p: T | undefined) => T);

export interface SimplePluginOptions {
  readonly name: string;
  readonly tls?: PluginParameter<TLSConfig | boolean | null>;
  readonly apiKey?: PluginParameter<string>;
  readonly dataConverter?: PluginParameter<DataConverter>;
  readonly clientInterceptors?: PluginParameter<ClientInterceptors>;
  readonly activities?: PluginParameter<object>;
  readonly nexusServices?: PluginParameter<nexus.ServiceHandler<any>[]>;
  readonly workflowsPath?: PluginParameter<string>;
  readonly workflowBundle?: PluginParameter<WorkflowBundleOption>;
  readonly workerInterceptors?: PluginParameter<WorkerInterceptors>;
  readonly runContext?: (next: () => Promise<void>) => Promise<void>;
}

export class SimplePlugin
  implements WorkerPlugin, ClientPlugin, BundlerPlugin, ConnectionPlugin, NativeConnectionPlugin
{
  readonly name: string;

  constructor(protected readonly options: SimplePluginOptions) {
    this.name = options.name;
  }

  configureClient(options: ClientOptions): ClientOptions {
    return {
      ...options,
      dataConverter: resolveParameter(options.dataConverter, this.options.dataConverter),
      interceptors: resolveClientInterceptors(options.interceptors, this.options.clientInterceptors),
    };
  }

  configureWorker(options: WorkerOptions): WorkerOptions {
    return {
      ...options,
      dataConverter: resolveParameter(options.dataConverter, this.options.dataConverter),
      activities: resolveAppendObjectParameter(options.activities, this.options.activities),
      nexusServices: resolveAppendParameter(options.nexusServices, this.options.nexusServices),
      workflowsPath: resolveParameter(options.workflowsPath, this.options.workflowsPath),
      workflowBundle: resolveParameter(options.workflowBundle, this.options.workflowBundle),
      interceptors: resolveWorkerInterceptors(options.interceptors, this.options.workerInterceptors),
    };
  }

  configureReplayWorker(options: ReplayWorkerOptions): ReplayWorkerOptions {
    return {
      ...options,
      dataConverter: resolveParameter(options.dataConverter, this.options.dataConverter),
      workflowsPath: resolveParameter(options.workflowsPath, this.options.workflowsPath),
      workflowBundle: resolveParameter(options.workflowBundle, this.options.workflowBundle),
      interceptors: resolveWorkerInterceptors(options.interceptors, this.options.workerInterceptors),
    };
  }

  runWorker(worker: Worker, next: (w: Worker) => Promise<void>): Promise<void> {
    if (this.options.runContext !== undefined) {
      return this.options.runContext(() => next(worker));
    }
    return next(worker);
  }

  configureBundler(options: BundleOptions): BundleOptions {
    return {
      ...options,
      workflowsPath: resolveRequiredParameter(options.workflowsPath, this.options.workflowsPath),
    };
  }

  configureConnection(options: ConnectionOptions): ConnectionOptions {
    const apiKey = typeof options.apiKey === 'function' ? options.apiKey : undefined;
    return {
      ...options,
      tls: resolveParameter(options.tls, this.options.tls),
      apiKey: apiKey ?? resolveParameter(options.apiKey as string | undefined, this.options.apiKey),
    };
  }

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
