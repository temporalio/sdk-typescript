import * as native from '@temporalio/core-bridge';
import {
  pollLogs,
  runtimeShutdown,
  newClient,
  newRuntime,
  initTelemetry,
  TelemetryOptions,
  Logger as TelemLogger,
  ForwardLogger,
} from '@temporalio/core-bridge';
import { filterNullAndUndefined, normalizeTlsConfig } from '@temporalio/internal-non-workflow-common';
import { IllegalStateError } from '@temporalio/internal-workflow-common';
import { temporal } from '@temporalio/proto';
import Heap from 'heap-js';
import { BehaviorSubject, lastValueFrom, of } from 'rxjs';
import { concatMap, delay, map, repeat } from 'rxjs/operators';
import { promisify } from 'util';
import * as errors from './errors';
import { DefaultLogger, LogEntry, Logger, LogTimestamp, timeOfDayToBigint } from './logger';
import { compileConnectionOptions, getDefaultConnectionOptions, NativeConnectionOptions } from './connection-options';
import { byteArrayToBuffer } from './utils';

export type History = temporal.api.history.v1.IHistory;

function isForwardingLogger(opts: TelemLogger): opts is ForwardLogger {
  return Object.hasOwnProperty.call(opts, 'forward');
}

/**
 * Options used to create a Core runtime
 */
export interface RuntimeOptions {
  /**
   * Automatically shut down on any of these signals.
   * @default
   * ```ts
   * ['SIGINT', 'SIGTERM', 'SIGQUIT', 'SIGUSR2']
   * ```
   */

  shutdownSignals?: NodeJS.Signals[];
  /** Telemetry options for traces/metrics/logging */
  telemetryOptions?: TelemetryOptions;
  /**
   * Custom logger for logging events from the SDK, by default we log everything to stderr
   * at the INFO level. See https://docs.temporal.io/typescript/logging/ for more info.
   */
  logger?: Logger;
}

export interface CompiledRuntimeOptions {
  shutdownSignals: NodeJS.Signals[];
  telemetryOptions: TelemetryOptions;
  logger: Logger;
}

function defaultTelemetryOptions(): TelemetryOptions {
  return {
    tracingFilter: 'temporal_sdk_core=WARN',
    logging: {
      console: {},
    },
  };
}

/** A logger that buffers logs from both Node.js and Rust Core and emits logs in the right order */
export class CoreLogger extends DefaultLogger {
  protected buffer = new Heap<LogEntry>((a, b) => Number(a.timestampNanos - b.timestampNanos));

  constructor(protected readonly next: Logger) {
    super('TRACE', (entry) => this.buffer.add(entry));
  }

  /** Flush all buffered logs into the logger supplied to the constructor */
  flush(): void {
    for (const entry of this.buffer) {
      this.next.log(entry.level, entry.message, { ...entry.meta, [LogTimestamp]: entry.timestampNanos });
    }
    this.buffer.clear();
  }
}

/**
 * Core singleton representing an instance of the Rust Core SDK
 *
 * Use {@link install} in order to customize the server connection options or other global process options.
 */
export class Runtime {
  /** Track the registered clients to automatically shutdown when all have been deregistered */
  protected readonly registeredClients = new Set<native.Client>();
  /** Track the registered workers to automatically shutdown when all have been deregistered */
  protected readonly registeredWorkers = new Set<native.Worker>();
  protected readonly shouldPollForLogs = new BehaviorSubject<boolean>(false);
  protected readonly logPollPromise: Promise<void>;
  /** Track the number of pending calls into the tokio runtime to prevent shut down */
  protected pendingCalls = 0;
  public readonly logger: Logger;
  protected readonly shutdownSignalCallbacks = new Set<() => void>();

  static _instance?: Runtime;
  static instantiator?: 'install' | 'instance';

  /**
   * Default options get overridden when Core is installed and are remembered in case Core is
   * re-instantiated after being shut down
   */
  static defaultOptions: RuntimeOptions = {};

  protected constructor(public readonly native: native.Runtime, public readonly options: CompiledRuntimeOptions) {
    if (this.isForwardingLogs()) {
      const logger = (this.logger = new CoreLogger(this.options.logger));
      this.logPollPromise = this.initLogPolling(logger);
    } else {
      this.logger = this.options.logger;
      this.logPollPromise = Promise.resolve();
    }
    this.setupShutdownHook();
  }

