import * as v8 from 'node:v8';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { Heap } from 'heap-js';
import { native } from '@temporalio/core-bridge';
import { filterNullAndUndefined } from '@temporalio/common/lib/internal-non-workflow';
import { IllegalStateError, Logger, LogLevel, LogMetadata, SdkComponent } from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import { History } from '@temporalio/common/lib/proto-utils';
import { DefaultLogger, LogTimestamp, LogEntry as LogEntry2 } from './logger';
import { compileConnectionOptions, NativeConnectionOptions } from './connection-options';
import { byteArrayToBuffer, toMB } from './utils';
import { CompiledRuntimeOptions, compileOptions, RuntimeOptions } from './runtime-options';

export { History };

export type LogEntryMetadata = {
  [key: string]: string | number | boolean | LogEntryMetadata;
};

export interface LogEntry {
  /** Log message */
  message: string;
  /**
   * Time since epoch [seconds, nanos].
   *
   * Should be switched to bigint once it is supported in neon.
   */
  timestamp: [number, number];

  /** Log level */
  level: LogLevel;

  /** Name of the Core subsystem that emitted that log entry */
  target: string;

  /*** Metadata fields */
  fields: LogEntryMetadata;
}

/** A logger that buffers logs from both Node.js and Rust Core and emits logs in the right order */
class BufferedLogger extends DefaultLogger {
  protected buffer = new Heap<LogEntry2>((a, b) => Number(a.timestampNanos - b.timestampNanos));

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
    const compiledOptions = compileOptions(options);
    const runtime = native.newRuntime(compiledOptions.telemetryOptions);

    // Remember the provided options in case Core is reinstantiated after being shut down
    this.defaultOptions = options;
    this.instantiator = instantiator;
    this._instance = new this(runtime, compiledOptions);
    return this._instance;
  }

  protected async initLogPolling(logger: BufferedLogger): Promise<void> {
    if (!this.isForwardingLogs()) {
      return;
    }

    const doPoll = () => {
      const logs = native.pollLogs(this.native);
      for (const log of logs) {
        const meta: LogMetadata = {
          [LogTimestamp]: log.timestamp,
          sdkComponent: SdkComponent.core,
          ...log.fields,
        };
        logger.log(log.level, log.message, meta);
      }
    };

    try {
      for (;;) {
        doPoll();
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
    return this.options.telemetryOptions.logExporter.type === 'forward';
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
    return await this.createNative(
      native.newClient,
      this.native,
      compileConnectionOptions(filterNullAndUndefined(options ?? {}))
    );
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
    return await this.createNativeNoBackRef(async () => {
      const worker = native.newWorker(client, options);
      await native.workerValidate(worker);
      this.backRefs.add(worker);
      return worker;
    });
  }

  /** @hidden */
  public async createReplayWorker(options: native.WorkerOptions): Promise<native.ReplayWorker> {
    return await this.createNativeNoBackRef(async () => {
      const replayWorker = native.newReplayWorker(this.native, options);
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
    return await native.pushHistory(pusher, workflowId, encoded);
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
    await native.workerFinalizeShutdown(worker).catch(() => {
      /* ignore */
    });
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
    return await this.createNative(native.startEphemeralServer, this.native, options);
  }

  /**
   * Shut down an ephemeral Temporal server.
   *
   * Hidden since it is meant to be used internally by the testing framework.
   * @hidden
   */
  public async shutdownEphemeralServer(server: native.EphemeralServer): Promise<void> {
    await native.shutdownEphemeralServer(server).catch(() => {
      /* ignore */
    });
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
    if (this.native === undefined) return;
    delete Runtime._instance;
    this.teardownShutdownHook();
    this.stopPollingForLogs = true;
    this.stopPollingForLogsCallback?.();
    // This will effectively drain all logs
    await this.logPollPromise;
    native.runtimeShutdown(this.native);
    delete (this as any).native;
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
