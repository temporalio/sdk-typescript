import * as native from '@temporalio/core-bridge';
import {
  pollLogs,
  runtimeShutdown,
  newClient,
  newRuntime,
  initTelemetry,
  TelemetryOptions as RequiredTelemetryOptions,
} from '@temporalio/core-bridge';
import { filterNullAndUndefined, normalizeTlsConfig } from '@temporalio/internal-non-workflow-common';
import { IllegalStateError, MakeOptional } from '@temporalio/internal-workflow-common';
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

export { RequiredTelemetryOptions };
export type TelemetryOptions = MakeOptional<RequiredTelemetryOptions, 'logForwardingLevel'>;

/**
 * Options used to create a Core runtime
 */
export interface RuntimeOptions {
  /** Telemetry options for traces/metrics/logging */
  telemetryOptions?: TelemetryOptions;
  /**
   * Custom logger for logging events from the SDK, by default we log everything to stderr
   * at the INFO level. See https://docs.temporal.io/docs/typescript/logging/ for more info.
   */
  logger?: Logger;
}

export interface CompiledRuntimeOptions {
  telemetryOptions: RequiredTelemetryOptions;
  logger: Logger;
}

function defaultTelemetryOptions(): RequiredTelemetryOptions {
  return {
    logForwardingLevel: 'OFF',
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
  }
}

/**
 * Core singleton representing an instance of the Rust Core SDK
 *
 * Use {@link install} in order to customize the server connection options or other global process options.
 */
export class Runtime {
  /** Track the registered workers to automatically shutdown when all have been deregistered */
  protected readonly registeredWorkers = new Set<native.Worker>();
  protected readonly shouldPollForLogs = new BehaviorSubject<boolean>(false);
  protected readonly logPollPromise: Promise<void>;
  public readonly logger: Logger;

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
        throw new IllegalStateError('Core singleton has already been installed');
      } else if (this.instantiator === 'instance') {
        throw new IllegalStateError(
          'Core singleton has already been instantiated. Did you start a Worker before calling `install`?'
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
    return this.options.telemetryOptions.logForwardingLevel !== 'OFF';
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
    return await promisify(newClient)(this.native, clientOptions);
  }

  /**
   * Register a Worker, this is required for automatically shutting down when all Workers have been deregistered
   *
   * Hidden in the docs because it is only meant to be used internally by the Worker.
   * @hidden
   */
  public async registerWorker(client: native.Client, options: native.WorkerOptions): Promise<native.Worker> {
    const worker = await promisify(native.newWorker)(client, options);
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
      await this.shutdown();
    }
  }

  /**
   * Shutdown and unset the singleton instance.
   *
   * Hidden in the docs because it is only meant to be used for testing.
   * @hidden
   */
  public async shutdown(): Promise<void> {
    this.shouldPollForLogs.next(false);
    await promisify(runtimeShutdown)(this.native);
    // This will effectively drain all logs
    await this.logPollPromise;
    delete Runtime._instance;
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
}