  /**
   * Instantiate a new Core object and set it as the singleton instance
   *
   * If Core has already been instantiated with {@link instance} or this method,
   * will throw a {@link IllegalStateError}.
   */
  public static install(options: RuntimeOptions): Runtime {
    if (this._instance !== undefined) {
      if (this.instantiator === 'install') {
        throw new IllegalStateError('Runtime singleton has already been installed');
      } else if (this.instantiator === 'instance') {
        throw new IllegalStateError(
          'Runtime singleton has already been instantiated. Did you start a Worker before calling `install`?'
        );
      }
    }
    return this.create(options, 'install');
  }

  /**
   * Get or instantiate the singleton Core object
   *
   * If Core has not been instantiated with {@link install} or this method,
   * a new Core instance will be installed and configured to connect to
   * a local server.
   */
  public static instance(): Runtime {
    const existingInst = this._instance;
    if (existingInst !== undefined) {
      return existingInst;
    }
    return this.create(this.defaultOptions, 'instance');
  }

  /**
   * Factory function for creating a new Core instance, not exposed because Core is meant to be used as a singleton
   */
  protected static create(options: RuntimeOptions, instantiator: 'install' | 'instance'): Runtime {
    // Remember the provided options in case Core is reinstantiated after being shut down
    this.defaultOptions = options;
    this.instantiator = instantiator;

    const compiledOptions = this.compileOptions(options);
    if (compiledOptions.telemetryOptions) {
      initTelemetry(compiledOptions.telemetryOptions);
    }
    const runtime = newRuntime();
    this._instance = new this(runtime, compiledOptions);
    return this._instance;
  }

  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  protected static compileOptions(options: RuntimeOptions): CompiledRuntimeOptions {
    const telemetryOptions = {
      ...defaultTelemetryOptions(),
      ...filterNullAndUndefined(options.telemetryOptions ?? {}),
    };
    return {
      shutdownSignals: options.shutdownSignals ?? ['SIGINT', 'SIGTERM', 'SIGQUIT', 'SIGUSR2'],
      telemetryOptions,
      logger: options.logger ?? new DefaultLogger('INFO'),
    };
  }

  protected async initLogPolling(logger: CoreLogger): Promise<void> {
    this.shouldPollForLogs.next(true);

    if (!this.isForwardingLogs()) {
      return;
    }
    const poll = promisify(pollLogs);
    try {
      await lastValueFrom(
        of(this.shouldPollForLogs).pipe(
          map((subject) => subject.getValue()),
          concatMap((shouldPoll) => {
            if (!shouldPoll) throw new errors.ShutdownError('Poll stop requested');
            return poll(this.native);
          }),
          map((logs) => {
            for (const log of logs) {
              logger.log(log.level, log.message, {
                [LogTimestamp]: timeOfDayToBigint(log.timestamp),
              });
            }
            logger.flush();
          }),
          delay(3), // Don't go wild polling as fast as possible
          repeat()
        )
      );
    } catch (error) {
      // Prevent unhandled rejection
      if (error instanceof errors.ShutdownError) return;
      // Log using the original logger instead of buffering
      this.options.logger.warn('Error gathering forwarded logs from core', { error });
    } finally {
      logger.flush();
    }
  }

  protected isForwardingLogs(): boolean {
    const logger = this.options.telemetryOptions.logging;
    return logger != null && isForwardingLogger(logger);
  }

  /**
   * Flush any buffered logs.
   *
   * This is a noop in case the instance is configured with
   * `logForwardingLevel=OFF`.
   */
  flushLogs(): void {
    if (this.isForwardingLogs()) {
      const logger = this.logger as CoreLogger;
      logger.flush();
    }
  }

  /**
   * Create a Core Connection object to power Workers
   *
   * Hidden in the docs because it is only meant to be used internally by the Worker.
   * @hidden
   */
  public async createNativeClient(options?: NativeConnectionOptions): Promise<native.Client> {
    const compiledServerOptions = compileConnectionOptions({
      ...getDefaultConnectionOptions(),
      ...filterNullAndUndefined(options ?? {}),
    });
    const clientOptions = {
      ...compiledServerOptions,
      tls: normalizeTlsConfig(compiledServerOptions.tls),
      url: options?.tls ? `https://${compiledServerOptions.address}` : `http://${compiledServerOptions.address}`,
    };
    this.pendingCalls++;
    try {
      const client = await promisify(newClient)(this.native, clientOptions);
      this.registeredClients.add(client);
      return client;
    } catch (err) {
      // Attempt to shutdown the runtime in case there's an error creating the
      // client to avoid leaving an idle Runtime.
      if (this.canShutdown()) {
        await this.shutdown();
      }
      throw err;
    } finally {
      this.pendingCalls--;
    }
  }

