import { promisify } from 'node:util';
import * as v8 from 'node:v8';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { Heap } from 'heap-js';
import * as native from '@temporalio/core-bridge';
import {
  pollLogs,
  runtimeShutdown,
  newClient,
  newRuntime,
  TelemetryOptions,
  CompiledTelemetryOptions,
  ForwardLogger,
  MetricsExporter,
  OtelCollectorExporter,
} from '@temporalio/core-bridge';
import { filterNullAndUndefined, normalizeTlsConfig } from '@temporalio/common/lib/internal-non-workflow';
import { IllegalStateError, LogMetadata, SdkComponent } from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import { History } from '@temporalio/common/lib/proto-utils';
import { msToNumber } from '@temporalio/common/lib/time';
import { DefaultLogger, LogEntry, Logger, LogTimestamp, timeOfDayToBigint } from './logger';
import { compileConnectionOptions, getDefaultConnectionOptions, NativeConnectionOptions } from './connection-options';
import { byteArrayToBuffer, toMB } from './utils';
import pkg from './pkg';

export { History };

function isForwardingLogger(opts: TelemetryOptions['logging']): opts is ForwardLogger {
  return Object.hasOwnProperty.call(opts, 'forward');
}

function isOtelCollectorExporter(opts: MetricsExporter): opts is OtelCollectorExporter {
  return Object.hasOwnProperty.call(opts, 'otel');
}

/**
 * Options used to create a Core runtime
 */
export interface RuntimeOptions {
  /**
   * Automatically shut down workers on any of these signals.
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
  telemetryOptions: CompiledTelemetryOptions;
  logger: Logger;
}

export interface MakeTelemetryFilterStringOptions {
  /**
   * Determines which level of verbosity to keep for _SDK Core_'s related events.
   * Any event with a verbosity level less than that value will be discarded.
   * Possible values are, in order: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'.
   */
  core: native.LogLevel;

  /**
   * Determines which level of verbosity to keep for events related to third
   * party native packages imported by SDK Core. Any event with a verbosity level
   * less than that value will be discarded. Possible values are, in order:
   * 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'.
   *
   * @defaults `'INFO'`
   */
  other?: native.LogLevel;
}

/**
 * A helper to build a filter string for use in `RuntimeOptions.telemetryOptions.tracingFilter`.
 *
 * Example:
 *  ```
 *  telemetryOptions: {
 *    logging: {
 *     filter: makeTelemetryFilterString({ core: 'TRACE', other: 'DEBUG' });
 *     // ...
 *    },
 *  }
 * ```
 */
export function makeTelemetryFilterString(options: MakeTelemetryFilterStringOptions): string {
  const { core, other } = { other: 'INFO', ...options };
  return `${other},temporal_sdk_core=${core},temporal_client=${core},temporal_sdk=${core}`;
}

/** A logger that buffers logs from both Node.js and Rust Core and emits logs in the right order */
class BufferedLogger extends DefaultLogger {
  protected buffer = new Heap<LogEntry>((a, b) => Number(a.timestampNanos - b.timestampNanos));

  constructor(protected readonly next: Logger) {
    super('TRACE', (entry) => this.buffer.add(entry));
  }

  /** Flush all buffered logs into the logger supplied to the constructor */
  flush(): void {
    for (const entry of this.buffer) {
      this.next.log(entry.level, entry.message, {
        ...entry.meta,
        [LogTimestamp]: entry.timestampNanos,
      });
    }
    this.buffer.clear();
  }
}

type TrackedNativeObject = native.Client | native.Worker | native.EphemeralServer;

/**
 * Core singleton representing an instance of the Rust Core SDK
 *
 * Use {@link install} in order to customize the server connection options or other global process options.
 */
export class Runtime {
  /** Track the number of pending creation calls into the tokio runtime to prevent shut down */
  protected pendingCreations = 0;
  /** Track the registered native objects to automatically shutdown when all have been deregistered */
  protected readonly backRefs = new Set<TrackedNativeObject>();
  protected stopPollingForLogs = false;
  protected stopPollingForLogsCallback?: () => void;
  protected readonly logPollPromise: Promise<void>;
  public readonly logger: Logger;
  protected readonly shutdownSignalCallbacks = new Set<() => void>();
  protected state: 'RUNNING' | 'SHUTTING_DOWN' = 'RUNNING';

