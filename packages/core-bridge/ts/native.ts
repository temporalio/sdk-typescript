/**
 * Indicates a property that is allowed to be unspecified when calling in or out of
 * native code (the equivalent of the `Option<T>` type in Rust).
 *
 * Always use either this type or the `T | null` idiom to indicate a property that may
 * legitimately be left unspecified when calling into or out of native code. Never use
 * `T | undefined` or `prop?: T` on TS/Rust interfaces.
 *
 * ### Rationale
 *
 * Differentiating between "a property that is set to an unspecified optional value"
 * and "a non-existant property" allows eager detection of some of the most common
 * bug patterns resulting from incoherencies between the JS and Rust type definitions
 * (e.g. optional properties whose names differ between the two languages, or that
 * are missing in the JS interface, etc.).
 *
 * Unfortunately, it is not possible at present in Neon to differentiate between
 * a property that is set to `undefined` and a property that is missing;
 * i.e. `obj.get_value(cx, "prop")` will return `undefined` in both cases.
 *
 * We therefore follow the following principles for our TypeScript/Rust interfaces:
 *
 * - Always use `null` to indicate an intentionally unspecified optional value
 *   in TypeScript interfaces. This will be converted to `None` on the Rust side.
 * - Explicitly set _every_ properties on objects sent to the native code,
 *   including optional properties (e.g. `{ prop: input.prop ?? null }`).
 * - Never use the "optional property" syntax in TypeScript (i.e. `prop?: T`).
 *
 * Thanks to those conventions, a property that reads as `undefined` is known to to always
 * indicate an _unintentionally missing_ property, which will results in a runtime error.
 */
type Option<T> = T | null;

/**
 * Marker for values that are transferred as JSON strings.
 */
export type JsonString<_T> = string;

////////////////////////////////////////////////////////////////////////////////////////////////////
// Runtime
////////////////////////////////////////////////////////////////////////////////////////////////////

export declare function newRuntime(telemOptions: RuntimeOptions): Runtime;
export declare function runtimeShutdown(runtime: Runtime): void;

export interface Runtime {
  type: 'runtime';
}

export type RuntimeOptions = {
  logExporter: LogExporterOptions;
  telemetry: {
    metricPrefix: string;
    attachServiceName: boolean;
  };
  metricsExporter: MetricExporterOptions;
};

export type LogExporterOptions =
  | {
      type: 'console';
      filter: string;
    }
  | {
      type: 'forward';
      filter: string;
      receiver: (entries: JsonString<LogEntry>[]) => void;
    };

export type MetricExporterOptions =
  | {
      type: 'prometheus';
      bindAddress: string;
      countersTotalSuffix: boolean;
      unitSuffix: boolean;
      useSecondsForDurations: boolean;
      histogramBucketOverrides: Record<string, number[]>;
      globalTags: Record<string, string>;
    }
  | {
      type: 'otel';
      url: string;
      protocol: 'http' | 'grpc';
      headers: Record<string, string>;
      metricsExportInterval: number;
      useSecondsForDurations: boolean;
      temporality: 'cumulative' | 'delta';
      histogramBucketOverrides: Record<string, number[]>;
      globalTags: Record<string, string>;
    }
  | null;

////////////////////////////////////////////////////////////////////////////////////////////////////
// Client
////////////////////////////////////////////////////////////////////////////////////////////////////

export declare function newClient(runtime: Runtime, clientOptions: ClientOptions): Promise<Client>;
export declare function clientUpdateHeaders(client: Client, headers: Record<string, string>): void;
export declare function clientUpdateApiKey(client: Client, apiKey: string): void;
export declare function clientClose(client: Client): void;

export interface Client {
  type: 'client';
}

export interface ClientOptions {
  url: string;
  sdkVersion: string;
  tls: Option<TLSConfig>;
  proxy: Option<ProxyConfig>;
  metadata: Option<Record<string, string>>;
  apiKey: Option<string>;
  disableErrorCodeMetricTags: boolean;
}

export interface TLSConfig {
  serverNameOverride: Option<string>;
  serverRootCaCertificate: Option<Buffer>;
  clientCertPair: Option<{
    crt: Buffer;
    key: Buffer;
  }>;
}

