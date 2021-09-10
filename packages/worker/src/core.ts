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
import { newCore, coreShutdown, TelemetryOptions, corePollLogs } from '@temporalio/core-bridge';
import { DefaultLogger, Logger } from './logger';
import { BehaviorSubject, lastValueFrom, of, map, concatMap, repeat } from 'rxjs';
import { delay, takeWhile } from 'rxjs/operators';

export interface CoreOptions {
  /** Options for communicating with the Temporal server */
  serverOptions?: ServerOptions;
  /** Telemetry options for traces/metrics/logging */
  telemetryOptions?: TelemetryOptions;
  /**
   * Custom logger for logging events from the SDK, by default we log everything to stderr
   * at the INFO level. See https://docs.temporal.io/docs/node/logging/ for more info.
   */
  logger?: Logger;
}

export interface CompiledCoreOptions extends CoreOptions {
  /** Options for communicating with the Temporal server */
  serverOptions: CompiledServerOptions;
  logger: Logger;
}

function defaultTelemetryOptions(): TelemetryOptions {
  return {
    logForwardingLevel: 'INFO',
  };
}

/**
 * Core singleton representing an instance of the Rust Core SDK
 *
 * Use {@link install} in order to customize the server connection options or other global process options.
 */
export class Core {
  /** Track the registered workers to automatically shutdown when all have been deregistered */
  protected registeredWorkers = new Set<native.Worker>();
  protected shouldPollForLogs = new BehaviorSubject<boolean>(false);
  protected logPollPromise;

  protected constructor(public readonly native: native.Core, public readonly options: CompiledCoreOptions) {
    this.logPollPromise = this.initLogPolling(options, native);
  }

  /**
   * Default options get overridden when Core is installed and are remembered in case Core is
   * re-instantiated after being shut down
   */
  protected static defaultOptions: CoreOptions = {};

  /**
   * Factory function for creating a new Core instance, not exposed because Core is meant to be used as a singleton
   */
  protected static async create(options: CoreOptions): Promise<Core> {
    const compiledServerOptions = compileServerOptions({ ...getDefaultServerOptions(), ...options.serverOptions });
    const telemetryOptions = { ...defaultTelemetryOptions(), ...options.telemetryOptions };
    const compiledOptions = {
      serverOptions: {
        ...compiledServerOptions,
        tls: normalizeTlsConfig(compiledServerOptions.tls),
        url: options.serverOptions?.tls
          ? `https://${compiledServerOptions.address}`
          : `http://${compiledServerOptions.address}`,
      },
      telemetryOptions,
      logger: options.logger ?? new DefaultLogger('INFO'),
    };
    const native = await promisify(newCore)(compiledOptions);

    return new this(native, compiledOptions);
  }

  private initLogPolling(options: CompiledCoreOptions, native: native.Core) {
    this.shouldPollForLogs.next(true);

    if (options.telemetryOptions?.logForwardingLevel !== 'OFF') {
      const poll = promisify(corePollLogs);
      const logPromise = lastValueFrom(
        of(this.shouldPollForLogs).pipe(
          map((subject) => subject.getValue()),
          takeWhile((shouldPoll) => shouldPoll),
          concatMap(() => poll(native)),
          map((logs) => {
            for (const log of logs) {
              if (log.level === 'TRACE') {
                options.logger.trace(log.message);
              } else if (log.level === 'DEBUG') {
                options.logger.debug(log.message);
              } else if (log.level === 'INFO') {
                options.logger.info(log.message);
              } else if (log.level === 'WARN') {
                options.logger.warn(log.message);
              } else if (log.level === 'ERROR') {
                options.logger.error(log.message);
              }
            }
          }),
          delay(3), // Don't go wild polling as fast as possible
          repeat()
        )
      );
      // Prevent unhandled rejection
      logPromise.catch((e) => options.logger.warn('Error gathering forwarded logs from core', e));
      return logPromise;
    }
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
      this.shouldPollForLogs.next(false);
      await promisify(coreShutdown)(this.native);
      delete Core._instance;
    }
  }
}