  static _instance?: Runtime;
  static instantiator?: 'install' | 'instance';

  /**
   * Default options get overridden when Core is installed and are remembered in case Core is
   * re-instantiated after being shut down
   */
  static defaultOptions: RuntimeOptions = {};

  protected constructor(
    public readonly native: native.Runtime,
    public readonly options: CompiledRuntimeOptions
  ) {
    if (this.isForwardingLogs()) {
      const logger = (this.logger = new BufferedLogger(this.options.logger));
      this.logPollPromise = this.initLogPolling(logger);
    } else {
      this.logger = this.options.logger;
      this.logPollPromise = Promise.resolve();
    }
    this.checkHeapSizeLimit();
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
    const compiledOptions = this.compileOptions(options);
    const runtime = newRuntime(compiledOptions.telemetryOptions);

    // Remember the provided options in case Core is reinstantiated after being shut down
    this.defaultOptions = options;
    this.instantiator = instantiator;
    this._instance = new this(runtime, compiledOptions);
    return this._instance;
  }

  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  protected static compileOptions(options: RuntimeOptions): CompiledRuntimeOptions {
    // eslint-disable-next-line deprecation/deprecation
    const { logging, metrics, tracingFilter, ...otherTelemetryOpts } = options.telemetryOptions ?? {};

    const defaultFilter =
      tracingFilter ??
      makeTelemetryFilterString({
        core: 'WARN',
        other: 'ERROR',
      });
    const loggingFilter = logging?.filter;

    // eslint-disable-next-line deprecation/deprecation
    const forwardLevel = (logging as ForwardLogger | undefined)?.forward?.level;
    const forwardLevelFilter =
      forwardLevel &&
      makeTelemetryFilterString({
        core: forwardLevel,
        other: forwardLevel,
      });

    return {
      shutdownSignals: options.shutdownSignals ?? ['SIGINT', 'SIGTERM', 'SIGQUIT', 'SIGUSR2'],
      telemetryOptions: {
        logging:
          !!logging && isForwardingLogger(logging)
            ? {
                filter: loggingFilter ?? forwardLevelFilter ?? defaultFilter,
                forward: {},
              }
            : {
                filter: loggingFilter ?? defaultFilter,
                console: {},
              },
        metrics: metrics && {
          temporality: metrics.temporality,
          ...(isOtelCollectorExporter(metrics)
            ? {
                otel: {
                  url: metrics.otel.url,
                  headers: metrics.otel.headers ?? {},
                  metricsExportInterval: msToNumber(metrics.otel.metricsExportInterval ?? '1s'),
                  useSecondsForDurations: metrics.otel.useSecondsForDurations,
                },
              }
            : {
                prometheus: {
                  bindAddress: metrics.prometheus.bindAddress,
                  unitSuffix: metrics.prometheus.unitSuffix,
                  countersTotalSuffix: metrics.prometheus.countersTotalSuffix,
                  useSecondsForDurations: metrics.prometheus.useSecondsForDurations,
                },
              }),
        },
        ...filterNullAndUndefined(otherTelemetryOpts ?? {}),
      },
      logger: options.logger ?? new DefaultLogger('INFO'),
    };
  }

