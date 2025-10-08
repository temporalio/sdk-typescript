import * as nexus from 'nexus-rpc';
import type {
  ClientInterceptors,
  ClientOptions,
  ConnectionOptions,
  ConnectionPlugin,
  Plugin as ClientPlugin,
} from '@temporalio/client';
import { native } from '@temporalio/core-bridge';
import type { ReplayWorkerOptions, WorkerOptions, WorkflowBundleOption } from './worker-options';
import type {
  DataConverter,
  Worker,
} from './worker';
import type {
  BundleOptions,
  BundlerPlugin,
  NativeConnectionOptions,
  NativeConnectionPlugin,
  WorkerInterceptors,
} from './index';
/**
 * Base Plugin class for both client and worker functionality.
 * 
 * Plugins provide a way to extend and customize the behavior of Temporal clients and workers through a chain of
 * responsibility pattern. They allow you to intercept and modify client creation, service connections, worker
 * configuration, and worker execution.
 */
export interface Plugin {
  /**
   * Gets the name of this plugin.
   * 
   * Returns:
   *   The name of the plugin class.
   */
  get name(): string;

  /**
   * Hook called when creating a worker to allow modification of configuration.
   * 
   * This method is called during worker creation and allows plugins to modify
   * the worker configuration before the worker is fully initialized. Plugins
   * can add activities, workflows, interceptors, or change other settings.
   * 
   * Args:
   *   config: The worker configuration to potentially modify.
   * 
   * Returns:
   *   The modified worker configuration.
   */
  configureWorker(config: WorkerOptions): WorkerOptions;

  /**
   * Hook called when creating a replay worker to allow modification of configuration.
   *
   * This method is called during worker creation and allows plugins to modify
   * the worker configuration before the worker is fully initialized. Plugins
   * can add activities, workflows, interceptors, or change other settings.
   *
   * Args:
   *   config: The replay worker configuration to potentially modify.
   *
   * Returns:
   *   The modified worker configuration.
   */
  configureReplayWorker(config: ReplayWorkerOptions): ReplayWorkerOptions;

  runWorker(worker: Worker, next: (w: Worker) => Promise<void>): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function isWorkerPlugin(p: any): p is Plugin {
  return "configureWorker" in p && "configureReplayWorker" in p && "runWorker" in p;
}

type PluginParameter<T> = T | ((p: T | undefined) => T);

export class SimplePlugin implements Plugin, ClientPlugin, BundlerPlugin, ConnectionPlugin, NativeConnectionPlugin {

  constructor(
    readonly name: string,
    protected readonly dataConverter?: PluginParameter<DataConverter>,
    protected readonly clientInterceptors?: PluginParameter<ClientInterceptors>,
    protected readonly activities?: PluginParameter<object>,
    protected readonly nexusServices?: PluginParameter<nexus.ServiceHandler<any>[]>,
    protected readonly workflowsPath?: PluginParameter<string>,
    protected readonly workflowBundle?: PluginParameter<WorkflowBundleOption>,
    protected readonly workerInterceptors?: PluginParameter<WorkerInterceptors>,
    protected readonly runContext?: {
      before: () => Promise<void>,
      after: () => Promise<void>,
    }){}

  private static resolveRequiredParameter<T>(existing: T, parameter: PluginParameter<T> | undefined): T {
    if (parameter === undefined) {
      return existing;
    }
    if (typeof parameter === 'function') {
      // @ts-expect-error Can't infer that parameter is a function
      return parameter(existing);
    }
    return parameter;
  }

  private static resolveParameter<T>(existing: T | undefined, parameter: PluginParameter<T> | undefined): T | undefined {
    if (parameter === undefined) {
      return existing;
    }
    if (typeof parameter === 'function') {
      // @ts-expect-error Can't infer that parameter is a function
      return parameter(existing);
    }
    return parameter;
  }

  private static resolveAppendParameter<T>(existing: T[] | undefined, parameter: PluginParameter<T[]> | undefined): T[] | undefined {
    if (parameter === undefined) {
      return existing;
    }
    if (typeof parameter === 'function') {
      return parameter(existing);
    }
    return (existing || []).concat(parameter);
  }


  configureClient(config: ClientOptions): ClientOptions {
    config.dataConverter = SimplePlugin.resolveParameter(config.dataConverter, this.dataConverter);

    // TODO: Way to do interceptor append?
    config.interceptors = SimplePlugin.resolveParameter(config.interceptors, this.clientInterceptors);
    return config;
  }

  configureWorker(config: WorkerOptions): WorkerOptions {
    config.dataConverter = SimplePlugin.resolveParameter(config.dataConverter, this.dataConverter);

    // TODO: Way to do activities append?
    config.activities = SimplePlugin.resolveParameter(config.activities, this.activities);
    config.nexusServices = SimplePlugin.resolveAppendParameter(config.nexusServices, this.nexusServices);
    config.workflowsPath = SimplePlugin.resolveParameter(config.workflowsPath, this.workflowsPath);
    config.workflowBundle = SimplePlugin.resolveParameter(config.workflowBundle, this.workflowBundle);

    // TODO: Way to do interceptor append?
    config.interceptors = SimplePlugin.resolveParameter(config.interceptors, this.workerInterceptors);

    return config;
  }

  configureReplayWorker(config: ReplayWorkerOptions): ReplayWorkerOptions {
    config.dataConverter = SimplePlugin.resolveParameter(config.dataConverter, this.dataConverter);

    // TODO: Way to do activities append?
    config.workflowsPath = SimplePlugin.resolveParameter(config.workflowsPath, this.workflowsPath);
    config.workflowBundle = SimplePlugin.resolveParameter(config.workflowBundle, this.workflowBundle);

    // TODO: Way to do interceptor append?
    config.interceptors = SimplePlugin.resolveParameter(config.interceptors, this.workerInterceptors);

    return config;
  }

  async runWorker(worker: Worker, next: (w: Worker) => Promise<void>): Promise<void> {
    if (this.runContext !== undefined) {
      await this.runContext.before();
    }
    const result = await next(worker);
    if (this.runContext !== undefined) {
      await this.runContext.after();
    }
    return result;
  }

  configureBundler(config: BundleOptions): BundleOptions {
    config.workflowsPath = SimplePlugin.resolveRequiredParameter(config.workflowsPath, this.workflowsPath);
    return config;
  }

  configureConnection(config: ConnectionOptions): ConnectionOptions {
    return config;
  }

  configureNativeConnection(options: NativeConnectionOptions): NativeConnectionOptions {
    return options;
  }

  connectNative(next: () => Promise<native.Client>): Promise<native.Client> {
    return next();
  }
}