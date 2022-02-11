import { promisify } from 'util';
import Heap from 'heap-js';
import { BehaviorSubject, lastValueFrom, of } from 'rxjs';
import { concatMap, delay, map, repeat } from 'rxjs/operators';
import { filterNullAndUndefined, IllegalStateError, normalizeTlsConfig } from '@temporalio/common';
import * as native from '@temporalio/core-bridge';
import {
  corePollLogs,
  coreShutdown,
  newCore,
  newReplayCore,
  TelemetryOptions as RequiredTelemetryOptions,
} from '@temporalio/core-bridge';
import { compileServerOptions, getDefaultServerOptions, RequiredServerOptions, ServerOptions } from './server-options';
import { DefaultLogger, LogEntry, Logger, LogTimestamp, timeOfDayToBigint } from './logger';
import * as errors from './errors';
import { temporal } from '@temporalio/proto';
import { byteArrayToBuffer } from './utils';
import { MakeOptional } from '@temporalio/common/src/type-helpers';

export type History = temporal.api.history.v1.IHistory;

export type TelemetryOptions = MakeOptional<RequiredTelemetryOptions, 'logForwardingLevel'>;

export interface CoreOptions {
  /** Options for communicating with the Temporal server */
  serverOptions?: ServerOptions;
  /** Telemetry options for traces/metrics/logging */
  telemetryOptions?: TelemetryOptions;
  /**
   * Custom logger for logging events from the SDK, by default we log everything to stderr
   * at the INFO level. See https://docs.temporal.io/docs/typescript/logging/ for more info.
   */
  logger?: Logger;
}

export interface CompiledCoreOptions extends CoreOptions {
  telemetryOptions: RequiredTelemetryOptions;
  /** Options for communicating with the Temporal server */
  serverOptions: RequiredServerOptions;
  logger: Logger;
}

function defaultTelemetryOptions(): RequiredTelemetryOptions {
  return {
    logForwardingLevel: 'INFO',
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
 * Holds bag-o-statics for different core types to ensure that they get independent instances of all
 * statics.
 */
class CoreStatics<T extends Core> {
  instance?: Promise<T>;
  instantiator?: 'install' | 'instance';
  /**
   * Default options get overridden when Core is installed and are remembered in case Core is
   * re-instantiated after being shut down
   */
  defaultOptions: CoreOptions = {};

  constructor(readonly instanceCtor: (options: native.CoreOptions, callback: native.CoreCallback) => void) {}
}

/**
 * Core singleton representing an instance of the Rust Core SDK
 *
 * Use {@link install} in order to customize the server connection options or other global process options.
 */
export class Core {
  /** Track the registered workers to automatically shutdown when all have been deregistered */
  protected readonly registeredWorkers = new Set<native.Worker>();
  protected readonly shouldPollForLogs = new BehaviorSubject<boolean>(false);
  protected readonly logPollPromise: Promise<void>;
  public readonly logger: Logger;

  protected static _statics: CoreStatics<Core> = new CoreStatics(newCore);

  /**
   * @ignore
   */
  constructor(public readonly native: native.Core, public readonly options: CompiledCoreOptions) {
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
  public static async install<T extends typeof Core>(this: T, options: CoreOptions): Promise<InstanceType<T>> {
    if (this._statics.instance !== undefined) {
      if (this._statics.instantiator === 'install') {
        throw new IllegalStateError('Core singleton has already been installed');
      } else if (this._statics.instantiator === 'instance') {
        throw new IllegalStateError(
          'Core singleton has already been instantiated. Did you start a Worker before calling `install`?'
        );
      }
    }
    return (await this.create(options, 'install').catch((err) => {
      // Unset the singleton in case creation failed
      delete this._statics.instance;
      throw err;
    })) as InstanceType<T>;
  }

  /**
   * Get or instantiate the singleton Core object
   *
   * If Core has not been instantiated with {@link install} or this method,
   * a new Core instance will be installed and configured to connect to
   * a local server.
   */
  public static async instance<T extends typeof Core>(this: T): Promise<InstanceType<T>> {
    const existingInst = this._statics.instance;
    if (existingInst !== undefined) {
      return existingInst as InstanceType<T>;
    }
    return (await this.create(this._statics.defaultOptions, 'instance')) as InstanceType<T>;
  }

  /**
   * Factory function for creating a new Core instance, not exposed because Core is meant to be used as a singleton
   */
  protected static async create<T extends typeof Core>(
    this: T,
    options: CoreOptions,
    instantiator: 'install' | 'instance'
  ): Promise<InstanceType<T>> {
    // Remember the provided options in case Core is reinstantiated after being shut down
    this._statics.defaultOptions = options;
    this._statics.instantiator = instantiator;

    const compiledOptions = this.compileOptions(options);
    this._statics.instance = promisify(this._statics.instanceCtor)(compiledOptions).then((native) => {
      return new this(native, compiledOptions);
    });
    return (await this._statics.instance) as InstanceType<T>;
  }

  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  protected static compileOptions(options: CoreOptions) {
    const compiledServerOptions = compileServerOptions({
      ...getDefaultServerOptions(),
      ...filterNullAndUndefined(options.serverOptions ?? {}),
    });
    const telemetryOptions = {
      ...defaultTelemetryOptions(),
      ...filterNullAndUndefined(options.telemetryOptions ?? {}),
    };
    return {
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
  }

  protected async initLogPolling(logger: CoreLogger): Promise<void> {
    this.shouldPollForLogs.next(true);

    if (!this.isForwardingLogs()) {
      return;
    }
    const poll = promisify(corePollLogs);
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
    await promisify(coreShutdown)(this.native);
    // This will effectively drain all logs
    await this.logPollPromise;
    delete Core._statics.instance;
  }
}

/**
 * An alternate version of Core which creates core instances that use mocks
 * rather than an actual server to replay histories.
 *
 * Intentionally not exported since Core will soon be deprecated.
 */
export class ReplayCore extends Core {
  protected static _statics: CoreStatics<ReplayCore> = new CoreStatics((opts, cb) =>
    newReplayCore(opts.telemetryOptions, cb)
  );

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