export interface ProxyConfig {
  type: 'http-connect';
  targetHost: string;
  basicAuth: Option<{
    username: string;
    password: string;
  }>;
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Worker
////////////////////////////////////////////////////////////////////////////////////////////////////

export declare function newWorker(client: Client, workerOptions: WorkerOptions): Worker;
export declare function workerValidate(worker: Worker): Promise<void>;

export declare function workerInitiateShutdown(worker: Worker): void;
export declare function workerFinalizeShutdown(worker: Worker): Promise<void>;

export declare function workerPollWorkflowActivation(worker: Worker): Promise<Buffer>;
export declare function workerCompleteWorkflowActivation(worker: Worker, result: Buffer): Promise<void>;

export declare function workerPollActivityTask(worker: Worker): Promise<Buffer>;
export declare function workerCompleteActivityTask(worker: Worker, result: Buffer): Promise<void>;
export declare function workerRecordActivityHeartbeat(worker: Worker, heartbeat: Buffer): void;

export interface Worker {
  type: 'worker';
}

export interface WorkerOptions {
  identity: string;
  buildId: string;
  useVersioning: boolean;
  taskQueue: string;
  namespace: string;
  tuner: WorkerTunerOptions;
  nonStickyToStickyPollRatio: number;
  maxConcurrentWorkflowTaskPolls: number;
  maxConcurrentActivityTaskPolls: number;
  enableNonLocalActivities: boolean;
  stickyQueueScheduleToStartTimeout: number;
  maxCachedWorkflows: number;
  maxHeartbeatThrottleInterval: number;
  defaultHeartbeatThrottleInterval: number;
  maxTaskQueueActivitiesPerSecond: Option<number>;
  maxActivitiesPerSecond: Option<number>;
  shutdownGraceTime: number;
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Worker Tuner
////////////////////////////////////////////////////////////////////////////////////////////////////

export interface WorkerTunerOptions {
  workflowTaskSlotSupplier: SlotSupplierOptions;
  activityTaskSlotSupplier: SlotSupplierOptions;
  localActivityTaskSlotSupplier: SlotSupplierOptions;
}

export type SlotSupplierOptions =
  | FixedSizeSlotSupplierOptions
  | ResourceBasedSlotSupplierOptions
  | CustomSlotSupplierOptions<any>; // FIXME: any?

interface FixedSizeSlotSupplierOptions {
  type: 'fixed-size';
  numSlots: number;
}

interface ResourceBasedSlotSupplierOptions {
  type: 'resource-based';
  minimumSlots: number;
  maximumSlots: number;
  rampThrottle: number;
  tunerOptions: ResourceBasedTunerOptions;
}

interface ResourceBasedTunerOptions {
  targetMemoryUsage: number;
  targetCpuUsage: number;
}

export interface CustomSlotSupplierOptions<SI extends SlotInfo> {
  type: 'custom';
  reserveSlot(ctx: SlotReserveContext, abortSignal: AbortSignal): Promise<SlotPermit>;
  tryReserveSlot(ctx: SlotReserveContext): Option<SlotPermit>;
  markSlotUsed(ctx: SlotMarkUsedContext<SI>): void;
  releaseSlot(ctx: SlotReleaseContext<SI>): void;
}

export type SlotInfo =
  | {
      type: 'workflow';
      workflowType: string;
      isSticky: boolean;
    }
  | {
      type: 'activity';
      activityType: string;
    }
  | {
      type: 'local-activity';
      activityType: string;
    }
  | {
      type: 'nexus';
      service: string;
      operation: string;
    };

export interface SlotReserveContext {
  slotType: SlotInfo['type'];
  taskQueue: string;
  workerIdentity: string;
  workerBuildId: string;
  isSticky: boolean;
}

export interface SlotMarkUsedContext<SI extends SlotInfo> {
  slotInfo: SI;
  permit: SlotPermit;
}

export interface SlotReleaseContext<SI extends SlotInfo> {
  slotInfo: Option<SI>;
  permit: SlotPermit;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SlotPermit {}

////////////////////////////////////////////////////////////////////////////////////////////////////
// ReplayWorker
////////////////////////////////////////////////////////////////////////////////////////////////////

export declare function newReplayWorker(runtime: Runtime, workerOptions: WorkerOptions): [Worker, HistoryPusher];
export declare function pushHistory(pusher: HistoryPusher, workflowId: string, history: Buffer): Promise<void>;
export declare function closeHistoryStream(pusher: HistoryPusher): void;

export interface HistoryPusher {
  type: 'history-pusher';
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Log Forwarding
////////////////////////////////////////////////////////////////////////////////////////////////////

// export declare function pollLogs(runtime: Runtime): LogEntry[];
export declare function getTimeOfDay(): bigint;

export interface LogEntry {
  message: string;
  timestamp: string; // u128 as a string - JSON doesn't support u128 numbers
  level: LogLevel;
  target: string;
  fields: LogEntryMetadata;
}

type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

type LogEntryMetadata = {
  [key: string]: string | number | boolean | LogEntryMetadata;
};

////////////////////////////////////////////////////////////////////////////////////////////////////
// Ephemeral Server
////////////////////////////////////////////////////////////////////////////////////////////////////

export interface EphemeralServer {
  type: 'ephemeral-server';
}

export declare function startEphemeralServer(runtime: Runtime, config: EphemeralServerConfig): Promise<EphemeralServer>;
export declare function getEphemeralServerTarget(server: EphemeralServer): string;
export declare function shutdownEphemeralServer(server: EphemeralServer): Promise<void>;

export type EphemeralServerConfig = TimeSkippingServerConfig | DevServerConfig;

export interface TimeSkippingServerConfig {
  type: 'time-skipping';
  executable: EphemeralServerExecutableConfig;
  port: Option<number>;
  extraArgs: string[];
}

export interface DevServerConfig {
  type: 'dev-server';
  executable: EphemeralServerExecutableConfig;
  ip: string;
  port: Option<number>;
  ui: boolean;
  uiPort: Option<number>;
  namespace: string;
  dbFilename: Option<string>;
  log: { format: string; level: string };
  extraArgs: string[];
}

export type EphemeralServerExecutableConfig =
  | {
      type: 'cached-download';
      downloadDir: Option<string>;
      version: string;
      ttl: number;
      sdkVersion: string;
    }
  | {
      type: 'existing-path';
      path: string;
    };