  /**
   * Close a native Client, if this is the last registered Client or Worker, shutdown the core and unset the singleton instance
   *
   * Hidden in the docs because it is only meant to be used internally by the Worker.
   * @hidden
   */
  public async closeNativeClient(client: native.Client): Promise<void> {
    this.registeredClients.delete(client);
    native.clientClose(client);
    if (this.canShutdown()) {
      await this.shutdown();
    }
  }

  /**
   * Register a Worker, this is required for automatically shutting down when all Workers have been deregistered
   *
   * Hidden in the docs because it is only meant to be used internally by the Worker.
   * @hidden
   */
  public async registerWorker(client: native.Client, options: native.WorkerOptions): Promise<native.Worker> {
    this.pendingCalls++;
    try {
      const worker = await promisify(native.newWorker)(client, options);
      this.registeredWorkers.add(worker);
      return worker;
    } finally {
      this.pendingCalls--;
    }
  }

  /**
   * Deregister a Worker, if this is the last registered Worker or Client, shutdown the core and unset the singleton instance
   *
   * Hidden in the docs because it is only meant to be used internally by the Worker.
   * @hidden
   */
  public async deregisterWorker(worker: native.Worker): Promise<void> {
    native.workerFinalizeShutdown(worker);
    this.registeredWorkers.delete(worker);
    // NOTE: only replay workers require registration since they don't have an associated connection
    // but we track all Workers for simplicity.
    if (this.canShutdown()) {
      await this.shutdown();
    }
  }

  protected canShutdown(): boolean {
    return this.pendingCalls === 0 && this.registeredClients.size === 0 && this.registeredWorkers.size === 0;
  }

  /**
   * Shutdown and unset the singleton instance.
   *
   * If the runtime is polling on Core logs, wait for those logs to be collected.
   *
   * Hidden in the docs because it is only meant to be used for testing.
   * @hidden
   */
  public async shutdown(): Promise<void> {
    delete Runtime._instance;
    this.teardownShutdownHook();
    this.shouldPollForLogs.next(false);
    // This will effectively drain all logs
    await this.logPollPromise;
    await promisify(runtimeShutdown)(this.native);
  }

  // TODO: accept either history or JSON or binary
  /** @hidden */
  public async createReplayWorker(options: native.WorkerOptions, history: History): Promise<native.Worker> {
    const worker = await promisify(native.newReplayWorker)(
      this.native,
      options,
      byteArrayToBuffer(temporal.api.history.v1.History.encodeDelimited(history).finish())
    );
    this.registeredWorkers.add(worker);
    return worker;
  }

  /**
   * Used by Workers to register for shutdown signals
   *
   * Hidden in the docs because it is only meant to be used internally by the Worker.
   * @hidden
   */
  public registerShutdownSignalCallback(callback: () => void): void {
    this.shutdownSignalCallbacks.add(callback);
  }

  /**
   * Used by Workers to deregister handlers registered with {@link registerShutdownSignalCallback}
   *
   * Hidden in the docs because it is only meant to be used internally by the Worker.
   * @hidden
   */
  public deregisterShutdownSignalCallback(callback: () => void): void {
    this.shutdownSignalCallbacks.delete(callback);
  }

  /**
   * Set up the shutdown hook, listen on shutdownSignals
   */
  protected setupShutdownHook(): void {
    for (const signal of this.options.shutdownSignals) {
      process.on(signal, this.startShutdownSequence);
    }
  }

  /**
   * Stop listening on shutdownSignals
   */
  protected teardownShutdownHook(): void {
    for (const signal of this.options.shutdownSignals) {
      process.off(signal, this.startShutdownSequence);
    }
  }

  /**
   * Bound to `this` for use with `process.on` and `process.off`
   */
  protected startShutdownSequence = (): void => {
    this.teardownShutdownHook();
    for (const callback of this.shutdownSignalCallbacks) {
      queueMicrotask(callback); // Run later
      this.deregisterShutdownSignalCallback(callback);
    }
  };
}
