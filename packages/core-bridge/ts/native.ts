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
  telemetry: TelemetryOptions;
  metricsExporter: MetricExporterOptions;
};

export type TelemetryOptions = {
  attachServiceName: boolean;
  metricPrefix: string;
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

export type MetricExporterOptions = PrometheusMetricsExporterOptions | OtelMetricsExporterOptions | null;

export interface PrometheusMetricsExporterOptions {
  type: 'prometheus';
  socketAddr: string;
  globalTags: Record<string, string>;
  countersTotalSuffix: boolean;
  unitSuffix: boolean;
  useSecondsForDurations: boolean;
  histogramBucketOverrides: Record<string, number[]>;
}

export interface OtelMetricsExporterOptions {
  type: 'otel';
  url: string;
  headers: Record<string, string>;
  metricPeriodicity: number;
  metricTemporality: 'cumulative' | 'delta';
  globalTags: Record<string, string>;
  useSecondsForDurations: boolean;
  histogramBucketOverrides: Record<string, number[]>;
  protocol: 'http' | 'grpc';
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Client
////////////////////////////////////////////////////////////////////////////////////////////////////

export declare function newClient(runtime: Runtime, clientOptions: ClientOptions): Promise<Client>;

export declare function clientUpdateHeaders(client: Client, headers: Record<string, string>): void;

export declare function clientUpdateApiKey(client: Client, apiKey: string): void;

export declare function clientSendWorkflowServiceRequest(client: Client, call: RpcCall): Promise<Buffer>;

export declare function clientSendOperatorServiceRequest(client: Client, call: RpcCall): Promise<Buffer>;

export declare function clientSendTestServiceRequest(client: Client, call: RpcCall): Promise<Buffer>;

export declare function clientSendHealthServiceRequest(client: Client, call: RpcCall): Promise<Buffer>;

export declare function clientClose(client: Client): void;

export interface Client {
  type: 'client';
}

export interface ClientOptions {
  targetUrl: string;
  clientName: string;
  clientVersion: string;
  tls: Option<TLSConfig>;
  httpConnectProxy: Option<HttpConnectProxy>;
  headers: Option<Record<string, string>>;
  apiKey: Option<string>;
  disableErrorCodeMetricTags: boolean;
}

export interface TLSConfig {
  domain: Option<string>;
  serverRootCaCert: Option<Buffer>;
  clientTlsConfig: Option<TlsConfigClientCertPair>;
}

export interface TlsConfigClientCertPair {
  clientCert: Buffer;
  clientPrivateKey: Buffer;
}

export interface HttpConnectProxy {
  targetHost: string;
  basicAuth: Option<{
    username: string;
    password: string;
  }>;
}

export interface HttpConnectProxyBasicAuth {
  username: string;
  password: string;
}

export interface RpcCall {
  rpc: string;
  req: Buffer;
  retry: boolean;
  metadata: Record<string, string>;
  timeout: Option<number>;
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Worker
////////////////////////////////////////////////////////////////////////////////////////////////////

export declare function newWorker(client: Client, workerOptions: WorkerOptions): Worker;

export declare function workerValidate(worker: Worker): Promise<void>;

export declare function workerPollWorkflowActivation(worker: Worker): Promise<Buffer>;

export declare function workerCompleteWorkflowActivation(worker: Worker, result: Buffer): Promise<void>;

export declare function workerPollActivityTask(worker: Worker): Promise<Buffer>;

export declare function workerCompleteActivityTask(worker: Worker, result: Buffer): Promise<void>;

export declare function workerRecordActivityHeartbeat(worker: Worker, heartbeat: Buffer): void;

export declare function workerPollNexusTask(worker: Worker): Promise<Buffer>;

export declare function workerCompleteNexusTask(worker: Worker, result: Buffer): Promise<void>;

export declare function workerInitiateShutdown(worker: Worker): void;

export declare function workerFinalizeShutdown(worker: Worker): Promise<void>;

export interface Worker {
  type: 'worker';
}

export interface WorkerOptions {
  identity: string;
  buildId: string;
  useVersioning: boolean;
  workerDeploymentOptions: Option<WorkerDeploymentOptions>;
  taskQueue: string;
  namespace: string;
  tuner: WorkerTunerOptions;
  nonStickyToStickyPollRatio: number;
  workflowTaskPollerBehavior: PollerBehavior;
  activityTaskPollerBehavior: PollerBehavior;
  nexusTaskPollerBehavior: PollerBehavior;
  enableNonLocalActivities: boolean;
  stickyQueueScheduleToStartTimeout: number;
  maxCachedWorkflows: number;
  maxHeartbeatThrottleInterval: number;
  defaultHeartbeatThrottleInterval: number;
  maxTaskQueueActivitiesPerSecond: Option<number>;
  maxActivitiesPerSecond: Option<number>;
  shutdownGraceTime: number;
}

export type PollerBehavior =
  | {
      type: 'simple-maximum';
      maximum: number;
    }
  | {
      type: 'autoscaling';
      minimum: number;
      maximum: number;
      initial: number;
    };

export type WorkerDeploymentOptions = {
  version: WorkerDeploymentVersion;
  useWorkerVersioning: boolean;
  defaultVersioningBehavior: VersioningBehavior;
};

export type WorkerDeploymentVersion = {
  buildId: string;
  deploymentName: string;
};

export type VersioningBehavior = { type: 'pinned' } | { type: 'auto-upgrade' };

////////////////////////////////////////////////////////////////////////////////////////////////////
// Worker Tuner
////////////////////////////////////////////////////////////////////////////////////////////////////

export interface WorkerTunerOptions {
  workflowTaskSlotSupplier: SlotSupplierOptions;
  activityTaskSlotSupplier: SlotSupplierOptions;
  localActivityTaskSlotSupplier: SlotSupplierOptions;
  nexusTaskSlotSupplier: SlotSupplierOptions;
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
  workerDeploymentVersion: Option<WorkerDeploymentVersion>;
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
// Testing
////////////////////////////////////////////////////////////////////////////////////////////////////

export declare function newEphemeralServer(runtime: Runtime, config: EphemeralServerConfig): Promise<EphemeralServer>;

export declare function ephemeralServerGetTarget(server: EphemeralServer): string;

export declare function ephemeralServerShutdown(server: EphemeralServer): Promise<void>;

export interface EphemeralServer {
  type: 'ephemeral-server';
}

export type EphemeralServerConfig = TimeSkippingServerConfig | DevServerConfig;

export interface TimeSkippingServerConfig {
  type: 'time-skipping';
  exe: EphemeralServerExecutableConfig;
  port: Option<number>;
  extraArgs: string[];
}

export interface DevServerConfig {
  type: 'dev-server';
  exe: EphemeralServerExecutableConfig;
  namespace: string;
  ip: string;
  port: Option<number>;
  uiPort: Option<number>;
  dbFilename: Option<string>;
  ui: boolean;
  log: DevServerLogConfig;
  extraArgs: string[];
}

export interface DevServerLogConfig {
  format: string;
  level: string;
}

export type EphemeralServerExecutableConfig = CachedDownloadConfig | ExistingPathConfig;

export interface CachedDownloadConfig {
  type: 'cached-download';
  downloadDir: Option<string>;
  version: string;
  ttl: number;
  sdkName: string;
  sdkVersion: string;
}

export interface ExistingPathConfig {
  type: 'existing-path';
  path: string;
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Log Forwarding
////////////////////////////////////////////////////////////////////////////////////////////////////

export declare function getTimeOfDay(): bigint;

export interface LogEntry {
  target: string;
  message: string;
  timestamp: string; // u128 as a string - JSON doesn't support u128 numbers
  level: LogLevel;
  fields: LogEntryMetadata;
  spanContexts: string[];
}

type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

type LogEntryMetadata = {
  [key: string]: string | number | boolean | LogEntryMetadata;
};

////////////////////////////////////////////////////////////////////////////////////////////////////
// Custom Metrics
////////////////////////////////////////////////////////////////////////////////////////////////////

export interface MetricMeter {
  type: 'metric-meter';
}

export interface MetricCounter {
  type: 'metric-counter';
}

export interface MetricHistogram {
  type: 'metric-histogram';
}

export interface MetricHistogramF64 {
  type: 'metric-histogram-f64';
}

export interface MetricGauge {
  type: 'metric-gauge';
}

export interface MetricGaugeF64 {
  type: 'metric-gauge-f64';
}

export type MetricAttributes = Record<string, string | number | boolean>;

export declare function newMetricCounter(
  runtime: Runtime,
  name: string,
  unit: string,
  description: string
): MetricCounter;

export declare function newMetricHistogram(
  runtime: Runtime,
  name: string,
  unit: string,
  description: string
): MetricHistogram;

export declare function newMetricHistogramF64(
  runtime: Runtime,
  name: string,
  unit: string,
  description: string
): MetricHistogramF64;

export declare function newMetricGauge(runtime: Runtime, name: string, unit: string, description: string): MetricGauge;

export declare function newMetricGaugeF64(
  runtime: Runtime,
  name: string,
  unit: string,
  description: string
): MetricGaugeF64;

export declare function addMetricCounterValue(
  counter: MetricCounter,
  value: number,
  attrs: JsonString<MetricAttributes>
): void;

export declare function recordMetricHistogramValue(
  histogram: MetricHistogram,
  value: number,
  attrs: JsonString<MetricAttributes>
): void;

export declare function recordMetricHistogramF64Value(
  histogram: MetricHistogramF64,
  value: number,
  attrs: JsonString<MetricAttributes>
): void;

export declare function setMetricGaugeValue(
  gauge: MetricGauge,
  value: number,
  attrs: JsonString<MetricAttributes>
): void;

export declare function setMetricGaugeF64Value(
  gauge: MetricGaugeF64,
  value: number,
  attrs: JsonString<MetricAttributes>
): void;