  protected async initLogPolling(logger: BufferedLogger): Promise<void> {
    if (!this.isForwardingLogs()) {
      return;
    }

    const poll = promisify(pollLogs);
    const doPoll = async () => {
      const logs = await poll(this.native);
      for (const log of logs) {
        const meta: LogMetadata = {
          [LogTimestamp]: timeOfDayToBigint(log.timestamp),
          sdkComponent: SdkComponent.core,
          ...log.fields,
        };
        logger.log(log.level, log.message, meta);
      }
    };

    try {
      for (;;) {
        await doPoll();
        logger.flush();
        if (this.stopPollingForLogs) {
          break;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 3);
          this.stopPollingForLogsCallback = resolve;
        });
      }
    } catch (error) {
      // Log using the original logger instead of buffering
      this.options.logger.warn('Error gathering forwarded logs from core', {
        error,
        sdkComponent: SdkComponent.worker,
      });
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
      const logger = this.logger as BufferedLogger;
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
    if (options?.apiKey && compiledServerOptions.metadata?.['Authorization']) {
      throw new TypeError(
        'Both `apiKey` option and `Authorization` header were provided. Only one makes sense to use at a time.'
      );
    }
    const clientOptions = {
      ...compiledServerOptions,
      tls: normalizeTlsConfig(compiledServerOptions.tls),
      url: options?.tls ? `https://${compiledServerOptions.address}` : `http://${compiledServerOptions.address}`,
    };
    return await this.createNative(promisify(newClient), this.native, clientOptions);
  }

  /**
   * Close a native Client, if this is the last registered Client or Worker, shutdown the core and unset the singleton instance
   *
   * Hidden in the docs because it is only meant to be used internally by the Worker.
   * @hidden
   */
  public async closeNativeClient(client: native.Client): Promise<void> {
    native.clientClose(client);
    this.backRefs.delete(client);
    await this.shutdownIfIdle();
  }

  /**
   * Register a Worker, this is required for automatically shutting down when all Workers have been deregistered
   *
   * Hidden in the docs because it is only meant to be used internally by the Worker.
   * @hidden
   */
  public async registerWorker(client: native.Client, options: native.WorkerOptions): Promise<native.Worker> {
    return await this.createNative(promisify(native.newWorker), client, options);
  }

  /** @hidden */
  public async createReplayWorker(options: native.WorkerOptions): Promise<native.ReplayWorker> {
    return await this.createNativeNoBackRef(async () => {
      const fn = promisify(native.newReplayWorker);
      const replayWorker = await fn(this.native, options);
      this.backRefs.add(replayWorker.worker);
      return replayWorker;
    });
  }

  /**
   * Push history to a replay worker's history pusher stream.
   *
   * Hidden in the docs because it is only meant to be used internally by the Worker.
   *
   * @hidden
   */
  public async pushHistory(pusher: native.HistoryPusher, workflowId: string, history: History): Promise<void> {
    const encoded = byteArrayToBuffer(temporal.api.history.v1.History.encodeDelimited(history).finish());
    return await promisify(native.pushHistory)(pusher, workflowId, encoded);
  }

  /**
   * Close a replay worker's history pusher stream.
   *
   * Hidden in the docs because it is only meant to be used internally by the Worker.
   *
   * @hidden
   */
  public closeHistoryStream(pusher: native.HistoryPusher): void {
    native.closeHistoryStream(pusher);
  }

  /**
   * Deregister a Worker, if this is the last registered Worker or Client, shutdown the core and unset the singleton instance
   *
   * Hidden in the docs because it is only meant to be used internally by the Worker.
   * @hidden
   */
  public async deregisterWorker(worker: native.Worker): Promise<void> {
    native.workerFinalizeShutdown(worker);
    this.backRefs.delete(worker);
    await this.shutdownIfIdle();
  }

  /**
   * Create an ephemeral Temporal server.
   *
   * Hidden since it is meant to be used internally by the testing framework.
   * @hidden
   */
  public async createEphemeralServer(options: native.EphemeralServerConfig): Promise<native.EphemeralServer> {
    return await this.createNative(promisify(native.startEphemeralServer), this.native, options, pkg.version);
  }

  /**
   * Shut down an ephemeral Temporal server.
   *
   * Hidden since it is meant to be used internally by the testing framework.
   * @hidden
   */
  public async shutdownEphemeralServer(server: native.EphemeralServer): Promise<void> {
    await promisify(native.shutdownEphemeralServer)(server);
    this.backRefs.delete(server);
    await this.shutdownIfIdle();
  }

  protected async createNative<
    R extends TrackedNativeObject,
    Args extends any[],
    F extends (...args: Args) => Promise<R>,
  >(f: F, ...args: Args): Promise<R> {
    return this.createNativeNoBackRef(async () => {
      const ref = await f(...args);
      this.backRefs.add(ref);
      return ref;
    });
  }

  protected async createNativeNoBackRef<R, Args extends any[], F extends (...args: Args) => Promise<R>>(
    f: F,
    ...args: Args
  ): Promise<R> {
    this.pendingCreations++;
    try {
      try {
        return await f(...args);
      } finally {
        this.pendingCreations--;
      }
    } catch (err) {
      // Attempt to shutdown the runtime in case there's an error creating the
      // native object to avoid leaving an idle Runtime.
      await this.shutdownIfIdle();
      throw err;
    }
  }

  protected isIdle(): boolean {
    return this.pendingCreations === 0 && this.backRefs.size === 0;
  }

  protected async shutdownIfIdle(): Promise<void> {
    if (this.isIdle()) await this.shutdown();
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
    this.stopPollingForLogs = true;
    this.stopPollingForLogsCallback?.();
    // This will effectively drain all logs
    await this.logPollPromise;
    await promisify(runtimeShutdown)(this.native);
  }

  /**
   * Used by Workers to register for shutdown signals
   *
   * Hidden in the docs because it is only meant to be used internally by the Worker.
   * @hidden
   */
  public registerShutdownSignalCallback(callback: () => void): void {
    if (this.state === 'RUNNING') {
      this.shutdownSignalCallbacks.add(callback);
    } else {
      queueMicrotask(callback);
    }
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
    this.state = 'SHUTTING_DOWN';
    this.teardownShutdownHook();
    for (const callback of this.shutdownSignalCallbacks) {
      queueMicrotask(callback); // Run later
      this.deregisterShutdownSignalCallback(callback);
    }
  };

  protected checkHeapSizeLimit(): void {
    if (process.platform === 'linux') {
      // References:
      // - https://facebookmicrosites.github.io/cgroup2/docs/memory-controller.html
      // - https://www.kernel.org/doc/Documentation/cgroup-v1/memory.txt
      const cgroupMemoryConstraint =
        this.tryReadNumberFileSync(/* cgroup v2 */ '/sys/fs/cgroup/memory.high') ??
        this.tryReadNumberFileSync(/* cgroup v2 */ '/sys/fs/cgroup/memory.max') ??
        this.tryReadNumberFileSync(/* cgroup v1 */ '/sys/fs/cgroup/memory/memory.limit_in_bytes');
      const cgroupMemoryReservation =
        this.tryReadNumberFileSync(/* cgroup v2 */ '/sys/fs/cgroup/memory.low') ??
        this.tryReadNumberFileSync(/* cgroup v2 */ '/sys/fs/cgroup/memory.min') ??
        this.tryReadNumberFileSync(/* cgroup v1 */ '/sys/fs/cgroup/memory/soft_limit_in_bytes');

      const applicableMemoryConstraint = cgroupMemoryReservation ?? cgroupMemoryConstraint;
      if (
        applicableMemoryConstraint &&
        applicableMemoryConstraint < os.totalmem() &&
        applicableMemoryConstraint < v8.getHeapStatistics().heap_size_limit
      ) {
        let dockerArgs = '';
        if (cgroupMemoryConstraint) {
          dockerArgs += `--memory=${toMB(cgroupMemoryConstraint, 0)}m `;
        }
        if (cgroupMemoryReservation) {
          dockerArgs += `--memory-reservation=${toMB(cgroupMemoryReservation, 0)}m `;
        }

        const suggestedOldSpaceSizeInMb = toMB(applicableMemoryConstraint * 0.75, 0);

        this.logger.warn(
          `This program is running inside a containerized environment with a memory constraint ` +
            `(eg. '${dockerArgs}' or similar). Node itself does not consider this memory constraint ` +
            `in how it manages its heap memory. There is consequently a high probability that ` +
            `the process will crash due to running out of memory. To increase reliability, we recommend ` +
            `adding '--max-old-space-size=${suggestedOldSpaceSizeInMb}' to your node arguments. ` +
            `Refer to https://docs.temporal.io/develop/typescript/core-application#run-a-worker-on-docker ` +
            `for more advice on tuning your Workers.`,
          { sdkComponent: SdkComponent.worker }
        );
      }
    }
  }

  protected tryReadNumberFileSync(file: string): number | undefined {
    try {
      const val = Number(fs.readFileSync(file, { encoding: 'ascii' }));
      return isNaN(val) ? undefined : val;
    } catch (_e) {
      return undefined;
    }
  }
}
