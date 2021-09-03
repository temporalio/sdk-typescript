import { promisify } from 'util';
import { IllegalStateError } from '@temporalio/common';
import {
  ServerOptions,
  CompiledServerOptions,
  getDefaultServerOptions,
  compileServerOptions,
  normalizeTlsConfig,
} from './server-options';
import * as native from '@temporalio/core-bridge';
import { newCore, coreShutdown, TelemetryOptions } from "@temporalio/core-bridge";

export interface CoreOptions {
  /** Options for communicating with the Temporal server */
  serverOptions?: ServerOptions;
  /** Telemetry options for traces/metrics/logging */
  telemetryOptions?: TelemetryOptions;
}

export interface CompiledCoreOptions extends CoreOptions {
  /** Options for communicating with the Temporal server */
  serverOptions: CompiledServerOptions;
}

/**
 * Core singleton representing an instance of the Rust Core SDK
 *
 * Use {@link install} in order to customize the server connection options or other global process options.
 */
export class Core {
  /** Track the registered workers to automatically shutdown when all have been deregistered */
  protected registeredWorkers = new Set<native.Worker>();
  protected constructor(public readonly native: native.Core, public readonly options: CompiledCoreOptions) {}

  /**
   * Default options get overriden when Core is installed and are remembered in case Core is
   * reinstantiated after being shut down
   */
  protected static defaultOptions: CoreOptions = {};

  /**
   * Factory function for creating a new Core instance, not exposed because Core is meant to be used as a singleton
   */
  protected static async create(options: CoreOptions): Promise<Core> {
    const compiledServerOptions = compileServerOptions({ ...getDefaultServerOptions(), ...options.serverOptions });
    const compiledOptions = {
      serverOptions: {
        ...compiledServerOptions,
        tls: normalizeTlsConfig(compiledServerOptions.tls),
        url: options.serverOptions?.tls
          ? `https://${compiledServerOptions.address}`
          : `http://${compiledServerOptions.address}`,
      },
      telemetryOptions: options.telemetryOptions || {}
    };
    const native = await promisify(newCore)(compiledOptions);
    return new this(native, compiledOptions);
  }

  protected static _instance?: Promise<Core>;
  protected static instantiator?: 'install' | 'instance';

  /**
   * Instantiate a new Core object and set it as the singleton instance
   *
   * If Core has already been instantiated with {@link instance} or this method,
   * will throw a {@link IllegalStateError}.
   */
  public static async install(options: CoreOptions): Promise<Core> {
    // Remember the provided options in case Core is reinstantiated after being shut down
    this.defaultOptions = options;
    if (this._instance !== undefined) {
      if (this.instantiator === 'install') {
        throw new IllegalStateError('Core singleton has already been installed');
      } else if (this.instantiator === 'instance') {
        throw new IllegalStateError(
          'Core singleton has already been instantiated. Did you start a Worker before calling `install`?'
        );
      }
    }
    this.instantiator = 'install';
    this._instance = this.create(options);
    return this._instance;
  }

  /**
   * Get or instantiate the singleton Core object
   *
   * If Core has not been instantiated with {@link install} or this method,
   * a new Core instance will be installed and configured to connect to
   * the local docker compose setup.
   */
  public static async instance(): Promise<Core> {
    if (this._instance === undefined) {
      this.instantiator = 'instance';
      this._instance = this.create(this.defaultOptions);
    }
    return this._instance;
  }

  /**
   * Register a Worker, this is required for automatically shutting down when all Workers have been deregistered
   *
   * Hidden in the docs because it is only meant to be used internally by the Worker.
   * @hidden
   */
  public async registerWorker(options: native.WorkerOptions): Promise<native.Worker> {
    const worker = await promisify(native.newWorker)(this.native, options);
    this.registeredWorkers.add(worker);
    return worker;
  }

  /**
   * Deregister a Worker, if this is the last registered Worker, shutdown the core and unset the singleton instance
   *
   * Hidden in the docs because it is only meant to be used internally by the Worker.
   * @hidden
   */
  public async deregisterWorker(worker: native.Worker): Promise<void> {
    this.registeredWorkers.delete(worker);
    if (this.registeredWorkers.size === 0) {
      await promisify(coreShutdown)(this.native);
      delete Core._instance;
    }
  }
}
